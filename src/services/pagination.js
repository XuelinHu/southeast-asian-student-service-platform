const pool = require('../config/db');

// 分页/SQL 构造。安全约定（重要）：
//   * 所有 SQL 片段的标识符（列名、排序方向、LIMIT/OFFSET）只能来自本文件的资源注册表，
//     绝不来自请求参数本身。
//   * 所有值一律走 ? 占位符，由 mysql2 客户端转义。
//   * 用 pool.query 而不是 pool.execute：实测 pool.execute 绑定 LIMIT ? 会抛
//     "Incorrect arguments to mysqld_stmt_execute"，因为 MySQL 预处理语句不接受
//     LIMIT/OFFSET 作为绑定参数。pool.query 走客户端转义，没有这个限制。

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_KEYWORD_LENGTH = 100;

// LIKE 的转义符。刻意不用反斜杠：反斜杠要同时穿过 JS 字符串字面量和 MySQL 字符串
// 字面量两层转义，极易写错。用 ! 只需要处理用户输入里的 ! 本身。
const LIKE_ESCAPE_CHAR = '!';

/**
 * 转义 LIKE 的通配符。
 * 不转义的话，用户搜 "%" 会匹配全表、搜 "_" 会匹配任意单字符 —— 不是注入，
 * 但结果明显不对。转义符自身必须最先替换，否则会把后面新加的转义符再转义一次。
 */
function escapeLike(value) {
  return String(value)
    .split(LIKE_ESCAPE_CHAR)
    .join(LIKE_ESCAPE_CHAR + LIKE_ESCAPE_CHAR)
    .replace(/%/g, `${LIKE_ESCAPE_CHAR}%`)
    .replace(/_/g, `${LIKE_ESCAPE_CHAR}_`);
}

function toPositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * 只解分页与关键字，不碰排序与筛选。给不属于任何资源注册项的接口用
 * （自己拼 SQL 的列表接口），出来的信封仍由 buildPageEnvelope 统一构造。
 * @param {object} query
 * @param {{defaultPageSize?: number}} options
 */
function parsePageQuery(query = {}, { defaultPageSize = DEFAULT_PAGE_SIZE } = {}) {
  const page = toPositiveInt(query.page, 1, 1, 1e6);
  const pageSize = toPositiveInt(query.pageSize, defaultPageSize, 1, MAX_PAGE_SIZE);
  const rawKeyword = query.q ?? query.keyword ?? '';

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    keyword: String(rawKeyword).trim().slice(0, MAX_KEYWORD_LENGTH)
  };
}

/**
 * 统一分页信封。所有列表接口都返回这个形状，前端只认这一种。
 * totalPages 在 0 条时给 0 而不是 1：前端据此区分"没有数据"和"有数据但本页为空"。
 */
function buildPageEnvelope(items, { page, pageSize, total, keyword } = {}) {
  const count = Number(total || 0);
  return {
    items: items || [],
    page,
    pageSize,
    total: count,
    totalPages: count === 0 ? 0 : Math.ceil(count / pageSize),
    ...(keyword === undefined ? {} : { keyword })
  };
}

/**
 * 解析分页/排序/搜索/筛选参数。
 * @param {object} query  express 的 req.query
 * @param {object} resource 资源注册表条目
 * @param {{sql: string, params: any[]}|null} scope 数据范围收窄条件，见 services/scope.js。
 *        必须是代码构造的片段，不能来自请求参数；params 走占位符。
 */
function parseListQuery(query = {}, resource = {}, scope = null) {
  const page = toPositiveInt(query.page, 1, 1, 1e6);
  const pageSize = toPositiveInt(query.pageSize, resource.defaultPageSize || DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  const rawKeyword = query.q ?? query.keyword ?? '';
  const keyword = String(rawKeyword).trim().slice(0, MAX_KEYWORD_LENGTH);

  // 排序：只在白名单里查表，查不到就用默认排序。非法输入静默回落，不报错。
  const sortable = resource.sortable || {};
  const sortKey = typeof query.sortBy === 'string' ? query.sortBy : '';
  const sortColumn = Object.prototype.hasOwnProperty.call(sortable, sortKey)
    ? sortable[sortKey]
    : null;
  const direction = String(query.sortOrder || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  // 默认排序串同样来自注册表，不接受请求参数
  const uniqueColumn = resource.primaryKeyColumn || resource.primaryKey || 'id';
  const defaultSort = resource.defaultSort || `${uniqueColumn} DESC`;

  // 排序必须构成全序，否则翻页会重复/漏行：
  // 像 visas.expiry_date 这种非唯一列，同值的几十行在 MySQL 里没有稳定顺序，
  // LIMIT/OFFSET 两次查询可以把同一行既放进第 1 页又放进第 2 页（实测确实发生）。
  // 所以统一把主键追加为最后一级排序键兜底。
  const orderParts = sortColumn ? [`${sortColumn} ${direction}`] : defaultSort.split(',');
  const hasUnique = orderParts.some((part) =>
    new RegExp(`^\\s*${uniqueColumn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(ASC|DESC)\\s*$`, 'i').test(part)
  );
  if (!hasUnique) orderParts.push(`${uniqueColumn} ASC`);
  const orderSql = orderParts.join(', ');

  const clauses = [];
  const params = [];

  if (keyword && (resource.searchable || []).length) {
    const like = `%${escapeLike(keyword)}%`;
    const parts = resource.searchable.map((column) => {
      params.push(like);
      return `${column} LIKE ? ESCAPE '!'`;
    });
    clauses.push(`(${parts.join(' OR ')})`);
  }

  for (const [paramName, filter] of Object.entries(resource.filters || {})) {
    const raw = query[paramName];
    if (raw === undefined || raw === null || raw === '') continue;

    const value = String(raw);

    // 枚举型筛选：值必须在白名单内，否则整个筛选项忽略（不报错，避免探测表结构）
    if (filter.values && !filter.values.includes(value)) continue;

    if (filter.type === 'int') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) continue;
      clauses.push(`${filter.column} = ?`);
      params.push(parsed);
      continue;
    }

    if (filter.type === 'like') {
      // 包含匹配，同样走占位符 + 转义通配符
      clauses.push(`${filter.column} LIKE ? ESCAPE '!'`);
      params.push(`%${escapeLike(value.slice(0, MAX_KEYWORD_LENGTH))}%`);
      continue;
    }

    clauses.push(`${filter.column} = ?`);
    params.push(value);
  }

  // 收窄条件放在最后：clauses 与 params 按同一顺序追加，拼出来的 SQL 与参数才一一对应。
  // 之前这里是一段裸字符串 extraWhere，拼接值只能靠手写转义；改成带 params 的 scope 之后
  // 教师 id 这类值也能走占位符。
  if (scope && scope.sql) {
    clauses.push(`(${scope.sql})`);
    params.push(...(scope.params || []));
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  return { page, pageSize, offset, keyword, orderSql, whereSql, params };
}

/**
 * 执行分页查询，返回统一信封。
 * @param {object} resource 资源注册表条目
 * @param {object} parsed   parseListQuery 的结果
 */
async function runPaginatedQuery(resource, parsed) {
  const { selectColumns, baseFrom } = resource;

  const countSql = `SELECT COUNT(*) AS total ${baseFrom} ${parsed.whereSql}`;
  const dataSql =
    `SELECT ${selectColumns} ${baseFrom} ${parsed.whereSql} ` +
    `ORDER BY ${parsed.orderSql} LIMIT ${Number(parsed.pageSize)} OFFSET ${Number(parsed.offset)}`;

  const [[countRow]] = await pool.query(countSql, parsed.params);
  const total = Number(countRow?.total || 0);

  const [rows] = await pool.query(dataSql, parsed.params);

  return buildPageEnvelope(rows, {
    page: parsed.page,
    pageSize: parsed.pageSize,
    total,
    keyword: parsed.keyword
  });
}

module.exports = {
  parseListQuery,
  parsePageQuery,
  buildPageEnvelope,
  runPaginatedQuery,
  // 智能体的工具查询也做关键字匹配，复用同一套转义，避免两处实现走偏
  escapeLike,
  toPositiveInt,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE
};
