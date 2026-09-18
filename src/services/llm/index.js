const {
  OLLAMA_MODELS_DIR,
  LOCAL_LLM_MODELS,
  LLM_DEFAULT_MODEL,
  LLM_MAX_CONCURRENCY,
  LLM_QUEUE_LIMIT,
  LLM_KEEP_ALIVE,
  LLM_MAX_MODEL_SIZE_GB,
  LLM_LOCAL_ONLY,
  LLM_REQUEST_TIMEOUT_MS,
  CLOUD_PROVIDERS
} = require('../../config/llm');
const ollama = require('./ollama');
const openaiCompat = require('./openaiCompat');
const modelDir = require('./modelDir');
const { LlmError } = ollama;

// ---------------------------------------------------------------------------
// 模型 id
// 形如 ollama:qwen3:14b、deepseek:deepseek-chat。
// 只按第一个冒号切，因为 Ollama 的模型名自身带标签（qwen3:14b）。
// ---------------------------------------------------------------------------

function parseModelId(modelId) {
  const raw = String(modelId || '').trim();
  const index = raw.indexOf(':');
  if (index <= 0) return null;
  const provider = raw.slice(0, index);
  const model = raw.slice(index + 1);
  if (!model) return null;
  return { provider, model, id: raw };
}

// ---------------------------------------------------------------------------
// 并发闸门
// 3090 24G 显存同时塞两个 14B 会直接 OOM，所以默认串行；
// 排队人数超过上限就直接拒绝，而不是让请求无限期挂着。
// ---------------------------------------------------------------------------

const gate = {
  limit: LLM_MAX_CONCURRENCY,
  active: 0,
  queue: []
};

function acquireSlot(signal) {
  if (gate.active < gate.limit) {
    gate.active += 1;
    return Promise.resolve(releaseSlot);
  }
  if (gate.queue.length >= LLM_QUEUE_LIMIT) {
    return Promise.reject(new LlmError('当前排队提问的人数较多，请稍后再试。', { status: 429 }));
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    gate.queue.push(waiter);
    if (signal) {
      const onAbort = () => {
        const index = gate.queue.indexOf(waiter);
        // 还在队列里才需要摘掉；已经被放行的话由持有者自己 release
        if (index >= 0) {
          gate.queue.splice(index, 1);
          reject(new Error('aborted'));
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function releaseSlot() {
  const next = gate.queue.shift();
  // 名额直接转交给队首，active 不变；没人排队才真正释放
  if (next) next.resolve(releaseSlot);
  else gate.active = Math.max(0, gate.active - 1);
}

function gateStatus() {
  return { active: gate.active, queued: gate.queue.length, limit: gate.limit };
}

// ---------------------------------------------------------------------------
// 能力缓存：/api/show 的结果在模型生命周期内不变，没必要每次提问都查
// ---------------------------------------------------------------------------

const capabilityCache = new Map();
const CAPABILITY_TTL_MS = 10 * 60 * 1000;

async function getCapabilities(modelId) {
  const parsed = parseModelId(modelId);
  if (!parsed || parsed.provider !== 'ollama') {
    // 云端 OpenAI 兼容端点一律认为支持工具调用
    return { capabilities: ['completion', 'tools'], contextLength: null, parameterSize: '' };
  }

  const cached = capabilityCache.get(modelId);
  if (cached && Date.now() - cached.at < CAPABILITY_TTL_MS) return cached.value;

  const value = await ollama.show(parsed.model);
  capabilityCache.set(modelId, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------------------
// 模型清单
// 三个来源合并：Ollama /api/tags 实时扫描 + 环境变量 LOCAL_LLM_MODELS 声明 + 配了 key 的云端。
// 声明了但没下载的本地模型标记 available=false 但依然列出，让用户知道该拉什么。
// ---------------------------------------------------------------------------

async function listModels() {
  const [tags, running, disk] = await Promise.all([
    ollama.listTags(),
    ollama.listRunning(),
    modelDir.scan(OLLAMA_MODELS_DIR)
  ]);
  const runningByName = new Map(running.map((item) => [item.name, item]));
  const diskByName = new Map(disk.models.map((item) => [item.name, item]));

  const items = [];
  const seen = new Set();

  for (const tag of tags) {
    seen.add(tag.name);
    const live = runningByName.get(tag.name);
    const onDisk = diskByName.get(tag.name);
    items.push({
      id: `ollama:${tag.name}`,
      provider: 'ollama',
      providerLabel: '本机 Ollama',
      model: tag.name,
      label: tag.name,
      available: true,
      loaded: Boolean(live),
      // /api/tags 与目录扫描应当一致；万一服务上报的体积是 0，用磁盘上的兜底
      sizeBytes: tag.sizeBytes || onDisk?.sizeBytes || 0,
      sizeVramBytes: live?.sizeVramBytes || 0,
      parameterSize: tag.parameterSize || onDisk?.parameterSize || '',
      quantization: tag.quantization || onDisk?.quantization || '',
      family: tag.family || onDisk?.family || '',
      contextLength: live?.contextLength || null,
      expiresAt: live?.expiresAt || null
    });
  }

  // 目录里有、但 /api/tags 没报的模型。两种情况：
  //   a) Ollama 服务没起来 —— 这时它是本机确实有的模型，照样可选；
  //   b) 清单在但数据块被手工删了 —— 选了也加载不了，靠 resolveModel 兜底报错。
  for (const onDisk of disk.models) {
    if (seen.has(onDisk.name)) continue;
    seen.add(onDisk.name);
    const live = runningByName.get(onDisk.name);
    items.push({
      id: `ollama:${onDisk.name}`,
      provider: 'ollama',
      providerLabel: '本机 Ollama',
      model: onDisk.name,
      label: onDisk.name,
      available: true,
      loaded: Boolean(live),
      sizeBytes: onDisk.sizeBytes,
      sizeVramBytes: live?.sizeVramBytes || 0,
      parameterSize: onDisk.parameterSize,
      quantization: onDisk.quantization,
      family: onDisk.family,
      contextLength: live?.contextLength || null,
      expiresAt: live?.expiresAt || null
    });
  }

  for (const name of LOCAL_LLM_MODELS) {
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({
      id: `ollama:${name}`,
      provider: 'ollama',
      providerLabel: '本机 Ollama',
      model: name,
      label: name,
      // 声明了但本机没有：前端置灰并提示先 ollama pull
      available: false,
      loaded: false,
      sizeBytes: 0,
      sizeVramBytes: 0,
      parameterSize: '',
      quantization: '',
      family: '',
      contextLength: null,
      expiresAt: null
    });
  }

  // 云端模型只在本机允许时才列。LLM_LOCAL_ONLY 默认开：这套系统面向内网/离线场景，
  // 而云端密钥常常是临时配上的，默认隐藏能避免误选到走外网的模型。
  if (!LLM_LOCAL_ONLY) {
    for (const provider of CLOUD_PROVIDERS) {
      for (const model of provider.models) {
        items.push({
          id: `${provider.key}:${model}`,
          provider: provider.key,
          providerLabel: provider.label,
          model,
          label: model,
          available: true,
          // 云端模型不占本机显存，"已加载"这个概念对它没意义
          loaded: false,
          remote: true,
          sizeBytes: 0,
          sizeVramBytes: 0,
          parameterSize: '',
          quantization: '',
          family: '',
          contextLength: null,
          expiresAt: null
        });
      }
    }
  }

  // 显存上限判定：超限的模型仍然列出来（让人知道本机有、要腾显存得先删），
  // 但标记成不可选并给出原因 —— 让它可选才是最糟的，用户选了只会拿到一个 OOM。
  const maxBytes = LLM_MAX_MODEL_SIZE_GB * 1e9;
  for (const item of items) {
    // 统一按 GB 下发：前端不再自己算字节换算，1e9 与 Ollama 上报口径一致
    item.sizeGb = item.sizeBytes ? Number((item.sizeBytes / 1e9).toFixed(2)) : 0;
    item.localOnly = LLM_LOCAL_ONLY;
    item.unavailableReason = '';
    if (item.remote) continue;

    if (item.loaded) continue; // 已经装在显存里的，体积再大也是跑起来了
    if (!item.available) {
      item.unavailableReason = `本机尚未下载，请先执行 ollama pull ${item.model}`;
      continue;
    }
    if (item.sizeBytes > maxBytes) {
      item.available = false;
      item.unavailableReason = `体积 ${item.sizeGb}GB 超出显存上限 ${LLM_MAX_MODEL_SIZE_GB}GB`;
    }
  }

  // 能力查询会打 /api/show，这里并发查一遍并靠缓存兜住，让前端能显示"支持工具调用"
  await Promise.all(
    items
      .filter((item) => item.available)
      .map(async (item) => {
        const caps = await getCapabilities(item.id);
        item.capabilities = caps.capabilities;
        item.supportsTools = caps.capabilities.includes('tools');
        item.supportsThinking = caps.capabilities.includes('thinking');
        if (!item.parameterSize && caps.parameterSize) item.parameterSize = caps.parameterSize;
      })
  );

  // 排序：已加载的排最前（选了就能用），其次本机可加载的按体积从小到大
  // （小模型先跑起来，冷启动快），最后才是超限/未下载的。
  const rank = (item) => {
    if (item.loaded) return 0;
    if (item.remote) return 1;
    if (item.available) return 1;
    return 2;
  };
  items.sort((a, b) => {
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    const sizeDiff = (a.sizeBytes || 0) - (b.sizeBytes || 0);
    if (sizeDiff !== 0) return sizeDiff;
    return String(a.id).localeCompare(String(b.id));
  });

  return items;
}

/** 挑一个默认模型：优先配置的默认值，其次第一个可用且已下载的。 */
async function pickDefaultModel() {
  const models = await listModels();
  const configured = models.find((item) => item.id === LLM_DEFAULT_MODEL && item.available);
  if (configured) return configured.id;
  const local = models.find((item) => item.provider === 'ollama' && item.available);
  if (local) return local.id;
  const any = models.find((item) => item.available);
  return any ? any.id : null;
}

async function resolveModel(modelId) {
  const parsed = parseModelId(modelId);
  if (!parsed) throw new LlmError(`模型标识不合法：${modelId}`, { status: 400 });

  if (parsed.provider === 'ollama') {
    // 白名单：只能用它自己列出来的模型，避免拿 model 参数去探测内网服务
    const models = await listModels();
    const found = models.find((item) => item.id === parsed.id);
    if (!found) throw new LlmError(`模型 ${parsed.id} 不在可用列表中`, { status: 400 });
    if (!found.available) {
      // 前端置灰只是体验，绕过前端直接打接口同样要被挡住，
      // 否则一个超限模型会让 Ollama 去加载它，把显存打爆。
      if (found.unavailableReason) {
        throw new LlmError(`模型 ${parsed.model} 不可用：${found.unavailableReason}`, { status: 409 });
      }
      // "没下载"和"Ollama 没起来"要给完全不同的排查方向，别混成一句话
      const tags = await ollama.listTags();
      if (!tags.length) {
        throw new LlmError(
          '本机 Ollama 当前不可达（可能是服务没启动）。请确认 Ollama 已运行，或改用下拉里的云端模型。',
          { status: 503 }
        );
      }
      throw new LlmError(`模型 ${parsed.model} 在本机尚未下载，请先执行 ollama pull ${parsed.model}`, {
        status: 409
      });
    }
    return { ...parsed, cloud: null };
  }

  const provider = CLOUD_PROVIDERS.find((item) => item.key === parsed.provider);
  if (!provider) throw new LlmError(`未知的模型提供方：${parsed.provider}`, { status: 400 });
  if (!provider.models.includes(parsed.model)) {
    throw new LlmError(`${provider.label} 不支持模型 ${parsed.model}`, { status: 400 });
  }
  return { ...parsed, cloud: provider };
}

// ---------------------------------------------------------------------------
// 加载 / 卸载
// ---------------------------------------------------------------------------

async function warmup(modelId) {
  const resolved = await resolveModel(modelId);
  if (resolved.cloud) {
    throw new LlmError('云端模型无需加载到本机显存', { status: 400 });
  }
  const before = await ollama.listRunning();
  await ollama.warmup(resolved.model);
  const after = await ollama.listRunning();
  const target = after.find((item) => item.name === resolved.model);
  return {
    model: resolved.id,
    loaded: Boolean(target),
    sizeVramBytes: target?.sizeVramBytes || 0,
    expiresAt: target?.expiresAt || null,
    // 顺带看看这次加载有没有把别的模型挤掉
    evicted: before.map((item) => item.name).filter((name) => !after.some((item) => item.name === name))
  };
}

async function unload(modelId) {
  const resolved = await resolveModel(modelId);
  if (resolved.cloud) throw new LlmError('云端模型不占本机显存', { status: 400 });
  await ollama.unload(resolved.model);
  return { model: resolved.id, loaded: false };
}

// ---------------------------------------------------------------------------
// 统一对话入口
// ---------------------------------------------------------------------------

/**
 * 流式对话。事件与两家适配器一致，额外多一类 status 用于把排队/加载状态告诉前端。
 * 调用方负责消费完整条流；提前 return 会触发 finally 释放并发名额。
 */
async function* chatStream(modelId, messages, { tools, signal, keepAlive = LLM_KEEP_ALIVE } = {}) {
  const resolved = await resolveModel(modelId);

  if (gate.active >= gate.limit) {
    yield { type: 'status', message: `模型正在忙，前面还有 ${gate.queue.length} 个请求排队` };
  }

  const release = await acquireSlot(signal);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), LLM_REQUEST_TIMEOUT_MS);
  const merged = mergeSignals(signal, timeoutController.signal);

  try {
    const stream = resolved.cloud
      ? openaiCompat.chat({
          provider: resolved.cloud,
          model: resolved.model,
          messages,
          tools,
          signal: merged.signal
        })
      : ollama.chat({ model: resolved.model, messages, tools, signal: merged.signal, keepAlive });

    for await (const event of stream) {
      yield event;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      // 超时和客户端主动断开都会走到这里，区分开才不至于误导用户
      if (timeoutController.signal.aborted && !signal?.aborted) {
        throw new LlmError(`模型响应超时（超过 ${Math.round(LLM_REQUEST_TIMEOUT_MS / 1000)} 秒），请重试或换用更小的模型。`, {
          status: 504
        });
      }
      throw error;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    merged.cleanup();
    release();
  }
}

/** 把外部取消信号和内部超时信号合成一个。 */
function mergeSignals(external, internal) {
  const controller = new AbortController();
  const onExternal = () => controller.abort();
  const onInternal = () => controller.abort();

  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternal, { once: true });
  }
  if (internal.aborted) controller.abort();
  else internal.addEventListener('abort', onInternal, { once: true });

  return {
    signal: controller.signal,
    cleanup() {
      if (external) external.removeEventListener('abort', onExternal);
      internal.removeEventListener('abort', onInternal);
    }
  };
}

/** 服务健康状态：给前端一行提示，也让运维一眼看出 Ollama 通不通。 */
async function health() {
  const [tags, running] = await Promise.all([ollama.listTags(), ollama.listRunning()]);
  return {
    ollamaReachable: tags.length > 0 || running.length > 0,
    localModels: tags.length,
    loadedModels: running.map((item) => ({
      name: item.name,
      sizeVramBytes: item.sizeVramBytes,
      expiresAt: item.expiresAt
    })),
    cloudProviders: CLOUD_PROVIDERS.map((provider) => ({
      key: provider.key,
      label: provider.label,
      models: provider.models
    })),
    gate: gateStatus()
  };
}

module.exports = {
  LlmError,
  parseModelId,
  listModels,
  pickDefaultModel,
  resolveModel,
  getCapabilities,
  warmup,
  unload,
  chatStream,
  gateStatus,
  health
};
