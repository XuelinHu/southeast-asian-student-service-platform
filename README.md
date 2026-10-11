# 面向国际留学生的信息管理系统 V1.0

<p align="center">
  <img height="20" alt="Express 4.19.2" src="https://img.shields.io/badge/express-4.19.2-000000" />
  <img height="20" alt="MySQL configured" src="https://img.shields.io/badge/mysql-configured-4479A1" />
  <img height="20" alt="Helmet 7.1.0" src="https://img.shields.io/badge/helmet-7.1.0-000000" />
  <img height="20" alt="JWT 9.0.2" src="https://img.shields.io/badge/jsonwebtoken-9.0.2-D63AFF" />
  <img height="20" alt="Ollama local LLM" src="https://img.shields.io/badge/ollama-local%20LLM-000000" />
  <img height="20" alt="License GPL-2.0" src="https://img.shields.io/badge/license-GPL--2.0-3DA639" />
</p>

前台使用 H5，后台使用 Node.js + Express，数据库使用 MySQL。前端是无构建步骤的原生 ES Module，
后端统一调用本机 Ollama 上的国内开源模型提供业务智能体。

## 功能范围

**用户全流程**

- 注册（可选同时建立学生档案）、登录、退出、修改密码、维护个人资料
- 登录写入审计日志，改密会使其他设备上的登录立即失效

**管理台**（`/admin.html`）

- 覆盖全部业务表的菜单式后台，14 个菜单分 6 组：系统管理（用户、角色、登录日志）、
  学籍管理（学生、教师、班级）、基础数据（国籍）、生活服务（住宿、签证）、
  学业管理（学习情况、成绩记录、成绩规则、对接学校）、智能体（问答记录）
- 每个菜单能打开与否由 `role_menus` 授权表决定，超级管理员可在「角色管理」里逐项勾选
- **每个菜单都是服务端分页查询**，支持关键词搜索、枚举筛选、多列排序、每页条数切换
- 菜单、表格列、编辑表单与筛选条件全部由 `src/config/resources.js` 的声明式注册表驱动，
  新增一张业务表只需加一条注册项
- 管理员可重置密码、启用/停用账号

**业务数据**

- 学生档案、国籍、班级、住宿、签证、学习情况基础数据模型
- 教师管理、教师班级管理、教师成绩管理入口
- 多国家、多学校成绩对接与成绩适配
- 成绩原始值、适配值、GPA、学分、规则版本、审核状态和异常原因留痕
- 管理端统计分析接口与风险聚合查询

**业务智能体**（门户页与管理台右下角悬浮按钮）

- 弹框问答，SSE 流式输出，思考过程、工具调用过程全程可见
- 模型下拉可切换：本机 Ollama 已下载模型 + 云端兜底模型，标注参数规模、量化方式与显存占用
- 「加载模型」按钮可把模型预先加载进显存（实测冷启动首次调用约 55s，热模型约 5s）
- 语音播报与语音对话：直接用浏览器 Web Speech API，无需安装客户端（需 https 或 localhost 访问）
- 未登录游客可用业务知识问答（不挂任何查库工具），登录后自动升级为可查真实数据
- 模型下拉只列本机已下载的模型，超过显存上限的置灰并写明原因，绕过前端直接打接口同样被拒

## 角色与权限

角色是库里的数据（`roles` 表），菜单授权也是（`role_menus` 表），改权限不用改代码：

| 角色代码 | 名称 | 端 | 数据范围 | 管理台菜单 |
|---|---|---|---|---|
| `super_admin` | 超级管理员 | 管理端 | 全部 | 全部 14 个（跳过授权校验） |
| `academic_admin` | 教务管理员 | 管理端 | 全部 | 学生、教师、班级、国籍、学习情况、成绩记录、成绩规则、对接学校 |
| `welfare_admin` | 学工后勤管理员 | 管理端 | 全部 | 住宿、签证（可写）、学生名册（只读） |
| `auditor` | 审计员 | 管理端 | 全部 | 登录日志、问答记录（**只读**） |
| `teacher` | 教师 | 用户端 | 本人所带班级 | 学生名册（只读）、班级、学习情况、成绩记录 |
| `student` | 留学生 | 用户端 | 本人 | 无 |

- `users.role_id` 外键指向 `roles`，删掉了原来写死的 `role ENUM('student','teacher','admin')`
- 菜单挂在哪张授权行上由 `role_menus` 决定，超级管理员可在管理台「角色管理」菜单里逐项勾选
- 管理台的侧边栏、路由校验、智能体的工具清单**三者同源**，都读这份授权：菜单看不到，
  `/api/admin/:resource` 也会 403，智能体那边对应的查库工具同样不会挂给模型
- `src/config/roles.js` 只负责首次播种，运行时的判据一律取自 `role_menus`

## 分页

所有列表接口统一返回 `{ items, page, pageSize, total, totalPages }`，管理台的 14 个菜单、
门户的学生名册 / 教师名册 / 成绩 / 班级 / 风险清单、以及 `/api/agent/history` 共用
`src/services/pagination.js` 一份实现。`pageSize` 被钳在 1..100，非法的 `sortBy`
按白名单静默回落，越界页返回空数组而不是报错。

管理台 `/api/admin/:resource/options` 与 `/api/management/nationalities` 也使用相同分页信封。
编辑表单会按页读取下拉选项，避免单个请求返回不受控的全量结果。

## 页面

| 地址 | 说明 |
|---|---|
| `/` | 门户：登录 / 注册 / 个人中心 / 学生成绩查询 |
| `/admin.html` | 管理台：侧边菜单 + 分页表格 + 编辑抽屉 |
| `/api/health` | 健康检查 |

## 数据库配置

数据库连接只从本机 `.env` 读取，字段模板见 `.env.example`。不要把账号、密码或连接串写入 README、提交到 Git 或放进客户端包；曾在文档中出现的数据库凭据应在数据库端轮换。

## 环境变量

复制 `.env.example` 为 `.env` 后按需修改。除数据库与 JWT 外，智能体相关配置都在同一份文件里：

| 变量 | 说明 |
|---|---|
| `OLLAMA_BASE_URL` | 本机 Ollama 地址，默认 `http://127.0.0.1:11434` |
| `LOCAL_LLM_MODELS` | 环境变量声明的本地模型，逗号分隔，与实时扫描结果合并后进下拉 |
| `LLM_DEFAULT_MODEL` | 默认选中的模型，格式 `<provider>:<model>`。测试/联调用最小的本地模型，演示时改成大的即可，不用改代码 |
| `OLLAMA_MODELS_DIR` | Ollama 模型仓库目录，用于扫描本机已下载的模型；即使 Ollama 服务没起来，下拉里也能列出磁盘上真实存在的模型。读不到只降级，不影响启动 |
| `LLM_MAX_MODEL_SIZE_GB` | 单卡显存上限，默认 `24`。超过这个体积的模型在下拉里置灰并写明原因，服务端也会拒绝加载 |
| `LLM_LOCAL_ONLY` | 只列本地模型，默认 `true`。设为 `false` 时配了 key 的云端模型才会重新出现在下拉里 |
| `LLM_KEEP_ALIVE` | 模型显存保活时长，默认 `30m` |
| `LLM_MAX_CONCURRENCY` | 同时进行的推理请求上限，默认 `1`（显存紧张时保持串行） |
| `LLM_REQUEST_TIMEOUT_MS` | 单次推理超时，默认 180000 |
| `DEEPSEEK_API_KEY` / `BAILIAN_API_KEY` | 云端兜底模型密钥，留空则该模型不进下拉（不报错） |
| `AGENT_GUEST_ENABLED` | 是否允许游客使用知识问答 |
| `AGENT_THINKING` | 是否把模型思考过程透传给前端 |

密钥也可以只配在 shell 的 `~/.zshrc` 里，进程环境变量优先于 `.env`。

## 启动步骤

1. 安装依赖：

```bash
npm install
```

2. 创建本地环境配置：

```bash
cp .env.example .env
```

3. 初始化数据库（建表 + 幂等迁移）：

```bash
npm run db:init
```

已有数据库升级时只跑迁移即可，它会查 `information_schema` 判断列/表是否存在，
不存在才 `ALTER` / `CREATE`。迁移版本、SHA-256 校验和与应用时间记录在
`schema_migrations`；已记录版本被改写会停止，后续结构变化必须新增迁移。迁移执行由 MySQL
advisory lock 串行化；失败迁移不会写入台账，重试依赖各迁移的幂等检查。
迁移 009 为签证状态/到期日组合列表和成绩审核状态筛选补充索引。

只查看待执行迁移名称、不连接数据库：

```bash
MIGRATE_DRY_RUN=1 npm run db:migrate
```

正常应用：

```bash
npm run db:migrate
```

4. 仅在隔离的开发/测试数据库中显式写入演示数据。生产环境禁止运行该命令；
`db:init` 不会创建演示用户或重置任何口令。演示数据只能写入名称以 `_dev`、`_test`
或 `_demo` 结尾的隔离数据库。需先在本地 `.env` 将 `DB_NAME` 改为隔离库名；
`db:init` 会按此名称创建数据库。`DB_NAME` 与 `DEMO_SEED_DATABASE`
必须完全相同，并设置 `ALLOW_DEMO_SEED=1` 和随机 `DEMO_SEED_PASSWORD`
（至少 16 位，包含大小写字母、数字和符号），再运行：

```bash
npm run db:seed
```

重复运行会更新演示业务数据，但不改变已存在用户的口令、角色、显示名或状态。

数据库集成测试仅允许显式设置 `RUN_DB_INTEGRATION=1`，并要求 `DB_NAME` 以 `_dev`、`_test`
或 `_demo` 结尾、`NODE_ENV` 非 production，以及提供 `DEMO_SEED_PASSWORD`。测试会调用真实 API
验证认证、角色权限、分页和登出。登出会递增用户的 `token_version`，因此该用户在所有设备上
已签发的 token 都会立即失效；重新登录会签发新 token。

```bash
npm test
RUN_DB_INTEGRATION=1 DB_NAME=student_dev NODE_ENV=test DEMO_SEED_PASSWORD='<强随机口令>' npm run test:db
```
只有确认是隔离测试库、且确实要重置 demo 账号密码时，才显式追加 `--reset-demo-passwords`。
这些 demo 用户名只在 seed 中创建，初始化 schema 不会预置通用口令。

5. 启动服务：

```bash
npm start
```

访问 `http://localhost:4034`。

## 演示账号

执行 opt-in 的开发/测试 seed 后会创建以下账号；初始口令由本地 `DEMO_SEED_PASSWORD` 提供，仓库不包含固定口令。

```text
admin         超级管理员
academic01    教务管理员
welfare01     学工后勤管理员
auditor01     审计员
teacher01     教师（班主任）
student01     留学生
teacher001    教师（批量种子数据）
student001    留学生（批量种子数据）
```

## 管理台

左侧菜单由 `src/config/resources.js` 生成，每个菜单都走后端统一的分页接口：

```text
GET /api/admin/:resource?page=1&pageSize=20&keyword=&sortBy=&sortOrder=desc&<筛选字段>=
```

响应统一为 `{ items, page, pageSize, total, totalPages }`。实现上有两个刻意的取舍：

- 通用分页层用 `pool.query` 而不是 `pool.execute`：MySQL 的预处理协议不接受 `LIMIT ?` 绑定参数
  （会报 `Incorrect arguments to mysqld_stmt_execute`），所以分页值走占位符、
  `LIMIT/OFFSET` 用 `Number()` 归一化后拼接，排序字段只接受注册表里的白名单列名。
- 所有 `ORDER BY` 都会追加主键作为最后的排序键，否则翻页时同值行顺序不稳定，会出现漏行重行。

## 智能体

后端统一走 `src/services/llm/`：本机 Ollama 用 `/api/chat` 的原生 tool calling，
云端 DeepSeek / 百炼走 OpenAI 兼容 SSE，两者在上层归一成同一套流式事件。

针对本项目业务的定制部分在 `src/services/agent/`：

| 文件 | 作用 |
|---|---|
| `prompt.js` | 业务 system prompt：平台定位、模块全景、成绩适配口径、按角色区分的权限边界与回答规范 |
| `knowledge.js` | 静态业务知识库（签证预警口径、住宿异常判定、成绩适配规则、系统用法等），游客可用 |
| `tools.js` | 15 个查库工具，**角色权限在服务端强制**：按角色过滤工具清单，学生角色只暴露 `get_my_profile`、`get_my_grades` 两个**参数表为空**的工具，查询范围由服务端从令牌取出的 `ctx.studentId` 决定，模型没有可填学号的位置 |
| `orchestrator.js` | tool-calling 循环：原生 tools 优先，无 tools 的模型回退到 JSON 协议提示词；最多 4 轮，最后一轮摘掉工具逼模型出结论；同工具同参数重复调用会被拦截 |

**没有经过微调也能用**：业务知识靠 system prompt + 知识库注入，实时数据靠工具查库，
模型只负责理解意图和调用工具，数字一律来自数据库。

### 语音

`public/js/voice.js` 直接用浏览器的 Web Speech API（`SpeechRecognition` + `SpeechSynthesis`），
不依赖任何客户端或原生桥。探测不到能力时置灰麦克风按钮，并把原因写在按钮提示上：

| 情况 | 表现 |
|---|---|
| 非 https 且非 localhost | 按钮置灰，提示「语音功能需要 https 或 localhost 访问」 |
| 浏览器无 Web Speech（如 Firefox） | 按钮置灰，提示改用文字提问；文字问答不受影响 |
| 麦克风权限被拒 / 无设备 / 网络失败 | 弹框内给出对应的中文提示 |

播报时会先停掉识别，播完再按需重开麦克风，避免喇叭里的声音被自己录进去；
关闭弹框时识别与播报一并停止。停止识别用 `abort()` 而不是 `stop()`，
后者会把没说完的半句话当成一次提问提交。

## 安全与限流

服务经 FRP 暴露公网，因此：

- 智能体接口全部鉴权 + 限流：登录用户按用户计数（20 次 / 10 分钟），游客按访客计数（5 次 / 10 分钟）
- 登录失败按**账号**计数（10 次 / 15 分钟）并按访客计数（30 次 / 15 分钟），只统计失败请求
- 提问长度、请求体大小、`model` 参数都有上限/白名单校验
- 工具执行的 SQL 全部硬编码并用占位符传参；学生角色的数据作用域在服务端强制——该角色只挂两个不接受参数、由服务端绑定本人 `studentId` 的工具，越权调用会被 `getTool()` 当作工具不存在，防提示词注入越权
- 全局推理并发闸门，客户端断开时中止上游请求

> **关于来源 IP**：`frpc.toml` 里本项目的转发是 `tcp` 类型，TCP 隧道不注入 `X-Forwarded-For`，
> 服务端看到的来源恒为 `127.0.0.1`。因此限流不能按 `req.ip` 计数——那样所有公网访客共用一个桶，
> 既挡不住真正的滥用者，又让任何人用 20 次失败登录把全世界的登录一起锁死。
> 现在改为给每个浏览器发一个随机 `vid` Cookie 作为计数维度（见 `src/middleware/visitor.js`），
> 不带 Cookie 的调用方落到 IP 兜底桶，不能靠「每次都是新访客」绕过。
> 若哪天把该端口改成 frp 的 `http` 类型或在前面挂了网关，可以改用
> `app.set('trust proxy', 'loopback')` 并直接按 `req.ip` 计数，**但那时也只能信任环回来源**。

## 数据库备份与恢复

使用 MySQL 一致性快照导出 InnoDB 表，数据经 gzip 和 AES-256-GCM 加密。请在本机 `.env` 设置独立 `DB_BACKUP_ENCRYPTION_KEY`（32 字节，即 64 位十六进制），并在密码管理器另存一份；密钥丢失后无法解密备份。快照包含平台标识，不能用于其他项目。默认输出在 `backups/`，不会覆盖已有文件。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"  # 将输出写入 .env
npm run db:backup
```

恢复只允许 `DB_NAME` 以 `_test` 结尾，必须明确使用 `--replace`，且目标库 schema 必须与快照完全匹配。工具会拒绝非 InnoDB 表、无主键表以及包含触发器/存储过程/事件的库，以免产生不完整快照。

```powershell
$env:DB_NAME = 'student_platform_restore_test'
npm run db:init
npm run db:restore -- --source .\backups\snapshot.seabak --replace
```

## 核心接口

**认证与个人中心**

- `POST /api/auth/register` 注册
- `POST /api/auth/login` 登录
- `POST /api/auth/logout` 退出
- `GET /api/auth/me` 当前用户资料
- `PATCH /api/auth/profile` 修改资料
- `POST /api/auth/change-password` 修改密码

**管理台**

- `GET /api/admin/resources` 菜单与列定义（驱动前端渲染）
- `GET /api/admin/stats/overview` 统计概览
- `GET /api/admin/risks` 风险聚合
- `GET /api/admin/:resource` 分页列表（搜索 / 排序 / 筛选）
- `GET|POST|PUT|DELETE /api/admin/:resource[/:id]` 通用增删改查
- `GET|PUT /api/admin/roles/:id/menus` 角色权限矩阵（读写 `role_menus`，改完立即生效）
- `POST /api/admin/users/:id/reset-password` 重置密码
- `PATCH /api/admin/users/:id/status` 启用 / 停用账号

**智能体**

- `GET /api/agent/models` 模型下拉数据源（含加载状态、参数规模、量化、显存占用）
- `POST /api/agent/chat` 问答（SSE 流式）
- `POST /api/agent/warmup` 加载模型进显存
- `POST /api/agent/unload` 卸载模型（仅管理员）
- `GET /api/agent/health` 模型与并发闸门状态
- `GET /api/agent/history` 问答记录（分页）
- `GET /api/agent/knowledge` 知识库主题列表

**业务**

- `GET /api/students/me` 学生查看本人档案
- `GET /api/students` 教师/管理员查看学生列表
- `GET /api/teachers` 管理员查看教师列表
- `POST /api/grades/adapt` 教师/管理员提交外部成绩并执行适配
- `GET /api/grades/student/:studentId` 查看学生成绩适配记录
- `PATCH /api/grades/:id/audit` 管理员审核成绩
- `GET /api/management/dashboard` 统计分析
- `GET /api/management/risks` 风险查询，聚合签证临期、成绩适配异常、低分风险、学习预警和住宿异常

## 目录结构

```text
src/
  config/       数据库、资源注册表、角色内置定义、鉴权与 LLM 配置
  middleware/   鉴权与菜单授权、限流、访客标识
  routes/       auth / admin / agent / students / teachers / grades / management
  services/
    pagination.js      通用分页信封、页大小钳制、LIKE 转义
    scope.js           数据范围收窄（全部 / 本人所带班级 / 本人）
    riskQuery.js       风险聚合 SQL，管理台与门户两个入口共用
    gradeAdapter.js    四种原始成绩类型的折算算法
    llm/               Ollama 与 OpenAI 兼容适配、并发闸门、模型清单、模型目录扫描
    agent/             业务 prompt、知识库、工具集、编排循环
public/
  index.html  admin.html        门户与管理台
  js/         core / portal / admin / agent / voice
database/    schema.sql
docs/        软著材料
```

## 开源协议

本项目使用 GNU General Public License v2.0（GPL-2.0）开源，详见 `LICENSE`。

## 启动端口

网页入口：4034；后台服务：8034。完整启动约定见 [PORTS.md](./PORTS.md)。
