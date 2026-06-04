const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');

const router = express.Router();

router.get('/', auth(['admin']), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT t.*, u.username
       FROM teachers t
       LEFT JOIN users u ON u.id = t.user_id
       ORDER BY t.id DESC`
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get('/me/classes', auth(['teacher']), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT c.*
       FROM classes c
       JOIN teachers t ON t.id = c.teacher_id
       WHERE t.user_id = :userId`,
      { userId: req.user.id }
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
      `INSERT INTO teachers (user_id, teacher_no, name, college, phone, email, teacher_type)
       VALUES (:userId, :teacherNo, :name, :college, :phone, :email, :teacherType)`,
      {
        userId: data.userId || null,
        teacherNo: data.teacherNo,
        name: data.name,
        college: data.college || null,
        phone: data.phone || null,
        email: data.email || null,
        teacherType: data.teacherType || 'course_teacher'
      }
    );
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
