const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const { requireMenu } = require('../middleware/auth');
const { parseListQuery, parsePageQuery, buildPageEnvelope, runPaginatedQuery } = require('../services/pagination');
const { studentScope } = require('../services/scope');
const riskQuery = require('../services/riskQuery');

/** 把数据范围条件拼进 `WHERE ...` 之后的附加条件里；无范围限制时返回空串。 */
function scopeAnd(scope, params) {
  if (!scope) return '';
  params.push(...scope.params);
  return ` AND (${scope.sql})`;
}

const router = express.Router();

const CLASS_LIST = {
  selectColumns: 'c.id, c.code, c.name, c.college, c.major, c.enrollment_year, c.teacher_id, t.name AS teacher_name',
  baseFrom: 'FROM classes c LEFT JOIN teachers t ON t.id = c.teacher_id',
  primaryKeyColumn: 'c.id',
  searchable: ['c.code', 'c.name', 'c.college', 'c.major'],
  filters: {
    college: { column: 'c.college', type: 'like' },
    major: { column: 'c.major', type: 'like' },
    teacherId: { column: 'c.teacher_id', type: 'int' },
    enrollmentYear: { column: 'c.enrollment_year', type: 'int' }
  },
  sortable: { id: 'c.id', code: 'c.code', name: 'c.name', enrollmentYear: 'c.enrollment_year' },
  defaultSort: 'c.id DESC'
};

// 概览的四项指标跟着数据范围走：教师看到的是自己班上的数字，不是全校的。
// 否则会出现"概览说 181 个学生、点进列表只有 12 个"这种对不上的情况。
router.get('/dashboard', auth(), requireMenu('students'), async (req, res, next) => {
  try {
    const scope = studentScope(req.user, 's');

    const studentParams = [];
    const [[students]] = await pool.query(
      `SELECT COUNT(*) AS count FROM students s WHERE 1 = 1${scopeAnd(scope, studentParams)}`,
      studentParams
    );

    // 教师总数是师资编制口径，不按学生范围收窄
    const [[teachers]] = await pool.execute('SELECT COUNT(*) AS count FROM teachers');

    const visaParams = [];
    const [[visaWarnings]] = await pool.query(
      `SELECT COUNT(*) AS count FROM visas v JOIN students s ON s.id = v.student_id
       WHERE v.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 60${scopeAnd(scope, visaParams)}`,
      visaParams
    );

    const gradeParams = [];
    const [[gradeExceptions]] = await pool.query(
      `SELECT COUNT(*) AS count FROM grade_records gr JOIN students s ON s.id = gr.student_id
       WHERE gr.adapt_status = 'exception'${scopeAnd(scope, gradeParams)}`,
      gradeParams
    );

    res.json({
      students: students.count,
      teachers: teachers.count,
      visaWarnings: visaWarnings.count,
      gradeExceptions: gradeExceptions.count
    });
  } catch (error) {
    next(error);
  }
});

// 国籍目录也使用分页信封；调用方需要完整选项时应逐页读取。
router.get('/nationalities', auth(), async (req, res, next) => {
  try {
    const page = parsePageQuery(req.query);
    const [[countRow]] = await pool.query(
      "SELECT COUNT(*) AS total FROM nationalities WHERE status = 'active'"
    );
    const [rows] = await pool.query(
      `SELECT * FROM nationalities WHERE status = 'active'
       ORDER BY sort_order, name_en, id
       LIMIT ${Number(page.pageSize)} OFFSET ${Number(page.offset)}`
    );
    res.json(buildPageEnvelope(rows, { ...page, total: countRow?.total || 0 }));
  } catch (error) {
    next(error);
  }
});

router.get('/classes', auth(), requireMenu('classes'), async (req, res, next) => {
  try {
    const parsed = parseListQuery(req.query, CLASS_LIST);
    res.json(await runPaginatedQuery(CLASS_LIST, parsed));
  } catch (error) {
    next(error);
  }
});

// 风险清单：与管理台的 /api/admin/risks 共用 services/riskQuery.js 的同一份 SQL。
// 这里只返回分页信封（不带 summary）——门户页要的是列表本身，指标卡归 dashboard 管。
router.get('/risks', auth(), requireMenu('students'), async (req, res, next) => {
  try {
    res.json(
      await riskQuery.listRisks({
        riskType: typeof req.query.riskType === 'string' ? req.query.riskType : '',
        keyword: String(req.query.q || '').trim().slice(0, 100),
        page: req.query.page,
        pageSize: req.query.pageSize
      })
    );
  } catch (error) {
    next(error);
  }
});

module.exports = router;
