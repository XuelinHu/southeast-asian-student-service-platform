require('dotenv').config();

// JWT 密钥在启动时校验，缺失或过短直接抛错退出。
// 保留 'dev_secret' 之类的兜底会让生产环境在忘记配置时静默地用一个公开密钥签发令牌。
const JWT_SECRET = process.env.JWT_SECRET || '';
const MIN_SECRET_LENGTH = 16;

if (!JWT_SECRET || JWT_SECRET.length < MIN_SECRET_LENGTH) {
  throw new Error(
    `JWT_SECRET 未配置或长度不足 ${MIN_SECRET_LENGTH} 位。请在 .env 中设置一个足够长的随机字符串。`
  );
}

module.exports = {
  JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '8h'
  // 这里原有 AUTH_CHECK_TOKEN_VERSION 开关，用于跳过每请求的 users 查询。
  // 角色与菜单权限现在也从那次查询读（见 middleware/auth.js 的 loadActiveUser），
  // 跳过它等于跳过全部授权校验，因此开关连同这个选项一并去掉。
};
