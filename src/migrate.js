const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

const { runMigrationsWithLedger } = require('./services/migrationLedger');
const { withMigrationLock } = require('./services/migrationLock');

const { BUILTIN_ROLES, expandRoleMenus } = require('./config/roles');
const { menuOrder } = require('./config/resources');

// MIGRATE_DRY_RUN=1 只列出迁移名称，不连接数据库或执行 SQL。
const DRY_RUN = process.env.MIGRATE_DRY_RUN === '1';

// 幂等迁移：每步先查 information_schema，已存在则跳过。
// 现有库已在运行且有数据，schema.sql 的 CREATE TABLE IF NOT EXISTS 不会修改已存在的表，
// 因此新增列/表必须走这里。反复执行是安全的，第二次应全部输出 [skip]。
//
// 两条贯穿全文件的规矩：
//   * 只补不覆盖。管理台能改的值（角色名称、数据范围、菜单勾选）一律 INSERT IGNORE，
//     重跑迁移不会把管理员改过的东西改回去。
//   * 改不动就报错退出，不猜。例如回填后仍有 role_id 为空时直接失败，
//     而不是把列收紧成 NOT NULL 再说。

async function columnExists(conn, db, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
    [db, table, column]
  );
  return rows.length > 0;
}

async function tableExists(conn, db, table) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = ? AND table_name = ? LIMIT 1`,
    [db, table]
  );
  return rows.length > 0;
}

async function indexExists(conn, db, table, index) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = ? AND index_name = ? LIMIT 1`,
    [db, table, index]
  );
  return rows.length > 0;
}

async function addColumn(conn, db, table, column, definition) {
  if (await columnExists(conn, db, table, column)) {
    console.log(`  [skip] ${table}.${column}`);
    return;
  }
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  console.log(`  [apply] ${table}.${column}`);
}

async function addIndex(conn, db, table, index, columns) {
  if (await indexExists(conn, db, table, index)) {
    console.log(`  [skip] index ${table}.${index}`);
    return;
  }
  await conn.query(`ALTER TABLE \`${table}\` ADD INDEX \`${index}\` (${columns})`);
  console.log(`  [apply] index ${table}.${index}`);
}

async function constraintExists(conn, db, table, constraint) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = ? AND table_name = ? AND constraint_name = ? LIMIT 1`,
    [db, table, constraint]
  );
  return rows.length > 0;
}

async function columnType(conn, db, table, column) {
  const [rows] = await conn.query(
    `SELECT column_type FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
    [db, table, column]
  );
  return rows.length ? String(rows[0].COLUMN_TYPE) : null;
}

/** 仅在列还是旧类型时才改，重复执行不会产生第二次 ALTER。 */
async function widenColumn(conn, db, table, column, expectedType, definition) {
  const current = await columnType(conn, db, table, column);
  if (current === null) {
    console.log(`  [skip] ${table}.${column}（列不存在）`);
    return;
  }
  if (current.toLowerCase() === expectedType.toLowerCase()) {
    console.log(`  [skip] ${table}.${column}（已是 ${expectedType}）`);
    return;
  }
  await conn.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
  console.log(`  [apply] ${table}.${column} ${current} -> ${expectedType}`);
}

const migrations = [
  {
    name: '001 users 扩展资料字段',
    async up(conn, db) {
      await addColumn(conn, db, 'users', 'email', 'VARCHAR(120) NULL AFTER display_name');
      await addColumn(conn, db, 'users', 'phone', 'VARCHAR(40) NULL AFTER email');
      await addColumn(conn, db, 'users', 'last_login_at', 'TIMESTAMP NULL AFTER status');
      // token_version：改密/被管理员重置后自增，使所有已签发的 JWT 立即失效
      await addColumn(conn, db, 'users', 'token_version', 'INT NOT NULL DEFAULT 0 AFTER last_login_at');
      await addColumn(
        conn,
        db,
        'users',
        'updated_at',
        'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER token_version'
      );
    }
  },
  {
    name: '002 登录日志表',
    async up(conn, db) {
      if (await tableExists(conn, db, 'login_logs')) {
        console.log('  [skip] table login_logs');
      } else {
        await conn.query(`
          CREATE TABLE login_logs (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            user_id BIGINT NULL,
            username VARCHAR(64) NOT NULL,
            role VARCHAR(20) NULL,
            success TINYINT(1) NOT NULL DEFAULT 0,
            message VARCHAR(255) NULL,
            ip VARCHAR(64) NULL,
            user_agent VARCHAR(255) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_login_logs_created (created_at),
            INDEX idx_login_logs_username (username),
            CONSTRAINT fk_login_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
          ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
        `);
        console.log('  [apply] table login_logs');
      }
      await addIndex(conn, db, 'login_logs', 'idx_login_logs_created', '`created_at`');
      await addIndex(conn, db, 'login_logs', 'idx_login_logs_username', '`username`');
    }
  },
  {
    name: '003 智能体问答记录表',
    async up(conn, db) {
      if (await tableExists(conn, db, 'agent_messages')) {
        console.log('  [skip] table agent_messages');
      } else {
        await conn.query(`
          CREATE TABLE agent_messages (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            user_id BIGINT NULL,
            username VARCHAR(64) NULL,
            role VARCHAR(20) NULL,
            model VARCHAR(120) NOT NULL,
            provider VARCHAR(40) NOT NULL,
            question TEXT NOT NULL,
            answer MEDIUMTEXT NULL,
            thinking MEDIUMTEXT NULL,
            tool_calls TEXT NULL,
            tool_rounds INT NOT NULL DEFAULT 0,
            status ENUM('success','error','aborted') NOT NULL DEFAULT 'success',
            error_message VARCHAR(255) NULL,
            latency_ms INT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_agent_messages_created (created_at),
            INDEX idx_agent_messages_user (user_id),
            CONSTRAINT fk_agent_messages_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
          ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
        `);
        console.log('  [apply] table agent_messages');
      }
      await addIndex(conn, db, 'agent_messages', 'idx_agent_messages_created', '`created_at`');
      await addIndex(conn, db, 'agent_messages', 'idx_agent_messages_user', '`user_id`');
    }
  },
  {
    name: '004 常用查询索引',
    async up(conn, db) {
      await addIndex(conn, db, 'students', 'idx_students_status', '`status`');
      await addIndex(conn, db, 'students', 'idx_students_class', '`class_id`');
      await addIndex(conn, db, 'students', 'idx_students_nationality', '`nationality_id`');
      await addIndex(conn, db, 'visas', 'idx_visas_expiry', '`expiry_date`');
      await addIndex(conn, db, 'grade_records', 'idx_grade_records_status', '`adapt_status`');
      await addIndex(conn, db, 'study_records', 'idx_study_records_warning', '`warning_level`');
    }
  },
  {
    // 角色从"写死在代码里的三档"变成"库里的一张表"。这张表一建，
    // 管理台改菜单勾选才有地方落，代码里再判断一次角色就是多余的真值来源。
    name: '005 角色与菜单权限表',
    async up(conn, db) {
      if (await tableExists(conn, db, 'roles')) {
        console.log('  [skip] table roles');
      } else {
        await conn.query(`
          CREATE TABLE roles (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            code VARCHAR(32) NOT NULL UNIQUE COMMENT '角色代码，写入令牌、接口校验与日志快照；一经启用不再改名',
            name VARCHAR(60) NOT NULL COMMENT '角色名称，管理台可改',
            scope ENUM('user','staff') NOT NULL COMMENT '归属端：user=用户端，staff=管理端',
            data_scope ENUM('self','class','all') NOT NULL DEFAULT 'self' COMMENT '可见数据范围：仅本人/本人所带班级/全部',
            description VARCHAR(255) NULL COMMENT '职责说明，显示在角色管理页',
            is_super TINYINT(1) NOT NULL DEFAULT 0 COMMENT '超级管理员：跳过菜单授权校验，防止误删授权行后无人能进管理台',
            is_builtin TINYINT(1) NOT NULL DEFAULT 0 COMMENT '内置角色：不可删除，只能改名称与菜单勾选',
            status ENUM('active','disabled') NOT NULL DEFAULT 'active' COMMENT '停用后该角色下所有账号无法登录',
            sort_order INT NOT NULL DEFAULT 0 COMMENT '管理台显示顺序',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = '角色定义'
        `);
        console.log('  [apply] table roles');
      }

      if (await tableExists(conn, db, 'role_menus')) {
        console.log('  [skip] table role_menus');
      } else {
        await conn.query(`
          CREATE TABLE role_menus (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            role_id BIGINT NOT NULL COMMENT '所属角色',
            menu_key VARCHAR(64) NOT NULL COMMENT '菜单标识，对应 src/config/resources.js 里的资源 key',
            can_view TINYINT(1) NOT NULL DEFAULT 1 COMMENT '可查看（能进这个菜单、能看到列表）',
            can_create TINYINT(1) NOT NULL DEFAULT 0 COMMENT '可新增',
            can_update TINYINT(1) NOT NULL DEFAULT 0 COMMENT '可修改',
            can_delete TINYINT(1) NOT NULL DEFAULT 0 COMMENT '可删除',
            teacher_types VARCHAR(120) NULL COMMENT '仅教师角色使用：允许的 teachers.teacher_type 白名单，NULL 表示不限',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_role_menu (role_id, menu_key),
            CONSTRAINT fk_role_menus_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
          ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = '角色菜单权限'
        `);
        console.log('  [apply] table role_menus');
      }

      // 播种内置角色。INSERT IGNORE 是有意的：名称、数据范围、排序都能在管理台改，
      // 重跑迁移不该把它们改回去。要恢复出厂值，删掉该行再跑一次。
      for (const role of BUILTIN_ROLES) {
        const [result] = await conn.execute(
          `INSERT IGNORE INTO roles
             (code, name, scope, data_scope, description, is_super, is_builtin, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            role.code,
            role.name,
            role.scope,
            role.dataScope,
            role.description,
            role.isSuper ? 1 : 0,
            role.isBuiltin ? 1 : 0,
            role.sortOrder
          ]
        );
        console.log(`  [${result.affectedRows ? 'apply' : 'skip'}] role ${role.code}`);
      }

      // 播种菜单授权。同样只补不覆盖：管理台勾掉的权限，重跑迁移不会给它勾回来。
      for (const role of BUILTIN_ROLES) {
        const [[{ id: roleId }]] = await conn.execute('SELECT id FROM roles WHERE code = ?', [role.code]);
        const granted = expandRoleMenus(role, menuOrder);
        let inserted = 0;
        for (const row of granted) {
          const [result] = await conn.execute(
            `INSERT IGNORE INTO role_menus
               (role_id, menu_key, can_view, can_create, can_update, can_delete, teacher_types)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [roleId, row.menuKey, row.canView, row.canCreate, row.canUpdate, row.canDelete, row.teacherTypes]
          );
          inserted += result.affectedRows;
        }
        console.log(`  [${inserted ? 'apply' : 'skip'}] role_menus ${role.code}：新增 ${inserted}/${granted.length} 行`);
      }
    }
  },
  {
    name: '006 users 以 role_id 取代 role',
    async up(conn, db) {
      await addColumn(
        conn,
        db,
        'users',
        'remark',
        "VARCHAR(255) NULL COMMENT '管理台备注，如停用原因' AFTER status"
      );

      // 先建可空列再回填，最后收紧。直接建 NOT NULL 会让已有 303 行插不进去。
      if (await columnExists(conn, db, 'users', 'role_id')) {
        console.log('  [skip] users.role_id');
      } else {
        await conn.query(
          "ALTER TABLE users ADD COLUMN role_id BIGINT NULL COMMENT '所属角色；角色代码经 roles.code 解析' AFTER password_hash"
        );
        console.log('  [apply] users.role_id');
      }

      // 回填与校验每次都跑，不放在"列不存在"的分支里：
      // 上一次中途失败留下的半成品库，重跑一次就能自愈。
      if (await columnExists(conn, db, 'users', 'role')) {
        // 旧值必须逐个显式映射。admin 不是角色代码，直接拿旧值当 code 会回填出 NULL。
        const ROLE_MAP = { admin: 'super_admin', teacher: 'teacher', student: 'student' };
        for (const [legacy, code] of Object.entries(ROLE_MAP)) {
          const [result] = await conn.execute(
            `UPDATE users u JOIN roles r ON r.code = ?
             SET u.role_id = r.id
             WHERE u.role = ? AND u.role_id IS NULL`,
            [code, legacy]
          );
          console.log(`  [backfill] users.role='${legacy}' -> ${code}：${result.affectedRows} 行`);
        }

        const [[{ n: orphan }]] = await conn.query(
          'SELECT COUNT(*) AS n FROM users WHERE role_id IS NULL'
        );
        if (orphan > 0) {
          const [rows] = await conn.query(
            'SELECT role, COUNT(*) AS n FROM users WHERE role_id IS NULL GROUP BY role'
          );
          const detail = rows.map((row) => `${row.role}=${row.n}`).join(', ');
          throw new Error(
            `还有 ${orphan} 个用户的 role_id 为空（${detail}），` +
              '说明 users.role 里出现了映射表之外的取值。补进 ROLE_MAP 后重跑，' +
              '本次不执行 DROP COLUMN，原列与数据都还在。'
          );
        }

        const [[nullable]] = await conn.query(
          `SELECT is_nullable FROM information_schema.columns
           WHERE table_schema = ? AND table_name = 'users' AND column_name = 'role_id'`,
          [db]
        );
        if (nullable && nullable.IS_NULLABLE === 'YES') {
          await conn.query(
            "ALTER TABLE users MODIFY COLUMN role_id BIGINT NOT NULL COMMENT '所属角色；角色代码经 roles.code 解析，账号本身不存角色字符串'"
          );
          console.log('  [apply] users.role_id 收紧为 NOT NULL');
        } else {
          console.log('  [skip] users.role_id（已是 NOT NULL）');
        }

        await conn.query('ALTER TABLE users DROP COLUMN role');
        console.log('  [apply] users.role 已删除（角色改由 role_id 唯一确定）');
      } else {
        console.log('  [skip] users.role（已删除）');
      }

      // 索引先建，外键后建：MySQL 建外键时会复用列上已有的索引，
      // 反过来则会自动补一个与约束同名的索引，最后多出一个冗余索引。
      await addIndex(conn, db, 'users', 'idx_users_role', '`role_id`');
      await addIndex(conn, db, 'users', 'idx_users_status', '`status`');
      if (await constraintExists(conn, db, 'users', 'fk_users_role')) {
        console.log('  [skip] fk users.fk_users_role');
      } else {
        await conn.query(
          'ALTER TABLE users ADD CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id)'
        );
        console.log('  [apply] fk users.fk_users_role');
      }
    }
  },
  {
    name: '007 公共表补列与索引',
    async up(conn, db) {
      // 登录日志与问答记录里的 role 是"当时的角色代码快照"，不是外键：
      // 角色改名或账号注销之后，这一列必须保持当时的样子，所以宽度留够而不是跟着 roles.code 走。
      await widenColumn(
        conn,
        db,
        'login_logs',
        'role',
        'varchar(32)',
        "VARCHAR(32) NULL COMMENT '登录当时的角色代码快照'"
      );
      await widenColumn(
        conn,
        db,
        'agent_messages',
        'role',
        'varchar(32)',
        "VARCHAR(32) NULL COMMENT '提问当时的角色代码快照，游客为 guest'"
      );
      await addIndex(
        conn,
        db,
        'login_logs',
        'idx_login_logs_success_created',
        '`success`, `created_at`'
      );

      // 一次连续对话原来在库里看不出是一串：一问一行，各不相干。
      await addColumn(
        conn,
        db,
        'agent_messages',
        'conversation_id',
        "VARCHAR(64) NULL COMMENT '一次连续对话的标识，由前端每次进入页面生成' AFTER tool_rounds"
      );
      await addColumn(
        conn,
        db,
        'agent_messages',
        'turn_index',
        "INT NOT NULL DEFAULT 0 COMMENT '该会话内的第几轮，从 1 开始' AFTER conversation_id"
      );
      await addIndex(
        conn,
        db,
        'agent_messages',
        'idx_agent_messages_conversation',
        '`conversation_id`'
      );

      // 字典表要能停用与排序，否则下架一个国家只能删行，历史数据的外键就断了。
      await addColumn(
        conn,
        db,
        'nationalities',
        'status',
        "ENUM('active','disabled') NOT NULL DEFAULT 'active' COMMENT '停用后不再出现在新增学生的下拉里，历史数据保留' AFTER timezone"
      );
      await addColumn(
        conn,
        db,
        'nationalities',
        'sort_order',
        "INT NOT NULL DEFAULT 0 COMMENT '下拉与列表显示顺序' AFTER status"
      );
      await addColumn(
        conn,
        db,
        'nationalities',
        'created_at',
        'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER sort_order'
      );
      await addColumn(
        conn,
        db,
        'nationalities',
        'updated_at',
        'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at'
      );
      // 存量行的排序按原有显示顺序（英文名）铺开一次，只在还全是 0 时执行
      const [[{ n: zeroSort }]] = await conn.query(
        'SELECT COUNT(*) AS n FROM nationalities WHERE sort_order = 0'
      );
      const [[{ n: total }]] = await conn.query('SELECT COUNT(*) AS n FROM nationalities');
      if (total > 0 && zeroSort === total) {
        await conn.query('SET @seq := 0');
        await conn.query('UPDATE nationalities SET sort_order = (@seq := @seq + 1) ORDER BY name_en');
        console.log(`  [apply] nationalities.sort_order 按英文名铺开 ${total} 行`);
      } else {
        console.log('  [skip] nationalities.sort_order（已有非默认值）');
      }
    }
  },
  {
    // 列注释也属于表结构，同样以 database/schema.sql 为唯一真值来源。
    // 本步把 schema.sql 里写的 COMMENT 同步到已有库，正文不在本文件里再抄一遍。
    // 只发 MODIFY COLUMN ... COMMENT，列类型、可空性、默认值都从 information_schema
    // 原样读回来拼；拼不出来（生成列、自增列、表达式默认值）就跳过并打印，绝不猜。
    // 表注释同理：schema.sql 的 CREATE TABLE 只在建表时生效，`CREATE TABLE IF NOT EXISTS`
    // 对已存在的表整条跳过，所以后来才补上的 COMMENT='...' 永远进不了老库，得在这里补。
    name: '008 公共表注释对齐 schema.sql',
    async up(conn, db) {
      const sqlPath = path.join(__dirname, '..', 'database', 'schema.sql');
      const wanted = parseSchemaComments(fs.readFileSync(sqlPath, 'utf8'));
      let applied = 0;
      let skipped = 0;
      let tablesApplied = 0;

      for (const [table, { comment: tableComment, columns }] of wanted) {
        if (!(await tableExists(conn, db, table))) continue;

        const [meta] = await conn.query(
          'SELECT table_comment FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
          [db, table]
        );
        const currentTableComment = meta.length ? meta[0].TABLE_COMMENT : null;
        if (tableComment && currentTableComment !== null && currentTableComment !== tableComment) {
          await conn.query(`ALTER TABLE \`${table}\` COMMENT = ?`, [tableComment]);
          tablesApplied += 1;
        }

        const [rows] = await conn.query(
          `SELECT column_name, column_type, is_nullable, column_default, extra, column_comment
           FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
          [db, table]
        );
        for (const column of rows) {
          const name = column.COLUMN_NAME;
          if (!columns.has(name)) continue;
          const comment = columns.get(name);
          if (comment === column.COLUMN_COMMENT) continue;

          const definition = rebuildColumnDefinition(column, comment);
          if (!definition) {
            console.log(`  [skip] ${table}.${name} 注释（列定义含表达式，未自动改）`);
            skipped += 1;
            continue;
          }
          await conn.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${name}\` ${definition}`);
          applied += 1;
        }
      }

      console.log(
        `  [${applied || tablesApplied ? 'apply' : 'skip'}] 注释：` +
          `更新 ${tablesApplied} 张表注释、${applied} 列注释，跳过 ${skipped} 列`
      );
    }
  },
  {
    name: '009 签证与成绩审核查询索引',
    async up(conn, db) {
      await addIndex(conn, db, 'visas', 'idx_visas_status_expiry', '`status`, `expiry_date`');
      await addIndex(conn, db, 'grade_records', 'idx_grade_records_audit_status', '`audit_status`');
    }
  }
];

/**
 * 从 schema.sql 里抠出每张表的表注释与每个列的列注释。
 * 只认"行首是列名、后面跟类型"的行，PRIMARY KEY / UNIQUE KEY / CONSTRAINT 一律跳过。
 *
 * 返回 Map<table, { comment, columns: Map<列名, 注释> }>。
 */
function parseSchemaComments(sql) {
  const tables = new Map();
  // 结尾的 ([^;]*) 用来接住 "\n) COMMENT='账号'" 里的表注释
  const tablePattern = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\)([^;]*);/g;
  let match;
  while ((match = tablePattern.exec(sql))) {
    const [, table, body, tail] = match;
    const columns = new Map();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK)\b/i.test(line)) continue;
      const nameMatch = /^`?(\w+)`?\s+[A-Za-z]/.exec(line);
      if (!nameMatch) continue;
      const commentMatch = /COMMENT\s+'((?:[^']|'')*)'/.exec(line);
      if (!commentMatch) continue;
      columns.set(nameMatch[1], commentMatch[1].replace(/''/g, "'"));
    }
    const tableComment = /COMMENT\s*=\s*'((?:[^']|'')*)'/.exec(tail);
    tables.set(table, { comment: tableComment ? tableComment[1].replace(/''/g, "'") : '', columns });
  }
  return tables;
}

/** 用 information_schema 读回来的属性重建列定义，只替换注释。拼不出来返回 null。 */
function rebuildColumnDefinition(column, comment) {
  if (/auto_increment|GENERATED/i.test(column.EXTRA)) return null;

  let definition = column.COLUMN_TYPE;
  definition += column.IS_NULLABLE === 'YES' ? ' NULL' : ' NOT NULL';

  // TEXT / BLOB / JSON 系不允许 DEFAULT 子句，连 DEFAULT NULL 也会被拒
  const isLob = /text|blob|json|geometry/i.test(column.COLUMN_TYPE);
  if (!isLob) {
    if (column.COLUMN_DEFAULT !== null && column.COLUMN_DEFAULT !== undefined) {
      definition += ` DEFAULT ${formatDefault(column.COLUMN_DEFAULT)}`;
    } else if (column.IS_NULLABLE === 'YES') {
      definition += ' DEFAULT NULL';
    }
  }

  if (/on update CURRENT_TIMESTAMP/i.test(column.EXTRA)) definition += ' ON UPDATE CURRENT_TIMESTAMP';
  definition += ` COMMENT '${String(comment).replace(/'/g, "''")}'`;
  return definition;
}

function formatDefault(value) {
  const text = String(value);
  if (/^-?\d+(\.\d+)?$/.test(text)) return text;
  if (/^CURRENT_TIMESTAMP(\(\d+\))?$/i.test(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

async function migrate() {
  const db = process.env.DB_NAME || 'international_student_platform';
  if (DRY_RUN) {
    for (const migration of migrations) console.log(`[dry-run] would run ${migration.name}`);
    return;
  }
  if (!process.env.DB_PASSWORD) {
    throw new Error('DB_PASSWORD must be set in the local environment.');
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: db,
    multipleStatements: false
  });

  try {
    const [[{ version }]] = await connection.query('SELECT VERSION() AS version');
    console.log(`Migrating ${db} (MySQL ${version})`);

    await withMigrationLock(connection, db, async () => {
      const result = await runMigrationsWithLedger(connection, db, migrations);
      console.log(`Applied ${result.applied.length}; skipped ${result.skipped.length} recorded migrations.`);
    });

    console.log('\nMigration finished.');
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error(`\nMigration failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { migrate, migrations };
