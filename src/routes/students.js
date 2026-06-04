const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');

const router = express.Router();

router.get('/me', auth(['student']), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT s.*, c.name AS class_name, n.name_zh AS nationality_zh, n.name_en AS nationality_en
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       LEFT JOIN nationalities n ON n.id = s.nationality_id
       WHERE s.user_id = :userId`,
      { userId: req.user.id }
    );
    res.json(rows[0] || null);
  } catch (error) {
    next(error);
  }
});

router.get('/', auth(['admin', 'teacher']), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT s.id, s.student_no, s.chinese_name, s.english_name, s.gender, s.enrollment_year,
              s.status, c.name AS class_name, n.name_zh AS nationality
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       LEFT JOIN nationalities n ON n.id = s.nationality_id
       ORDER BY s.id DESC`
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post('/', auth(['admin']), async (req, res, next) => {
  try {
    const data = req.body;
    const [result] = await pool.execute(
      `INSERT INTO students
       (user_id, student_no, chinese_name, english_name, gender, birth_date, nationality_id,
        passport_no, passport_expiry, phone, email, emergency_contact, enrollment_year,
        major, college, class_id, status)
       VALUES (:userId, :studentNo, :chineseName, :englishName, :gender, :birthDate, :nationalityId,
        :passportNo, :passportExpiry, :phone, :email, :emergencyContact, :enrollmentYear,
        :major, :college, :classId, :status)`,
      {
        userId: data.userId || null,
        studentNo: data.studentNo,
        chineseName: data.chineseName || null,
        englishName: data.englishName,
        gender: data.gender || null,
        birthDate: data.birthDate || null,
        nationalityId: data.nationalityId || null,
        passportNo: data.passportNo || null,
        passportExpiry: data.passportExpiry || null,
        phone: data.phone || null,
        email: data.email || null,
        emergencyContact: data.emergencyContact || null,
        enrollmentYear: data.enrollmentYear || null,
        major: data.major || null,
        college: data.college || null,
        classId: data.classId || null,
        status: data.status || 'active'
      }
    );
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
