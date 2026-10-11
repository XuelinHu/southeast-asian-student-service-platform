// 用户端角色的数据范围收窄（roles.data_scope）。
//
// 菜单授权管"能不能进这个菜单"，数据范围管"进去之后看得见哪些行"。两层都要有：
// 教师有学生菜单的查看位，但不该看见全校 181 个学生，只该看见自己带的班。
//
// 这里产出的 SQL 片段会直接拼进 WHERE，所以有一条硬约定：
//   * 片段本身是代码里的字面量，只有 alias 参与拼接，而 alias 由调用方写死；
//   * 所有值一律走兼容层的 ? 占位符，再绑定为 PostgreSQL 参数。
// 调用方返回的 params 会被追加到 WHERE 参数列表末尾，顺序与 clauses 一致。

/**
 * 学生维度的可见范围。适用于任何能 JOIN 到 students 的查询。
 * @param {object} user   middleware/auth.js 的 req.user
 * @param {string} alias  该查询里 students 表的别名，必须是代码里写死的常量
 * @returns {{sql: string, params: any[]}|null} null 表示不限范围
 */
function studentScope(user, alias = 's') {
  if (!user || user.dataScope === 'all') return null;

  if (user.dataScope === 'class') {
    // 没绑定教师档案的账号（例如角色是教师但 teachers 表里没有本人记录）
    // 不能退化成"看全部"：那样一个漏建的档案就等于越权。收成空集更安全。
    if (!user.teacherId) return { sql: '1 = 0', params: [] };
    return {
      sql: `${alias}.class_id IN (SELECT c.id FROM classes c WHERE c.teacher_id = ?)`,
      params: [user.teacherId]
    };
  }

  if (user.dataScope === 'self') {
    if (!user.studentId) return { sql: '1 = 0', params: [] };
    return { sql: `${alias}.id = ?`, params: [user.studentId] };
  }

  return null;
}

/**
 * 班级维度的可见范围：教师只看得到自己带的班。
 * @param {object} user
 * @param {string} alias  classes 表在本查询里的别名，必须是代码里写死的常量
 */
function classScope(user, alias = 'c') {
  if (!user || user.dataScope === 'all') return null;

  if (user.dataScope === 'class') {
    if (!user.teacherId) return { sql: '1 = 0', params: [] };
    return { sql: `${alias}.teacher_id = ?`, params: [user.teacherId] };
  }

  // 学生角色没有班级菜单，真调到了也看不到任何一行
  if (user.dataScope === 'self') return { sql: '1 = 0', params: [] };
  return null;
}

/**
 * 该用户是否受数据范围限制。自行拼 SQL 的接口用它决定要不要加 scope。
 */
function isScoped(user) {
  return Boolean(user) && user.dataScope !== 'all';
}

module.exports = { studentScope, classScope, isScoped };
