const pool = require('../../config/db');
const knowledge = require('./knowledge');
const { escapeLike, toPositiveInt } = require('../pagination');
const { canAccess } = require('../../config/roles');

// ---------------------------------------------------------------------------
// 智能体的只读查询工具
//
// 安全约定：
//   * 所有 SQL 都是硬编码的，工具参数只作为 ? 占位符的值，绝不拼进 SQL。
//   * LIMIT 一律走 toPositiveInt 归一化后内联（pool.query 客户端转义）。
//   * 角色在服务端强制过滤：学生角色拿不到任何跨学生查询工具，
//     这是防提示词注入越权的关键 —— 模型说什么都不会改变工具清单。
// ---------------------------------------------------------------------------

// 工具授权分两种写法，二选一，不混用：
//   menus: [...]  按菜单授权，与该角色在管理台的可见性完全一致。改成"审计员也能看签证"
//                 只需在角色权限矩阵里勾一下，这里的代码不用动。
//   roles: [...]  与身份绑定，不看菜单。学生那两个本人类工具属于这种：它们查的是
//                 ctx.studentId（服务端由令牌解析），给别的角色反而没有意义。
// 两个都不写的工具所有身份都能用（search_knowledge）。
// guest 不在任何 menus 里，因此游客只剩 search_knowledge。

function like(value) {
  return `%${escapeLike(String(value).trim().slice(0, 100))}%`;
}

/** 工具返回给模型的统一分页信封，避免模型把"只列了 20 条"当成总量。 */
function envelope(rows, { total, page, pageSize, note }) {
  return {
    total,
    returned: rows.length,
    page,
    pageSize,
    hasMore: page * pageSize < total,
    note,
    items: rows
  };
}

const TOOLS = [
  // -------------------------------------------------------------------------
  // 概览
  // -------------------------------------------------------------------------
  {
    name: 'get_dashboard_stats',
    description: '获取平台核心统计数字：学生总数、教师总数、60 天内到期的签证数、成绩异常数。回答"现在有多少学生"这类问题用它。',
    parameters: { type: 'object', properties: {}, required: [] },
    menus: ['students'],
    async run() {
      const [[students]] = await pool.query('SELECT COUNT(*) AS count FROM students');
      const [[activeStudents]] = await pool.query("SELECT COUNT(*) AS count FROM students WHERE status = 'active'");
      const [[teachers]] = await pool.query('SELECT COUNT(*) AS count FROM teachers');
      const [[classes]] = await pool.query('SELECT COUNT(*) AS count FROM classes');
      const [[visaWarnings]] = await pool.query(
        'SELECT COUNT(*) AS count FROM visas WHERE expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 60 DAY)'
      );
      const [[gradeExceptions]] = await pool.query(
        "SELECT COUNT(*) AS count FROM grade_records WHERE adapt_status = 'exception'"
      );
      return {
        students: students.count,
        activeStudents: activeStudents.count,
        teachers: teachers.count,
        classes: classes.count,
        visaExpiringWithin60Days: visaWarnings.count,
        gradeExceptions: gradeExceptions.count,
        note: '签证预警口径为今天起 60 天内到期；成绩异常口径为 adapt_status = exception。'
      };
    }
  },

  {
    name: 'search_students',
    description: '按关键字（学号、中文名、英文名、护照号、邮箱、手机号）搜索学生，可按状态与班级过滤。返回分页结果。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键字，可留空表示不限制' },
        status: {
          type: 'string',
          description: '学生状态过滤',
          enum: ['active', 'suspended', 'withdrawn', 'graduated', 'delayed']
        },
        page: { type: 'integer', description: '页码，从 1 开始，默认 1' },
        pageSize: { type: 'integer', description: '每页条数，默认 10，最大 30' }
      },
      required: []
    },
    menus: ['students'],
    async run(args) {
      const page = toPositiveInt(args.page, 1, 1, 1000);
      const pageSize = toPositiveInt(args.pageSize, 10, 1, 30);

      const clauses = [];
      const params = [];

      if (args.keyword) {
        const pattern = like(args.keyword);
        clauses.push(
          '(s.student_no LIKE ? ESCAPE \'!\' OR s.chinese_name LIKE ? ESCAPE \'!\' OR s.english_name LIKE ? ESCAPE \'!\' OR s.passport_no LIKE ? ESCAPE \'!\' OR s.email LIKE ? ESCAPE \'!\' OR s.phone LIKE ? ESCAPE \'!\')'
        );
        params.push(pattern, pattern, pattern, pattern, pattern, pattern);
      }
      if (args.status) {
        clauses.push('s.status = ?');
        params.push(String(args.status));
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const baseFrom =
        'FROM students s LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN nationalities n ON n.id = s.nationality_id';

      const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${where}`, params);
      const [rows] = await pool.query(
        `SELECT s.id, s.student_no, s.chinese_name, s.english_name, s.gender, s.status,
                s.enrollment_year, s.major, s.college, c.name AS class_name,
                COALESCE(n.name_zh, n.name_en) AS nationality
         ${baseFrom} ${where}
         ORDER BY s.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params
      );

      return envelope(rows, { total: Number(countRow.total), page, pageSize });
    }
  },

  {
    name: 'get_student_detail',
    description: '按学号或姓名查询单个学生的完整档案，包含班级、国籍、护照与签证、住宿、最近成绩与学习记录。',
    parameters: {
      type: 'object',
      properties: {
        studentNo: { type: 'string', description: '学号，优先用它精确定位' },
        name: { type: 'string', description: '中文名或英文名，学号未知时用' }
      },
      required: []
    },
    menus: ['students'],
    async run(args) {
      const clauses = [];
      const params = [];
      if (args.studentNo) {
        clauses.push('s.student_no = ?');
        params.push(String(args.studentNo).trim());
      } else if (args.name) {
        const pattern = like(args.name);
        clauses.push("(s.chinese_name LIKE ? ESCAPE '!' OR s.english_name LIKE ? ESCAPE '!')");
        params.push(pattern, pattern);
      } else {
        return { error: '需要提供 studentNo 或 name 才能定位学生。' };
      }

      const [students] = await pool.query(
        `SELECT s.*, c.name AS class_name, COALESCE(n.name_zh, n.name_en) AS nationality
         FROM students s
         LEFT JOIN classes c ON c.id = s.class_id
         LEFT JOIN nationalities n ON n.id = s.nationality_id
         WHERE ${clauses.join(' AND ')} LIMIT 5`,
        params
      );

      if (!students.length) return { found: false, message: '没有找到匹配的学生。' };
      // 姓名搜索可能命中多人，只取第一条并说明，避免模型把多个人的数据混在一起回答
      const student = students[0];

      const [[visa]] = await pool.query(
        `SELECT visa_type, visa_no, issue_date, expiry_date, status,
                DATEDIFF(expiry_date, CURDATE()) AS days_to_expiry
         FROM visas WHERE student_id = ? ORDER BY expiry_date DESC LIMIT 1`,
        [student.id]
      );
      const [[dorm]] = await pool.query(
        `SELECT building, room_no, bed_no, check_in_date, check_out_date, status
         FROM dormitories WHERE student_id = ? ORDER BY id DESC LIMIT 1`,
        [student.id]
      );
      const [grades] = await pool.query(
        `SELECT course_name, original_grade, original_type, adapted_score, adapted_gpa, passed,
                adapt_status, exception_reason, audit_status, rule_version
         FROM grade_records WHERE student_id = ? ORDER BY id DESC LIMIT 10`,
        [student.id]
      );
      const [study] = await pool.query(
        `SELECT course_name, attendance_rate, homework_status, class_performance, warning_level, recorded_at
         FROM study_records WHERE student_id = ? ORDER BY recorded_at DESC LIMIT 5`,
        [student.id]
      );

      return {
        found: true,
        matchedCount: students.length,
        ambiguous: students.length > 1 ? '匹配到多名学生，以下仅返回第一条，建议改用学号查询。' : undefined,
        student: {
          studentNo: student.student_no,
          chineseName: student.chinese_name,
          englishName: student.english_name,
          gender: student.gender,
          status: student.status,
          nationality: student.nationality,
          className: student.class_name,
          major: student.major,
          college: student.college,
          passportNo: student.passport_no,
          passportExpiry: student.passport_expiry,
          enrollmentYear: student.enrollment_year,
          email: student.email,
          phone: student.phone,
          emergencyContact: student.emergency_contact
        },
        visa: visa || null,
        dormitory: dorm || null,
        recentGrades: grades,
        recentStudyRecords: study
      };
    }
  },

  // -------------------------------------------------------------------------
  // 学生本人类（仅 student 角色）
  // -------------------------------------------------------------------------
  {
    name: 'get_my_profile',
    description: '查询当前登录学生本人的档案信息（学号、国籍、班级、护照、联系方式等）。',
    parameters: { type: 'object', properties: {}, required: [] },
    roles: ['student'],
    async run(_args, ctx) {
      if (!ctx.studentId) return { found: false, message: '当前账号还没有关联学生档案，请联系教务补充。' };
      const [[student]] = await pool.query(
        `SELECT s.student_no, s.chinese_name, s.english_name, s.gender, s.birth_date, s.status,
                s.passport_no, s.passport_expiry, s.major, s.college, s.enrollment_year,
                s.email, s.phone, s.emergency_contact,
                c.name AS class_name, COALESCE(n.name_zh, n.name_en) AS nationality
         FROM students s
         LEFT JOIN classes c ON c.id = s.class_id
         LEFT JOIN nationalities n ON n.id = s.nationality_id
         WHERE s.id = ? LIMIT 1`,
        [ctx.studentId]
      );
      if (!student) return { found: false, message: '没有找到你的档案。' };

      const [[visa]] = await pool.query(
        `SELECT visa_type, expiry_date, status, DATEDIFF(expiry_date, CURDATE()) AS days_to_expiry
         FROM visas WHERE student_id = ? ORDER BY expiry_date DESC LIMIT 1`,
        [ctx.studentId]
      );
      const [[dorm]] = await pool.query(
        `SELECT building, room_no, bed_no, check_in_date, check_out_date, status
         FROM dormitories WHERE student_id = ? ORDER BY id DESC LIMIT 1`,
        [ctx.studentId]
      );

      return { found: true, student, visa: visa || null, dormitory: dorm || null };
    }
  },

  {
    name: 'get_my_grades',
    description: '查询当前登录学生本人的成绩，含原始成绩、适配成绩、适配 GPA、是否通过与审核状态。',
    parameters: { type: 'object', properties: {}, required: [] },
    roles: ['student'],
    async run(_args, ctx) {
      if (!ctx.studentId) return { found: false, message: '当前账号还没有关联学生档案，查不到成绩。' };
      const [rows] = await pool.query(
        `SELECT gr.course_name, gr.source_country_code, es.name AS source_school,
                gr.original_grade, gr.original_type, gr.original_credit,
                gr.adapted_score, gr.adapted_gpa, gr.adapted_credit, gr.passed,
                gr.adapt_status, gr.exception_reason, gr.audit_status, gr.rule_version
         FROM grade_records gr
         LEFT JOIN external_schools es ON es.id = gr.source_school_id
         WHERE gr.student_id = ? ORDER BY gr.id DESC LIMIT 50`,
        [ctx.studentId]
      );

      const scored = rows.filter((row) => row.adapted_score !== null);
      const average = scored.length
        ? Number((scored.reduce((sum, row) => sum + Number(row.adapted_score), 0) / scored.length).toFixed(2))
        : null;

      return {
        total: rows.length,
        passedCount: rows.filter((row) => row.passed === 1).length,
        exceptionCount: rows.filter((row) => row.adapt_status === 'exception').length,
        averageAdaptedScore: average,
        items: rows
      };
    }
  },

  // -------------------------------------------------------------------------
  // 风险清单
  // -------------------------------------------------------------------------
  {
    name: 'list_visa_expiring',
    description: '列出签证即将到期的学生。默认口径为今天起 60 天内到期。',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: '预警窗口天数，默认 60' },
        limit: { type: 'integer', description: '返回条数上限，默认 20，最大 50' }
      },
      required: []
    },
    menus: ['visas'],
    async run(args) {
      const days = toPositiveInt(args.days, 60, 1, 365);
      const limit = toPositiveInt(args.limit, 20, 1, 50);
      const [rows] = await pool.query(
        `SELECT s.student_no, s.chinese_name, s.english_name, c.name AS class_name,
                v.visa_type, v.expiry_date, v.status,
                DATEDIFF(v.expiry_date, CURDATE()) AS days_to_expiry
         FROM visas v
         JOIN students s ON s.id = v.student_id
         LEFT JOIN classes c ON c.id = s.class_id
         WHERE v.expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
         ORDER BY v.expiry_date ASC LIMIT ${limit}`,
        [days]
      );
      return envelope(rows, { total: rows.length, page: 1, pageSize: limit, note: `统计口径：今天起 ${days} 天内到期。` });
    }
  },

  {
    name: 'list_grade_exceptions',
    description: '列出成绩适配异常的记录，含异常原因，用于排查哪些成绩需要人工核对。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '返回条数上限，默认 20，最大 50' } },
      required: []
    },
    menus: ['gradeRecords'],
    async run(args) {
      const limit = toPositiveInt(args.limit, 20, 1, 50);
      const [rows] = await pool.query(
        `SELECT s.student_no, s.chinese_name, s.english_name, c.name AS class_name,
                gr.course_name, gr.original_grade, gr.original_type,
                gr.exception_reason, gr.audit_status, gr.created_at
         FROM grade_records gr
         JOIN students s ON s.id = gr.student_id
         LEFT JOIN classes c ON c.id = s.class_id
         WHERE gr.adapt_status = 'exception'
         ORDER BY gr.created_at DESC LIMIT ${limit}`
      );
      const [[countRow]] = await pool.query(
        "SELECT COUNT(*) AS total FROM grade_records WHERE adapt_status = 'exception'"
      );
      return envelope(rows, { total: Number(countRow.total), page: 1, pageSize: limit });
    }
  },

  {
    name: 'list_low_scores',
    description: '列出适配后分数低于及格线的成绩记录，默认阈值 60 分。',
    parameters: {
      type: 'object',
      properties: {
        threshold: { type: 'integer', description: '分数阈值，默认 60' },
        limit: { type: 'integer', description: '返回条数上限，默认 20，最大 50' }
      },
      required: []
    },
    menus: ['gradeRecords'],
    async run(args) {
      const threshold = toPositiveInt(args.threshold, 60, 1, 100);
      const limit = toPositiveInt(args.limit, 20, 1, 50);
      const [rows] = await pool.query(
        `SELECT s.student_no, s.chinese_name, s.english_name, c.name AS class_name,
                gr.course_name, gr.original_grade, gr.adapted_score, gr.adapted_gpa, gr.passed
         FROM grade_records gr
         JOIN students s ON s.id = gr.student_id
         LEFT JOIN classes c ON c.id = s.class_id
         WHERE gr.adapted_score IS NOT NULL AND gr.adapted_score < ?
         ORDER BY gr.adapted_score ASC LIMIT ${limit}`,
        [threshold]
      );
      const [[countRow]] = await pool.query(
        'SELECT COUNT(*) AS total FROM grade_records WHERE adapted_score IS NOT NULL AND adapted_score < ?',
        [threshold]
      );
      return envelope(rows, { total: Number(countRow.total), page: 1, pageSize: limit, note: `阈值 ${threshold} 分。` });
    }
  },

  {
    name: 'list_study_warnings',
    description: '列出学习预警记录：预警级别为 warning/serious，或出勤率低于 70%。',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', description: '预警级别过滤', enum: ['notice', 'warning', 'serious'] },
        limit: { type: 'integer', description: '返回条数上限，默认 20，最大 50' }
      },
      required: []
    },
    menus: ['studyRecords'],
    async run(args) {
      const limit = toPositiveInt(args.limit, 20, 1, 50);
      const clauses = ["(sr.warning_level IN ('warning', 'serious') OR sr.attendance_rate < 70)"];
      const params = [];
      if (args.level) {
        clauses.push('sr.warning_level = ?');
        params.push(String(args.level));
      }
      const where = `WHERE ${clauses.join(' AND ')}`;

      const [rows] = await pool.query(
        `SELECT s.student_no, s.chinese_name, s.english_name, c.name AS class_name,
                sr.course_name, sr.attendance_rate, sr.homework_status,
                sr.class_performance, sr.warning_level, sr.recorded_at
         FROM study_records sr
         JOIN students s ON s.id = sr.student_id
         LEFT JOIN classes c ON c.id = s.class_id
         ${where} ORDER BY sr.recorded_at DESC LIMIT ${limit}`,
        params
      );
      const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS total FROM study_records sr ${where}`,
        params
      );
      return envelope(rows, { total: Number(countRow.total), page: 1, pageSize: limit });
    }
  },

  {
    name: 'list_dormitory_issues',
    description: '列出住宿异常：床位处于维修或预留状态却仍挂着学生，或退宿日期已经早于今天。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '返回条数上限，默认 20，最大 50' } },
      required: []
    },
    menus: ['dormitories'],
    async run(args) {
      const limit = toPositiveInt(args.limit, 20, 1, 50);
      const where = "(d.status IN ('maintenance', 'reserved') OR d.check_out_date < CURDATE())";
      const [rows] = await pool.query(
        `SELECT s.student_no, s.chinese_name, s.english_name, c.name AS class_name,
                d.building, d.room_no, d.bed_no, d.check_in_date, d.check_out_date, d.status
         FROM dormitories d
         JOIN students s ON s.id = d.student_id
         LEFT JOIN classes c ON c.id = s.class_id
         WHERE ${where} ORDER BY d.check_out_date ASC LIMIT ${limit}`
      );
      const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS total FROM dormitories d WHERE ${where}`
      );
      return envelope(rows, { total: Number(countRow.total), page: 1, pageSize: limit });
    }
  },

  {
    name: 'get_risk_summary',
    description: '获取风险清单汇总：五类风险各自的数量与总体分布，适合回答"现在有哪些风险""整体情况如何"。',
    parameters: { type: 'object', properties: {}, required: [] },
    menus: ['students'],
    async run() {
      const [[visa]] = await pool.query(
        `SELECT COUNT(*) AS count FROM visas
         WHERE expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 60 DAY)`
      );
      const [[grade]] = await pool.query(
        "SELECT COUNT(*) AS count FROM grade_records WHERE adapt_status = 'exception'"
      );
      const [[lowScore]] = await pool.query(
        'SELECT COUNT(*) AS count FROM grade_records WHERE adapted_score IS NOT NULL AND adapted_score < 60'
      );
      const [[learning]] = await pool.query(
        "SELECT COUNT(*) AS count FROM study_records WHERE warning_level IN ('warning', 'serious') OR attendance_rate < 70"
      );
      const [[dormitory]] = await pool.query(
        "SELECT COUNT(*) AS count FROM dormitories WHERE status IN ('maintenance', 'reserved') OR check_out_date < CURDATE()"
      );

      const summary = {
        visa_expiring: visa.count,
        grade_exception: grade.count,
        low_score: lowScore.count,
        learning_warning: learning.count,
        dormitory_exception: dormitory.count
      };

      return {
        summary,
        total: Object.values(summary).reduce((sum, value) => sum + value, 0),
        note: '同一名学生可能同时命中多类风险。签证窗口为 60 天，低分阈值为 60。'
      };
    }
  },

  // -------------------------------------------------------------------------
  // 基础数据
  // -------------------------------------------------------------------------
  {
    name: 'list_classes',
    description: '列出班级及其班主任、专业、学院与学生人数。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '按班级名称或编码搜索' },
        limit: { type: 'integer', description: '返回条数上限，默认 20，最大 50' }
      },
      required: []
    },
    menus: ['classes'],
    async run(args) {
      const limit = toPositiveInt(args.limit, 20, 1, 50);
      const clauses = [];
      const params = [];
      if (args.keyword) {
        const pattern = like(args.keyword);
        clauses.push("(c.name LIKE ? ESCAPE '!' OR c.code LIKE ? ESCAPE '!')");
        params.push(pattern, pattern);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

      const [rows] = await pool.query(
        `SELECT c.code, c.name, c.college, c.major, c.enrollment_year, t.name AS head_teacher,
                (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS student_count
         FROM classes c LEFT JOIN teachers t ON t.id = c.teacher_id
         ${where} ORDER BY c.id DESC LIMIT ${limit}`,
        params
      );
      const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total FROM classes c ${where}`, params);
      return envelope(rows, { total: Number(countRow.total), page: 1, pageSize: limit });
    }
  },

  {
    name: 'list_nationalities',
    description: '列出国籍分布：每个国家的学生人数。回答"学生都来自哪些国家""哪国学生最多"用它。',
    parameters: { type: 'object', properties: {}, required: [] },
    menus: ['nationalities'],
    async run() {
      const [rows] = await pool.query(
        `SELECT COALESCE(n.name_zh, n.name_en) AS nationality, n.country_code, n.continent,
                COUNT(s.id) AS student_count
         FROM nationalities n
         LEFT JOIN students s ON s.nationality_id = n.id
         GROUP BY n.id, n.name_zh, n.name_en, n.country_code, n.continent
         ORDER BY student_count DESC, n.name_en ASC
         LIMIT 50`
      );
      return { total: rows.length, items: rows };
    }
  },

  {
    name: 'get_grade_rule',
    description: '查询成绩适配规则：某个学校或国家用哪套规则折算 GPA 与学分。',
    parameters: {
      type: 'object',
      properties: {
        schoolName: { type: 'string', description: '对接学校名称，模糊匹配' },
        countryCode: { type: 'string', description: '国家代码，如 TH、VN、MY' }
      },
      required: []
    },
    menus: ['gradeRules'],
    async run(args) {
      const clauses = [];
      const params = [];
      if (args.schoolName) {
        clauses.push("es.name LIKE ? ESCAPE '!'");
        params.push(like(args.schoolName));
      }
      if (args.countryCode) {
        clauses.push('gr.country_code = ?');
        params.push(String(args.countryCode).toUpperCase().slice(0, 8));
      }
      if (!clauses.length) {
        return { error: '需要提供 schoolName 或 countryCode 才能查询规则。' };
      }

      const [rows] = await pool.query(
        `SELECT gr.name AS rule_name, gr.version, gr.country_code, es.name AS school_name,
                gr.gpa_scale, gr.credit_ratio, gr.pass_score, gr.status,
                gr.effective_from, gr.effective_to
         FROM grade_rules gr
         LEFT JOIN external_schools es ON es.id = gr.school_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY gr.id DESC LIMIT 10`,
        params
      );
      return rows.length
        ? { total: rows.length, items: rows }
        : { total: 0, items: [], message: '没有匹配的成绩规则，可能该校尚未配置。' };
    }
  },

  // -------------------------------------------------------------------------
  // 知识检索（所有角色，含游客）
  // -------------------------------------------------------------------------
  {
    name: 'search_knowledge',
    description:
      '检索平台的业务规则与使用说明（成绩适配口径、签证预警规则、住宿状态含义、学习预警标准、角色权限、系统操作方式等）。回答"这个规则是怎么定的""这系统怎么用"这类问题时用它。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '要查询的业务主题或问题' } },
      required: ['query']
    },
    async run(args) {
      const entries = knowledge.search(args.query, 3);
      if (!entries.length) {
        return { found: false, message: '知识库里没有匹配的业务条目。', availableTopics: knowledge.listTopics() };
      }
      return { found: true, entries: entries.map((entry) => ({ title: entry.title, content: entry.content })) };
    }
  }
];

// ---------------------------------------------------------------------------
// 角色过滤 —— 这是防越权的唯一入口，模型无法影响
// ---------------------------------------------------------------------------

/**
 * 这个身份能不能用这个工具。identity 形如
 * { role, menus, isSuper }（登录用户，menus 来自 role_menus 表）
 * 或 { role: 'guest', menus: new Map() }（游客）。
 */
function toolAllowed(tool, identity) {
  if (!identity) return false;
  if (tool.menus) return tool.menus.every((key) => canAccess(identity, key, 'view'));
  if (tool.roles) return tool.roles.includes(identity.role);
  return true;
}

function toolsForUser(identity) {
  return TOOLS.filter((tool) => toolAllowed(tool, identity));
}

/** 转成 Ollama / OpenAI 通用的 tools 定义。 */
function schemaForUser(identity) {
  return toolsForUser(identity).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

function getTool(name, identity) {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) return null;
  // 越权调用直接当作"不存在"，不告诉模型这个工具存在
  if (!toolAllowed(tool, identity)) return null;
  return tool;
}

module.exports = { TOOLS, toolsForUser, schemaForUser, getTool };
