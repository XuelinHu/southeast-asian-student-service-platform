// Ollama 模型仓库目录扫描。
//
// 用途：Ollama 服务没起来、或者 /api/tags 挂了的时候，下拉里仍然应该能列出
// 本机已经下载了哪些模型 —— "本机有没有这个模型"是磁盘上的事实，不该依赖服务进程。
//
// 目录结构（Ollama 自己的布局）：
//   <root>/manifests/<registry>/<namespace>/<name>/<tag>   清单，JSON
//   <root>/blobs/sha256-<hex>                              实际数据块
// 清单里的 layers[].size 之和就是 Ollama 上报的模型体积；
// config 指向的 blob 里有参数量与量化方式。
//
// 目录可能不存在、可能没有读权限（ollama 用户 750 是常态），
// 所以这里一律不抛错：扫不到就返回空列表和一句能看懂的原因。

const fs = require('fs/promises');
const path = require('path');

const MANIFEST_ROOT = 'manifests';
const REGISTRY = 'registry.ollama.ai';
// 官方库模型的 namespace 固定是 library，展示时要去掉这一层（qwen3:14b 而不是 library/qwen3:14b）
const LIBRARY_NAMESPACE = 'library';

/** digest 形如 sha256:abcd...，落盘时冒号换成短横。 */
function blobPath(root, digest) {
  const [algorithm, hex] = String(digest || '').split(':');
  if (!algorithm || !hex) return null;
  return path.join(root, 'blobs', `${algorithm}-${hex}`);
}

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

/**
 * 列出 <root>/manifests/<registry>/ 下的所有「命名空间/模型名/标签」。
 * 只处理 Ollama 自己的 registry；其他 registry（比如私有镜像）暂不解析。
 */
async function listManifestFiles(root) {
  const files = [];
  const registryDir = path.join(root, MANIFEST_ROOT, REGISTRY);

  let namespaces;
  try {
    namespaces = await fs.readdir(registryDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return files;
    throw error;
  }

  for (const namespace of namespaces) {
    if (!namespace.isDirectory()) continue;
    const namespaceDir = path.join(registryDir, namespace.name);
    const models = await fs.readdir(namespaceDir, { withFileTypes: true }).catch(() => []);
    for (const model of models) {
      if (!model.isDirectory()) continue;
      const modelDir = path.join(namespaceDir, model.name);
      const tags = await fs.readdir(modelDir, { withFileTypes: true }).catch(() => []);
      for (const tag of tags) {
        if (!tag.isFile()) continue;
        // 带 namespace 的模型（用户自己 push 的）保留前缀，官方库模型去掉 library/
        const displayName =
          namespace.name === LIBRARY_NAMESPACE ? model.name : `${namespace.name}/${model.name}`;
        files.push({ name: `${displayName}:${tag.name}`, file: path.join(modelDir, tag.name) });
      }
    }
  }

  return files;
}

/** 把一份清单读成模型记录。清单坏了或字段缺失都不算致命，能拿到多少算多少。 */
async function readManifest(root, name, file) {
  const manifest = await readJson(file);
  const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
  const sizeBytes = layers.reduce((sum, layer) => sum + (Number(layer.size) || 0), 0);

  const record = {
    name,
    sizeBytes,
    parameterSize: '',
    quantization: '',
    family: ''
  };

  // 参数量与量化方式在 config 指向的那个小 blob 里，缺了不影响"有没有这个模型"的判断
  const configPath = manifest.config?.digest ? blobPath(root, manifest.config.digest) : null;
  if (configPath) {
    try {
      const config = await readJson(configPath);
      record.parameterSize = config.model_type || '';
      record.quantization = config.file_type || '';
      record.family = config.model_family || '';
    } catch {
      /* 配置块读不到就只少几个展示字段 */
    }
  }

  return record;
}

/**
 * 扫描模型目录。
 * @param {string} root 模型仓库根目录
 * @returns {Promise<{models: Array, reason: string}>} reason 非空表示没扫全，前端可提示
 */
async function scan(root) {
  if (!root) return { models: [], reason: '未配置模型目录' };

  let files;
  try {
    files = await listManifestFiles(root);
  } catch (error) {
    if (error.code === 'EACCES') {
      return { models: [], reason: `没有读取模型目录的权限：${root}` };
    }
    if (error.code === 'ENOENT') {
      return { models: [], reason: `模型目录不存在：${root}` };
    }
    return { models: [], reason: `读取模型目录失败：${error.message}` };
  }

  // 单个清单坏了不该连累整份列表：能读几个是几个
  const settled = await Promise.all(
    files.map((item) => readManifest(root, item.name, item.file).catch(() => null))
  );
  const models = settled.filter(Boolean);
  return { models, reason: models.length ? '' : `模型目录里没有任何模型：${root}` };
}

module.exports = { scan, MANIFEST_ROOT };
