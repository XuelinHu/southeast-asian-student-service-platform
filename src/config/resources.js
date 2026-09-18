// 管理台资源注册表（声明式）。
//
// 每个菜单一条，管理台的分页查询、搜索、排序、筛选、增删改、表格列、编辑表单
// 全部由这里驱动，路由层和前端都不再单独写死字段。约定：
//   * selectColumns / baseFrom / sortable / filters / searchable / displayColumns
//     只在本文件里定义，绝不接受来自请求的标识符 —— 这是防 SQL 注入的根本保障。
//   * fields 描述可写字段；不在 fields 里的列（如 created_at、password_hash）
//     永远无法被创建或修改接口写入。
//   * displayColumns[].key 必须等于 selectColumns 里的输出列名（别名），
//     前端拿它当取值键；sortable 指向 sortable 映射里的键。
//   * options 自带 from / valueColumn / labelColumn，不能复用目标资源的 baseFrom：
//     带 JOIN 的资源里 id / name 是歧义列（实测 classes JOIN teachers 会直接报错）。
//
// 本文件**不声明任何 roles 数组**。角色能看见哪些菜单由 roles 表 + role_menus 表决定，
// 见 src/config/roles.js；在这里再写一份"哪个角色能看"必然与库里的勾选结果打架。

const { visibleMenuKeys, canAccess, grantedTeacherTypes } = require('./roles');

const STUDENT_STATUS = ['active', 'suspended', 'withdrawn', 'graduated', 'delayed'];
// 角色不再是写死的枚举：取值来自 roles 表，users.role_id 外键指向它。
// 角色的名称与菜单授权见 src/config/roles.js 与 role_menus 表。
const USER_STATUS = ['active', 'disabled'];
const ROLE_SCOPES = ['user', 'staff'];
const DATA_SCOPES = ['self', 'class', 'all'];
const TEACHER_TYPES = ['course_teacher', 'head_teacher', 'counselor', 'admin_teacher'];
const DORMITORY_STATUS = ['available', 'occupied', 'reserved', 'maintenance'];
const VISA_STATUS = ['valid', 'expiring', 'expired', 'renewing'];
const WARNING_LEVELS = ['none', 'notice', 'warning', 'serious'];
const ADAPT_STATUS = ['pending', 'success', 'exception'];
const AUDIT_STATUS = ['pending', 'approved', 'rejected', 'archived'];
const GRADE_TYPES = ['percent', 'letter', 'gpa', 'pass_fail'];
const INTEGRATION_TYPES = ['api', 'excel', 'csv', 'manual', 'scheduled_sync'];
const RECORD_STATUS = ['active', 'disabled'];
const AGENT_STATUS = ['success', 'error', 'aborted'];

// 枚举值的中文标签：既用于表头筛选下拉，也用于表格里的徽章文案
const ENUM_LABELS = {
  active: '启用', disabled: '停用',
  suspended: '休学', withdrawn: '退学', graduated: '毕业', delayed: '延期',
  // 角色代码的中文名以 roles 表为准（角色可增删），这里只兜底日志与快照里的历史值
  student: '留学生', teacher: '教师', admin: '管理员',
  super_admin: '超级管理员', academic_admin: '教务管理员',
  welfare_admin: '学工后勤管理员', auditor: '审计员',
  user: '用户端', staff: '管理端',
  self: '仅本人', class: '本人所带班级', all: '全部',
  course_teacher: '任课教师', head_teacher: '班主任', counselor: '辅导员', admin_teacher: '教务',
  available: '空闲', occupied: '在用', reserved: '预留', maintenance: '维修',
  valid: '有效', expiring: '临期', expired: '过期', renewing: '续签中',
  none: '无', notice: '提示', warning: '预警', serious: '严重',
  pending: '待处理', success: '成功', exception: '异常',
  approved: '已通过', rejected: '已驳回', archived: '已归档',
  percent: '百分制', letter: '等级制', gpa: 'GPA', pass_fail: '通过制',
  api: '接口', excel: 'Excel', csv: 'CSV', manual: '手工', scheduled_sync: '定时同步',
  error: '失败', aborted: '已中断'
};

// 徽章底色：决定表格里用绿/橙/红哪种状态色
const ENUM_TONES = {
  active: 'ok', success: 'ok', approved: 'ok', valid: 'ok', available: 'ok',
  disabled: 'danger', expired: 'danger', exception: 'danger', rejected: 'danger',
  error: 'danger', serious: 'danger', withdrawn: 'danger', maintenance: 'danger',
  suspended: 'warning', delayed: 'warning', expiring: 'warning', renewing: 'warning',
  pending: 'warning', warning: 'warning', reserved: 'warning', notice: 'warning',
  aborted: 'warning'
};

// 可复用的下拉数据源
const STUDENT_OPTION = {
  from: 'FROM students s',
  valueColumn: 's.id',
  labelColumn: "CONCAT(s.student_no, ' ', COALESCE(s.chinese_name, s.english_name, ''))",
  orderBy: 's.student_no'
};
const TEACHER_OPTION = {
  from: 'FROM teachers t',
  valueColumn: 't.id',
  labelColumn: "CONCAT(t.teacher_no, ' ', t.name)",
  orderBy: 't.teacher_no'
};
// 角色下拉：取值来自 roles 表，所以角色是增是减都不需要改这里。
// 刻意不过滤 status：筛选器也用这个数据源，停用角色下的存量账号仍然要查得出来。
const ROLE_OPTION = {
  name: 'roleId',
  from: 'FROM roles r',
  valueColumn: 'r.id',
  labelColumn: "CONCAT(r.name, '（', r.code, '）')",
  orderBy: 'r.sort_order, r.id'
};

const resources = {
  // ---------------------------------------------------------------- 用户
  users: {
    key: 'users',
    label: '用户管理',
    group: '系统管理',
    table: 'users',
    primaryKey: 'id',
    primaryKeyColumn: 'u.id',
    // 角色列改成 JOIN roles 取名称：users 表里只有 role_id，不再冗余角色代码
    selectColumns:
      'u.id, u.username, u.role_id, r.code AS role_code, r.name AS role_name, u.display_name, ' +
      'u.email, u.phone, u.status, u.last_login_at, u.created_at',
    baseFrom: 'FROM users u LEFT JOIN roles r ON r.id = u.role_id',
    countColumn: 'u.id',
    searchable: ['u.username', 'u.display_name', 'u.email', 'u.phone'],
    searchPlaceholder: '账号 / 姓名 / 邮箱 / 手机号',
    filters: {
      roleId: { column: 'u.role_id', type: 'int', option: 'roleId', label: '角色' },
      status: { column: 'u.status', values: USER_STATUS, label: '状态' }
    },
    sortable: {
      id: 'u.id',
      username: 'u.username',
      roleId: 'u.role_id',
      status: 'u.status',
      createdAt: 'u.created_at',
      lastLoginAt: 'u.last_login_at'
    },
    defaultSort: 'u.id DESC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'username', label: '账号', sortable: 'username' },
      { key: 'display_name', label: '姓名' },
      { key: 'role_name', label: '角色' },
      { key: 'email', label: '邮箱' },
      { key: 'phone', label: '手机号' },
      { key: 'status', label: '状态', type: 'enum' },
      { key: 'last_login_at', label: '最后登录', type: 'datetime', sortable: 'lastLoginAt' },
      { key: 'created_at', label: '创建时间', type: 'datetime', sortable: 'createdAt' }
    ],
    fields: {
      displayName: { column: 'display_name', type: 'string', required: true, maxLength: 120, label: '姓名' },
      email: { column: 'email', type: 'string', maxLength: 120, label: '邮箱' },
      phone: { column: 'phone', type: 'string', maxLength: 40, label: '手机号' },
      roleId: { column: 'role_id', type: 'int', required: true, option: 'roleId', label: '角色' },
      status: { column: 'status', type: 'enum', values: USER_STATUS, label: '状态' },
      remark: { column: 'remark', type: 'string', maxLength: 255, label: '备注' }
    },
    options: [ROLE_OPTION],
    rowActions: ['resetPassword', 'toggleStatus'],
    canCreate: false, // 用户通过注册流程产生，管理台只做改、禁用、重置密码
    canUpdate: true,
    canDelete: false
  },

  // ---------------------------------------------------------------- 学生
  students: {
    key: 'students',
    label: '学生管理',
    group: '学籍管理',
    table: 'students',
    primaryKey: 'id',
    primaryKeyColumn: 's.id',
    selectColumns: `s.id, s.user_id, s.student_no, s.chinese_name, s.english_name, s.gender,
      s.birth_date, s.nationality_id, n.name_zh AS nationality_zh, n.name_en AS nationality_en,
      s.passport_no, s.passport_expiry, s.phone, s.email, s.emergency_contact,
      s.enrollment_year, s.major, s.college, s.class_id, c.name AS class_name,
      s.status, s.created_at`,
    baseFrom: `FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      LEFT JOIN nationalities n ON n.id = s.nationality_id`,
    countColumn: 's.id',
    searchable: ['s.student_no', 's.chinese_name', 's.english_name', 's.passport_no', 's.email', 's.phone'],
    searchPlaceholder: '学号 / 姓名 / 护照号 / 邮箱 / 手机号',
    filters: {
      status: { column: 's.status', values: STUDENT_STATUS, label: '状态' },
      classId: { column: 's.class_id', type: 'int', label: '班级', option: 'classId' },
      nationalityId: { column: 's.nationality_id', type: 'int', label: '国籍', option: 'nationalityId' },
      gender: { column: 's.gender', type: 'like', label: '性别' },
      enrollmentYear: { column: 's.enrollment_year', type: 'int', label: '入学年份' }
    },
    sortable: {
      id: 's.id',
      studentNo: 's.student_no',
      chineseName: 's.chinese_name',
      englishName: 's.english_name',
      enrollmentYear: 's.enrollment_year',
      passportExpiry: 's.passport_expiry',
      createdAt: 's.created_at'
    },
    defaultSort: 's.id DESC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'student_no', label: '学号', sortable: 'studentNo' },
      { key: 'chinese_name', label: '中文名', sortable: 'chineseName' },
      { key: 'english_name', label: '英文名', sortable: 'englishName' },
      { key: 'nationality_zh', label: '国籍' },
      { key: 'class_name', label: '班级' },
      { key: 'major', label: '专业' },
      { key: 'passport_expiry', label: '护照有效期', type: 'date', sortable: 'passportExpiry' },
      { key: 'status', label: '状态', type: 'enum' }
    ],
    fields: {
      studentNo: { column: 'student_no', type: 'string', required: true, maxLength: 64, label: '学号' },
      chineseName: { column: 'chinese_name', type: 'string', maxLength: 120, label: '中文名' },
      englishName: { column: 'english_name', type: 'string', required: true, maxLength: 120, label: '英文名' },
      gender: { column: 'gender', type: 'string', maxLength: 20, label: '性别' },
      birthDate: { column: 'birth_date', type: 'date', label: '出生日期' },
      nationalityId: { column: 'nationality_id', type: 'int', label: '国籍', option: 'nationalityId' },
      passportNo: { column: 'passport_no', type: 'string', maxLength: 80, label: '护照号' },
      passportExpiry: { column: 'passport_expiry', type: 'date', label: '护照有效期' },
      phone: { column: 'phone', type: 'string', maxLength: 40, label: '手机号' },
      email: { column: 'email', type: 'string', maxLength: 120, label: '邮箱' },
      emergencyContact: { column: 'emergency_contact', type: 'string', maxLength: 160, label: '紧急联系人' },
      enrollmentYear: { column: 'enrollment_year', type: 'int', label: '入学年份' },
      major: { column: 'major', type: 'string', maxLength: 120, label: '专业' },
      college: { column: 'college', type: 'string', maxLength: 120, label: '学院' },
      classId: { column: 'class_id', type: 'int', label: '班级', option: 'classId' },
      status: { column: 'status', type: 'enum', values: STUDENT_STATUS, label: '状态' }
    },
    options: [
      { name: 'classId', from: 'FROM classes c', valueColumn: 'c.id', labelColumn: 'c.name', orderBy: 'c.name' },
      { name: 'nationalityId', from: 'FROM nationalities n', valueColumn: 'n.id', labelColumn: 'n.name_zh', orderBy: 'n.name_zh' }
    ],
    // 数据范围口径：教师按 data_scope='class' 收窄时，用哪个维度过滤这张表。
    // 取值见 services/scope.js；管理端角色 data_scope='all'，不受影响。
    scope: 'student',
    canCreate: true,
    canUpdate: true,
    canDelete: true,
  },

  // ---------------------------------------------------------------- 教师
  teachers: {
    key: 'teachers',
    label: '教师管理',
    group: '学籍管理',
    table: 'teachers',
    primaryKey: 'id',
    primaryKeyColumn: 't.id',
    selectColumns:
      't.id, t.user_id, t.teacher_no, t.name, t.college, t.phone, t.email, t.teacher_type, t.created_at, u.username',
    baseFrom: 'FROM teachers t LEFT JOIN users u ON u.id = t.user_id',
    countColumn: 't.id',
    searchable: ['t.teacher_no', 't.name', 't.college', 't.email', 't.phone', 'u.username'],
    searchPlaceholder: '工号 / 姓名 / 学院 / 邮箱',
    filters: {
      teacherType: { column: 't.teacher_type', values: TEACHER_TYPES, label: '教师类型' },
      college: { column: 't.college', type: 'like', label: '学院' }
    },
    sortable: {
      id: 't.id',
      teacherNo: 't.teacher_no',
      name: 't.name',
      college: 't.college',
      createdAt: 't.created_at'
    },
    defaultSort: 't.id DESC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'teacher_no', label: '工号', sortable: 'teacherNo' },
      { key: 'name', label: '姓名', sortable: 'name' },
      { key: 'college', label: '学院', sortable: 'college' },
      { key: 'teacher_type', label: '教师类型', type: 'enum' },
      { key: 'username', label: '登录账号' },
      { key: 'email', label: '邮箱' },
      { key: 'phone', label: '手机号' }
    ],
    fields: {
      teacherNo: { column: 'teacher_no', type: 'string', required: true, maxLength: 64, label: '工号' },
      name: { column: 'name', type: 'string', required: true, maxLength: 120, label: '姓名' },
      college: { column: 'college', type: 'string', maxLength: 120, label: '学院' },
      phone: { column: 'phone', type: 'string', maxLength: 40, label: '手机号' },
      email: { column: 'email', type: 'string', maxLength: 120, label: '邮箱' },
      teacherType: { column: 'teacher_type', type: 'enum', values: TEACHER_TYPES, label: '教师类型' },
      userId: { column: 'user_id', type: 'int', label: '绑定登录账号', option: 'userId' }
    },
    options: [
      {
        name: 'userId',
        from: 'FROM users u',
        valueColumn: 'u.id',
        labelColumn: 'u.username',
        orderBy: 'u.username',
        where: "u.role IN ('teacher','admin')"
      }
    ],
    canCreate: true,
    canUpdate: true,
    canDelete: true,
  },

  // ---------------------------------------------------------------- 班级
  classes: {
    key: 'classes',
    label: '班级管理',
    group: '学籍管理',
    table: 'classes',
    primaryKey: 'id',
    primaryKeyColumn: 'c.id',
    selectColumns:
      'c.id, c.code, c.name, c.college, c.major, c.teacher_id, t.name AS teacher_name, c.enrollment_year, c.created_at',
    baseFrom: 'FROM classes c LEFT JOIN teachers t ON t.id = c.teacher_id',
    countColumn: 'c.id',
    searchable: ['c.code', 'c.name', 'c.college', 'c.major'],
    searchPlaceholder: '班级编码 / 名称 / 学院 / 专业',
    filters: {
      college: { column: 'c.college', type: 'like', label: '学院' },
      major: { column: 'c.major', type: 'like', label: '专业' },
      teacherId: { column: 'c.teacher_id', type: 'int', label: '班主任', option: 'teacherId' },
      enrollmentYear: { column: 'c.enrollment_year', type: 'int', label: '入学年份' }
    },
    sortable: {
      id: 'c.id',
      code: 'c.code',
      name: 'c.name',
      enrollmentYear: 'c.enrollment_year',
      createdAt: 'c.created_at'
    },
    defaultSort: 'c.id DESC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'code', label: '班级编码', sortable: 'code' },
      { key: 'name', label: '班级名称', sortable: 'name' },
      { key: 'college', label: '学院' },
      { key: 'major', label: '专业' },
      { key: 'teacher_name', label: '班主任' },
      { key: 'enrollment_year', label: '入学年份', type: 'number', sortable: 'enrollmentYear' }
    ],
    fields: {
      code: { column: 'code', type: 'string', required: true, maxLength: 64, label: '班级编码' },
      name: { column: 'name', type: 'string', required: true, maxLength: 120, label: '班级名称' },
      college: { column: 'college', type: 'string', maxLength: 120, label: '学院' },
      major: { column: 'major', type: 'string', maxLength: 120, label: '专业' },
      teacherId: { column: 'teacher_id', type: 'int', label: '班主任', option: 'teacherId' },
      enrollmentYear: { column: 'enrollment_year', type: 'int', label: '入学年份' }
    },
    options: [
      { name: 'teacherId', from: 'FROM teachers t', valueColumn: 't.id', labelColumn: 't.name', orderBy: 't.name' }
    ],
    // 数据范围口径：教师按 data_scope='class' 收窄时，用哪个维度过滤这张表。
    // 取值见 services/scope.js；管理端角色 data_scope='all'，不受影响。
    scope: 'class',
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    // 班级维护按 teachers.teacher_type 分权：教师角色只有班主任与教务能改班级。
    // 声明在这里是为了让权限矩阵知道"这个菜单的某些角色行需要选教师类型"，
    // 否则抽屉保存时会把它读到的 teacher_types 当作可丢弃的字段抹掉。
    teacherScoped: true,
  },

  // ---------------------------------------------------------------- 国籍
  nationalities: {
    key: 'nationalities',
    label: '国籍管理',
    group: '基础数据',
    table: 'nationalities',
    primaryKey: 'id',
    primaryKeyColumn: 'id',
    selectColumns:
      'id, country_code, name_zh, name_en, continent, primary_language, timezone, status, sort_order',
    baseFrom: 'FROM nationalities',
    countColumn: 'id',
    searchable: ['country_code', 'name_zh', 'name_en', 'continent', 'primary_language'],
    searchPlaceholder: '国家代码 / 中英文名 / 洲别',
    filters: {
      continent: { column: 'continent', type: 'like', label: '洲别' },
      status: { column: 'status', values: RECORD_STATUS, label: '状态' }
    },
    sortable: {
      id: 'id',
      countryCode: 'country_code',
      nameZh: 'name_zh',
      nameEn: 'name_en',
      sortOrder: 'sort_order'
    },
    defaultSort: 'sort_order ASC, name_en ASC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'country_code', label: '国家代码', sortable: 'countryCode' },
      { key: 'name_zh', label: '中文名', sortable: 'nameZh' },
      { key: 'name_en', label: '英文名', sortable: 'nameEn' },
      { key: 'continent', label: '洲别' },
      { key: 'primary_language', label: '主要语言' },
      { key: 'timezone', label: '时区' },
      { key: 'status', label: '状态', type: 'enum' },
      { key: 'sort_order', label: '排序', type: 'number', sortable: 'sortOrder' }
    ],
    fields: {
      countryCode: { column: 'country_code', type: 'string', required: true, maxLength: 8, label: '国家代码' },
      nameZh: { column: 'name_zh', type: 'string', required: true, maxLength: 120, label: '中文名' },
      nameEn: { column: 'name_en', type: 'string', required: true, maxLength: 120, label: '英文名' },
      continent: { column: 'continent', type: 'string', maxLength: 60, label: '洲别' },
      primaryLanguage: { column: 'primary_language', type: 'string', maxLength: 80, label: '主要语言' },
      timezone: { column: 'timezone', type: 'string', maxLength: 80, label: '时区' },
      status: { column: 'status', type: 'enum', values: RECORD_STATUS, label: '状态' },
      sortOrder: { column: 'sort_order', type: 'int', label: '排序' }
    },
    canCreate: true,
    canUpdate: true,
    canDelete: true,
  },

  // ---------------------------------------------------------------- 住宿
  dormitories: {
    key: 'dormitories',
    label: '住宿管理',
    group: '生活服务',
    table: 'dormitories',
    primaryKey: 'id',
    primaryKeyColumn: 'd.id',
    selectColumns: `d.id, d.building, d.room_no, d.bed_no, d.student_id,
      s.student_no, s.chinese_name, s.english_name, d.check_in_date, d.check_out_date, d.status`,
    baseFrom: 'FROM dormitories d LEFT JOIN students s ON s.id = d.student_id',
    countColumn: 'd.id',
    searchable: ['d.building', 'd.room_no', 'd.bed_no', 's.student_no', 's.chinese_name', 's.english_name'],
    searchPlaceholder: '楼栋 / 房间 / 床位 / 学号 / 姓名',
    filters: {
      status: { column: 'd.status', values: DORMITORY_STATUS, label: '床位状态' },
      building: { column: 'd.building', type: 'like', label: '楼栋' },
      studentId: { column: 'd.student_id', type: 'int', label: '学生', option: 'studentId' }
    },
    sortable: {
      id: 'd.id',
      building: 'd.building',
      roomNo: 'd.room_no',
      checkOutDate: 'd.check_out_date',
      status: 'd.status'
    },
    defaultSort: 'd.id DESC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'building', label: '楼栋', sortable: 'building' },
      { key: 'room_no', label: '房间', sortable: 'roomNo' },
      { key: 'bed_no', label: '床位' },
      { key: 'student_no', label: '学号' },
      { key: 'chinese_name', label: '学生' },
      { key: 'check_in_date', label: '入住日期', type: 'date' },
      { key: 'check_out_date', label: '退宿日期', type: 'date', sortable: 'checkOutDate' },
      { key: 'status', label: '床位状态', type: 'enum', sortable: 'status' }
    ],
    fields: {
      building: { column: 'building', type: 'string', required: true, maxLength: 120, label: '楼栋' },
      roomNo: { column: 'room_no', type: 'string', required: true, maxLength: 60, label: '房间' },
      bedNo: { column: 'bed_no', type: 'string', required: true, maxLength: 60, label: '床位' },
      studentId: { column: 'student_id', type: 'int', label: '学生', option: 'studentId' },
      checkInDate: { column: 'check_in_date', type: 'date', label: '入住日期' },
      checkOutDate: { column: 'check_out_date', type: 'date', label: '退宿日期' },
      status: { column: 'status', type: 'enum', values: DORMITORY_STATUS, label: '床位状态' }
    },
    options: [{ name: 'studentId', ...STUDENT_OPTION }],
    canCreate: true,
    canUpdate: true,
    canDelete: true,
  },

  // ---------------------------------------------------------------- 签证
  visas: {
    key: 'visas',
    label: '签证管理',
    group: '生活服务',
    table: 'visas',
    primaryKey: 'id',
    primaryKeyColumn: 'v.id',
    selectColumns: `v.id, v.student_id, s.student_no, s.chinese_name, s.english_name,
      v.visa_type, v.visa_no, v.issue_date, v.expiry_date, v.residence_permit_no,
      v.document_url, v.status,
      DATEDIFF(v.expiry_date, CURDATE()) AS days_to_expiry`,
    baseFrom: 'FROM visas v LEFT JOIN students s ON s.id = v.student_id',
    countColumn: 'v.id',
    searchable: ['s.student_no', 's.chinese_name', 's.english_name', 'v.visa_no', 'v.residence_permit_no'],
    searchPlaceholder: '学号 / 姓名 / 签证号 / 居留许可号',
    filters: {
      status: { column: 'v.status', values: VISA_STATUS, label: '签证状态' },
      visaType: { column: 'v.visa_type', type: 'like', label: '签证类型' },
      studentId: { column: 'v.student_id', type: 'int', label: '学生', option: 'studentId' }
    },
    sortable: {
      id: 'v.id',
      expiryDate: 'v.expiry_date',
      issueDate: 'v.issue_date',
      status: 'v.status',
      daysToExpiry: 'days_to_expiry'
    },
    defaultSort: 'v.expiry_date ASC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'student_no', label: '学号' },
      { key: 'chinese_name', label: '学生' },
      { key: 'visa_type', label: '签证类型' },
      { key: 'visa_no', label: '签证号' },
      { key: 'issue_date', label: '签发日期', type: 'date', sortable: 'issueDate' },
      { key: 'expiry_date', label: '到期日期', type: 'date', sortable: 'expiryDate' },
      { key: 'days_to_expiry', label: '剩余天数', type: 'days', sortable: 'daysToExpiry' },
      { key: 'status', label: '状态', type: 'enum', sortable: 'status' }
    ],
    fields: {
      studentId: { column: 'student_id', type: 'int', required: true, label: '学生', option: 'studentId' },
      visaType: { column: 'visa_type', type: 'string', required: true, maxLength: 80, label: '签证类型' },
      visaNo: { column: 'visa_no', type: 'string', maxLength: 120, label: '签证号' },
      issueDate: { column: 'issue_date', type: 'date', label: '签发日期' },
      expiryDate: { column: 'expiry_date', type: 'date', required: true, label: '到期日期' },
      residencePermitNo: { column: 'residence_permit_no', type: 'string', maxLength: 120, label: '居留许可号' },
      documentUrl: { column: 'document_url', type: 'string', maxLength: 255, label: '材料链接' },
      status: { column: 'status', type: 'enum', values: VISA_STATUS, label: '状态' }
    },
    options: [{ name: 'studentId', ...STUDENT_OPTION }],
    canCreate: true,
    canUpdate: true,
    canDelete: true,
  },

  // ---------------------------------------------------------------- 学习情况
  studyRecords: {
    key: 'studyRecords',
    label: '学习情况',
    group: '学业管理',
    table: 'study_records',
    primaryKey: 'id',
    primaryKeyColumn: 'sr.id',
    selectColumns: `sr.id, sr.student_id, s.student_no, s.chinese_name, s.english_name,
      sr.course_code, sr.course_name, sr.attendance_rate, sr.homework_status,
      sr.class_performance, sr.warning_level, sr.teacher_id, t.name AS teacher_name, sr.recorded_at`,
    baseFrom: `FROM study_records sr
      LEFT JOIN students s ON s.id = sr.student_id
      LEFT JOIN teachers t ON t.id = sr.teacher_id`,
    countColumn: 'sr.id',
    searchable: ['s.student_no', 's.chinese_name', 's.english_name', 'sr.course_code', 'sr.course_name'],
    searchPlaceholder: '学号 / 姓名 / 课程编码 / 课程名',
    filters: {
      warningLevel: { column: 'sr.warning_level', values: WARNING_LEVELS, label: '预警级别' },
      studentId: { column: 'sr.student_id', type: 'int', label: '学生', option: 'studentId' },
      teacherId: { column: 'sr.teacher_id', type: 'int', label: '任课教师', option: 'teacherId' },
      courseName: { column: 'sr.course_name', type: 'like', label: '课程名' }
    },
    sortable: {
      id: 'sr.id',
      attendanceRate: 'sr.attendance_rate',
      warningLevel: 'sr.warning_level',
      recordedAt: 'sr.recorded_at'
    },
    defaultSort: 'sr.id DESC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'student_no', label: '学号' },
      { key: 'chinese_name', label: '学生' },
      { key: 'course_name', label: '课程' },
      { key: 'attendance_rate', label: '出勤率', type: 'percent', sortable: 'attendanceRate' },
      { key: 'homework_status', label: '作业情况' },
      { key: 'warning_level', label: '预警级别', type: 'enum', sortable: 'warningLevel' },
      { key: 'teacher_name', label: '任课教师' },
      { key: 'recorded_at', label: '记录时间', type: 'datetime', sortable: 'recordedAt' }
    ],
    fields: {
      studentId: { column: 'student_id', type: 'int', required: true, label: '学生', option: 'studentId' },
      courseCode: { column: 'course_code', type: 'string', maxLength: 80, label: '课程编码' },
      courseName: { column: 'course_name', type: 'string', required: true, maxLength: 160, label: '课程名' },
      attendanceRate: { column: 'attendance_rate', type: 'decimal', min: 0, max: 100, label: '出勤率(%)' },
      homeworkStatus: { column: 'homework_status', type: 'string', maxLength: 120, label: '作业情况' },
      classPerformance: { column: 'class_performance', type: 'string', maxLength: 255, label: '课堂表现' },
      warningLevel: { column: 'warning_level', type: 'enum', values: WARNING_LEVELS, label: '预警级别' },
      teacherId: { column: 'teacher_id', type: 'int', label: '任课教师', option: 'teacherId' }
    },
    options: [{ name: 'studentId', ...STUDENT_OPTION }, { name: 'teacherId', ...TEACHER_OPTION }],
    // 数据范围口径：教师按 data_scope='class' 收窄时，用哪个维度过滤这张表。
    // 取值见 services/scope.js；管理端角色 data_scope='all'，不受影响。
    scope: 'student',
    canCreate: true,
    canUpdate: true,
    canDelete: true,
  },

  // ---------------------------------------------------------------- 成绩记录
  gradeRecords: {
    key: 'gradeRecords',
    label: '成绩记录',
    group: '学业管理',
    table: 'grade_records',
    primaryKey: 'id',
    primaryKeyColumn: 'gr.id',
    selectColumns: `gr.id, gr.student_id, s.student_no, s.chinese_name, s.english_name,
      gr.course_code, gr.course_name, gr.source_school_id, es.name AS source_school_name,
      gr.source_country_code, gr.original_grade, gr.original_type, gr.original_credit,
      gr.adapted_score, gr.adapted_gpa, gr.adapted_credit, gr.passed, gr.rule_version,
      gr.adapt_status, gr.exception_reason, gr.audit_status, gr.audited_at, gr.created_at`,
    baseFrom: `FROM grade_records gr
      LEFT JOIN students s ON s.id = gr.student_id
      LEFT JOIN external_schools es ON es.id = gr.source_school_id`,
    countColumn: 'gr.id',
    searchable: ['s.student_no', 's.chinese_name', 's.english_name', 'gr.course_code', 'gr.course_name'],
    searchPlaceholder: '学号 / 姓名 / 课程编码 / 课程名',
    filters: {
      adaptStatus: { column: 'gr.adapt_status', values: ADAPT_STATUS, label: '适配状态' },
      auditStatus: { column: 'gr.audit_status', values: AUDIT_STATUS, label: '审核状态' },
      originalType: { column: 'gr.original_type', values: GRADE_TYPES, label: '原始成绩类型' },
      studentId: { column: 'gr.student_id', type: 'int', label: '学生', option: 'studentId' },
      sourceSchoolId: { column: 'gr.source_school_id', type: 'int', label: '来源学校', option: 'sourceSchoolId' }
    },
    sortable: {
      id: 'gr.id',
      adaptedScore: 'gr.adapted_score',
      adaptedGpa: 'gr.adapted_gpa',
      createdAt: 'gr.created_at'
    },
    defaultSort: 'gr.id DESC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'student_no', label: '学号' },
      { key: 'chinese_name', label: '学生' },
      { key: 'course_name', label: '课程' },
      { key: 'source_school_name', label: '来源学校' },
      { key: 'original_grade', label: '原始成绩' },
      { key: 'original_type', label: '原始类型', type: 'enum' },
      { key: 'adapted_score', label: '适配成绩', type: 'number', sortable: 'adaptedScore' },
      { key: 'adapted_gpa', label: '适配 GPA', type: 'number', sortable: 'adaptedGpa' },
      { key: 'passed', label: '是否通过', type: 'boolean' },
      { key: 'rule_version', label: '规则版本' },
      { key: 'adapt_status', label: '适配状态', type: 'enum' },
      { key: 'audit_status', label: '审核状态', type: 'enum' },
      { key: 'created_at', label: '创建时间', type: 'datetime', sortable: 'createdAt' }
    ],
    fields: {
      studentId: { column: 'student_id', type: 'int', required: true, label: '学生', option: 'studentId' },
      courseCode: { column: 'course_code', type: 'string', maxLength: 80, label: '课程编码' },
      courseName: { column: 'course_name', type: 'string', maxLength: 160, label: '课程名' },
      sourceSchoolId: { column: 'source_school_id', type: 'int', label: '来源学校', option: 'sourceSchoolId' },
      sourceCountryCode: { column: 'source_country_code', type: 'string', maxLength: 8, label: '来源国家代码' },
      originalGrade: { column: 'original_grade', type: 'string', maxLength: 40, label: '原始成绩' },
      originalType: { column: 'original_type', type: 'enum', values: GRADE_TYPES, label: '原始成绩类型' },
      originalCredit: { column: 'original_credit', type: 'decimal', min: 0, max: 999, label: '原始学分' },
      adaptedScore: { column: 'adapted_score', type: 'decimal', min: 0, max: 100, label: '适配成绩' },
      adaptedGpa: { column: 'adapted_gpa', type: 'decimal', min: 0, max: 5, label: '适配 GPA' },
      adaptedCredit: { column: 'adapted_credit', type: 'decimal', min: 0, max: 999, label: '适配学分' },
      passed: { column: 'passed', type: 'boolean', label: '是否通过' },
      ruleVersion: { column: 'rule_version', type: 'string', maxLength: 40, label: '规则版本' },
      adaptStatus: { column: 'adapt_status', type: 'enum', values: ADAPT_STATUS, label: '适配状态' },
      exceptionReason: { column: 'exception_reason', type: 'string', maxLength: 255, label: '异常原因' },
      auditStatus: { column: 'audit_status', type: 'enum', values: AUDIT_STATUS, label: '审核状态' }
    },
    options: [
      { name: 'studentId', ...STUDENT_OPTION },
      { name: 'sourceSchoolId', from: 'FROM external_schools es', valueColumn: 'es.id', labelColumn: 'es.name', orderBy: 'es.name' }
    ],
    // 数据范围口径：教师按 data_scope='class' 收窄时，用哪个维度过滤这张表。
    // 取值见 services/scope.js；管理端角色 data_scope='all'，不受影响。
    scope: 'student',
    canCreate: false, // 成绩通过 /api/grades/adapt 适配流程写入
    canUpdate: true,
    canDelete: true,
  },

  // ---------------------------------------------------------------- 成绩规则
  gradeRules: {
    key: 'gradeRules',
    label: '成绩规则',
    group: '学业管理',
    table: 'grade_rules',
    primaryKey: 'id',
    primaryKeyColumn: 'gr.id',
    selectColumns: `gr.id, gr.school_id, es.name AS school_name, gr.country_code, gr.name, gr.version,
      gr.gpa_scale, gr.credit_ratio, gr.pass_score, gr.status, gr.effective_from, gr.effective_to, gr.created_at`,
    baseFrom: 'FROM grade_rules gr LEFT JOIN external_schools es ON es.id = gr.school_id',
    countColumn: 'gr.id',
    searchable: ['gr.name', 'gr.version', 'gr.country_code', 'es.name'],
    searchPlaceholder: '规则名 / 版本 / 国家代码 / 学校名',
    filters: {
      status: { column: 'gr.status', values: RECORD_STATUS, label: '状态' },
      countryCode: { column: 'gr.country_code', type: 'like', label: '国家代码' },
      schoolId: { column: 'gr.school_id', type: 'int', label: '学校', option: 'schoolId' }
    },
    sortable: { id: 'gr.id', name: 'gr.name', version: 'gr.version', gpaScale: 'gr.gpa_scale', createdAt: 'gr.created_at' },
    defaultSort: 'gr.id DESC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'name', label: '规则名称', sortable: 'name' },
      { key: 'version', label: '版本', sortable: 'version' },
      { key: 'school_name', label: '适用学校' },
      { key: 'country_code', label: '国家代码' },
      { key: 'gpa_scale', label: 'GPA 满分', type: 'number', sortable: 'gpaScale' },
      { key: 'credit_ratio', label: '学分系数', type: 'number' },
      { key: 'pass_score', label: '及格分', type: 'number' },
      { key: 'status', label: '状态', type: 'enum' },
      { key: 'effective_from', label: '生效日期', type: 'date' },
      { key: 'effective_to', label: '失效日期', type: 'date' }
    ],
    fields: {
      schoolId: { column: 'school_id', type: 'int', label: '适用学校', option: 'schoolId' },
      countryCode: { column: 'country_code', type: 'string', maxLength: 8, label: '国家代码' },
      name: { column: 'name', type: 'string', required: true, maxLength: 160, label: '规则名称' },
      version: { column: 'version', type: 'string', required: true, maxLength: 40, label: '版本' },
      gpaScale: { column: 'gpa_scale', type: 'decimal', min: 0, max: 10, label: 'GPA 满分' },
      creditRatio: { column: 'credit_ratio', type: 'decimal', min: 0, max: 10, label: '学分系数' },
      passScore: { column: 'pass_score', type: 'decimal', min: 0, max: 100, label: '及格分' },
      status: { column: 'status', type: 'enum', values: RECORD_STATUS, label: '状态' },
      effectiveFrom: { column: 'effective_from', type: 'date', label: '生效日期' },
      effectiveTo: { column: 'effective_to', type: 'date', label: '失效日期' }
    },
    options: [
      { name: 'schoolId', from: 'FROM external_schools es', valueColumn: 'es.id', labelColumn: 'es.name', orderBy: 'es.name' }
    ],
    canCreate: true,
    canUpdate: true,
    canDelete: true,
  },

  // ---------------------------------------------------------------- 外部学校
  externalSchools: {
    key: 'externalSchools',
    label: '对接学校',
    group: '学业管理',
    table: 'external_schools',
    primaryKey: 'id',
    primaryKeyColumn: 'id',
    selectColumns:
      'id, country_code, name, contact_name, contact_email, integration_type, endpoint_url, status',
    baseFrom: 'FROM external_schools',
    countColumn: 'id',
    searchable: ['name', 'country_code', 'contact_name', 'contact_email'],
    searchPlaceholder: '学校名 / 国家代码 / 联系人 / 邮箱',
    filters: {
      integrationType: { column: 'integration_type', values: INTEGRATION_TYPES, label: '对接方式' },
      status: { column: 'status', values: RECORD_STATUS, label: '状态' },
      countryCode: { column: 'country_code', type: 'like', label: '国家代码' }
    },
    sortable: { id: 'id', name: 'name', countryCode: 'country_code', status: 'status' },
    defaultSort: 'id DESC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'name', label: '学校名称', sortable: 'name' },
      { key: 'country_code', label: '国家代码', sortable: 'countryCode' },
      { key: 'contact_name', label: '联系人' },
      { key: 'contact_email', label: '联系邮箱' },
      { key: 'integration_type', label: '对接方式', type: 'enum' },
      { key: 'endpoint_url', label: '接口地址' },
      { key: 'status', label: '状态', type: 'enum', sortable: 'status' }
    ],
    fields: {
      countryCode: { column: 'country_code', type: 'string', maxLength: 8, label: '国家代码' },
      name: { column: 'name', type: 'string', required: true, maxLength: 180, label: '学校名称' },
      contactName: { column: 'contact_name', type: 'string', maxLength: 120, label: '联系人' },
      contactEmail: { column: 'contact_email', type: 'string', maxLength: 120, label: '联系邮箱' },
      integrationType: { column: 'integration_type', type: 'enum', values: INTEGRATION_TYPES, label: '对接方式' },
      endpointUrl: { column: 'endpoint_url', type: 'string', maxLength: 255, label: '接口地址' },
      status: { column: 'status', type: 'enum', values: RECORD_STATUS, label: '状态' }
    },
    canCreate: true,
    canUpdate: true,
    canDelete: true,
  },

  // ---------------------------------------------------------------- 登录日志
  loginLogs: {
    key: 'loginLogs',
    label: '登录日志',
    group: '系统管理',
    table: 'login_logs',
    primaryKey: 'id',
    primaryKeyColumn: 'll.id',
    selectColumns:
      'll.id, ll.user_id, ll.username, ll.role, ll.success, ll.message, ll.ip, ll.user_agent, ll.created_at',
    baseFrom: 'FROM login_logs ll',
    countColumn: 'll.id',
    searchable: ['ll.username', 'll.ip', 'll.message', 'll.user_agent'],
    searchPlaceholder: '账号 / IP / 消息 / User-Agent',
    filters: {
      success: { column: 'll.success', type: 'int', label: '是否成功' },
      // 登录日志里的 role 是**写入当时的角色代码快照**，可能含 guest 与已改名的历史值，
      // 所以这里用包含匹配而不是角色表白名单：白名单会把历史行筛没。
      role: { column: 'll.role', type: 'like', label: '角色' },
      username: { column: 'll.username', type: 'like', label: '账号' }
    },
    sortable: { id: 'll.id', username: 'll.username', createdAt: 'll.created_at' },
    defaultSort: 'll.id DESC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'username', label: '账号', sortable: 'username' },
      { key: 'role', label: '角色', type: 'enum' },
      { key: 'success', label: '结果', type: 'boolean' },
      { key: 'message', label: '说明' },
      { key: 'ip', label: 'IP' },
      { key: 'user_agent', label: 'User-Agent' },
      { key: 'created_at', label: '时间', type: 'datetime', sortable: 'createdAt' }
    ],
    fields: {},
    canCreate: false,
    canUpdate: false,
    canDelete: true,
  },

  // ---------------------------------------------------------------- 智能体问答记录
  agentMessages: {
    key: 'agentMessages',
    label: '问答记录',
    group: '智能体',
    table: 'agent_messages',
    primaryKey: 'id',
    primaryKeyColumn: 'am.id',
    selectColumns: `am.id, am.conversation_id, am.turn_index, am.user_id, am.username,
      am.role, am.model, am.provider, am.question, am.answer, am.tool_calls, am.tool_rounds,
      am.status, am.error_message, am.latency_ms, am.created_at`,
    baseFrom: 'FROM agent_messages am',
    countColumn: 'am.id',
    searchable: ['am.username', 'am.question', 'am.answer', 'am.model'],
    searchPlaceholder: '账号 / 提问 / 回答 / 模型',
    filters: {
      status: { column: 'am.status', values: AGENT_STATUS, label: '状态' },
      provider: { column: 'am.provider', type: 'like', label: '模型来源' },
      // 同登录日志：存的是提问当时的角色快照，含 guest，用包含匹配
      role: { column: 'am.role', type: 'like', label: '提问角色' },
      model: { column: 'am.model', type: 'like', label: '模型' }
    },
    sortable: { id: 'am.id', latencyMs: 'am.latency_ms', createdAt: 'am.created_at' },
    defaultSort: 'am.id DESC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'conversation_id', label: '会话' },
      { key: 'username', label: '账号' },
      { key: 'role', label: '角色', type: 'enum' },
      { key: 'model', label: '模型' },
      { key: 'question', label: '提问', type: 'truncate' },
      { key: 'answer', label: '回答', type: 'truncate' },
      { key: 'tool_rounds', label: '工具轮次', type: 'number' },
      { key: 'latency_ms', label: '耗时(ms)', type: 'number', sortable: 'latencyMs' },
      { key: 'status', label: '状态', type: 'enum' },
      { key: 'created_at', label: '时间', type: 'datetime', sortable: 'createdAt' }
    ],
    fields: {},
    canCreate: false,
    canUpdate: false,
    canDelete: true,
  },

  // ---------------------------------------------------------------- 角色管理
  // 第 14 个菜单，也是唯一一个"权限自己管自己"的菜单：只有超级管理员默认可见。
  // role_menus 的勾选矩阵不单独开菜单，放在本菜单行内的权限抽屉里（见 roleMenus 接口）。
  roles: {
    key: 'roles',
    label: '角色管理',
    group: '系统管理',
    table: 'roles',
    primaryKey: 'id',
    primaryKeyColumn: 'r.id',
    selectColumns: `r.id, r.code, r.name, r.scope, r.data_scope, r.description,
      r.is_super, r.is_builtin, r.status, r.sort_order, r.created_at`,
    baseFrom: 'FROM roles r',
    countColumn: 'r.id',
    searchable: ['r.code', 'r.name', 'r.description'],
    searchPlaceholder: '角色代码 / 名称 / 说明',
    filters: {
      scope: { column: 'r.scope', values: ROLE_SCOPES, label: '归属端' },
      dataScope: { column: 'r.data_scope', values: DATA_SCOPES, label: '数据范围' },
      status: { column: 'r.status', values: USER_STATUS, label: '状态' }
    },
    sortable: { id: 'r.id', code: 'r.code', name: 'r.name', sortOrder: 'r.sort_order' },
    defaultSort: 'r.sort_order ASC, r.id ASC',
    displayColumns: [
      { key: 'id', label: 'ID', type: 'number' },
      { key: 'code', label: '角色代码', sortable: 'code' },
      { key: 'name', label: '角色名称', sortable: 'name' },
      { key: 'scope', label: '归属端', type: 'enum' },
      { key: 'data_scope', label: '数据范围', type: 'enum' },
      { key: 'is_super', label: '超管', type: 'boolean' },
      { key: 'is_builtin', label: '内置', type: 'boolean' },
      { key: 'status', label: '状态', type: 'enum' },
      { key: 'description', label: '说明', type: 'truncate' }
    ],
    // code / scope / is_super / is_builtin 刻意不可写：改角色代码会让历史日志快照对不上，
    // 改 scope 会让用户端账号跑进管理台。要调整权限请走权限抽屉。
    fields: {
      name: { column: 'name', type: 'string', required: true, maxLength: 60, label: '角色名称' },
      description: { column: 'description', type: 'string', maxLength: 255, label: '说明' },
      dataScope: { column: 'data_scope', type: 'enum', values: DATA_SCOPES, label: '数据范围' },
      status: { column: 'status', type: 'enum', values: USER_STATUS, label: '状态' },
      sortOrder: { column: 'sort_order', type: 'int', label: '排序' }
    },
    rowActions: ['permissions'],
    canCreate: false, // 本轮只支持改内置角色的菜单权限，不支持新建角色
    canUpdate: true,
    canDelete: false  // 内置角色不可删除
  }
};

// 侧边栏顺序
const menuOrder = [
  'users',
  'roles',
  'students',
  'teachers',
  'classes',
  'nationalities',
  'dormitories',
  'visas',
  'studyRecords',
  'gradeRecords',
  'gradeRules',
  'externalSchools',
  'loginLogs',
  'agentMessages'
];

function getResource(key) {
  return resources[key] || null;
}

/**
 * 供管理台前端渲染的元数据。前端据此自动生成菜单、表格列、筛选器、编辑表单，
 * 不在页面里写死任何字段名。
 *
 * 权限判据是 role_menus 表（登录时由 middleware/auth.js 读进 user.menus），
 * 不是本文件：本文件只描述"菜单长什么样"。资源自带的 canCreate/canUpdate/canDelete
 * 表示"这个菜单本身支不支持写操作"（问答记录天生不可编辑），与角色的授权位取交集后，
 * 才是前端最终看到的按钮集合。服务端写入前会再校验一次，前端隐藏按钮只是体验。
 */
function listResourcesForUser(user) {
  const visibleKeys = visibleMenuKeys(user); // null = 超管不限
  const allowed = visibleKeys === null ? null : new Set(visibleKeys);

  return menuOrder
    .map((key) => resources[key])
    .filter((resource) => resource && (allowed === null || allowed.has(resource.key)))
    .map((resource) => ({
      key: resource.key,
      label: resource.label,
      group: resource.group,
      searchPlaceholder: resource.searchPlaceholder || '输入关键词搜索',
      canCreate: Boolean(resource.canCreate) && canAccess(user, resource.key, 'create'),
      canUpdate: Boolean(resource.canUpdate) && canAccess(user, resource.key, 'update'),
      canDelete: Boolean(resource.canDelete) && canAccess(user, resource.key, 'delete'),
      // 教师角色在 classes 菜单上按 teacher_type 再收窄；null 表示不限
      teacherTypes: grantedTeacherTypes(user, resource.key),
      rowActions: resource.rowActions || [],
      columns: resource.displayColumns || [],
      // 只暴露 name/label/option，from/valueColumn 是服务端 SQL 细节，不给前端
      filters: Object.fromEntries(
        Object.entries(resource.filters || {}).map(([name, filter]) => [
          name,
          {
            type: filter.type || 'enum',
            label: filter.label || name,
            values: filter.values || null,
            option: filter.option || null
          }
        ])
      ),
      fields: Object.fromEntries(
        Object.entries(resource.fields || {}).map(([name, field]) => [
          name,
          {
            // 接口返回的行是下划线列名，字段名是驼峰，前端要靠 key 回填表单
            key: field.column,
            label: field.label || name,
            type: field.type || 'string',
            required: Boolean(field.required),
            maxLength: field.maxLength,
            min: field.min,
            max: field.max,
            values: field.values || null,
            option: field.option || null
          }
        ])
      ),
      options: (resource.options || []).map((option) => option.name)
    }));
}

module.exports = {
  resources,
  menuOrder,
  getResource,
  listResourcesForUser,
  ENUM_LABELS,
  ENUM_TONES
};
