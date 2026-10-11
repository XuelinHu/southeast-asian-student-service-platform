INSERT INTO roles (id, code, name, scope, data_scope, is_super, is_builtin, sort_order, description)
VALUES
  (1, 'super_admin',    '超级管理员',     'staff', 'all',   1, 1, 1, '拥有全部菜单与全部操作权限，可维护角色权限、重置密码、启用停用账号'),
  (2, 'academic_admin', '教务管理员',     'staff', 'all',   0, 1, 2, '负责学籍、师资、班级、国籍、学习情况、成绩适配与对接学校维护'),
  (3, 'welfare_admin',  '学工后勤管理员', 'staff', 'all',   0, 1, 3, '负责住宿分配、床位状态与签证居留许可维护，只读查看学生名册'),
  (4, 'auditor',        '审计员',         'staff', 'all',   0, 1, 4, '只读查看登录日志与智能体问答记录，不能修改任何业务数据'),
  (5, 'teacher',        '教师',           'user',  'class', 0, 1, 5, '查看本人所带班级的学生，录入学习情况与成绩'),
  (6, 'student',        '留学生',         'user',  'self',  0, 1, 6, '留学生本人账号，可查询本人档案与成绩、使用智能体问答')
ON CONFLICT (code) DO NOTHING;

INSERT INTO nationalities
  (id, country_code, name_zh, name_en, continent, primary_language, timezone, status, sort_order)
VALUES
  (1, 'TH', '泰国', 'Thailand', 'Asia', 'Thai', 'Asia/Bangkok', 'active', 1),
  (2, 'VN', '越南', 'Vietnam', 'Asia', 'Vietnamese', 'Asia/Ho_Chi_Minh', 'active', 2),
  (3, 'MY', '马来西亚', 'Malaysia', 'Asia', 'Malay', 'Asia/Kuala_Lumpur', 'active', 3),
  (4, 'ID', '印度尼西亚', 'Indonesia', 'Asia', 'Indonesian', 'Asia/Jakarta', 'active', 4)
ON CONFLICT (country_code) DO NOTHING;

INSERT INTO external_schools (id, country_code, name, integration_type, status)
VALUES
  (1, 'TH', 'Demo Partner University Thailand', 'api', 'active'),
  (2, 'VN', 'Demo Partner College Vietnam', 'excel', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO grade_rules (id, school_id, country_code, name, version, gpa_scale, credit_ratio, pass_score, status)
VALUES
  (1, NULL, NULL, 'Default international grade adapter', 'default-v1', 4.00, 1.000, 60.00, 'active'),
  (2, 1, 'TH', 'Thailand partner GPA rule', 'TH-GPA-2026', 4.00, 1.000, 60.00, 'active')
ON CONFLICT DO NOTHING;
