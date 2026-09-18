require('dotenv').config();

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

// ---------------------------------------------------------------------------
// 本机 Ollama
// ---------------------------------------------------------------------------

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');

// Ollama 自身没有任何鉴权，任何能连上它的人都能删模型、拉新模型、把显存钉死。
// 所以这里只警告不阻断（有人确实会在内网另起一台推理机），但要把风险说清楚。
try {
  const host = new URL(OLLAMA_BASE_URL).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host)) {
    console.warn(
      `[llm] OLLAMA_BASE_URL 指向非本机地址 ${host}。Ollama 没有鉴权，请确认该地址只在可信网络内可达。`
    );
  }
} catch {
  throw new Error(`OLLAMA_BASE_URL 不是合法 URL: ${OLLAMA_BASE_URL}`);
}

// 环境变量里声明的本地模型，会和 /api/tags 实时扫到的合并。
// 声明了但没下载的模型不隐藏，标记成 unavailable，方便看出该拉哪个。
const LOCAL_LLM_MODELS = parseList(process.env.LOCAL_LLM_MODELS);

const LLM_DEFAULT_MODEL = process.env.LLM_DEFAULT_MODEL || (LOCAL_LLM_MODELS[0] ? `ollama:${LOCAL_LLM_MODELS[0]}` : '');

// 显存保活时长。太长会一直占着卡，太短就每次冷启动（实测冷启 55s / 热 5s）。
const LLM_KEEP_ALIVE = process.env.LLM_KEEP_ALIVE || '30m';

// Ollama 模型仓库目录。用于在 Ollama 服务不可达时也能列出本机已下载的模型
// —— "这个模型在不在本机"是磁盘上的事实，不该依赖服务进程活着。
const OLLAMA_MODELS_DIR = process.env.OLLAMA_MODELS_DIR || '/usr/share/ollama/.ollama/models';

// 单卡显存上限。超过这个体积的模型在下拉里仍然列出来（让人知道本机有），
// 但标记为不可选并写明原因：选了也加载不进去，只会 OOM。
const LLM_MAX_MODEL_SIZE_GB = parsePositiveInt(process.env.LLM_MAX_MODEL_SIZE_GB, 24);

// 只列本地模型。默认开：这套系统面向内网/离线场景，云端密钥往往是临时配的。
// 需要云端兜底时把它设成 false，配了 key 的云端模型就会回到下拉里。
const LLM_LOCAL_ONLY = parseBool(process.env.LLM_LOCAL_ONLY, true);

// 3090 24G 显存紧张，默认串行推理。
const LLM_MAX_CONCURRENCY = parsePositiveInt(process.env.LLM_MAX_CONCURRENCY, 1);

// 排队等待上限。超过就直接告诉用户前面有人，而不是无限期挂着。
const LLM_QUEUE_LIMIT = parsePositiveInt(process.env.LLM_QUEUE_LIMIT, 8);

const LLM_REQUEST_TIMEOUT_MS = parsePositiveInt(process.env.LLM_REQUEST_TIMEOUT_MS, 180000);

// 工具返回给模型的文本上限，防止一次查太多把上下文撑爆。
const LLM_TOOL_RESULT_MAX_CHARS = parsePositiveInt(process.env.LLM_TOOL_RESULT_MAX_CHARS, 6000);

// ---------------------------------------------------------------------------
// 云端兜底（OpenAI 兼容）。只有配了 key 的才会出现在下拉里。
// 密钥通常只写在 ~/.zshrc，进程环境变量优先于 .env，两者取其一即可。
// ---------------------------------------------------------------------------

const CLOUD_PROVIDERS = [
  {
    key: 'deepseek',
    label: 'DeepSeek 云端',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    models: parseList(process.env.DEEPSEEK_MODELS).length
      ? parseList(process.env.DEEPSEEK_MODELS)
      : ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    key: 'bailian',
    label: '阿里百炼',
    apiKey: process.env.BAILIAN_API_KEY || '',
    baseUrl: (process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    models: parseList(process.env.BAILIAN_MODELS).length ? parseList(process.env.BAILIAN_MODELS) : ['qwen-plus', 'qwen-turbo']
  }
].filter((provider) => provider.apiKey);

// ---------------------------------------------------------------------------
// 智能体行为
// ---------------------------------------------------------------------------

const AGENT_MAX_TOOL_ROUNDS = parsePositiveInt(process.env.AGENT_MAX_TOOL_ROUNDS, 4);

// qwen3 的思考过程在独立字段里，透传给前端做成可折叠区域，否则用户会对着空白干等。
const AGENT_THINKING = parseBool(process.env.AGENT_THINKING, true);

// 游客只能知识问答，不挂任何查库工具。
const AGENT_GUEST_ENABLED = parseBool(process.env.AGENT_GUEST_ENABLED, true);

// 单次提问长度上限（字符）。
const AGENT_MAX_QUESTION_CHARS = parsePositiveInt(process.env.AGENT_MAX_QUESTION_CHARS, 2000);

// 携带的历史轮数上限，只保留最近若干条，避免上下文无限增长。
const AGENT_MAX_HISTORY_MESSAGES = parsePositiveInt(process.env.AGENT_MAX_HISTORY_MESSAGES, 12);

module.exports = {
  OLLAMA_BASE_URL,
  OLLAMA_MODELS_DIR,
  LOCAL_LLM_MODELS,
  LLM_DEFAULT_MODEL,
  LLM_KEEP_ALIVE,
  LLM_MAX_MODEL_SIZE_GB,
  LLM_LOCAL_ONLY,
  LLM_MAX_CONCURRENCY,
  LLM_QUEUE_LIMIT,
  LLM_REQUEST_TIMEOUT_MS,
  LLM_TOOL_RESULT_MAX_CHARS,
  CLOUD_PROVIDERS,
  AGENT_MAX_TOOL_ROUNDS,
  AGENT_THINKING,
  AGENT_GUEST_ENABLED,
  AGENT_MAX_QUESTION_CHARS,
  AGENT_MAX_HISTORY_MESSAGES
};
