const pool = require('../config/db');
const { buildPageEnvelope, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, toPositiveInt, escapeLike } = require('./pagination');

// 风险清单是跨五张业务表的聚合，管理台（/api/admin/risks）与门户（/api/management/risks）
// 看的是同一批数据。以前两处各写一份 SQL，分支数、文案、上限都不一样：
// 门户那份漏了"签证过期"，而它恰恰是六类里最严重的一类。
// 现在只有这一份定义，两处接口共用，差异只留在响应信封上。

// 每一支都自带 LIMIT 上限，避免 UNION ALL 的分支在大表上无界展开。
// 注意：这个 LIMIT 是"每类最多取这么多条"，不是分页；分页由外层对这个并集做。
const BRANCH_LIMIT = 500;

const RISK_BRANCHES = {
  visa_expiring: {
    label: '签证临期',
    sql: `SELECT 'visa_expiring' AS risk_type, s.student_no, s.chinese_name, s.english_name,
                 v.expiry_date AS risk_date,
                 CONCAT('签证将于 ', TO_CHAR(v.expiry_date, 'YYYY-MM-DD'), ' 到期（剩余 ',
                        (v.expiry_date - CURRENT_DATE), ' 天）') AS detail,
                 NULL AS severity
          FROM visas v JOIN students s ON s.id = v.student_id
          WHERE v.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 60
          LIMIT ${BRANCH_LIMIT}`
  },
  visa_expired: {
    label: '签证过期',
    sql: `SELECT 'visa_expired' AS risk_type, s.student_no, s.chinese_name, s.english_name,
                 v.expiry_date AS risk_date,
                 CONCAT('签证已于 ', TO_CHAR(v.expiry_date, 'YYYY-MM-DD'), ' 过期') AS detail,
                 NULL AS severity
          FROM visas v JOIN students s ON s.id = v.student_id
          WHERE v.expiry_date < CURRENT_DATE
          LIMIT ${BRANCH_LIMIT}`
  },
  grade_exception: {
    label: '成绩适配异常',
    sql: `SELECT 'grade_exception' AS risk_type, s.student_no, s.chinese_name, s.english_name,
                 gr.created_at AS risk_date,
                 CONCAT(COALESCE(gr.course_name, '未知课程'), '：',
                        COALESCE(gr.exception_reason, gr.adapt_status)) AS detail,
                 NULL AS severity
          FROM grade_records gr JOIN students s ON s.id = gr.student_id
          WHERE gr.adapt_status = 'exception'
          LIMIT ${BRANCH_LIMIT}`
  },
  low_score: {
    label: '低分风险',
    sql: `SELECT 'low_score' AS risk_type, s.student_no, s.chinese_name, s.english_name,
                 gr.created_at AS risk_date,
                 CONCAT(COALESCE(gr.course_name, '未知课程'), '：适配成绩 ', gr.adapted_score) AS detail,
                 NULL AS severity
          FROM grade_records gr JOIN students s ON s.id = gr.student_id
          WHERE gr.adapted_score IS NOT NULL AND gr.adapted_score < 60
          LIMIT ${BRANCH_LIMIT}`
  },
  learning_warning: {
    label: '学习预警',
    sql: `SELECT 'learning_warning' AS risk_type, s.student_no, s.chinese_name, s.english_name,
                 sr.recorded_at AS risk_date,
                 CONCAT(sr.course_name, '：', sr.warning_level, '，出勤率 ',
                        COALESCE(sr.attendance_rate, 0), '%') AS detail,
                 NULL AS severity
          FROM study_records sr JOIN students s ON s.id = sr.student_id
          WHERE sr.warning_level IN ('warning','serious') OR sr.attendance_rate < 70
          LIMIT ${BRANCH_LIMIT}`
  },
  dormitory_exception: {
    label: '住宿异常',
    sql: `SELECT 'dormitory_exception' AS risk_type, s.student_no, s.chinese_name, s.english_name,
                 d.check_out_date AS risk_date,
                 CONCAT(d.building, '-', d.room_no, '-', d.bed_no, '：', d.status) AS detail,
                 NULL AS severity
          FROM dormitories d JOIN students s ON s.id = d.student_id
          WHERE d.status IN ('maintenance','reserved') OR d.check_out_date < CURRENT_DATE
          LIMIT ${BRANCH_LIMIT}`
  }
};

const RISK_TYPES = Object.keys(RISK_BRANCHES);

/**
 * 各风险类型的条数。不受分页影响，供顶部指标卡使用。
 * @returns {Promise<Record<string, number>>}
 */
async function countByType({ riskType } = {}) {
  const branches = selectBranches(riskType);
  const unionSql = branches.map((branch) => `(${branch.sql})`).join(' UNION ALL ');
  const [rows] = await pool.query(
    `SELECT risk_type, COUNT(*) AS count FROM (${unionSql}) AS risk_pool GROUP BY risk_type`
  );

  const summary = Object.fromEntries(RISK_TYPES.map((type) => [type, 0]));
  for (const row of rows) summary[row.risk_type] = Number(row.count);
  return summary;
}

/**
 * 风险清单分页查询。六类并成一个列表后统一排序（风险日期倒序，主键兜底成全序）。
 *
 * @param {object} options
 * @param {string} [options.riskType] 只取某一类，非法值忽略（退回全部）
 * @param {string} [options.keyword]  学号 / 中英文姓名 / 明细的包含匹配
 * @param {number} [options.page]
 * @param {number} [options.pageSize]
 */
async function listRisks({ riskType = '', keyword = '', page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const branches = selectBranches(riskType);
  const unionSql = branches.map((branch) => `(${branch.sql})`).join(' UNION ALL ');

  const safePage = toPositiveInt(page, 1, 1, 1e6);
  const safePageSize = toPositiveInt(pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = (safePage - 1) * safePageSize;

  const params = [];
  let whereSql = '';
  if (keyword) {
    whereSql = 'WHERE student_no LIKE ? ESCAPE \'!\' OR chinese_name LIKE ? ESCAPE \'!\' ' +
      'OR english_name LIKE ? ESCAPE \'!\' OR detail LIKE ? ESCAPE \'!\'';
    const like = `%${escapeLike(keyword)}%`;
    params.push(like, like, like, like);
  }

  const [[countRow]] = await pool.query(
    `SELECT COUNT(*) AS total FROM (${unionSql}) AS risk_pool ${whereSql}`,
    params
  );
  const [items] = await pool.query(
    `SELECT * FROM (${unionSql}) AS risk_pool ${whereSql} ` +
      // 同一 risk_date 上可能堆几十行（同一天到期的签证），只按它排序翻页会重复/漏行，
      // 所以追加几个一定会区分开的列把顺序定死
      `ORDER BY risk_date DESC, risk_type ASC, student_no ASC LIMIT ${Number(safePageSize)} OFFSET ${Number(offset)}`,
    params
  );

  return buildPageEnvelope(items, {
    page: safePage,
    pageSize: safePageSize,
    total: Number(countRow?.total || 0)
  });
}

/** 只取某一类风险时返回单支，否则返回全部。未知类型一律退回全部，不报错。 */
function selectBranches(riskType) {
  const branch = RISK_BRANCHES[riskType];
  return branch ? [branch] : Object.values(RISK_BRANCHES);
}

module.exports = { RISK_BRANCHES, RISK_TYPES, listRisks, countByType };
