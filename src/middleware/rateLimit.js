// 零依赖的内存滑动窗口限流。
// 服务经 FRP 暴露在公网，LLM 接口又是"一句话烧一次 GPU"，必须有频次闸门。
// 单进程内存实现，重启即清零——对本项目单实例部署足够；
// 若将来多实例部署，需要换成 Redis 之类的共享存储。

const buckets = new Map();

/** 匿名维度：带 Cookie 的按访客分桶，不带的退到 IP 兜底桶（见 visitor.js）。 */
function anonymousKey(req) {
  return req.visitorCookie ? `v:${req.visitorCookie}` : `ip:${req.ip}`;
}

/**
 * 计数键。匿名接口优先按 visitor id 计数——经 TCP 隧道时 req.ip 对所有公网访客
 * 都是 127.0.0.1，按它计数等于全世界共用一个桶（见 visitor.js）。
 */
function identityKey(req, keyBy) {
  if (keyBy === 'username') {
    const username = String(req.body?.username || '').trim().toLowerCase();
    // 没带用户名就退化成匿名维度，避免所有空用户名请求挤进同一个桶
    return username ? `n:${username}` : anonymousKey(req);
  }
  if (keyBy === 'ip') return `ip:${req.ip}`;
  if (keyBy === 'user') return req.user?.id ? `u:${req.user.id}` : anonymousKey(req);
  return anonymousKey(req);
}

/**
 * @param {string} name        限流桶名，用于区分不同接口
 * @param {object} options
 * @param {number} options.windowMs 窗口长度（毫秒）
 * @param {number} options.max      窗口内允许的最大次数
 * @param {'user'|'ip'|'visitor'|'username'} options.keyBy 计数维度，默认 visitor
 * @param {boolean} options.skipSuccessful 为 true 时只有响应 >= 400 才计数（用于登录失败计数）
 */
function rateLimit(name, { windowMs, max, keyBy = 'visitor', skipSuccessful = false }) {
  return (req, res, next) => {
    const key = `${name}:${identityKey(req, keyBy)}`;
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((time) => now - time < windowMs);

    if (hits.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - hits[0])) / 1000);
      res.set('Retry-After', String(retryAfter));
      const error = new Error('请求过于频繁，请稍后再试');
      error.status = 429;
      return next(error);
    }

    if (skipSuccessful) {
      // 登录接口：先放行，等响应结束再决定是否计数（只统计失败，避免正常登录被自己限流）
      res.on('finish', () => {
        if (res.statusCode >= 400) {
          const list = buckets.get(key) || [];
          list.push(Date.now());
          buckets.set(key, list);
        }
      });
      return next();
    }

    hits.push(now);
    buckets.set(key, hits);
    next();
  };
}

// 定期清理过期桶，避免 Map 无界增长
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, times] of buckets) {
    const kept = times.filter((time) => now - time < 3600000);
    if (kept.length) buckets.set(key, kept);
    else buckets.delete(key);
  }
}, 300000);
cleanup.unref();

module.exports = { rateLimit };
