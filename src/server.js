const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createWebServer } = require('./web-server');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/students');
const teacherRoutes = require('./routes/teachers');
const gradeRoutes = require('./routes/grades');
const managementRoutes = require('./routes/management');
const adminRoutes = require('./routes/admin');
const agentRoutes = require('./routes/agent');
const { visitorId } = require('./middleware/visitor');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
// cors() 默认不返回 Access-Control-Allow-Credentials，但同源页面本来就会带 Cookie；
// 限流用的 vid 只在同源请求里起作用，跨域调用方拿不到它，会落到共享兜底桶。
app.use(cors());
// 匿名访客标识：必须排在限流之前，登录/注册/游客问答都靠它做计数维度
app.use(visitorId());
app.use(express.json({ limit: '10mb' }));
app.get('/favicon.ico', (req, res) => {
  res.redirect(302, '/favicon.svg');
});
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: 'international-student-platform' });
});

app.use('/api/auth', authRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/teachers', teacherRoutes);
app.use('/api/grades', gradeRoutes);
app.use('/api/management', managementRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/agent', agentRoutes);

app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  const status = Number(error.status) || 500;
  const parserError = error.type === 'entity.parse.failed' || error.type === 'entity.too.large';
  if (status >= 500) {
    console.error(error);
  }
  // 5xx 默认不暴露内部信息，但显式标了 expose 的错误（如"连不上本机 Ollama"）
  // 正是要给人看的运维提示，藏起来反而让人无从下手
  const message =
    error.type === 'entity.parse.failed'
      ? 'JSON 格式不正确'
      : error.type === 'entity.too.large'
        ? '请求体超过允许大小'
        : status >= 500 && !error.expose
          ? 'Internal server error'
          : error.message;
  const body = {
    message,
    ...(parserError ? { code: error.type === 'entity.too.large' ? 'payload_too_large' : 'invalid_json' } : {})
  };
  const retryAfter = res.get('Retry-After');
  if (retryAfter) body.retryAfter = Number(retryAfter);
  res.status(status).json(body);
});

if (require.main === module) {
  const port = Number(process.env.PORT || 8034);
  const webPort = Number(process.env.WEB_PORT || 4034);
  const webServer = createWebServer(port);
  const apiServer = app.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`API running at http://127.0.0.1:${port}`);
  });
  for (const listener of [apiServer, webServer]) {
    listener.on('error', (error) => {
      console.error(`留学生服务启动失败：${error.code}`);
      process.exit(1);
    });
  }
  webServer.listen(webPort, process.env.HOST || '0.0.0.0', () => {
    console.log(`Web running at http://localhost:${webPort}`);
  });
}

module.exports = app;
