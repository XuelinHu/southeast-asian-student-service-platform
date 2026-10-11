const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const { requireMenu } = require('../middleware/auth');
const {
  getResource,
  listResourcesForUser,
  menuOrder,
  ENUM_LABELS,
  ENUM_TONES
} = require('../config/resources');
const { canAccess, getGrantedMenu, teacherTypeAllowed, TEACHER_TYPES } = require('../config/roles');
const { studentScope, classScope } = require('../services/scope');
const { parseListQuery, parsePageQuery, buildPageEnvelope, runPaginatedQuery } = require('../services/pagination');
const riskQuery = require('../services/riskQuery');

const router = express.Router();

// 这里只要求"已登录"。具体能不能用某个菜单，由下面的 canAccess 按 role_menus 表逐次判断，
// 不再按角色写死在路由上：新增角色或调整勾选都不需要改这个文件。
// 学生等用户端角色进得来，但一个菜单都没有，每一步都会被 403 挡下。
router.use(auth());

// ---------------------------------------------------------------------------
// 字段校验与类型转换
// ---------------------------------------------------------------------------

function coerceField(field, raw) {
  const isEmpty = raw === undefined || raw === null || raw === '';

  if (isEmpty) {
    if (field.required) return { ok: false, message: '该字段为必填项' };
    return { ok: true, value: null };
  }

  switch (field.type) {
    case 'int': {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return { ok: false, message: '必须是整数' };
      return { ok: true, value: parsed };
    }
    case 'decimal': {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return { ok: false, message: '必须是数字' };
      if (field.min !== undefined && parsed < field.min) return { ok: false, message: `不能小于 ${field.min}` };
      if (field.max !== undefined && parsed > field.max) return { ok: false, message: `不能大于 ${field.max}` };
      return { ok: true, value: parsed };
    }
    case 'boolean':
      return { ok: true, value: raw === true || raw === 1 || raw === '1' || raw === 'true' ? 1 : 0 };
    case 'enum': {
      const value = String(raw);
      if (!field.values.includes(value)) {
        return { ok: false, message: `取值必须是：${field.values.join('、')}` };
      }
      return { ok: true, value };
    }
    case 'date': {
      const value = String(raw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, message: '日期格式应为 YYYY-MM-DD' };
      return { ok: true, value };
    }
    case 'datetime': {
      const value = String(raw);
      if (Number.isNaN(Date.parse(value))) return { ok: false, message: '时间格式不正确' };
      return { ok: true, value };
    }
    default: {
      const value = String(raw).trim();
      if (field.required && !value) return { ok: false, message: '该字段为必填项' };
      if (field.maxLength && value.length > field.maxLength) {
        return { ok: false, message: `长度不能超过 ${field.maxLength} 个字符` };
      }
      return { ok: true, value };
    }
  }
}

/**
 * 把请求体按注册表的 fields 映射成 { columns, values }。
 * 不在 fields 里的键会被直接丢弃 —— 这是防止越权写列（如 role、password_hash）的关键。
 */
function mapBodyToColumns(resource, body, { partial }) {
  const columns = [];
  const values = [];

  for (const [name, field] of Object.entries(resource.fields || {})) {
    if (partial && !Object.prototype.hasOwnProperty.call(body, name)) continue;

    // 新增时没传（或传了空值）的可选字段不进 INSERT 列表，交给列自己的默认值。
    // 早先的写法是显式写 NULL，那样在 `sort_order INT NOT NULL DEFAULT 0` 这类列上
    // 会触发 NOT NULL 约束错误；可选字段缺省时应交给数据库默认值。
    // 修改（partial）不做这个处理：那里传空值就是"清空该字段"，显式写 NULL 才是本意。
    const raw = body[name];
    if (!partial && !field.required && (raw === undefined || raw === null || raw === '')) continue;

    const result = coerceField(field, raw);
    if (!result.ok) {
      return { ok: false, message: `${name}: ${result.message}` };
    }
    columns.push(field.column);
    values.push(result.value);
  }

  if (!columns.length) return { ok: false, message: '没有需要更新的字段' };
  return { ok: true, columns, values };
}

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

router.get('/resources', (req, res) => {
  res.json({
    // 只下发该用户有权查看的菜单，且写操作按角色授权位收窄
    items: listResourcesForUser(req.user),
    user: {
      id: req.user.id,
      username: req.user.username,
      name: req.user.name,
      role: req.user.role,
      roleName: req.user.roleName,
      isSuper: req.user.isSuper
    },
    // 前端据此把 active / exception 这类枚举值渲染成中文徽章
    enumLabels: ENUM_LABELS,
    enumTones: ENUM_TONES
  });
});

// 统计概览覆盖的是学生、签证、成绩、住宿这些学籍侧数据，凡是能看到学生名册的角色才给看；
// 审计员只有日志菜单，看不到这里。
router.get('/stats/overview', requireMenu('students'), async (req, res, next) => {
  try {
    const [[students]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM((status = 'active')::int) AS active,
              SUM((status = 'suspended')::int) AS suspended,
              SUM((status = 'delayed')::int) AS delayed
       FROM students`
    );
    const [[teachers]] = await pool.query('SELECT COUNT(*) AS total FROM teachers');
    const [[classes]] = await pool.query('SELECT COUNT(*) AS total FROM classes');
    const [[nationalities]] = await pool.query('SELECT COUNT(*) AS total FROM nationalities');
    const [[users]] = await pool.query(
      `SELECT COUNT(*) AS total, SUM((status = 'active')::int) AS active FROM users`
    );
    const [[visas]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM((expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 60)::int) AS expiring,
              SUM((expiry_date < CURRENT_DATE)::int) AS expired
       FROM visas`
    );
    const [[grades]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM((adapt_status = 'exception')::int) AS exceptions,
              SUM((audit_status = 'pending')::int) AS pending_audit,
              SUM((adapted_score IS NOT NULL AND adapted_score < 60)::int) AS low_scores
       FROM grade_records`
    );
    const [[dormitories]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM((status = 'occupied')::int) AS occupied,
              SUM((status = 'maintenance')::int) AS maintenance
       FROM dormitories`
    );
    const [[study]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM((warning_level IN ('warning','serious'))::int) AS warnings,
              SUM((attendance_rate < 70)::int) AS low_attendance
       FROM study_records`
    );
    const [[agent]] = await pool.query(
      `SELECT COUNT(*) AS total, SUM((status = 'error')::int) AS errors FROM agent_messages`
    );

    res.json({
      students,
      teachers,
      classes,
      nationalities,
      users,
      visas,
      grades,
      dormitories,
      study,
      agent
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 风险预警（跨表聚合，同样支持分页与筛选）
//
// 六类风险的 SQL 定义在 services/riskQuery.js，与门户的 /api/management/risks 共用一份，
// 这里只决定响应形状（多带一个不受分页影响的 summary 给指标卡）。
// ---------------------------------------------------------------------------

router.get('/risks', requireMenu('students'), async (req, res, next) => {
  try {
    const riskType = typeof req.query.riskType === 'string' ? req.query.riskType : '';
    const keyword = String(req.query.q || '').trim().slice(0, 100);

    const [page, summary] = await Promise.all([
      riskQuery.listRisks({
        riskType,
        keyword,
        page: req.query.page,
        pageSize: req.query.pageSize
      }),
      riskQuery.countByType({ riskType })
    ]);

    res.json({ ...page, summary });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 下拉选项（供编辑表单使用）
// ---------------------------------------------------------------------------

router.get('/:resource/options', async (req, res, next) => {
  try {
    const resource = getResource(req.params.resource);
    if (!resource) return res.status(404).json({ message: '资源不存在' });
    if (!canAccess(req.user, resource.key, 'view')) {
      return res.status(403).json({ message: '没有该菜单的查看权限' });
    }

    const option = (resource.options || []).find((item) => item.name === req.query.field);
    if (!option) return res.status(404).json({ message: '该字段没有配置可选项' });

    // option.from / valueColumn / labelColumn / orderBy 全部来自注册表常量，不含请求参数。
    // labelColumn 可能是 CONCAT(...) 表达式，所以排序单列一个 orderBy 字段兜底。
    const where = option.where ? `WHERE ${option.where}` : '';
    const orderBy = option.orderBy || option.labelColumn;
    const page = parsePageQuery(req.query);
    const [[countRow]] = await pool.query(
      `SELECT COUNT(DISTINCT ${option.valueColumn}) AS total ${option.from} ${where}`
    );
    const [rows] = await pool.query(
      `SELECT ${option.valueColumn} AS value, ${option.labelColumn} AS label
       ${option.from} ${where} ORDER BY ${orderBy}, ${option.valueColumn}
       LIMIT ${Number(page.pageSize)} OFFSET ${Number(page.offset)}`
    );
    res.json(buildPageEnvelope(rows, { ...page, total: countRow?.total || 0 }));
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 用户专用操作：重置密码 / 启用禁用
// ---------------------------------------------------------------------------

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < 8) return '密码长度不能少于 8 位';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return '密码需要同时包含字母和数字';
  return null;
}

// 重置密码是不可逆操作，判据取"用户菜单的修改位"——目前只有超级管理员有这个位，
// 但判据落在权限表上而不是角色名上：以后把 users:update 授给谁，谁就能重置。
router.post('/users/:id/reset-password', requireMenu('users', 'update'), async (req, res, next) => {
  try {
    const { newPassword } = req.body || {};
    const error = validateNewPassword(newPassword);
    if (error) return res.status(400).json({ message: error });

    const [rows] = await pool.execute(
      'SELECT id, username FROM users WHERE id = :id LIMIT 1',
      { id: req.params.id }
    );
    if (!rows[0]) return res.status(404).json({ message: '用户不存在' });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.execute(
      'UPDATE users SET password_hash = :passwordHash, token_version = token_version + 1 WHERE id = :id',
      { passwordHash, id: req.params.id }
    );

    await pool.execute(
      `INSERT INTO login_logs (user_id, username, role, success, message, ip)
       VALUES (:userId, :username, :role, 1, :message, :ip)`,
      {
        userId: rows[0].id,
        username: rows[0].username,
        // 记操作者本人的角色代码，不写死 'admin'：这条日志要能回答"是谁重置的"
        role: req.user.role,
        message: `${req.user.roleName} ${req.user.username} 重置了密码`,
        ip: (req.ip || '').slice(0, 64) || null
      }
    );

    res.json({ message: '密码已重置，该用户在其他设备的登录已失效' });
  } catch (error) {
    next(error);
  }
});

router.patch('/users/:id/status', requireMenu('users', 'update'), async (req, res, next) => {
  try {
    const status = String(req.body?.status || '');
    if (!['active', 'disabled'].includes(status)) {
      return res.status(400).json({ message: '状态只能是 active 或 disabled' });
    }
    if (String(req.params.id) === String(req.user.id) && status === 'disabled') {
      return res.status(400).json({ message: '不能禁用当前登录的账号' });
    }

    const [result] = await pool.execute(
      'UPDATE users SET status = :status WHERE id = :id',
      { status, id: req.params.id }
    );
    if (!result.affectedRows) return res.status(404).json({ message: '用户不存在' });

    res.json({ id: Number(req.params.id), status });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 角色权限矩阵（角色管理菜单里的权限抽屉）
//
// 不给 role_menus 单开一个菜单：菜单会从 14 个变成 14+N 个，而权限本来就是"某个角色的"，
// 放在角色行里打开才符合直觉。勾选矩阵整份替换，不做逐行 PATCH——勾选是整体提交的。
// ---------------------------------------------------------------------------

async function loadRoleById(id, res) {
  const numericId = Number.parseInt(id, 10);
  if (!Number.isFinite(numericId)) {
    res.status(400).json({ message: '无效的角色 ID' });
    return null;
  }
  const [rows] = await pool.execute(
    'SELECT id, code, name, is_super, is_builtin FROM roles WHERE id = :id LIMIT 1',
    { id: numericId }
  );
  if (!rows[0]) {
    res.status(404).json({ message: '角色不存在' });
    return null;
  }
  return rows[0];
}

router.get('/roles/:id/menus', requireMenu('roles'), async (req, res, next) => {
  try {
    const role = await loadRoleById(req.params.id, res);
    if (!role) return;

    const [rows] = await pool.execute(
      `SELECT menu_key, can_view, can_create, can_update, can_delete, teacher_types
       FROM role_menus WHERE role_id = :roleId`,
      { roleId: role.id }
    );
    const granted = new Map(rows.map((row) => [row.menu_key, row]));

    res.json({
      role: {
        id: role.id,
        code: role.code,
        name: role.name,
        isSuper: Boolean(Number(role.is_super)),
        isBuiltin: Boolean(Number(role.is_builtin))
      },
      // 按侧边栏顺序列出全部菜单，没授权的四项均为 0，前端据此画勾选矩阵
      menus: menuOrder.map((menuKey) => {
        const resource = getResource(menuKey);
        const row = granted.get(menuKey);
        return {
          menuKey,
          label: resource ? resource.label : menuKey,
          group: resource ? resource.group : '',
          canView: row ? Number(row.can_view) : 0,
          canCreate: row ? Number(row.can_create) : 0,
          canUpdate: row ? Number(row.can_update) : 0,
          canDelete: row ? Number(row.can_delete) : 0,
          teacherTypes: row ? row.teacher_types : null,
          // 该菜单是否支持按教师类型收窄。前端据此决定要不要画教师类型勾选，
          // 并且在保存时把读到的 teacherTypes 原样回传（整份替换，漏传等于清空）。
          teacherScoped: Boolean(resource && resource.teacherScoped)
        };
      })
    });
  } catch (error) {
    next(error);
  }
});

/** 把前端提交的一行勾选规整成可入库的四个权限位；不合法时返回 { error }。 */
function normalizeMenuGrant(item) {
  if (!item || typeof item !== 'object') return { error: '每一项都要是对象' };

  const menuKey = String(item.menuKey || '');
  if (!menuOrder.includes(menuKey)) return { error: `未知的菜单：${menuKey || '(空)'}` };

  // 看不到就没得谈增删改：这种行存进去也是死行，canAccess 第一关就按 view 挡掉了
  const canView = item.canView ? 1 : 0;
  const rest = canView ? 1 : 0;

  let teacherTypes = null;
  if (item.teacherTypes) {
    const list = (Array.isArray(item.teacherTypes) ? item.teacherTypes : String(item.teacherTypes).split(','))
      .map((value) => String(value).trim())
      .filter(Boolean);
    const unknown = list.filter((value) => !TEACHER_TYPES.includes(value));
    if (unknown.length) return { error: `未知的教师类型：${unknown.join('、')}` };
    teacherTypes = list.length ? list.join(',') : null;
  }

  return {
    row: {
      menuKey,
      canView,
      canCreate: item.canCreate ? rest : 0,
      canUpdate: item.canUpdate ? rest : 0,
      canDelete: item.canDelete ? rest : 0,
      teacherTypes
    }
  };
}

router.put('/roles/:id/menus', requireMenu('roles', 'update'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const role = await loadRoleById(req.params.id, res);
    if (!role) return;

    // 超级管理员在 canAccess 里是短路的，改这张表对它没有任何影响。
    // 与其存下一份看着像真的、实际不起作用的勾选，不如直接拒掉。
    if (Number(role.is_super)) {
      return res.status(409).json({
        message: '超级管理员对所有菜单都有全部权限，权限矩阵对它不生效，无需也无法修改'
      });
    }

    const input = req.body?.menus;
    if (!Array.isArray(input)) return res.status(400).json({ message: 'menus 必须是数组' });

    const rows = [];
    for (const item of input) {
      const normalized = normalizeMenuGrant(item);
      if (normalized.error) return res.status(400).json({ message: normalized.error });
      // 没勾查看的菜单不落库：留空行会让矩阵页显示成一个有权限、实际进不去的菜单
      if (normalized.row.canView) rows.push(normalized.row);
    }

    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.menuKey)) return res.status(400).json({ message: `菜单重复：${row.menuKey}` });
      seen.add(row.menuKey);
    }

    await connection.beginTransaction();
    await connection.execute('DELETE FROM role_menus WHERE role_id = ?', [role.id]);
    for (const row of rows) {
      await connection.execute(
        `INSERT INTO role_menus
           (role_id, menu_key, can_view, can_create, can_update, can_delete, teacher_types)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [role.id, row.menuKey, row.canView, row.canCreate, row.canUpdate, row.canDelete, row.teacherTypes]
      );
    }
    await connection.commit();

    res.json({ roleId: role.id, menuCount: rows.length, message: '权限已保存' });
  } catch (error) {
    await connection.rollback().catch(() => {});
    next(error);
  } finally {
    connection.release();
  }
});

// ---------------------------------------------------------------------------
// 通用 CRUD
// ---------------------------------------------------------------------------

/**
 * 取资源并校验动作权限。所有资源接口的第一道闸门，权限判据是 role_menus 表。
 * 资源自身的 canCreate/canUpdate/canDelete 表示"这个菜单支不支持写操作"
 * （问答记录、用户管理天生不可删），与角色授权位一起看才算放行。
 */
const ACTION_LABELS = { view: '查看', create: '新增', update: '修改', delete: '删除' };

function resolveResource(req, res, action = 'view') {
  const resource = getResource(req.params.resource);
  if (!resource) {
    res.status(404).json({ message: '资源不存在' });
    return null;
  }
  if (!canAccess(req.user, resource.key, action)) {
    res.status(403).json({ message: `没有该菜单的${ACTION_LABELS[action] || action}权限` });
    return null;
  }

  // 教师类型收窄：role_menus.teacher_types 是"同一角色内的收窄"，只有教师角色的行会带它，
  // 管理端角色恒为 NULL（不限类型）。班级菜单是唯一用到它的地方 ——
  // 任课教师与辅导员看得到班级，但只有班主任与教务改得动。
  if (action !== 'view' && resource.teacherScoped) {
    const granted = getGrantedMenu(req.user, resource.key);
    if (!teacherTypeAllowed(granted, req.user.teacherType)) {
      res.status(403).json({ message: '你的教师类型没有该菜单的操作权限' });
      return null;
    }
  }
  return resource;
}

/**
 * 资源的数据范围条件。资源在注册表里用 scope: 'student' | 'class' 声明自己按哪个维度收窄，
 * 别名与本文件里各资源的 baseFrom 一致（students 与 studyRecords、gradeRecords 都是 s，
 * classes 是 c）。管理端角色 data_scope='all'，一律返回 null。
 */
function resourceScope(user, resource) {
  if (resource.scope === 'class') return classScope(user, 'c');
  if (resource.scope === 'student') return studentScope(user, 's');
  return null;
}

router.get('/:resource', async (req, res, next) => {
  try {
    const resource = resolveResource(req, res, 'view');
    if (!resource) return;

    const parsed = parseListQuery(req.query, resource, resourceScope(req.user, resource));
    const result = await runPaginatedQuery(resource, parsed);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/:resource/:id', async (req, res, next) => {
  try {
    const resource = resolveResource(req, res);
    if (!resource) return;

    // 只允许按主键查，且主键必须是整数，避免任何字符串进入 SQL
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: '无效的 ID' });

    const [rows] = await pool.query(
      `SELECT ${resource.selectColumns} ${resource.baseFrom} WHERE ${resource.primaryKeyColumn} = ? LIMIT 1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ message: '记录不存在' });
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

router.post('/:resource', async (req, res, next) => {
  try {
    const resource = resolveResource(req, res, 'create');
    if (!resource) return;
    if (!resource.canCreate) return res.status(405).json({ message: '该资源不支持新增' });

    const mapped = mapBodyToColumns(resource, req.body || {}, { partial: false });
    if (!mapped.ok) return res.status(400).json({ message: mapped.message });

    const placeholders = mapped.columns.map(() => '?').join(', ');
    const columnsSql = mapped.columns.map((column) => `\`${column}\``).join(', ');

    const [result] = await pool.query(
      `INSERT INTO \`${resource.table}\` (${columnsSql}) VALUES (${placeholders})`,
      mapped.values
    );

    const [rows] = await pool.query(
      `SELECT ${resource.selectColumns} ${resource.baseFrom} WHERE ${resource.primaryKeyColumn} = ? LIMIT 1`,
      [result.insertId]
    );
    res.status(201).json(rows[0] || { id: result.insertId });
  } catch (error) {
    if (['23505', 'ER_DUP_ENTRY'].includes(error.code)) {
      return res.status(409).json({ message: '存在重复的唯一字段值（如编号已存在）' });
    }
    if (['23503', 'ER_NO_REFERENCED_ROW_2'].includes(error.code)) {
      return res.status(400).json({ message: '关联的记录不存在' });
    }
    next(error);
  }
});

router.put('/:resource/:id', async (req, res, next) => {
  try {
    const resource = resolveResource(req, res, 'update');
    if (!resource) return;
    if (!resource.canUpdate) return res.status(405).json({ message: '该资源不支持修改' });

    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: '无效的 ID' });

    const mapped = mapBodyToColumns(resource, req.body || {}, { partial: true });
    if (!mapped.ok) return res.status(400).json({ message: mapped.message });

    // 值走占位符，列名来自注册表白名单
    const setSql = mapped.columns.map((column) => `\`${column}\` = ?`).join(', ');
    const [result] = await pool.query(
      `UPDATE \`${resource.table}\` SET ${setSql} WHERE \`${resource.primaryKey}\` = ?`,
      [...mapped.values, id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ message: '记录不存在' });
    }

    const [rows] = await pool.query(
      `SELECT ${resource.selectColumns} ${resource.baseFrom} WHERE ${resource.primaryKeyColumn} = ? LIMIT 1`,
      [id]
    );
    res.json(rows[0] || { id });
  } catch (error) {
    if (['23505', 'ER_DUP_ENTRY'].includes(error.code)) {
      return res.status(409).json({ message: '存在重复的唯一字段值（如编号已存在）' });
    }
    if (['23503', 'ER_NO_REFERENCED_ROW_2'].includes(error.code)) {
      return res.status(400).json({ message: '关联的记录不存在' });
    }
    next(error);
  }
});

router.delete('/:resource/:id', async (req, res, next) => {
  try {
    const resource = resolveResource(req, res, 'delete');
    if (!resource) return;
    if (!resource.canDelete) return res.status(405).json({ message: '该资源不支持删除' });

    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: '无效的 ID' });

    const [result] = await pool.query(
      `DELETE FROM \`${resource.table}\` WHERE \`${resource.primaryKey}\` = ?`,
      [id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: '记录不存在' });

    res.json({ id, deleted: true });
  } catch (error) {
    // 外键约束：被其他表引用时不能删
    if (['23503', 'ER_ROW_IS_REFERENCED_2'].includes(error.code)) {
      return res.status(409).json({ message: '该记录被其他数据引用，无法删除' });
    }
    next(error);
  }
});

module.exports = router;
