CREATE DATABASE IF NOT EXISTS international_student_platform
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE international_student_platform;

-- ===========================================================================
-- 公共模块：roles / role_menus / users / nationalities / login_logs / agent_messages
-- 这六张表被所有业务模块共用，结构改动影响面最大，列级 COMMENT 写全，
-- 设计说明书的数据设计章直接引用本文件。
-- ===========================================================================

CREATE TABLE IF NOT EXISTS roles (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(32) NOT NULL UNIQUE COMMENT '角色代码，写入令牌、接口校验与日志快照；一经启用不再改名',
  name VARCHAR(60) NOT NULL COMMENT '角色名称，管理台可改',
  scope ENUM('user', 'staff') NOT NULL COMMENT '归属端：user=用户端，staff=管理端',
  data_scope ENUM('self', 'class', 'all') NOT NULL DEFAULT 'self' COMMENT '可见数据范围：仅本人/本人所带班级/全部',
  description VARCHAR(255) NULL COMMENT '职责说明，显示在角色管理页',
  is_super TINYINT(1) NOT NULL DEFAULT 0 COMMENT '超级管理员：跳过菜单授权校验，防止误删授权行后无人能进管理台',
  is_builtin TINYINT(1) NOT NULL DEFAULT 0 COMMENT '内置角色：不可删除，只能改名称与菜单勾选',
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active' COMMENT '停用后该角色下所有账号无法登录',
  sort_order INT NOT NULL DEFAULT 0 COMMENT '管理台显示顺序',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) COMMENT='角色定义';

CREATE TABLE IF NOT EXISTS role_menus (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  role_id BIGINT NOT NULL COMMENT '所属角色',
  menu_key VARCHAR(64) NOT NULL COMMENT '菜单标识，对应 src/config/resources.js 里的资源 key',
  can_view TINYINT(1) NOT NULL DEFAULT 1 COMMENT '可查看（能进这个菜单、能看到列表）',
  can_create TINYINT(1) NOT NULL DEFAULT 0 COMMENT '可新增',
  can_update TINYINT(1) NOT NULL DEFAULT 0 COMMENT '可修改',
  can_delete TINYINT(1) NOT NULL DEFAULT 0 COMMENT '可删除',
  teacher_types VARCHAR(120) NULL COMMENT '仅教师角色使用：允许的 teachers.teacher_type 白名单，NULL 表示不限',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_role_menu (role_id, menu_key),
  CONSTRAINT fk_role_menus_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
) COMMENT='角色菜单权限';

CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(64) NOT NULL UNIQUE COMMENT '登录账号',
  password_hash VARCHAR(255) NOT NULL COMMENT 'bcrypt 摘要，任何接口都不返回',
  role_id BIGINT NOT NULL COMMENT '所属角色；角色代码经 roles.code 解析，账号本身不存角色字符串',
  display_name VARCHAR(120) NOT NULL COMMENT '显示名',
  email VARCHAR(120) NULL COMMENT '联系邮箱，个人中心可自行修改；不做唯一约束',
  phone VARCHAR(40) NULL COMMENT '联系电话，个人中心可自行修改；不做唯一约束',
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active' COMMENT 'disabled 禁止登录，历史数据保留',
  remark VARCHAR(255) NULL COMMENT '管理台备注，如停用原因',
  last_login_at TIMESTAMP NULL COMMENT '最近一次登录成功时间',
  token_version INT NOT NULL DEFAULT 0 COMMENT '改密与退出登录时自增，使已签发的旧令牌立即失效',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_role (role_id),
  INDEX idx_users_status (status),
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id)
) COMMENT='账号';

CREATE TABLE IF NOT EXISTS nationalities (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  country_code VARCHAR(8) NOT NULL UNIQUE COMMENT 'ISO 3166-1 两位代码，成绩规则按它匹配',
  name_zh VARCHAR(120) NOT NULL COMMENT '中文国名',
  name_en VARCHAR(120) NOT NULL COMMENT '英文国名',
  continent VARCHAR(60) COMMENT '所属洲',
  primary_language VARCHAR(80) COMMENT '主要语言',
  timezone VARCHAR(80) COMMENT '时区，用于按当地时间算签证剩余天数',
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active' COMMENT '停用后不再出现在新增学生的下拉里，历史数据保留',
  sort_order INT NOT NULL DEFAULT 0 COMMENT '下拉与列表显示顺序',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) COMMENT='国籍字典';

CREATE TABLE IF NOT EXISTS teachers (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNIQUE,
  teacher_no VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  college VARCHAR(120),
  phone VARCHAR(40),
  email VARCHAR(120),
  teacher_type ENUM('course_teacher', 'head_teacher', 'counselor', 'admin_teacher') NOT NULL DEFAULT 'course_teacher',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_teachers_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS classes (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  college VARCHAR(120),
  major VARCHAR(120),
  teacher_id BIGINT,
  enrollment_year INT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_classes_teacher FOREIGN KEY (teacher_id) REFERENCES teachers(id)
);

CREATE TABLE IF NOT EXISTS students (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNIQUE,
  student_no VARCHAR(64) NOT NULL UNIQUE,
  chinese_name VARCHAR(120),
  english_name VARCHAR(120) NOT NULL,
  gender VARCHAR(20),
  birth_date DATE,
  nationality_id BIGINT,
  passport_no VARCHAR(80),
  passport_expiry DATE,
  phone VARCHAR(40),
  email VARCHAR(120),
  emergency_contact VARCHAR(160),
  enrollment_year INT,
  major VARCHAR(120),
  college VARCHAR(120),
  class_id BIGINT,
  status ENUM('active', 'suspended', 'withdrawn', 'graduated', 'delayed') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_students_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_students_nationality FOREIGN KEY (nationality_id) REFERENCES nationalities(id),
  CONSTRAINT fk_students_class FOREIGN KEY (class_id) REFERENCES classes(id)
);

CREATE TABLE IF NOT EXISTS dormitories (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  building VARCHAR(120) NOT NULL,
  room_no VARCHAR(60) NOT NULL,
  bed_no VARCHAR(60) NOT NULL,
  student_id BIGINT,
  check_in_date DATE,
  check_out_date DATE,
  status ENUM('available', 'occupied', 'reserved', 'maintenance') NOT NULL DEFAULT 'available',
  CONSTRAINT fk_dormitories_student FOREIGN KEY (student_id) REFERENCES students(id)
);

CREATE TABLE IF NOT EXISTS visas (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  student_id BIGINT NOT NULL,
  visa_type VARCHAR(80) NOT NULL,
  visa_no VARCHAR(120),
  issue_date DATE,
  expiry_date DATE NOT NULL,
  residence_permit_no VARCHAR(120),
  document_url VARCHAR(255),
  status ENUM('valid', 'expiring', 'expired', 'renewing') NOT NULL DEFAULT 'valid',
  CONSTRAINT fk_visas_student FOREIGN KEY (student_id) REFERENCES students(id)
);

CREATE TABLE IF NOT EXISTS study_records (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  student_id BIGINT NOT NULL,
  course_code VARCHAR(80),
  course_name VARCHAR(160) NOT NULL,
  attendance_rate DECIMAL(5,2),
  homework_status VARCHAR(120),
  class_performance VARCHAR(255),
  warning_level ENUM('none', 'notice', 'warning', 'serious') NOT NULL DEFAULT 'none',
  teacher_id BIGINT,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_study_records_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT fk_study_records_teacher FOREIGN KEY (teacher_id) REFERENCES teachers(id)
);

CREATE TABLE IF NOT EXISTS external_schools (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  country_code VARCHAR(8),
  name VARCHAR(180) NOT NULL,
  contact_name VARCHAR(120),
  contact_email VARCHAR(120),
  integration_type ENUM('api', 'excel', 'csv', 'manual', 'scheduled_sync') NOT NULL DEFAULT 'manual',
  endpoint_url VARCHAR(255),
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS grade_rules (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  school_id BIGINT,
  country_code VARCHAR(8),
  name VARCHAR(160) NOT NULL,
  version VARCHAR(40) NOT NULL,
  gpa_scale DECIMAL(4,2) NOT NULL DEFAULT 4.00,
  credit_ratio DECIMAL(6,3) NOT NULL DEFAULT 1.000,
  pass_score DECIMAL(5,2) NOT NULL DEFAULT 60.00,
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  effective_from DATE,
  effective_to DATE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_grade_rules_school FOREIGN KEY (school_id) REFERENCES external_schools(id)
);

CREATE TABLE IF NOT EXISTS grade_records (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  student_id BIGINT NOT NULL,
  course_code VARCHAR(80),
  course_name VARCHAR(160),
  source_school_id BIGINT,
  source_country_code VARCHAR(8),
  original_grade VARCHAR(40),
  original_type ENUM('percent', 'letter', 'gpa', 'pass_fail'),
  original_credit DECIMAL(6,2) DEFAULT 0,
  adapted_score DECIMAL(5,2),
  adapted_gpa DECIMAL(4,2),
  adapted_credit DECIMAL(6,2),
  passed TINYINT(1),
  rule_version VARCHAR(40),
  adapt_status ENUM('pending', 'success', 'exception') NOT NULL DEFAULT 'pending',
  exception_reason VARCHAR(255),
  audit_status ENUM('pending', 'approved', 'rejected', 'archived') NOT NULL DEFAULT 'pending',
  audited_by BIGINT,
  audited_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_grade_records_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT fk_grade_records_school FOREIGN KEY (source_school_id) REFERENCES external_schools(id),
  CONSTRAINT fk_grade_records_auditor FOREIGN KEY (audited_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS login_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NULL COMMENT '命中的账号；账号不存在时为 NULL，登录失败也要留痕',
  username VARCHAR(64) NOT NULL COMMENT '提交上来的账号原文',
  -- 存的是登录当时的角色代码快照，不是外键。角色改名或账号删号后这里必须保持当时的样子，
  -- 所以它是 VARCHAR 而不是 role_id；'guest' 也出现在这一列（未登录访问）。
  role VARCHAR(32) NULL COMMENT '登录当时的角色代码快照',
  success TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=登录成功，0=失败',
  message VARCHAR(255) NULL COMMENT '失败原因或成功提示',
  ip VARCHAR(64) NULL COMMENT '来源 IP',
  user_agent VARCHAR(255) NULL COMMENT '浏览器标识，截断到 255',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_login_logs_created (created_at),
  INDEX idx_login_logs_username (username),
  INDEX idx_login_logs_success_created (success, created_at),
  CONSTRAINT fk_login_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) COMMENT='登录审计日志';

CREATE TABLE IF NOT EXISTS agent_messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NULL COMMENT '提问账号；游客为 NULL',
  username VARCHAR(64) NULL COMMENT '提问账号名快照',
  role VARCHAR(32) NULL COMMENT '提问当时的角色代码快照，游客为 guest',
  model VARCHAR(120) NOT NULL COMMENT '形如 ollama:qwen3:14b，只按第一个冒号切分',
  provider VARCHAR(40) NOT NULL COMMENT '推理服务商标识：ollama / deepseek / bailian 等',
  question TEXT NOT NULL COMMENT '用户提问原文',
  answer MEDIUMTEXT NULL COMMENT '模型最终回答',
  thinking MEDIUMTEXT NULL COMMENT '推理过程（仅带思考的模型有）',
  tool_calls TEXT NULL COMMENT '工具调用明细的 JSON 数组',
  tool_rounds INT NOT NULL DEFAULT 0 COMMENT '本轮编排实际用掉的工具轮数',
  conversation_id VARCHAR(64) NULL COMMENT '一次连续对话的标识，由前端每次进入页面生成，用于把多轮问答归组',
  turn_index INT NOT NULL DEFAULT 0 COMMENT '该会话内的第几轮，从 1 开始',
  status ENUM('success', 'error', 'aborted') NOT NULL DEFAULT 'success' COMMENT 'aborted 指用户中途停止生成',
  error_message VARCHAR(255) NULL COMMENT 'status 非 success 时的失败原因，成功时留空',
  latency_ms INT NULL COMMENT '端到端耗时（毫秒）',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_agent_messages_created (created_at),
  INDEX idx_agent_messages_user (user_id),
  INDEX idx_agent_messages_conversation (conversation_id),
  CONSTRAINT fk_agent_messages_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) COMMENT='智能体问答记录';

-- 内置角色。这里是"全新初始化"口径，与 src/config/roles.js 的 BUILTIN_ROLES 同源；
-- 已有库升级走 npm run db:migrate（按 code 幂等播种，只更新名称与排序，不覆盖菜单勾选）。
-- role_menus 的四十余行权限不在这里展开，避免同一份权限在两个文件里各维护一遍：
-- 建表后执行 npm run db:migrate 会按 roles.js 灌入。
INSERT IGNORE INTO roles (id, code, name, scope, data_scope, is_super, is_builtin, sort_order, description)
VALUES
  (1, 'super_admin',    '超级管理员',     'staff', 'all',   1, 1, 1, '拥有全部菜单与全部操作权限，可维护角色权限、重置密码、启用停用账号'),
  (2, 'academic_admin', '教务管理员',     'staff', 'all',   0, 1, 2, '负责学籍、师资、班级、国籍、学习情况、成绩适配与对接学校维护'),
  (3, 'welfare_admin',  '学工后勤管理员', 'staff', 'all',   0, 1, 3, '负责住宿分配、床位状态与签证居留许可维护，只读查看学生名册'),
  (4, 'auditor',        '审计员',         'staff', 'all',   0, 1, 4, '只读查看登录日志与智能体问答记录，不能修改任何业务数据'),
  (5, 'teacher',        '教师',           'user',  'class', 0, 1, 5, '查看本人所带班级的学生，录入学习情况与成绩'),
  (6, 'student',        '留学生',         'user',  'self',  0, 1, 6, '留学生本人账号，可查询本人档案与成绩、使用智能体问答');

-- 演示账号。role_id 用 roles.code 反查，不写字面 id：角色顺序若调整，这里不会静默指错。
-- 每个内置角色各留一个演示账号：4 个管理角色的菜单差异要看得到才好验收。
-- 密码统一 Admin@123，登录后请立即修改。
INSERT IGNORE INTO users (id, username, password_hash, role_id, display_name)
VALUES
  (1, 'admin', '$2a$10$JGOz7ZAw2wwr58Or4MCR6u/pZqPR0V321yii2Il3lXl24EIehaDrW',
   (SELECT id FROM roles WHERE code = 'super_admin'), 'System Admin'),
  (2, 'teacher01', '$2a$10$JGOz7ZAw2wwr58Or4MCR6u/pZqPR0V321yii2Il3lXl24EIehaDrW',
   (SELECT id FROM roles WHERE code = 'teacher'), 'Teacher Demo'),
  (3, 'student01', '$2a$10$JGOz7ZAw2wwr58Or4MCR6u/pZqPR0V321yii2Il3lXl24EIehaDrW',
   (SELECT id FROM roles WHERE code = 'student'), 'Student Demo'),
  (4, 'academic01', '$2a$10$JGOz7ZAw2wwr58Or4MCR6u/pZqPR0V321yii2Il3lXl24EIehaDrW',
   (SELECT id FROM roles WHERE code = 'academic_admin'), 'Academic Admin Demo'),
  (5, 'welfare01', '$2a$10$JGOz7ZAw2wwr58Or4MCR6u/pZqPR0V321yii2Il3lXl24EIehaDrW',
   (SELECT id FROM roles WHERE code = 'welfare_admin'), 'Welfare Admin Demo'),
  (6, 'auditor01', '$2a$10$JGOz7ZAw2wwr58Or4MCR6u/pZqPR0V321yii2Il3lXl24EIehaDrW',
   (SELECT id FROM roles WHERE code = 'auditor'), 'Auditor Demo');

UPDATE users
SET password_hash = '$2a$10$JGOz7ZAw2wwr58Or4MCR6u/pZqPR0V321yii2Il3lXl24EIehaDrW'
WHERE username IN ('admin', 'teacher01', 'student01', 'academic01', 'welfare01', 'auditor01');

INSERT IGNORE INTO nationalities
  (id, country_code, name_zh, name_en, continent, primary_language, timezone, status, sort_order)
VALUES
  (1, 'TH', '泰国', 'Thailand', 'Asia', 'Thai', 'Asia/Bangkok', 'active', 1),
  (2, 'VN', '越南', 'Vietnam', 'Asia', 'Vietnamese', 'Asia/Ho_Chi_Minh', 'active', 2),
  (3, 'MY', '马来西亚', 'Malaysia', 'Asia', 'Malay', 'Asia/Kuala_Lumpur', 'active', 3),
  (4, 'ID', '印度尼西亚', 'Indonesia', 'Asia', 'Indonesian', 'Asia/Jakarta', 'active', 4);

INSERT IGNORE INTO teachers (id, user_id, teacher_no, name, college, phone, email, teacher_type)
VALUES (1, 2, 'T2026001', 'Teacher Demo', 'International Education College', '13800000000', 'teacher@example.edu', 'head_teacher');

INSERT IGNORE INTO classes (id, code, name, college, major, teacher_id, enrollment_year)
VALUES (1, 'ISE-2026-A', 'International Student Class A', 'International Education College', 'Chinese Language', 1, 2026);

INSERT IGNORE INTO students
  (id, user_id, student_no, chinese_name, english_name, gender, birth_date, nationality_id,
   passport_no, passport_expiry, phone, email, emergency_contact, enrollment_year, major, college, class_id, status)
VALUES
  (1, 3, 'S2026001', '学生示例', 'Student Demo', 'Female', '2004-08-01', 1,
   'P000001', '2029-08-01', '13900000000', 'student@example.com', 'Family +66 000000', 2026,
   'Chinese Language', 'International Education College', 1, 'active');

INSERT IGNORE INTO external_schools (id, country_code, name, integration_type, status)
VALUES
  (1, 'TH', 'Demo Partner University Thailand', 'api', 'active'),
  (2, 'VN', 'Demo Partner College Vietnam', 'excel', 'active');

INSERT IGNORE INTO grade_rules (id, school_id, country_code, name, version, gpa_scale, credit_ratio, pass_score, status)
VALUES
  (1, NULL, NULL, 'Default international grade adapter', 'default-v1', 4.00, 1.000, 60.00, 'active'),
  (2, 1, 'TH', 'Thailand partner GPA rule', 'TH-GPA-2026', 4.00, 1.000, 60.00, 'active');
