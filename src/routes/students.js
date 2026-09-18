const express = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const { requireMenu } = require('../middleware/auth');
const { parseListQuery, runPaginatedQuery } = require('../services/pagination');
const { studentScope } = require('../services/scope');

const router = express.Router();

// 学生名册的分页查询描述子。和 config/resources.js 里的注册项形状一致，
// 但这里只声明本接口用得上的部分：管理台那份要喂给通用 CRUD 与自动生成的表格。
const STUDENT_LIST = {
  selectColumns:
    's.id, s.student_no, s.chinese_name, s.english_name, s.gender, s.enrollment_year, ' +
    's.status, c.name AS class_name, n.name_zh AS nationality',
  baseFrom:
    'FROM students s ' +
    'LEFT JOIN classes c ON c.id = s.class_id ' +
    'LEFT JOIN nationalities n ON n.id = s.nationality_id',
  primaryKeyColumn: 's.id',
  searchable: ['s.student_no', 's.chinese_name', 's.english_name'],
  filters: {
    status: { column: 's.status', values: ['active', 'suspended', 'withdrawn', 'graduated', 'delayed'] },
    classId: { column: 's.class_id', type: 'int' },
    enrollmentYear: { column: 's.enrollment_year', type: 'int' },
    nationalityId: { column: 's.nationality_id', type: 'int' }
  },
  sortable: {
    id: 's.id',
    studentNo: 's.student_no',
    enrollmentYear: 's.enrollment_year',
    status: 's.status'
  },
  defaultSort: 's.id DESC'
};

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

// 学生名册：教师按所带班级收窄，管理员不限（见 services/scope.js）。
// 授权按角色菜单走 —— 教务处、学工处都能看，审计员与学生看不到。
router.get('/', auth(), requireMenu('students'), async (req, res, next) => {
  try {
    const parsed = parseListQuery(req.query, STUDENT_LIST, studentScope(req.user, 's'));
    res.json(await runPaginatedQuery(STUDENT_LIST, parsed));
  } catch (error) {
    next(error);
  }
});

router.post('/', auth(), requireMenu('students', 'create'), async (req, res, next) => {
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
