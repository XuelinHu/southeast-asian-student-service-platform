const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const { requireMenu } = require('../middleware/auth');
const { parseListQuery, runPaginatedQuery } = require('../services/pagination');

const router = express.Router();

// 教师名册的分页描述子。教师角色本身没有 teachers 菜单，看不到同行的档案。
const TEACHER_LIST = {
  selectColumns:
    't.id, t.teacher_no, t.name, t.college, t.teacher_type, t.phone, t.email, t.user_id, u.username',
  baseFrom: 'FROM teachers t LEFT JOIN users u ON u.id = t.user_id',
  primaryKeyColumn: 't.id',
  searchable: ['t.teacher_no', 't.name', 't.college'],
  filters: {
    teacherType: { column: 't.teacher_type', values: ['course_teacher', 'head_teacher', 'counselor', 'admin_teacher'] },
    college: { column: 't.college', type: 'like' }
  },
  sortable: { id: 't.id', teacherNo: 't.teacher_no', name: 't.name', college: 't.college' },
  defaultSort: 't.id DESC'
};

router.get('/', auth(), requireMenu('teachers'), async (req, res, next) => {
  try {
    const parsed = parseListQuery(req.query, TEACHER_LIST);
    res.json(await runPaginatedQuery(TEACHER_LIST, parsed));
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

router.post('/', auth(), requireMenu('teachers', 'create'), async (req, res, next) => {
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
