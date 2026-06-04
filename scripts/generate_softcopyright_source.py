from pathlib import Path
import html
import re
import markdown

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs" / "softcopyright"
OUT_DIR.mkdir(parents=True, exist_ok=True)

SOFT_NAME = "面向国际留学生的信息管理系统"
VERSION = "V1.0"
DOC_NAME = f"{SOFT_NAME}{VERSION}源代码"

FILES = [
    ("package.json", "项目依赖、启动命令和数据库脚本命令配置", "项目配置"),
    (".env.example", "环境变量示例配置，展示服务端口、数据库连接和令牌配置项", "项目配置"),
    ("src/server.js", "Node.js 后台服务入口，注册静态资源、接口路由和统一错误处理", "后端服务入口"),
    ("src/config/db.js", "MySQL 连接池配置，提供后端数据访问基础能力", "后端配置"),
    ("src/middleware/auth.js", "JWT 鉴权中间件，按角色限制接口访问", "认证与权限"),
    ("src/routes/auth.js", "登录接口路由，完成账号校验、密码校验和令牌签发", "认证与权限"),
    ("src/routes/students.js", "学生档案接口路由，支持本人档案和学生列表查询", "学生档案模块"),
    ("src/routes/teachers.js", "教师管理接口路由，支持教师列表和教师班级查询", "教师管理模块"),
    ("src/routes/grades.js", "成绩适配接口路由，支持成绩列表、适配、查询和审核", "成绩适配模块"),
    ("src/routes/management.js", "管理统计和风险查询接口路由", "统计与风险模块"),
    ("src/services/gradeAdapter.js", "成绩适配核心服务，实现百分制、字母制、GPA 和通过制换算", "成绩适配模块"),
    ("src/initDb.js", "数据库初始化脚本，执行建库建表 SQL", "数据初始化"),
    ("src/seedBusinessData.js", "业务关联测试数据种子脚本，生成学生、教师、班级、成绩和风险数据", "数据初始化"),
    ("database/schema.sql", "MySQL 数据库建表脚本和基础数据脚本", "数据层"),
    ("public/index.html", "H5 前台页面结构，包含登录、工作台、角色菜单和内容区域", "前端页面"),
    ("public/styles.css", "H5 与管理端页面样式，包含移动端和桌面端布局", "前端样式"),
    ("public/app.js", "前端交互逻辑，包含国际化、登录、菜单切换和接口调用", "前端逻辑"),
    ("public/favicon.svg", "系统图标资源，属于自研轻量界面资源", "前端资源"),
]


def sanitize(text: str) -> str:
    text = re.sub(r"DB_PASSWORD=.*", "DB_PASSWORD=***", text)
    text = re.sub(r"JWT_SECRET=.*", "JWT_SECRET=***", text)
    text = text.replace("Java@c1024", "***")
    text = text.replace("Admin@123", "******")
    text = text.replace("Admin@123", "******")
    text = re.sub(r"\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}", "***BCRYPT_HASH***", text)
    text = re.sub(r"local_dev_secret_for_v1", "***", text)
    text = re.sub(r"change_this_secret_before_production", "***", text)
    text = re.sub(r"138\d{8}", "138********", text)
    text = re.sub(r"139\d{8}", "139********", text)
    text = re.sub(r"[A-Za-z0-9._%+-]+@example\.(?:com|edu)", "***@example.com", text)
    text = re.sub(r"[A-Za-z0-9._%+-]+@school\.example", "***@example.com", text)
    text = re.sub(r"https://partner[0-9]+\.example\.edu/api/grades", "https://***.example/api/grades", text)
    return text


def lang_for(path: str) -> str:
    suffix = Path(path).suffix
    return {
        ".js": "javascript",
        ".json": "json",
        ".html": "html",
        ".css": "css",
        ".sql": "sql",
        ".svg": "xml",
        ".example": "dotenv",
    }.get(suffix, "")


def tree_text():
    return """.
├── database
│   └── schema.sql
├── public
│   ├── app.js
│   ├── favicon.svg
│   ├── index.html
│   └── styles.css
├── src
│   ├── config
│   │   └── db.js
│   ├── middleware
│   │   └── auth.js
│   ├── routes
│   │   ├── auth.js
│   │   ├── grades.js
│   │   ├── management.js
│   │   ├── students.js
│   │   └── teachers.js
│   ├── services
│   │   └── gradeAdapter.js
│   ├── initDb.js
│   ├── seedBusinessData.js
│   └── server.js
├── package.json
└── .env.example"""


def code_block(path: str, content: str) -> str:
    numbered = []
    for idx, line in enumerate(content.splitlines(), start=1):
        numbered.append(f"{idx:04d}  {line}")
    return f"```{lang_for(path)}\n" + "\n".join(numbered) + "\n```"


md = f"""# {DOC_NAME}

## 1 源代码属性结构说明

### 1.1 项目技术栈

本软件采用 H5、Node.js、Express 和 MySQL 技术栈实现。前端由 HTML、CSS 和 JavaScript 组成，提供学生端双语 H5 页面以及教师端、管理端的横向管理界面。后端由 Node.js 和 Express 提供 REST API，包含登录认证、学生档案、教师管理、成绩适配、统计分析和风险查询等接口。数据库使用 MySQL，保存用户、学生、教师、班级、国籍、住宿、签证、学习记录、外部学校、成绩规则和成绩记录等业务数据。

### 1.2 源码根目录

源码根目录为当前项目目录。源码稿只选入与本系统运行直接相关的自研业务源码、完整后台代码、前端页面源码、数据库脚本、业务种子脚本和必要配置文件，不选入第三方依赖、锁文件、截图、PDF、缓存文件、说明书、Markdown 文档正文或软著材料生成脚本。

### 1.3 一级目录划分

- `src`：Node.js 后端源码，包含服务入口、路由、中间件、数据库连接和成绩适配服务。
- `public`：H5 前台和管理端静态资源，包含页面结构、样式和交互逻辑。
- `database`：MySQL 建库建表和基础数据脚本。
- `scripts`：软著材料生成脚本，不属于系统运行源码，本源码稿不纳入。
- `docs`：软著材料输出目录，不纳入源码正文。

### 1.4 二级与三级目录划分

```text
{tree_text()}
```

### 1.5 主要模块归属关系

| 模块 | 文件范围 | 说明 |
| --- | --- | --- |
| 用户认证 | `src/routes/auth.js`、`src/middleware/auth.js` | 登录、令牌签发、角色鉴权 |
| 学生档案 | `src/routes/students.js`、`public/app.js` | 本人档案、学生列表和学生端展示 |
| 教师管理 | `src/routes/teachers.js`、`public/app.js` | 教师列表、教师班级和教师端入口 |
| 成绩适配 | `src/routes/grades.js`、`src/services/gradeAdapter.js` | 多学校、多国家成绩换算、审核和异常记录 |
| 风险查询 | `src/routes/management.js` | 签证、成绩、学习、住宿风险聚合 |
| 数据层 | `src/config/db.js`、`database/schema.sql`、`src/initDb.js`、`src/seedBusinessData.js` | MySQL 连接、表结构、初始化和业务关联数据 |
| 前端界面 | `public/index.html`、`public/styles.css`、`public/app.js` | H5 双语界面和管理端页面 |

### 1.6 选入源码稿范围说明

本源码稿按真实文件逐一输出，所有选入文件均来自当前软件工程并与系统运行直接相关。后台代码已完整纳入，包括服务入口、数据库连接、认证中间件、认证路由、学生路由、教师路由、成绩路由、统计与风险路由、成绩适配服务、数据库初始化脚本和业务数据种子脚本。配置文件和初始化脚本中涉及数据库密码、令牌密钥、演示密码、哈希、手机号、邮箱和外部地址的内容已脱敏，脱敏不改变文件结构和业务逻辑表达。

## 2 源码正文
"""

for path, purpose, module in FILES:
    file_path = ROOT / path
    content = sanitize(file_path.read_text(encoding="utf-8"))
    md += f"""
### 2.{FILES.index((path, purpose, module)) + 1} 文件：`{path}`

文件职责：{purpose}。

所属模块：{module}。

{code_block(path, content)}
"""

md_path = OUT_DIR / f"{DOC_NAME}.md"
md_path.write_text(md, encoding="utf-8")

html_body = markdown.markdown(md, extensions=["tables", "fenced_code"])
css = """
@page { size: A4; margin: 13mm 11mm 13mm 11mm; @top-center { content: '面向国际留学生的信息管理系统 V1.0'; } @bottom-center { content: counter(page); } }
body { font-family: 'Noto Sans CJK SC', 'Microsoft YaHei', Arial, sans-serif; color: #111827; line-height: 1.48; font-size: 11.2px; }
h1 { text-align: center; font-size: 20px; margin: 0 0 12px; }
h2 { font-size: 15px; margin: 14px 0 8px; border-bottom: 1px solid #888; padding-bottom: 3px; }
h3 { font-size: 12px; margin: 10px 0 6px; }
p { margin: 4px 0; }
table { width: 100%; border-collapse: collapse; margin: 7px 0 10px; }
th, td { border-top: 1px solid #333; border-bottom: 1px solid #aaa; padding: 4px 6px; text-align: left; vertical-align: top; }
pre { white-space: pre-wrap; word-break: break-all; margin: 6px 0 10px; padding: 7px 8px; background: #fff; border: 1px solid #cfd4dc; break-inside: auto; }
code { font-family: 'DejaVu Sans Mono', 'Consolas', monospace; font-size: 10.4px; line-height: 1.38; }
pre code { display: block; }
"""
html_doc = f"<!doctype html><html><head><meta charset='utf-8'><title>{DOC_NAME}</title><style>{css}</style></head><body>{html_body}</body></html>"
html_path = OUT_DIR / f"{DOC_NAME}.html"
html_path.write_text(html_doc, encoding="utf-8")

print(md_path)
print(html_path)
