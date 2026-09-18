// 匿名访客标识。
//
// 为什么不能只用 req.ip：本项目经 FRP 暴露公网，而 frpc.toml 里这个端口是 **tcp 类型**
// 的转发（localIP = 127.0.0.1），TCP 隧道不会注入 X-Forwarded-For，服务端看到的来源
// 永远是 127.0.0.1。结果是所有公网访客共用一个限流桶——既挡不住真正的滥用者，
// 又让任何人用 20 次失败登录就能把全世界的登录一起锁死 15 分钟。
//
// 所以给每个浏览器发一个随机 visitor id，限流按它计数：
//  - 它只是一个**计数键**，不承担任何身份认证职责，伪造它最多只能绕开限流；
//  - 真正的边界仍然在业务侧（角色鉴权、学生数据作用域、提问长度上限）。
//
// 如果哪天这个端口改成 frp 的 http 类型（或前面挂了 nginx / 网关），
// 就可以改为 app.set('trust proxy', 'loopback') 并直接用 req.ip，
// 注意那时也**必须**只信任环回来源，否则任何客户端都能伪造 X-Forwarded-For 绕过限流。

const crypto = require('crypto');

const COOKIE_NAME = 'vid';
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
// 只接受自己发出去的格式，避免客户端塞一个畸形值把桶撑爆
const VALID = /^[a-f0-9]{32}$/;

function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

function visitorId() {
  return (req, res, next) => {
    let id = readCookie(req.headers.cookie, COOKIE_NAME);
    // 请求里真的带了合法 Cookie 才算"回头访客"。没带的一律按 IP 兜底：
    // 否则每次请求都会被当成新访客、各拿一个新桶，限流等于形同虚设。
    req.visitorCookie = id && VALID.test(id) ? id : null;
    if (!id || !VALID.test(id)) {
      id = crypto.randomBytes(16).toString('hex');
      // 不带 Secure：当前经 TCP 隧道对外是 http，加了浏览器就不会回传。
      // HttpOnly + SameSite 足够，它本来也不是凭证。
      res.append(
        'Set-Cookie',
        `${COOKIE_NAME}=${id}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`
      );
    }
    req.visitorId = id;
    next();
  };
}

module.exports = { visitorId, COOKIE_NAME };
