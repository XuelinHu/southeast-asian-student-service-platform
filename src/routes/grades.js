const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const { requireMenu } = require('../middleware/auth');
const { canAccess } = require('../config/roles');
const { adaptGrade } = require('../services/gradeAdapter');
const { parseListQuery, parsePageQuery, runPaginatedQuery, buildPageEnvelope, escapeLike } =
  require('../services/pagination');
const { studentScope } = require('../services/scope');

const router = express.Router();

const GRADE_LIST = {
  selectColumns:
    'gr.id, gr.student_id, gr.course_code, gr.course_name, gr.original_grade, gr.original_type, ' +
    'gr.adapted_score, gr.adapted_gpa, gr.adapt_status, gr.audit_status, gr.created_at, ' +
    's.student_no, s.chinese_name, s.english_name, es.name AS source_school_name',
  baseFrom:
    'FROM grade_records gr ' +
    'JOIN students s ON s.id = gr.student_id ' +
    'LEFT JOIN external_schools es ON es.id = gr.source_school_id',
  primaryKeyColumn: 'gr.id',
  searchable: ['s.student_no', 's.chinese_name', 's.english_name', 'gr.course_name', 'gr.course_code'],
  filters: {
    adaptStatus: { column: 'gr.adapt_status', values: ['pending', 'success', 'exception'] },
    auditStatus: { column: 'gr.audit_status', values: ['pending', 'approved', 'rejected', 'archived'] },
    studentId: { column: 'gr.student_id', type: 'int' },
    courseCode: { column: 'gr.course_code', type: 'like' }
  },
  sortable: {
    id: 'gr.id',
    adaptedScore: 'gr.adapted_score',
    createdAt: 'gr.created_at',
    auditStatus: 'gr.audit_status'
  },
  defaultSort: 'gr.id DESC'
};

async function findRule(schoolId, countryCode) {
  const [rows] = await pool.execute(
    `SELECT *
     FROM grade_rules
     WHERE (school_id = :schoolId OR school_id IS NULL)
       AND (country_code = :countryCode OR country_code IS NULL)
       AND status = 'active'
     ORDER BY school_id DESC, id DESC
     LIMIT 1`,
    { schoolId: schoolId || null, countryCode: countryCode || null }
  );
  const rule = rows[0];
  if (!rule) return {};

  return {
    gpaScale: rule.gpa_scale,
    creditRatio: rule.credit_ratio,
    passScore: rule.pass_score,
    version: rule.version
  };
}

// 成绩列表。原来硬编码 LIMIT 200，超过 200 条的部分在界面上根本不存在；
// 现在按统一信封分页，教师同样只看得见自己班上的学生。
router.get('/', auth(), requireMenu('gradeRecords'), async (req, res, next) => {
  try {
    const parsed = parseListQuery(req.query, GRADE_LIST, studentScope(req.user, 's'));
    res.json(await runPaginatedQuery(GRADE_LIST, parsed));
  } catch (error) {
    next(error);
  }
});

router.post('/adapt', auth(), requireMenu('gradeRecords', 'create'), async (req, res, next) => {
  try {
    const input = req.body;
    const rule = await findRule(input.schoolId, input.countryCode);
    const adapted = adaptGrade(input, rule);

    const [result] = await pool.execute(
      `INSERT INTO grade_records
       (student_id, course_code, course_name, source_school_id, source_country_code,
        original_grade, original_type, original_credit, adapted_score, adapted_gpa,
        adapted_credit, passed, rule_version, adapt_status, audit_status)
       VALUES (:studentId, :courseCode, :courseName, :schoolId, :countryCode,
        :originalGrade, :originalType, :originalCredit, :adaptedScore, :adaptedGpa,
        :adaptedCredit, :passed, :ruleVersion, 'success', 'pending')`,
      {
        studentId: input.studentId,
        courseCode: input.courseCode,
        courseName: input.courseName,
        schoolId: input.schoolId || null,
        countryCode: input.countryCode || null,
        originalGrade: String(input.originalGrade),
        originalType: input.originalType,
        originalCredit: input.originalCredit || 0,
        adaptedScore: adapted.adaptedScore,
        adaptedGpa: adapted.adaptedGpa,
        adaptedCredit: adapted.adaptedCredit,
        passed: adapted.passed ? 1 : 0,
        ruleVersion: adapted.ruleVersion
      }
    );

    res.status(201).json({ id: result.insertId, ...adapted, auditStatus: 'pending' });
  } catch (error) {
    if (req.body && req.body.studentId) {
      await pool.execute(
        `INSERT INTO grade_records
         (student_id, course_code, course_name, source_school_id, source_country_code,
          original_grade, original_type, original_credit, adapt_status, exception_reason, audit_status)
         VALUES (:studentId, :courseCode, :courseName, :schoolId, :countryCode,
          :originalGrade, :originalType, :originalCredit, 'exception', :reason, 'pending')`,
        {
          studentId: req.body.studentId,
          courseCode: req.body.courseCode || null,
          courseName: req.body.courseName || null,
          schoolId: req.body.schoolId || null,
          countryCode: req.body.countryCode || null,
          originalGrade: String(req.body.originalGrade || ''),
          originalType: req.body.originalType || null,
          originalCredit: req.body.originalCredit || 0,
          reason: error.message
        }
      );
    }
    res.status(422).json({ message: error.message });
  }
});

/**
 * 某个学生的成绩，按统一信封分页。学生本人、教师、管理员都可能调用，所以不能直接挂
 * requireMenu('gradeRecords')：学生一个管理台菜单都没有，那样等于把本人查成绩也一起挡了。
 *
 * 权限按身份分两条路：
 *   * 学生              —— 只能是本人（路径参数与令牌里的学生主键比对）
 *   * 其他登录用户      —— 需要在成绩菜单上有查看位，且落在自己的数据范围内
 */
router.get('/student/:studentId', auth(), async (req, res, next) => {
  try {
    // 非数字的 studentId 直接 400，避免数据库类型转换错误变成 500。
    const studentId = Number.parseInt(req.params.studentId, 10);
    if (!Number.isFinite(studentId)) {
      return res.status(400).json({ message: '学生 ID 不合法' });
    }

    if (req.user.role === 'student') {
      if (!req.user.studentId || Number(req.user.studentId) !== studentId) {
        return res.status(403).json({ message: '只能查看本人的成绩' });
      }
    } else if (!canAccess(req.user, 'gradeRecords', 'view')) {
      return res.status(403).json({ message: '没有成绩记录的查看权限' });
    } else if (req.user.dataScope !== 'all') {
      // 教师按所带班级收窄：路径里的学生不在自己班上就当作看不到
      const scope = studentScope(req.user, 's');
      const [visible] = await pool.query(
        `SELECT 1 FROM students s WHERE s.id = ?${scope ? ` AND (${scope.sql})` : ''} LIMIT 1`,
        [studentId, ...(scope?.params || [])]
      );
      if (!visible.length) return res.status(403).json({ message: '该学生不在你的数据范围内' });
    }

    // 默认页大小与门户成绩单保持一致（public/js/portal.js 的 GRADES_PAGE_SIZE）：
    // 不带 pageSize 的调用方拿到的页大小若与页面不同，totalPages 的算法就跟着不同，
    // 同一份数据会算出两套翻页结果。
    const parsed = parsePageQuery(req.query, { defaultPageSize: 10 });
    const params = [studentId];
    let whereSql = 'WHERE gr.student_id = ?';
    if (parsed.keyword) {
      whereSql += ' AND (gr.course_name LIKE ? ESCAPE \'!\' OR gr.course_code LIKE ? ESCAPE \'!\')';
      const like = `%${escapeLike(parsed.keyword)}%`;
      params.push(like, like);
    }

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total FROM grade_records gr ${whereSql}`,
      params
    );
    const [items] = await pool.query(
      `SELECT gr.id, gr.course_code, gr.course_name, gr.original_grade, gr.original_type,
              gr.original_credit, gr.adapted_score, gr.adapted_gpa, gr.adapted_credit,
              gr.passed, gr.rule_version, gr.adapt_status, gr.exception_reason,
              gr.audit_status, gr.created_at, es.name AS source_school_name
       FROM grade_records gr
       LEFT JOIN external_schools es ON es.id = gr.source_school_id
       ${whereSql}
       ORDER BY gr.id DESC LIMIT ${Number(parsed.pageSize)} OFFSET ${Number(parsed.offset)}`,
      params
    );

    res.json(
      buildPageEnvelope(items, {
        page: parsed.page,
        pageSize: parsed.pageSize,
        total: Number(countRow?.total || 0),
        keyword: parsed.keyword
      })
    );
  } catch (error) {
    next(error);
  }
});

/**
 * 成绩审核是复核动作，录入者不能自己审自己：教师对成绩菜单有修改位（管理台可以改成绩记录），
 * 但不含审核。这里用数据范围区分——只有全平台范围的管理端角色能审。
 */
function requireAudit(req, res, next) {
  if (!canAccess(req.user, 'gradeRecords', 'update') || req.user.dataScope !== 'all') {
    return res.status(403).json({ message: '没有成绩审核权限' });
  }
  next();
}

router.patch('/:id/audit', auth(), requireAudit, async (req, res, next) => {
  try {
    const { auditStatus } = req.body;
    await pool.execute(
      'UPDATE grade_records SET audit_status = :auditStatus, audited_by = :auditedBy, audited_at = NOW() WHERE id = :id',
      { auditStatus, auditedBy: req.user.id, id: req.params.id }
    );
    res.json({ id: Number(req.params.id), auditStatus });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
