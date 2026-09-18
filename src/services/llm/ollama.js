const { OLLAMA_BASE_URL, LLM_KEEP_ALIVE } = require('../../config/llm');

// ---------------------------------------------------------------------------
// 基础请求
// ---------------------------------------------------------------------------

class LlmError extends Error {
  constructor(message, { status, provider = 'ollama' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.provider = provider;
    // 让 server.js 的错误处理把 5xx 的原始信息也发给前端：
    // "连不上本机 Ollama" 这类提示藏着只会让人无从排查
    this.expose = true;
  }
}

async function request(path, { method = 'GET', body, signal, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  // 外部取消（客户端断开）也要传导到上游，否则 Ollama 会继续把显存占着算完
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new LlmError(`Ollama ${path} 返回 ${response.status}: ${text.slice(0, 300)}`, {
        status: response.status
      });
    }
    return response;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    if (error instanceof LlmError) throw error;
    // 连接被拒多半是 Ollama 没起来，给出可操作的提示而不是裸的 ECONNREFUSED
    throw new LlmError(`无法连接本机 Ollama (${OLLAMA_BASE_URL})：${error.message}`, { status: 503 });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// 模型清单
// ---------------------------------------------------------------------------

/** 本机已下载的模型。Ollama 没起来时返回空数组而不是抛错，让下拉至少能用云端模型。 */
async function listTags() {
  try {
    const response = await request('/api/tags', { timeoutMs: 5000 });
    const data = await response.json();
    return (data.models || []).map((model) => ({
      name: model.name,
      sizeBytes: model.size || 0,
      parameterSize: model.details?.parameter_size || '',
      quantization: model.details?.quantization_level || '',
      family: model.details?.family || '',
      modifiedAt: model.modified_at || null
    }));
  } catch {
    return [];
  }
}

/** 当前已加载进显存、可以直接推理的模型。 */
async function listRunning() {
  try {
    const response = await request('/api/ps', { timeoutMs: 5000 });
    const data = await response.json();
    return (data.models || []).map((model) => ({
      name: model.name,
      sizeVramBytes: model.size_vram || 0,
      contextLength: model.context_length || null,
      expiresAt: model.expires_at || null
    }));
  } catch {
    return [];
  }
}

/** 模型能力（tools / thinking）与上下文长度。用于决定走原生工具调用还是提示词回退。 */
async function show(model) {
  try {
    const response = await request('/api/show', { method: 'POST', body: { model }, timeoutMs: 10000 });
    const data = await response.json();
    return {
      capabilities: data.capabilities || [],
      contextLength: data.model_info?.[`${data.details?.family || 'qwen3'}.context_length`] || null,
      parameterSize: data.details?.parameter_size || ''
    };
  } catch {
    // show 失败不影响推理，按"没有原生工具能力"处理，编排层会回退到提示词协议
    return { capabilities: [], contextLength: null, parameterSize: '' };
  }
}

// ---------------------------------------------------------------------------
// 加载 / 卸载
// ---------------------------------------------------------------------------

/**
 * 把模型加载进显存。冷启动首次推理要 50s 以上，先 warmup 再提问能明显改善体验。
 * 空 prompt 的 generate 不会产生任何 token，只是让 Ollama 把权重读进显存。
 */
async function warmup(model, { signal } = {}) {
  const response = await request('/api/generate', {
    method: 'POST',
    body: { model, prompt: '', keep_alive: LLM_KEEP_ALIVE, stream: false },
    signal,
    timeoutMs: 300000
  });
  await response.json().catch(() => null);
  return true;
}

/** 立刻把模型从显存里卸掉（keep_alive: 0），用于给别的模型腾地方。 */
async function unload(model) {
  const response = await request('/api/generate', {
    method: 'POST',
    body: { model, prompt: '', keep_alive: 0, stream: false },
    timeoutMs: 30000
  });
  await response.json().catch(() => null);
  return true;
}

// ---------------------------------------------------------------------------
// 流式对话
// ---------------------------------------------------------------------------

/**
 * 把 NDJSON 字节流切成一行行 JSON。
 * 一个 chunk 可能包含半行，也可能一次包含好几行，所以必须自己维护行缓冲。
 */
async function* readLines(response) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield line;
      index = buffer.indexOf('\n');
    }
  }

  const tail = buffer.trim();
  if (tail) yield tail;
}

/**
 * 流式对话，产出与 openaiCompat 一致的规范化事件：
 *   { type: 'thinking', text }
 *   { type: 'delta', text }
 *   { type: 'tool_call', id, name, arguments }
 *   { type: 'done', finishReason, usage }
 *
 * 实测（Ollama 0.19 + qwen3:14b）：
 *   - 思考过程在独立的 message.thinking 字段，不混进 content，不需要剥 <｜end▁of▁thinking｜> 标签
 *   - tool_calls 在流式下是「单帧完整下发」，arguments 已是对象而非 JSON 字符串；
 *     仍按 index 累加，防御将来变成增量下发
 *   - 模型纯调工具时 content 为空，输出全在 thinking 里，所以 UI 必须渲染思考流
 */
async function* chat({ model, messages, tools, signal, keepAlive = LLM_KEEP_ALIVE, options } = {}) {
  const body = {
    model,
    messages,
    stream: true,
    keep_alive: keepAlive
  };
  if (tools && tools.length) body.tools = tools;
  if (options && Object.keys(options).length) body.options = options;

  const response = await request('/api/chat', { method: 'POST', body, signal });

  // Ollama 不返回 tool_call id，这里自己编号，供编排层把结果配回对应的调用
  const callsByIndex = new Map();
  let finishReason = 'stop';
  let usage = null;
  let emittedAny = false;

  for await (const line of readLines(response)) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }

    if (payload.error) {
      throw new LlmError(`Ollama 推理失败: ${payload.error}`, { status: 502 });
    }

    const message = payload.message || {};

    // qwen3 等支持思考的模型把推理过程放在这里
    if (message.thinking) {
      emittedAny = true;
      yield { type: 'thinking', text: message.thinking };
    }

    if (message.content) {
      emittedAny = true;
      yield { type: 'delta', text: message.content };
    }

    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const fn = call.function || {};
        const index = call.index ?? callsByIndex.size;
        let entry = callsByIndex.get(index);
        if (!entry) {
          entry = { id: `call_${index}`, name: '', arguments: '' };
          callsByIndex.set(index, entry);
        }
        if (fn.name) entry.name = fn.name;
        // 对象直接用；字符串就累加，兼容增量下发的实现
        if (typeof fn.arguments === 'string') entry.arguments += fn.arguments;
        else if (fn.arguments && typeof fn.arguments === 'object') entry.arguments = JSON.stringify(fn.arguments);
      }
    }

    if (payload.done) {
      if (payload.done_reason) finishReason = payload.done_reason;
      usage = {
        promptTokens: payload.prompt_eval_count ?? null,
        completionTokens: payload.eval_count ?? null
      };
      break;
    }
  }

  for (const entry of callsByIndex.values()) {
    emittedAny = true;
    let parsed = {};
    try {
      parsed = entry.arguments ? JSON.parse(entry.arguments) : {};
    } catch {
      // 模型偶尔会给出半截 JSON，交给编排层当成"参数缺失"处理，不要在这里崩
      parsed = {};
    }
    yield { type: 'tool_call', id: entry.id, name: entry.name, arguments: parsed };
  }

  // 工具调用轮的 content 为空是正常的，此时 finishReason 记成 tool_calls 更准确
  if (callsByIndex.size && finishReason === 'stop') finishReason = 'tool_calls';
  if (!emittedAny) finishReason = finishReason || 'empty';

  yield { type: 'done', finishReason, usage };
}

module.exports = {
  LlmError,
  listTags,
  listRunning,
  show,
  warmup,
  unload,
  chat
};
