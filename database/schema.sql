CREATE DATABASE IF NOT EXISTS international_student_platform
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE international_student_platform;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('student', 'teacher', 'admin') NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nationalities (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  country_code VARCHAR(8) NOT NULL UNIQUE,
  name_zh VARCHAR(120) NOT NULL,
  name_en VARCHAR(120) NOT NULL,
  continent VARCHAR(60),
  primary_language VARCHAR(80),
  timezone VARCHAR(80)
);

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

INSERT IGNORE INTO users (id, username, password_hash, role, display_name)
VALUES
  (1, 'admin', '$2a$10$JGOz7ZAw2wwr58Or4MCR6u/pZqPR0V321yii2Il3lXl24EIehaDrW', 'admin', 'System Admin'),
  (2, 'teacher01', '$2a$10$JGOz7ZAw2wwr58Or4MCR6u/pZqPR0V321yii2Il3lXl24EIehaDrW', 'teacher', 'Teacher Demo'),
  (3, 'student01', '$2a$10$JGOz7ZAw2wwr58Or4MCR6u/pZqPR0V321yii2Il3lXl24EIehaDrW', 'student', 'Student Demo');

UPDATE users
SET password_hash = '$2a$10$JGOz7ZAw2wwr58Or4MCR6u/pZqPR0V321yii2Il3lXl24EIehaDrW'
WHERE username IN ('admin', 'teacher01', 'student01');

INSERT IGNORE INTO nationalities (id, country_code, name_zh, name_en, continent, primary_language, timezone)
VALUES
  (1, 'TH', '泰国', 'Thailand', 'Asia', 'Thai', 'Asia/Bangkok'),
  (2, 'VN', '越南', 'Vietnam', 'Asia', 'Vietnamese', 'Asia/Ho_Chi_Minh'),
  (3, 'MY', '马来西亚', 'Malaysia', 'Asia', 'Malay', 'Asia/Kuala_Lumpur'),
  (4, 'ID', '印度尼西亚', 'Indonesia', 'Asia', 'Indonesian', 'Asia/Jakarta');

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
