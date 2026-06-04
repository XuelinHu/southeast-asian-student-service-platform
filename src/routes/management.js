const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');

const router = express.Router();

router.get('/dashboard', auth(['admin', 'teacher']), async (req, res, next) => {
  try {
    const [[students]] = await pool.execute('SELECT COUNT(*) AS count FROM students');
    const [[teachers]] = await pool.execute('SELECT COUNT(*) AS count FROM teachers');
    const [[visaWarnings]] = await pool.execute(
      'SELECT COUNT(*) AS count FROM visas WHERE expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 60 DAY)'
    );
    const [[gradeExceptions]] = await pool.execute(
      "SELECT COUNT(*) AS count FROM grade_records WHERE adapt_status = 'exception'"
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

router.get('/nationalities', auth(['admin', 'teacher', 'student']), async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM nationalities ORDER BY name_en');
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get('/classes', auth(['admin', 'teacher']), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT c.*, t.name AS teacher_name
       FROM classes c
       LEFT JOIN teachers t ON t.id = c.teacher_id
       ORDER BY c.id DESC`
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get('/risks', auth(['admin', 'teacher']), async (req, res, next) => {
  try {
    const [visaRisks] = await pool.execute(
      `SELECT 'visa_expiring' AS risk_type, s.student_no, s.english_name, s.chinese_name,
              v.expiry_date AS risk_date,
              CONCAT('Visa expires on ', DATE_FORMAT(v.expiry_date, '%Y-%m-%d')) AS detail
       FROM visas v
       JOIN students s ON s.id = v.student_id
       WHERE v.expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 60 DAY)
       ORDER BY v.expiry_date ASC
       LIMIT 100`
    );

    const [gradeRisks] = await pool.execute(
      `SELECT 'grade_exception' AS risk_type, s.student_no, s.english_name, s.chinese_name,
              gr.created_at AS risk_date,
              CONCAT(COALESCE(gr.course_name, 'Unknown course'), ': ', COALESCE(gr.exception_reason, gr.adapt_status)) AS detail
       FROM grade_records gr
       JOIN students s ON s.id = gr.student_id
       WHERE gr.adapt_status = 'exception'
       ORDER BY gr.created_at DESC
       LIMIT 100`
    );

    const [lowScoreRisks] = await pool.execute(
      `SELECT 'low_score' AS risk_type, s.student_no, s.english_name, s.chinese_name,
              gr.created_at AS risk_date,
              CONCAT(COALESCE(gr.course_name, 'Unknown course'), ': adapted score ', gr.adapted_score) AS detail
       FROM grade_records gr
       JOIN students s ON s.id = gr.student_id
       WHERE gr.adapted_score IS NOT NULL AND gr.adapted_score < 60
       ORDER BY gr.adapted_score ASC
       LIMIT 100`
    );

    const [learningRisks] = await pool.execute(
      `SELECT 'learning_warning' AS risk_type, s.student_no, s.english_name, s.chinese_name,
              sr.recorded_at AS risk_date,
              CONCAT(sr.course_name, ': ', sr.warning_level, ', attendance ', COALESCE(sr.attendance_rate, 0), '%') AS detail
       FROM study_records sr
       JOIN students s ON s.id = sr.student_id
       WHERE sr.warning_level IN ('warning', 'serious') OR sr.attendance_rate < 70
       ORDER BY sr.recorded_at DESC
       LIMIT 100`
    );

    const [dormitoryRisks] = await pool.execute(
      `SELECT 'dormitory_exception' AS risk_type, s.student_no, s.english_name, s.chinese_name,
              d.check_out_date AS risk_date,
              CONCAT(d.building, '-', d.room_no, '-', d.bed_no, ': ', d.status) AS detail
       FROM dormitories d
       JOIN students s ON s.id = d.student_id
       WHERE d.status IN ('maintenance', 'reserved') OR d.check_out_date < CURDATE()
       ORDER BY d.check_out_date ASC
       LIMIT 100`
    );

    const items = [...visaRisks, ...gradeRisks, ...lowScoreRisks, ...learningRisks, ...dormitoryRisks];
    const summary = items.reduce((acc, item) => {
      acc[item.risk_type] = (acc[item.risk_type] || 0) + 1;
      return acc;
    }, {});

    res.json({ summary, items });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
