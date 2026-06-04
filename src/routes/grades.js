const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const { adaptGrade } = require('../services/gradeAdapter');

const router = express.Router();

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

router.get('/', auth(['admin', 'teacher']), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT gr.*, s.student_no, s.english_name, s.chinese_name, es.name AS source_school_name
       FROM grade_records gr
       JOIN students s ON s.id = gr.student_id
       LEFT JOIN external_schools es ON es.id = gr.source_school_id
       ORDER BY gr.id DESC
       LIMIT 200`
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post('/adapt', auth(['admin', 'teacher']), async (req, res, next) => {
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

router.get('/student/:studentId', auth(['admin', 'teacher', 'student']), async (req, res, next) => {
  try {
    if (req.user.role === 'student') {
      const [owned] = await pool.execute('SELECT id FROM students WHERE user_id = :userId', { userId: req.user.id });
      if (!owned[0] || String(owned[0].id) !== String(req.params.studentId)) {
        return res.status(403).json({ message: 'Permission denied' });
      }
    }

    const [rows] = await pool.execute(
      `SELECT gr.*, es.name AS source_school_name
       FROM grade_records gr
       LEFT JOIN external_schools es ON es.id = gr.source_school_id
       WHERE gr.student_id = :studentId
       ORDER BY gr.id DESC`,
      { studentId: req.params.studentId }
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/audit', auth(['admin']), async (req, res, next) => {
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
