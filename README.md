# 面向国际留学生的信息管理系统 V1.0

前台使用 H5，后台使用 Node.js + Express，数据库使用 MySQL。

## 功能范围

- 学生登录与学生端中英双语界面
- 学生档案、国籍、班级、住宿、签证、学习情况基础数据模型
- 教师管理、教师班级管理、教师成绩管理入口
- 多国家、多学校成绩对接与成绩适配接口
- 成绩原始值、适配值、GPA、学分、规则版本、审核状态和异常原因留痕
- 管理端统计分析接口

## 数据库配置

默认连接配置：

```text
host: 127.0.0.1
port: 3306
user: root
password: Java@c1024
database: international_student_platform
```

## 启动步骤

1. 安装依赖：

```bash
npm install
```

2. 创建本地环境配置：

```bash
cp .env.example .env
```

3. 初始化数据库：

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p < database/schema.sql
```

也可以使用内置 Node 脚本初始化，不依赖本机 `mysql` 命令：

```bash
npm run db:init
```

4. 写入业务关联测试数据。该脚本会让每张业务表不少于 100 条记录，并保持用户、学生、教师、班级、住宿、签证、学习、外部学校、成绩规则和成绩记录之间的业务关联：

```bash
npm run db:seed
```

5. 启动服务：

```bash
npm start
```

访问地址：

```text
http://localhost:3000
```

## 演示账号

三个演示账号的初始密码均为 `Admin@123`。

```text
admin
teacher01
student01
teacher001
student001
```

## 核心接口

- `POST /api/auth/login` 登录
- `GET /api/students/me` 学生查看本人档案
- `GET /api/students` 教师/管理员查看学生列表
- `GET /api/teachers` 管理员查看教师列表
- `POST /api/grades/adapt` 教师/管理员提交外部成绩并执行适配
- `GET /api/grades/student/:studentId` 查看学生成绩适配记录
- `PATCH /api/grades/:id/audit` 管理员审核成绩
- `GET /api/management/dashboard` 统计分析
- `GET /api/management/risks` 风险查询，聚合签证临期、成绩适配异常、低分风险、学习预警和住宿异常

## 开源协议

本项目使用 GNU General Public License v2.0（GPL-2.0）开源，详见 `LICENSE`。
