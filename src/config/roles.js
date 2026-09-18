// 角色与菜单授权（声明式）。
//
// 本文件是"角色 → 菜单"的权威定义，只在两处被消费：
//   1. database/schema.sql —— 全新初始化时灌入 roles / role_menus 两张表
//   2. src/migrate.js      —— 对已有库做幂等播种
// 运行时的权限判据是数据库里的 role_menus 行，不是本文件：管理台改过某个角色的
// 菜单勾选之后，migrate 重跑不会把权限位改回去（播种走 INSERT ... ON DUPLICATE KEY
// UPDATE，只更新角色名称与排序，不覆盖 can_* 四个权限位）。
//
// 权限位用紧凑串表示：v=查看 c=新增 u=修改 d=删除。写成 'vcu' 而不是四个布尔字段，
// 是为了让几个角色的差异在本文件里一眼可比。
//
// 注意：资源注册表 resources.js 里**不再**声明 roles 数组。之前那份 roles: ['admin']
// 与这里会形成两个真值来源，改一处漏一处就会出现"菜单看得见但点进去 403"。

const ACTION_FLAG = { view: 'v', create: 'c', update: 'u', delete: 'd' };
const READ_ONLY = 'v';
const FULL = 'vcud';

// 教师角色内部再按 teachers.teacher_type 细分。teacherTypes 为 null 表示不限。
// 这一层是"同一角色内的收窄"，不是新角色：教师登录后拿到的仍然是 teacher 角色的
// 菜单集合，再按本人的 teacher_type 与所带班级收窄数据范围。
const TEACHER_TYPES = ['course_teacher', 'head_teacher', 'counselor', 'admin_teacher'];

const BUILTIN_ROLES = [
  {
    code: 'super_admin',
    name: '超级管理员',
    scope: 'staff',
    dataScope: 'all',
    isSuper: true,
    isBuiltin: true,
    sortOrder: 1,
    description: '拥有全部菜单与全部操作权限，可维护角色权限、重置密码、启用停用账号、卸载模型',
    // '*' 展开为全部菜单的全权限。仅超级管理员可用；运行时由 roles.is_super 短路，
    // 这个展开只用于播种 role_menus 行，让权限矩阵页有东西可勾。
    menus: '*'
  },
  {
    code: 'academic_admin',
    name: '教务管理员',
    scope: 'staff',
    dataScope: 'all',
    isBuiltin: true,
    sortOrder: 2,
    description: '负责学籍、师资、班级、国籍、学习情况、成绩适配与对接学校维护',
    menus: {
      students: FULL,
      teachers: 'vcu', // 教师档案不允许在管理台删除，与注册表 canDelete 取交集后同样为不可删
      classes: 'vcu',
      nationalities: FULL,
      studyRecords: FULL,
      gradeRecords: FULL,
      gradeRules: 'vcu',
      externalSchools: 'vcu'
    }
  },
  {
    code: 'welfare_admin',
    name: '学工后勤管理员',
    scope: 'staff',
    dataScope: 'all',
    isBuiltin: true,
    sortOrder: 3,
    description: '负责住宿分配、床位状态与签证居留许可维护，只读查看学生名册',
    menus: {
      students: READ_ONLY,
      dormitories: FULL,
      visas: FULL
    }
  },
  {
    code: 'auditor',
    name: '审计员',
    scope: 'staff',
    dataScope: 'all',
    isBuiltin: true,
    sortOrder: 4,
    description: '只读查看登录日志与智能体问答记录，不能修改任何业务数据',
    // 四个动作只给 view：审计员不得新增、修改、删除，也不得重置密码或停用账号
    menus: {
      loginLogs: READ_ONLY,
      agentMessages: READ_ONLY
    }
  },
  {
    code: 'teacher',
    name: '教师',
    scope: 'user',
    dataScope: 'class',
    isBuiltin: true,
    sortOrder: 5,
    description: '查看本人所带班级的学生，录入学习情况与成绩；班级维护仅班主任与教务可操作',
    menus: {
      students: READ_ONLY,
      classes: { actions: 'vcu', teacherTypes: ['head_teacher', 'admin_teacher'] },
      studyRecords: FULL,
      gradeRecords: 'vcu'
    }
  },
  {
    code: 'student',
    name: '留学生',
    scope: 'user',
    dataScope: 'self',
    isBuiltin: true,
    sortOrder: 6,
    description: '留学生本人账号，可查询本人档案与成绩、使用智能体问答，无管理台菜单',
    menus: {}
  }
];

function findBuiltinRole(code) {
  return BUILTIN_ROLES.find((role) => role.code === code) || null;
}

/**
 * 把角色声明展开成 role_menus 行。
 * @param {object} role         BUILTIN_ROLES 里的一条
 * @param {string[]} allMenuKeys menuOrder，仅在 role.menus === '*' 时使用
 * @returns {Array<{menuKey,canView,canCreate,canUpdate,canDelete,teacherTypes}>}
 */
function expandRoleMenus(role, allMenuKeys = []) {
  const declaration = role.menus === '*' ? null : role.menus || {};
  const keys = role.menus === '*' ? allMenuKeys : Object.keys(declaration);

  return keys.map((menuKey) => {
    const entry = role.menus === '*' ? FULL : declaration[menuKey];
    const actions = typeof entry === 'string' ? entry : (entry && entry.actions) || READ_ONLY;
    const teacherTypes =
      typeof entry === 'object' && entry && Array.isArray(entry.teacherTypes)
        ? entry.teacherTypes.join(',')
        : null;

    return {
      menuKey,
      canView: actions.includes('v') ? 1 : 0,
      canCreate: actions.includes('c') ? 1 : 0,
      canUpdate: actions.includes('u') ? 1 : 0,
      canDelete: actions.includes('d') ? 1 : 0,
      teacherTypes
    };
  });
}

/**
 * 取某个菜单的授权行。user.menus 在服务端是 Map（middleware/auth.js 构造），
 * 在脚本与测试里可能是普通对象，两种都接受。
 */
function getGrantedMenu(user, menuKey) {
  if (!user || !user.menus) return null;
  const menus = user.menus;
  return menus instanceof Map ? menus.get(menuKey) || null : menus[menuKey] || null;
}

/**
 * 运行时权限判据。user 是 middleware/auth.js 里 loadActiveUser 的产物。
 * 超级管理员短路：role_menus 表被误删也不会把超管锁在门外。
 */
function canAccess(user, menuKey, action = 'view') {
  if (!user) return false;
  if (user.isSuper) return true;

  const granted = getGrantedMenu(user, menuKey);
  if (!granted) return false;
  if (action === 'view') return Boolean(granted.canView);
  if (action === 'create') return Boolean(granted.canCreate);
  if (action === 'update') return Boolean(granted.canUpdate);
  if (action === 'delete') return Boolean(granted.canDelete);
  return false;
}

/**
 * 该用户有权查看的菜单 key 列表（顺序不限，给智能体工具授权与菜单渲染用）。
 * 返回 null 表示"不限"（超级管理员），调用方自行展开为全部菜单。
 */
function visibleMenuKeys(user) {
  if (!user) return [];
  if (user.isSuper) return null;
  const entries = user.menus instanceof Map ? [...user.menus.entries()] : Object.entries(user.menus || {});
  return entries.filter(([, granted]) => granted && granted.canView).map(([key]) => key);
}

/**
 * 该用户在某菜单上被放行的教师类型白名单（数组），null 表示不限类型。
 * 只有教师角色的 classes 行会带上这个收窄。
 */
function grantedTeacherTypes(user, menuKey) {
  const granted = getGrantedMenu(user, menuKey);
  if (!granted || !granted.teacherTypes) return null;
  return String(granted.teacherTypes).split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * 教师内部细分：该教师类型是否被这一行 role_menus 放行。
 * teacher_types 为 NULL 表示不限类型。
 */
function teacherTypeAllowed(granted, teacherType) {
  if (!granted || !granted.teacherTypes) return true;
  if (!teacherType) return false;
  return String(granted.teacherTypes)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(teacherType);
}

module.exports = {
  BUILTIN_ROLES,
  TEACHER_TYPES,
  MENU_ACTION_FLAG: ACTION_FLAG,
  findBuiltinRole,
  expandRoleMenus,
  getGrantedMenu,
  canAccess,
  visibleMenuKeys,
  grantedTeacherTypes,
  teacherTypeAllowed
};
