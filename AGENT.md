# AGENT.md

## Project

- Project: `southeast-asian-student-service-platform`
- Stack: Node.js + Express, PostgreSQL 18, JWT, Helmet, 本机 Ollama
- Type: international student information management service
- Frontend: 无构建步骤的原生 ES Module（`public/js/`），不使用打包器

## Runtime

- Service port: `8034` from `.env.example` `PORT`.
- Local URL: `http://localhost:4034`; backend API port remains `8034`.
- Admin console: `http://localhost:4034/admin.html`.
- Dev: `npm run dev`.
- Start: `npm start`.
- Init DB (建表 + 迁移): `npm run db:init`.
- Migrate only (幂等，已有库升级用): `npm run db:migrate`.
- Seed data: opt-in only for isolated `_dev` / `_test` / `_demo` databases; requires a strong local `DEMO_SEED_PASSWORD`; production refuses it.

## Database

- Type: PostgreSQL 18.
- Database name: `international_student_platform`.
- Env file: `.env` based on `.env.example`.
- Variables: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `JWT_SECRET`, `JWT_EXPIRES_IN`.
- Active schema and seed: `database/postgres/schema.sql` and `database/postgres/seed.sql`. The historical MySQL `database/schema.sql` is retained only as a migration reference.
- Each project uses a dedicated PostgreSQL database and login role. The application role must not be a cluster administrator or have `CREATEDB`/`CREATEROLE`.
- Migration ledger: `schema_migrations` stores the baseline name and SHA-256. Applied baseline inputs are immutable; add a new PostgreSQL migration instead of editing an applied migration. Migrations use a transaction and PostgreSQL advisory lock.
- Migration 009 adds indexes for visa status/expiry ordering and grade audit-status filtering; query changes should be reviewed against indexes and verified with `EXPLAIN` on an isolated database.
- `MIGRATE_DRY_RUN=1` prints the migration plan and exits before opening a database connection; it must not execute SQL.
- Keep real passwords only in local `.env`.
- 删除测试数据要按外键顺序：`students`（被 dormitories / grade_records / study_records / visas 引用）
  → `login_logs` / `agent_messages` → `users`。

## LLM / Agent

- 环境变量见 `.env.example` 的「智能体 / 大模型」段落；密钥也可以只配在 `~/.zshrc`，进程环境变量优先。
- 模型 id 形如 `ollama:qwen3:14b`、`deepseek:deepseek-chat`。**只按第一个冒号切分**，因为 Ollama 模型名自带冒号。
- 并发：显存有限，默认 `LLM_MAX_CONCURRENCY=1`，所有推理请求过全局闸门。
- 限流维度见 `src/middleware/visitor.js`：本项目的 FRP 转发是 **tcp 类型**，不注入 `X-Forwarded-For`，
  所以不能按 `req.ip` 计数（所有公网访客都是 127.0.0.1，会共用一个桶）。
- 工具的角色权限在服务端强制，不依赖提示词：学生角色查不到他人数据。

## Codex Notes

- Maintain relationships among users, students, teachers, classes, grades, visas, dormitories, and nationalities.
- 前端改动同步改 `README.md` 的页面说明；新增业务表时在 `src/config/resources.js` 加注册项，
  管理台菜单与分页接口会自动生成，不要另写一套 CRUD 路由。
- 新增 SQL 时使用 PostgreSQL 双引号引用保留字；优先选择不需要引用的别名。
- If schema or seed logic changes, update README and this file.

## GitHub Commit Language

- Use English for all GitHub commit messages and pull/push related commit notes.

## Port allocation

Web: 4034. API/services: 8034. See `PORTS.md`; keep dev/preview ports fixed and fail on conflicts.
