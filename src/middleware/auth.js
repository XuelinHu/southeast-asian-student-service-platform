const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { JWT_SECRET } = require('../config/auth');
const { canAccess } = require('../config/roles');

function readToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * 按角色 id 读菜单授权，做成 Map<menuKey, {canView,canCreate,canUpdate,canDelete,teacherTypes}>。
 * 超级管理员不查：canAccess 对它短路，查了也是白查一次表。
 */
async function loadRoleMenus(roleId, isSuper) {
  const menus = new Map();
  if (isSuper) return menus;

  const [rows] = await pool.execute(
    `SELECT menu_key, can_view, can_create, can_update, can_delete, teacher_types
     FROM role_menus WHERE role_id = :roleId`,
    { roleId }
  );
  for (const row of rows) {
    menus.set(row.menu_key, {
      canView: Number(row.can_view),
      canCreate: Number(row.can_create),
      canUpdate: Number(row.can_update),
      canDelete: Number(row.can_delete),
      teacherTypes: row.teacher_types
    });
  }
  return menus;
}

/**
 * 补上数据范围收窄要用的身份信息：教师看得到自己带的班，学生只看得到自己。
 * 只有用户端角色才查，管理端角色不需要。
 */
async function loadIdentityScope(user) {
  if (user.dataScope === 'class') {
    const [rows] = await pool.execute(
      'SELECT id, teacher_type FROM teachers WHERE user_id = :id LIMIT 1',
      { id: user.id }
    );
    return { teacherId: rows[0] ? rows[0].id : null, teacherType: rows[0] ? rows[0].teacher_type : null };
  }
  if (user.dataScope === 'self') {
    const [rows] = await pool.execute('SELECT id FROM students WHERE user_id = :id LIMIT 1', {
      id: user.id
    });
    return { studentId: rows[0] ? rows[0].id : null };
  }
  return {};
}

/**
 * 校验 token 对应的账号仍然有效，并把角色与菜单权限一并读出来。
 * 返回 { id, username, role, roleName, name, isSuper, dataScope, menus, tokenVersion,
 *        teacherId?, teacherType?, studentId? } 或 null。
 *
 * 这里每请求必查一次库，没有"跳过校验"的开关：菜单权限就从这个查询来，
 * 跳过它等于跳过全部授权。改密或被重置后 token_version 自增，旧 token 随即失效。
 */
async function loadActiveUser(payload) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.username, u.display_name, u.status, u.token_version,
            r.id AS role_id, r.code AS role, r.name AS role_name,
            r.is_super, r.data_scope, r.status AS role_status
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = :id LIMIT 1`,
    { id: payload.id }
  );
  const user = rows[0];
  if (!user || user.status !== 'active' || user.role_status !== 'active') return null;

  if (Number(user.token_version) !== Number(payload.tokenVersion ?? 0)) return null;

  const isSuper = Boolean(Number(user.is_super));
  const resolved = {
    id: user.id,
    username: user.username,
    role: user.role,
    roleId: user.role_id,
    roleName: user.role_name,
    name: user.display_name,
    isSuper,
    dataScope: user.data_scope,
    menus: await loadRoleMenus(user.role_id, isSuper),
    tokenVersion: Number(user.token_version)
  };
  return Object.assign(resolved, await loadIdentityScope(resolved));
}

function auth(requiredRoles = []) {
  return async (req, res, next) => {
    const token = readToken(req);
    if (!token) {
      return res.status(401).json({ message: 'Missing authorization token' });
    }

    try {
      const payload = verifyToken(token);
      const user = await loadActiveUser(payload);

      if (!user) {
        return res.status(401).json({ message: 'Invalid or expired token' });
      }
      if (requiredRoles.length && !requiredRoles.includes(user.role)) {
        return res.status(403).json({ message: 'Permission denied' });
      }

      req.user = user;
      next();
    } catch (error) {
      if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        return res.status(401).json({ message: 'Invalid or expired token' });
      }
      next(error);
    }
  };
}

/**
 * 菜单级授权。要求 req.user 在列出的每个菜单上都有该动作权限，否则 403。
 *
 *   requireMenu('students')                  需要在学生菜单上可查看
 *   requireMenu(['students', 'classes'])     两个都要
 *   requireMenu('users', 'update')           需要在用户菜单上可修改
 *
 * 用于不属于任何资源的接口（统计概览、风险聚合、重置密码等），必须放在 auth() 之后。
 * 权限来源与资源接口完全一致：都是 role_menus 表，改授权不需要改路由。
 */
function requireMenu(menuKeys, action = 'view') {
  const keys = Array.isArray(menuKeys) ? menuKeys : [menuKeys];
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Missing authorization token' });
    const denied = keys.filter((key) => !canAccess(req.user, key, action));
    if (denied.length) {
      return res
        .status(403)
        .json({ message: `没有「${denied.join('、')}」的${actionLabel(action)}权限` });
    }
    next();
  };
}

function actionLabel(action) {
  return { view: '查看', create: '新增', update: '修改', delete: '删除' }[action] || action;
}

/**
 * 可选鉴权：带合法 token 就填 req.user，否则 req.user = null 并继续。
 * 供"游客可用知识问答、登录后可查真实数据"的智能体路由使用。
 */
function optionalAuth() {
  return async (req, res, next) => {
    req.user = null;
    const token = readToken(req);
    if (!token) return next();

    try {
      const user = await loadActiveUser(verifyToken(token));
      if (user) req.user = user;
    } catch {
      // 游客身份继续，不因坏 token 中断
    }
    next();
  };
}

module.exports = auth;
module.exports.auth = auth;
module.exports.optionalAuth = optionalAuth;
module.exports.requireMenu = requireMenu;
module.exports.loadActiveUser = loadActiveUser;
