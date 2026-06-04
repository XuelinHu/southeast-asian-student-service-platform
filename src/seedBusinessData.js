const bcrypt = require('bcryptjs');
const pool = require('./config/db');
const { adaptGrade } = require('./services/gradeAdapter');

const passwordHash = bcrypt.hashSync('Admin@123', 10);
const countryCodes = [
  'TH', 'VN', 'MY', 'ID', 'PH', 'SG', 'LA', 'KH', 'MM', 'BN',
  'CN', 'JP', 'KR', 'IN', 'PK', 'BD', 'LK', 'NP', 'MN', 'KZ'
];
const gradeTypes = ['percent', 'letter', 'gpa', 'pass_fail'];
const letters = ['A', 'A-', 'B', 'B-', 'C', 'C-', 'D', 'F'];

function pad(num, size = 3) {
  return String(num).padStart(size, '0');
}

function datePlus(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function execute(sql, params = {}) {
  await pool.execute(sql, params);
}

async function seedUsers() {
  await execute(
    `INSERT INTO users (id, username, password_hash, role, display_name, status)
     VALUES (1, 'admin', :passwordHash, 'admin', 'System Admin', 'active')
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), status = 'active'`,
    { passwordHash }
  );

  for (let i = 1; i <= 120; i += 1) {
    await execute(
      `INSERT INTO users (id, username, password_hash, role, display_name, status)
       VALUES (:id, :username, :passwordHash, :role, :displayName, 'active')
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role), display_name = VALUES(display_name), status = 'active'`,
      {
        id: 1000 + i,
        username: `teacher${pad(i)}`,
        passwordHash,
        role: 'teacher',
        displayName: `Teacher ${pad(i)}`
      }
    );
  }

  for (let i = 1; i <= 180; i += 1) {
    await execute(
      `INSERT INTO users (id, username, password_hash, role, display_name, status)
       VALUES (:id, :username, :passwordHash, 'student', :displayName, 'active')
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'student', display_name = VALUES(display_name), status = 'active'`,
      {
        id: 2000 + i,
        username: `student${pad(i)}`,
        passwordHash,
        displayName: `International Student ${pad(i)}`
      }
    );
  }
}

async function seedNationalities() {
  for (let i = 1; i <= 120; i += 1) {
    const code = `${countryCodes[(i - 1) % countryCodes.length]}${pad(Math.ceil(i / countryCodes.length), 2)}`;
    await execute(
      `INSERT INTO nationalities (id, country_code, name_zh, name_en, continent, primary_language, timezone)
       VALUES (:id, :countryCode, :nameZh, :nameEn, 'Asia-Pacific', :language, :timezone)
       ON DUPLICATE KEY UPDATE name_zh = VALUES(name_zh), name_en = VALUES(name_en), primary_language = VALUES(primary_language), timezone = VALUES(timezone)`,
      {
        id: i,
        countryCode: code,
        nameZh: `国际生来源地${pad(i)}`,
        nameEn: `International Region ${pad(i)}`,
        language: `Language ${pad(((i - 1) % 20) + 1, 2)}`,
        timezone: `Asia/Test-${pad(((i - 1) % 24) + 1, 2)}`
      }
    );
  }
}

async function seedTeachers() {
  for (let i = 1; i <= 120; i += 1) {
    await execute(
      `INSERT INTO teachers (id, user_id, teacher_no, name, college, phone, email, teacher_type)
       VALUES (:id, :userId, :teacherNo, :name, :college, :phone, :email, :teacherType)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), name = VALUES(name), college = VALUES(college), phone = VALUES(phone), email = VALUES(email), teacher_type = VALUES(teacher_type)`,
      {
        id: i,
        userId: 1000 + i,
        teacherNo: `T2026${pad(i)}`,
        name: `Teacher ${pad(i)}`,
        college: i % 2 === 0 ? 'International Education College' : 'School of Language Studies',
        phone: `1380000${pad(i, 4)}`,
        email: `teacher${pad(i)}@example.edu`,
        teacherType: ['course_teacher', 'head_teacher', 'counselor', 'admin_teacher'][i % 4]
      }
    );
  }
}

async function seedClasses() {
  for (let i = 1; i <= 120; i += 1) {
    await execute(
      `INSERT INTO classes (id, code, name, college, major, teacher_id, enrollment_year)
       VALUES (:id, :code, :name, :college, :major, :teacherId, :year)
       ON DUPLICATE KEY UPDATE name = VALUES(name), college = VALUES(college), major = VALUES(major), teacher_id = VALUES(teacher_id), enrollment_year = VALUES(enrollment_year)`,
      {
        id: i,
        code: `ISE-2026-${pad(i)}`,
        name: `International Student Class ${pad(i)}`,
        college: i % 2 === 0 ? 'International Education College' : 'School of Language Studies',
        major: ['Chinese Language', 'Business Chinese', 'Computer Science', 'International Trade'][i % 4],
        teacherId: ((i - 1) % 120) + 1,
        year: 2024 + (i % 3)
      }
    );
  }
}

async function seedStudents() {
  for (let i = 1; i <= 180; i += 1) {
    await execute(
      `INSERT INTO students
       (id, user_id, student_no, chinese_name, english_name, gender, birth_date, nationality_id,
        passport_no, passport_expiry, phone, email, emergency_contact, enrollment_year, major, college, class_id, status)
       VALUES (:id, :userId, :studentNo, :chineseName, :englishName, :gender, :birthDate, :nationalityId,
        :passportNo, :passportExpiry, :phone, :email, :emergencyContact, :enrollmentYear, :major, :college, :classId, :status)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), chinese_name = VALUES(chinese_name), english_name = VALUES(english_name),
        nationality_id = VALUES(nationality_id), class_id = VALUES(class_id), status = VALUES(status)`,
      {
        id: i,
        userId: 2000 + i,
        studentNo: `S2026${pad(i)}`,
        chineseName: `留学生${pad(i)}`,
        englishName: `International Student ${pad(i)}`,
        gender: i % 2 === 0 ? 'Male' : 'Female',
        birthDate: `200${i % 6}-0${(i % 9) + 1}-15`,
        nationalityId: ((i - 1) % 120) + 1,
        passportNo: `P${pad(i, 6)}`,
        passportExpiry: datePlus(365 + i),
        phone: `1390000${pad(i, 4)}`,
        email: `student${pad(i)}@example.com`,
        emergencyContact: `Family Contact ${pad(i)}`,
        enrollmentYear: 2024 + (i % 3),
        major: ['Chinese Language', 'Business Chinese', 'Computer Science', 'International Trade'][i % 4],
        college: i % 2 === 0 ? 'International Education College' : 'School of Language Studies',
        classId: ((i - 1) % 120) + 1,
        status: ['active', 'active', 'active', 'delayed', 'suspended'][i % 5]
      }
    );
  }
}

async function seedDormitories() {
  for (let i = 1; i <= 180; i += 1) {
    await execute(
      `INSERT INTO dormitories (id, building, room_no, bed_no, student_id, check_in_date, check_out_date, status)
       VALUES (:id, :building, :roomNo, :bedNo, :studentId, :checkIn, :checkOut, :status)
       ON DUPLICATE KEY UPDATE student_id = VALUES(student_id), check_out_date = VALUES(check_out_date), status = VALUES(status)`,
      {
        id: i,
        building: `International Dorm ${((i - 1) % 8) + 1}`,
        roomNo: `${100 + ((i - 1) % 60)}`,
        bedNo: `${((i - 1) % 4) + 1}`,
        studentId: i,
        checkIn: '2026-09-01',
        checkOut: i % 17 === 0 ? datePlus(-5) : datePlus(200 + i),
        status: i % 29 === 0 ? 'maintenance' : 'occupied'
      }
    );
  }
}

async function seedVisas() {
  for (let i = 1; i <= 180; i += 1) {
    await execute(
      `INSERT INTO visas (id, student_id, visa_type, visa_no, issue_date, expiry_date, residence_permit_no, document_url, status)
       VALUES (:id, :studentId, :visaType, :visaNo, :issueDate, :expiryDate, :permitNo, :documentUrl, :status)
       ON DUPLICATE KEY UPDATE expiry_date = VALUES(expiry_date), status = VALUES(status)`,
      {
        id: i,
        studentId: i,
        visaType: i % 2 === 0 ? 'X1' : 'X2',
        visaNo: `VISA${pad(i, 6)}`,
        issueDate: '2026-01-10',
        expiryDate: i % 9 === 0 ? datePlus(20 + (i % 30)) : datePlus(180 + i),
        permitNo: `RP${pad(i, 6)}`,
        documentUrl: `/uploads/visa/${pad(i)}.pdf`,
        status: i % 9 === 0 ? 'expiring' : 'valid'
      }
    );
  }
}

async function seedStudyRecords() {
  for (let i = 1; i <= 240; i += 1) {
    const attendance = 55 + (i % 46);
    await execute(
      `INSERT INTO study_records
       (id, student_id, course_code, course_name, attendance_rate, homework_status, class_performance, warning_level, teacher_id)
       VALUES (:id, :studentId, :courseCode, :courseName, :attendance, :homeworkStatus, :performance, :warningLevel, :teacherId)
       ON DUPLICATE KEY UPDATE attendance_rate = VALUES(attendance_rate), warning_level = VALUES(warning_level), teacher_id = VALUES(teacher_id)`,
      {
        id: i,
        studentId: ((i - 1) % 180) + 1,
        courseCode: `CN${100 + (i % 12)}`,
        courseName: ['Chinese Listening', 'Chinese Speaking', 'Chinese Reading', 'Academic Writing'][i % 4],
        attendance,
        homeworkStatus: attendance < 70 ? 'Incomplete' : 'Completed',
        performance: attendance < 70 ? 'Needs support' : 'Normal',
        warningLevel: attendance < 65 ? 'serious' : attendance < 75 ? 'warning' : 'none',
        teacherId: ((i - 1) % 120) + 1
      }
    );
  }
}

async function seedExternalSchools() {
  for (let i = 1; i <= 120; i += 1) {
    await execute(
      `INSERT INTO external_schools (id, country_code, name, contact_name, contact_email, integration_type, endpoint_url, status)
       VALUES (:id, :countryCode, :name, :contactName, :contactEmail, :integrationType, :endpointUrl, 'active')
       ON DUPLICATE KEY UPDATE country_code = VALUES(country_code), name = VALUES(name), integration_type = VALUES(integration_type), endpoint_url = VALUES(endpoint_url), status = 'active'`,
      {
        id: i,
        countryCode: `${countryCodes[(i - 1) % countryCodes.length]}${pad(Math.ceil(i / countryCodes.length), 2)}`,
        name: `Partner School ${pad(i)}`,
        contactName: `Partner Contact ${pad(i)}`,
        contactEmail: `partner${pad(i)}@school.example`,
        integrationType: ['api', 'excel', 'csv', 'manual', 'scheduled_sync'][i % 5],
        endpointUrl: `https://partner${pad(i)}.example.edu/api/grades`
      }
    );
  }
}

async function seedGradeRules() {
  for (let i = 1; i <= 120; i += 1) {
    await execute(
      `INSERT INTO grade_rules (id, school_id, country_code, name, version, gpa_scale, credit_ratio, pass_score, status, effective_from, effective_to)
       VALUES (:id, :schoolId, :countryCode, :name, :version, :gpaScale, :creditRatio, :passScore, 'active', '2026-01-01', '2028-12-31')
       ON DUPLICATE KEY UPDATE gpa_scale = VALUES(gpa_scale), credit_ratio = VALUES(credit_ratio), pass_score = VALUES(pass_score), status = 'active'`,
      {
        id: i,
        schoolId: i,
        countryCode: `${countryCodes[(i - 1) % countryCodes.length]}${pad(Math.ceil(i / countryCodes.length), 2)}`,
        name: `Grade Adaptation Rule ${pad(i)}`,
        version: `RULE-2026-${pad(i)}`,
        gpaScale: i % 3 === 0 ? 5 : 4,
        creditRatio: 0.8 + ((i % 5) * 0.1),
        passScore: i % 4 === 0 ? 65 : 60
      }
    );
  }
}

function originalGrade(i, type) {
  if (type === 'percent') return String(45 + (i % 56));
  if (type === 'letter') return letters[i % letters.length];
  if (type === 'gpa') return String(((i % 41) / 10).toFixed(1));
  return i % 6 === 0 ? 'fail' : 'pass';
}

async function seedGradeRecords() {
  for (let i = 1; i <= 360; i += 1) {
    const type = gradeTypes[i % gradeTypes.length];
    const studentId = ((i - 1) % 180) + 1;
    const schoolId = ((i - 1) % 120) + 1;
    const countryCode = `${countryCodes[(schoolId - 1) % countryCodes.length]}${pad(Math.ceil(schoolId / countryCodes.length), 2)}`;
    const grade = originalGrade(i, type);
    const rule = {
      gpaScale: schoolId % 3 === 0 ? 5 : 4,
      creditRatio: 0.8 + ((schoolId % 5) * 0.1),
      passScore: schoolId % 4 === 0 ? 65 : 60,
      version: `RULE-2026-${pad(schoolId)}`
    };

    if (i % 37 === 0) {
      await execute(
        `INSERT INTO grade_records
         (id, student_id, course_code, course_name, source_school_id, source_country_code,
          original_grade, original_type, original_credit, adapt_status, exception_reason, audit_status)
         VALUES (:id, :studentId, :courseCode, :courseName, :schoolId, :countryCode,
          'N/A', 'letter', :credit, 'exception', 'Source grade cannot be mapped', 'pending')
         ON DUPLICATE KEY UPDATE adapt_status = 'exception', exception_reason = VALUES(exception_reason), audit_status = 'pending'`,
        {
          id: i,
          studentId,
          courseCode: `CR${100 + (i % 20)}`,
          courseName: ['Mathematics', 'Chinese Language', 'Computer Basics', 'Economics'][i % 4],
          schoolId,
          countryCode,
          credit: 1 + (i % 4)
        }
      );
      continue;
    }

    const adapted = adaptGrade(
      { originalType: type, originalGrade: grade, originalCredit: 1 + (i % 4) },
      rule
    );

    await execute(
      `INSERT INTO grade_records
       (id, student_id, course_code, course_name, source_school_id, source_country_code,
        original_grade, original_type, original_credit, adapted_score, adapted_gpa, adapted_credit,
        passed, rule_version, adapt_status, audit_status, audited_by, audited_at)
       VALUES (:id, :studentId, :courseCode, :courseName, :schoolId, :countryCode,
        :originalGrade, :originalType, :originalCredit, :adaptedScore, :adaptedGpa, :adaptedCredit,
        :passed, :ruleVersion, 'success', :auditStatus, 1, NOW())
       ON DUPLICATE KEY UPDATE adapted_score = VALUES(adapted_score), adapted_gpa = VALUES(adapted_gpa),
        adapted_credit = VALUES(adapted_credit), passed = VALUES(passed), rule_version = VALUES(rule_version),
        adapt_status = 'success', audit_status = VALUES(audit_status)`,
      {
        id: i,
        studentId,
        courseCode: `CR${100 + (i % 20)}`,
        courseName: ['Mathematics', 'Chinese Language', 'Computer Basics', 'Economics'][i % 4],
        schoolId,
        countryCode,
        originalGrade: grade,
        originalType: type,
        originalCredit: 1 + (i % 4),
        adaptedScore: adapted.adaptedScore,
        adaptedGpa: adapted.adaptedGpa,
        adaptedCredit: adapted.adaptedCredit,
        passed: adapted.passed ? 1 : 0,
        ruleVersion: adapted.ruleVersion,
        auditStatus: i % 5 === 0 ? 'pending' : 'approved'
      }
    );
  }
}

async function seedDemoAliases() {
  await execute(
    `INSERT INTO teachers (id, user_id, teacher_no, name, college, phone, email, teacher_type)
     VALUES (121, 2, 'T-DEMO-001', 'Teacher Demo', 'International Education College', '13800009999', 'teacher.demo@example.edu', 'head_teacher')
     ON DUPLICATE KEY UPDATE user_id = 2, name = VALUES(name), college = VALUES(college), phone = VALUES(phone), email = VALUES(email), teacher_type = VALUES(teacher_type)`
  );

  await execute(
    `INSERT INTO classes (id, code, name, college, major, teacher_id, enrollment_year)
     VALUES (121, 'ISE-DEMO-001', 'Demo International Student Class', 'International Education College', 'Chinese Language', 121, 2026)
     ON DUPLICATE KEY UPDATE name = VALUES(name), teacher_id = 121, enrollment_year = 2026`
  );

  await execute(
    `INSERT INTO students
     (id, user_id, student_no, chinese_name, english_name, gender, birth_date, nationality_id,
      passport_no, passport_expiry, phone, email, emergency_contact, enrollment_year, major, college, class_id, status)
     VALUES (181, 3, 'S-DEMO-001', '学生示例', 'Student Demo', 'Female', '2004-08-01', 1,
      'PDEMO001', :passportExpiry, '13900009999', 'student.demo@example.com', 'Family Demo', 2026,
      'Chinese Language', 'International Education College', 121, 'active')
     ON DUPLICATE KEY UPDATE user_id = 3, class_id = 121, status = 'active'`,
    { passportExpiry: datePlus(900) }
  );

  await execute(
    `INSERT INTO dormitories (id, building, room_no, bed_no, student_id, check_in_date, check_out_date, status)
     VALUES (181, 'International Dorm Demo', 'D101', '1', 181, '2026-09-01', :checkOut, 'occupied')
     ON DUPLICATE KEY UPDATE student_id = 181, check_out_date = VALUES(check_out_date), status = 'occupied'`,
    { checkOut: datePlus(360) }
  );

  await execute(
    `INSERT INTO visas (id, student_id, visa_type, visa_no, issue_date, expiry_date, residence_permit_no, document_url, status)
     VALUES (181, 181, 'X1', 'VISA-DEMO-001', '2026-01-10', :expiryDate, 'RP-DEMO-001', '/uploads/visa/demo.pdf', 'valid')
     ON DUPLICATE KEY UPDATE student_id = 181, expiry_date = VALUES(expiry_date), status = 'valid'`,
    { expiryDate: datePlus(360) }
  );

  await execute(
    `INSERT INTO study_records
     (id, student_id, course_code, course_name, attendance_rate, homework_status, class_performance, warning_level, teacher_id)
     VALUES (241, 181, 'CN-DEMO', 'Demo Chinese Language', 92.50, 'Completed', 'Normal', 'none', 121)
     ON DUPLICATE KEY UPDATE student_id = 181, attendance_rate = VALUES(attendance_rate), warning_level = 'none', teacher_id = 121`
  );

  const adapted = adaptGrade(
    { originalType: 'letter', originalGrade: 'A', originalCredit: 3 },
    { creditRatio: 1, passScore: 60, version: 'DEMO-RULE-2026' }
  );
  await execute(
    `INSERT INTO grade_records
     (id, student_id, course_code, course_name, source_school_id, source_country_code,
      original_grade, original_type, original_credit, adapted_score, adapted_gpa, adapted_credit,
      passed, rule_version, adapt_status, audit_status, audited_by, audited_at)
     VALUES (500, 181, 'CN-DEMO', 'Demo Chinese Language', 1, 'TH01',
      'A', 'letter', 3, :adaptedScore, :adaptedGpa, :adaptedCredit,
      1, :ruleVersion, 'success', 'approved', 1, NOW())
     ON DUPLICATE KEY UPDATE adapted_score = VALUES(adapted_score), adapted_gpa = VALUES(adapted_gpa),
      adapted_credit = VALUES(adapted_credit), adapt_status = 'success', audit_status = 'approved'`,
    adapted
  );
}

async function main() {
  await seedUsers();
  await seedNationalities();
  await seedTeachers();
  await seedClasses();
  await seedStudents();
  await seedDormitories();
  await seedVisas();
  await seedStudyRecords();
  await seedExternalSchools();
  await seedGradeRules();
  await seedGradeRecords();
  await seedDemoAliases();
  await pool.end();
  console.log('Business seed data inserted.');
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
