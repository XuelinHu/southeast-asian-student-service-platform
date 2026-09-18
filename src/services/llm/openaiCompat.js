const { LlmError } = require('./ollama');

// ---------------------------------------------------------------------------
// OpenAI 兼容协议的流式适配（DeepSeek / 阿里百炼 / 任何兼容端点）。
// 产出的事件与 ollama.js 完全一致，编排层不需要知道背后是哪家。
// ---------------------------------------------------------------------------

/**
 * 从 SSE 字节流里切出 data: 行。
 * 与 Ollama 的 NDJSON 不同，SSE 用空行分隔事件，且可能带 event:/id: 等其它字段。
 */
async function* readSse(response) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
      index = buffer.indexOf('\n');
    }
  }

  const tail = buffer.trim();
  if (tail.startsWith('data:')) yield tail.slice(5).trim();
}

async function* chat({ provider, model, messages, tools, signal, temperature }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const body = { model, messages, stream: true };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (temperature !== undefined) body.temperature = temperature;

  let response;
  try {
    response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new LlmError(`无法连接 ${provider.label}：${error.message}`, {
      status: 503,
      provider: provider.key
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LlmError(`${provider.label} 返回 ${response.status}: ${text.slice(0, 300)}`, {
      status: response.status,
      provider: provider.key
    });
  }

  // OpenAI 协议下 arguments 是逐字符下发的 JSON 字符串片段，必须按 index 累加后再解析
  const callsByIndex = new Map();
  let finishReason = 'stop';

  try {
    for await (const data of readSse(response)) {
      if (data === '[DONE]') break;

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }

      if (payload.error) {
        throw new LlmError(`${provider.label} 推理失败: ${payload.error.message || JSON.stringify(payload.error)}`, {
          status: 502,
          provider: provider.key
        });
      }

      const choice = payload.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      // deepseek-reasoner 的思维链字段
      if (delta.reasoning_content) yield { type: 'thinking', text: delta.reasoning_content };
      if (delta.content) yield { type: 'delta', text: delta.content };

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = call.index ?? 0;
          let entry = callsByIndex.get(index);
          if (!entry) {
            entry = { id: '', name: '', arguments: '' };
            callsByIndex.set(index, entry);
          }
          // id 和 name 只在第一帧出现，为空时不要覆盖已有的
          if (call.id) entry.id = call.id;
          if (call.function?.name) entry.name = call.function.name;
          if (call.function?.arguments) entry.arguments += call.function.arguments;
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  for (const [index, entry] of callsByIndex) {
    let parsed = {};
    try {
      parsed = entry.arguments ? JSON.parse(entry.arguments) : {};
    } catch {
      parsed = {};
    }
    yield {
      type: 'tool_call',
      // 有些兼容端点不给 id，兜一个稳定的本地 id
      id: entry.id || `call_${index}`,
      name: entry.name,
      arguments: parsed
    };
  }

  yield {
    type: 'done',
    finishReason: callsByIndex.size && finishReason === 'stop' ? 'tool_calls' : finishReason,
    usage: null
  };
}

module.exports = { chat };
