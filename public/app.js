const i18n = {
  zh: {
    systemTag: 'V1.0 留学生信息管理系统',
    systemName: '面向国际留学生的信息管理系统',
    logout: '退出',
    loginTitle: '用户登录',
    loginHint: '学生、教师和管理员使用统一入口登录。',
    username: '账号',
    password: '密码',
    loginButton: '登录系统',
    demoUsers: '演示账号',
    profile: '个人档案',
    grades: '成绩适配',
    learning: '学习情况',
    teacher: '教师管理',
    students: '学生管理',
    dashboard: '统计分析',
    risks: '风险查询',
    source: '来源',
    status: '状态',
    adaptedScore: '适配成绩',
    adaptedGpa: '适配 GPA',
    auditStatus: '审核状态',
    noData: '暂无数据',
    studentCount: '学生人数',
    teacherCount: '教师人数',
    visaWarnings: '签证预警',
    gradeExceptions: '成绩异常',
    loginFailed: '登录失败，请检查账号或密码。',
    loadFailed: '数据加载失败，请确认后台和数据库已启动。',
    studentOnly: '学生端支持中英文切换并仅展示本人数据。',
    teacherScope: '教师端用于班级、课程、成绩录入与学习预警管理。',
    adminScope: '管理员端用于档案、国籍、班级、住宿、签证、教师、成绩规则和统计分析管理。'
  },
  en: {
    systemTag: 'V1.0 International Student Information System',
    systemName: 'Information Management System for International Students',
    logout: 'Logout',
    loginTitle: 'Sign In',
    loginHint: 'Students, teachers, and administrators use the same portal.',
    username: 'Username',
    password: 'Password',
    loginButton: 'Sign In',
    demoUsers: 'Demo accounts',
    profile: 'Profile',
    grades: 'Grade Adapter',
    learning: 'Learning',
    teacher: 'Teacher Management',
    students: 'Student Management',
    dashboard: 'Analytics',
    risks: 'Risk Query',
    source: 'Source',
    status: 'Status',
    adaptedScore: 'Adapted Score',
    adaptedGpa: 'Adapted GPA',
    auditStatus: 'Audit Status',
    noData: 'No data',
    studentCount: 'Students',
    teacherCount: 'Teachers',
    visaWarnings: 'Visa Alerts',
    gradeExceptions: 'Grade Exceptions',
    loginFailed: 'Sign-in failed. Check your username or password.',
    loadFailed: 'Failed to load data. Confirm the API and database are running.',
    studentOnly: 'The student client supports Chinese and English and only shows personal data.',
    teacherScope: 'The teacher portal supports classes, courses, grade entry, and learning alerts.',
    adminScope: 'The admin portal manages profiles, nationalities, classes, dormitories, visas, teachers, grade rules, and analytics.'
  }
};

let lang = localStorage.getItem('lang') || 'zh';
let session = JSON.parse(localStorage.getItem('session') || 'null');
let currentTab = 'profile';

const loginPanel = document.querySelector('#loginPanel');
const workspace = document.querySelector('#workspace');
const tabs = document.querySelector('#tabs');
const summaryGrid = document.querySelector('#summaryGrid');
const primaryView = document.querySelector('#primaryView');
const sideView = document.querySelector('#sideView');
const loginMessage = document.querySelector('#loginMessage');
const logoutBtn = document.querySelector('#logoutBtn');

function t(key) {
  return i18n[lang][key] || key;
}

function applyLanguage() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  if (session) renderApp();
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || response.statusText);
  }
  return response.json();
}

function setLoggedIn(value) {
  loginPanel.classList.toggle('hidden', value);
  workspace.classList.toggle('hidden', !value);
  logoutBtn.classList.toggle('hidden', !value);
}

function roleTabs(role) {
  if (role === 'student') return ['profile', 'grades', 'learning'];
  if (role === 'teacher') return ['dashboard', 'students', 'grades', 'risks'];
  return ['dashboard', 'students', 'teacher', 'grades', 'risks'];
}

function renderTabs() {
  tabs.innerHTML = roleTabs(session.user.role)
    .map((tab) => `<button class="tab-button ${tab === currentTab ? 'active' : ''}" data-tab="${tab}">${t(tab)}</button>`)
    .join('');
  tabs.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      currentTab = button.dataset.tab;
      renderApp();
    });
  });
}

function metric(label, value, tone = '') {
  return `<div class="metric"><span class="muted">${label}</span><strong class="${tone}">${value}</strong></div>`;
}

function table(headers, rows) {
  if (!rows.length) return `<p class="muted">${t('noData')}</p>`;
  return `
    <table class="data-table">
      <thead><tr>${headers.map((item) => `<th>${item}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  `;
}

async function renderDashboard() {
  const data = await api('/api/management/dashboard');
  summaryGrid.innerHTML = [
    metric(t('studentCount'), data.students),
    metric(t('teacherCount'), data.teachers),
    metric(t('visaWarnings'), data.visaWarnings, 'warning'),
    metric(t('gradeExceptions'), data.gradeExceptions, 'danger')
  ].join('');
  primaryView.innerHTML = `<h2>${t('dashboard')}</h2><p class="muted">${session.user.role === 'admin' ? t('adminScope') : t('teacherScope')}</p>`;
  sideView.innerHTML = `<h3>${t('status')}</h3><p class="status">${session.user.displayName}</p>`;
}

async function renderStudentProfile() {
  const me = await api('/api/students/me');
  summaryGrid.innerHTML = [
    metric(t('profile'), me?.student_no || '-'),
    metric(lang === 'zh' ? '国籍' : 'Nationality', lang === 'zh' ? me?.nationality_zh || '-' : me?.nationality_en || '-'),
    metric(lang === 'zh' ? '班级' : 'Class', me?.class_name || '-'),
    metric(t('status'), me?.status || '-')
  ].join('');
  primaryView.innerHTML = `
    <h2>${t('profile')}</h2>
    <div class="profile-list">
      <div><span>${lang === 'zh' ? '中文名' : 'Chinese Name'}</span>${me?.chinese_name || '-'}</div>
      <div><span>${lang === 'zh' ? 'English Name' : '英文名'}</span>${me?.english_name || '-'}</div>
      <div><span>${lang === 'zh' ? '护照号' : 'Passport No.'}</span>${me?.passport_no || '-'}</div>
      <div><span>${lang === 'zh' ? '护照有效期' : 'Passport Expiry'}</span>${me?.passport_expiry || '-'}</div>
      <div><span>${lang === 'zh' ? '专业' : 'Major'}</span>${me?.major || '-'}</div>
      <div><span>${lang === 'zh' ? '邮箱' : 'Email'}</span>${me?.email || '-'}</div>
    </div>
  `;
  sideView.innerHTML = `<h3>${t('learning')}</h3><p class="muted">${t('studentOnly')}</p>`;
}

async function renderStudentGrades(studentId) {
  const id = studentId || (await api('/api/students/me'))?.id;
  const grades = id ? await api(`/api/grades/student/${id}`) : [];
  summaryGrid.innerHTML = [
    metric(t('grades'), grades.length),
    metric(t('adaptedGpa'), grades[0]?.adapted_gpa || '-'),
    metric(t('auditStatus'), grades[0]?.audit_status || '-'),
    metric(t('status'), grades[0]?.adapt_status || '-')
  ].join('');
  primaryView.innerHTML = `
    <h2>${t('grades')}</h2>
    ${table(
      [lang === 'zh' ? '课程' : 'Course', t('source'), lang === 'zh' ? '原始成绩' : 'Original', t('adaptedScore'), t('adaptedGpa'), t('auditStatus')],
      grades.map(
        (item) => `<tr>
          <td>${item.course_name || '-'}</td>
          <td>${item.source_school_name || item.source_country_code || '-'}</td>
          <td>${item.original_grade || '-'}</td>
          <td>${item.adapted_score || '-'}</td>
          <td>${item.adapted_gpa || '-'}</td>
          <td><span class="status">${item.audit_status}</span></td>
        </tr>`
      )
    )}
  `;
  sideView.innerHTML = `<h3>${lang === 'zh' ? '成绩适配接口要点' : 'Adapter Notes'}</h3><p class="muted">${lang === 'zh' ? '系统保留原始成绩、适配成绩、规则版本、审核状态和异常原因，支持跨国家、跨学校成绩归一化。' : 'The system keeps original grades, adapted results, rule versions, audit states, and exception reasons for cross-country grade normalization.'}</p>`;
}

async function renderGradeManagement() {
  const grades = await api('/api/grades');
  summaryGrid.innerHTML = [
    metric(t('grades'), grades.length),
    metric(t('adaptedGpa'), grades[0]?.adapted_gpa || '-'),
    metric(t('auditStatus'), grades[0]?.audit_status || '-'),
    metric(lang === 'zh' ? '异常记录' : 'Exceptions', grades.filter((item) => item.adapt_status === 'exception').length, 'danger')
  ].join('');
  primaryView.innerHTML = `
    <h2>${t('grades')}</h2>
    ${table(
      [lang === 'zh' ? '学号' : 'Student No.', lang === 'zh' ? '学生' : 'Student', lang === 'zh' ? '课程' : 'Course', t('source'), lang === 'zh' ? '原始成绩' : 'Original', t('adaptedScore'), t('auditStatus')],
      grades.map(
        (item) => `<tr>
          <td>${item.student_no}</td>
          <td>${item.chinese_name || item.english_name}</td>
          <td>${item.course_name || '-'}</td>
          <td>${item.source_school_name || item.source_country_code || '-'}</td>
          <td>${item.original_grade || '-'}</td>
          <td>${item.adapted_score || '-'}</td>
          <td><span class="status ${item.adapt_status === 'exception' ? 'danger' : ''}">${item.audit_status}</span></td>
        </tr>`
      )
    )}
  `;
  sideView.innerHTML = `<h3>${lang === 'zh' ? '成绩适配管理' : 'Grade Adaptation'}</h3><p class="muted">${lang === 'zh' ? '教师和管理员可查看外部学校成绩、原始成绩类型、适配分数、GPA、审核状态和异常记录，支撑跨国家、跨学校成绩统一归档。' : 'Teachers and administrators can review external school grades, original types, adapted scores, GPA, audit states, and exception records for unified archiving.'}</p>`;
}

async function renderStudents() {
  const students = await api('/api/students');
  summaryGrid.innerHTML = [metric(t('studentCount'), students.length), metric(t('status'), session.user.role), metric(t('grades'), '-'), metric(t('visaWarnings'), '-')].join('');
  primaryView.innerHTML = `
    <h2>${t('students')}</h2>
    ${table(
      [lang === 'zh' ? '学号' : 'Student No.', lang === 'zh' ? '姓名' : 'Name', lang === 'zh' ? '国籍' : 'Nationality', lang === 'zh' ? '班级' : 'Class', t('status')],
      students.map(
        (item) => `<tr>
          <td>${item.student_no}</td>
          <td>${item.chinese_name || item.english_name}</td>
          <td>${item.nationality || '-'}</td>
          <td>${item.class_name || '-'}</td>
          <td><span class="status">${item.status}</span></td>
        </tr>`
      )
    )}
  `;
  sideView.innerHTML = `<h3>${t('teacher')}</h3><p class="muted">${session.user.role === 'teacher' ? t('teacherScope') : t('adminScope')}</p>`;
}

async function renderTeachers() {
  const teachers = await api('/api/teachers');
  summaryGrid.innerHTML = [metric(t('teacherCount'), teachers.length), metric(t('status'), 'active'), metric(lang === 'zh' ? '权限' : 'Role', 'RBAC'), metric(lang === 'zh' ? '日志' : 'Logs', 'on')].join('');
  primaryView.innerHTML = `
    <h2>${t('teacher')}</h2>
    ${table(
      [lang === 'zh' ? '工号' : 'Teacher No.', lang === 'zh' ? '姓名' : 'Name', lang === 'zh' ? '学院' : 'College', lang === 'zh' ? '类型' : 'Type', lang === 'zh' ? '邮箱' : 'Email'],
      teachers.map(
        (item) => `<tr>
          <td>${item.teacher_no}</td>
          <td>${item.name}</td>
          <td>${item.college || '-'}</td>
          <td>${item.teacher_type}</td>
          <td>${item.email || '-'}</td>
        </tr>`
      )
    )}
  `;
  sideView.innerHTML = `<h3>${lang === 'zh' ? '教师端权限' : 'Teacher Permissions'}</h3><p class="muted">${t('teacherScope')}</p>`;
}

async function renderRisks() {
  const data = await api('/api/management/risks');
  const summary = data.summary || {};
  summaryGrid.innerHTML = [
    metric(lang === 'zh' ? '签证临期' : 'Visa Expiring', summary.visa_expiring || 0, 'warning'),
    metric(lang === 'zh' ? '成绩异常' : 'Grade Exceptions', summary.grade_exception || 0, 'danger'),
    metric(lang === 'zh' ? '低分风险' : 'Low Scores', summary.low_score || 0, 'danger'),
    metric(lang === 'zh' ? '学习预警' : 'Learning Alerts', summary.learning_warning || 0, 'warning')
  ].join('');
  primaryView.innerHTML = `
    <h2>${t('risks')}</h2>
    ${table(
      [lang === 'zh' ? '类型' : 'Type', lang === 'zh' ? '学号' : 'Student No.', lang === 'zh' ? '姓名' : 'Name', lang === 'zh' ? '日期' : 'Date', lang === 'zh' ? '详情' : 'Detail'],
      (data.items || []).map(
        (item) => `<tr>
          <td><span class="status ${item.risk_type.includes('exception') || item.risk_type === 'low_score' ? 'danger' : 'warning'}">${item.risk_type}</span></td>
          <td>${item.student_no}</td>
          <td>${item.chinese_name || item.english_name}</td>
          <td>${String(item.risk_date || '-').slice(0, 10)}</td>
          <td>${item.detail || '-'}</td>
        </tr>`
      )
    )}
  `;
  sideView.innerHTML = `<h3>${t('risks')}</h3><p class="muted">${lang === 'zh' ? '风险查询聚合签证、成绩、学习和住宿等关键业务风险，便于教师和管理员及时处理。' : 'Risk query aggregates visa, grade, learning, and dormitory risks for teachers and administrators.'}</p>`;
}

function renderLearningPlaceholder() {
  summaryGrid.innerHTML = [metric(t('learning'), '-'), metric(lang === 'zh' ? '考勤' : 'Attendance', '-'), metric(lang === 'zh' ? '预警' : 'Alerts', '-'), metric(lang === 'zh' ? '课程' : 'Courses', '-')].join('');
  primaryView.innerHTML = `<h2>${t('learning')}</h2><p class="muted">${lang === 'zh' ? '学习情况模块用于展示课程、考勤、作业、课堂表现、学习预警和教师评价。' : 'The learning module shows courses, attendance, assignments, classroom performance, alerts, and teacher evaluations.'}</p>`;
  sideView.innerHTML = `<h3>${t('status')}</h3><p class="status">${lang === 'zh' ? '待接入数据' : 'Awaiting records'}</p>`;
}

async function renderApp() {
  if (!session) return;
  setLoggedIn(true);
  renderTabs();
  try {
    if (currentTab === 'dashboard') await renderDashboard();
    if (currentTab === 'profile') await renderStudentProfile();
    if (currentTab === 'grades') {
      if (session.user.role === 'student') await renderStudentGrades();
      else await renderGradeManagement();
    }
    if (currentTab === 'students') await renderStudents();
    if (currentTab === 'teacher') await renderTeachers();
    if (currentTab === 'risks') await renderRisks();
    if (currentTab === 'learning') renderLearningPlaceholder();
  } catch (error) {
    primaryView.innerHTML = `<p class="message">${t('loadFailed')}</p><code>${error.message}</code>`;
    sideView.innerHTML = '';
  }
}

document.querySelector('#langToggle').addEventListener('click', () => {
  lang = lang === 'zh' ? 'en' : 'zh';
  localStorage.setItem('lang', lang);
  applyLanguage();
});

document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  loginMessage.textContent = '';
  const form = new FormData(event.currentTarget);
  try {
    session = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: form.get('username'),
        password: form.get('password')
      })
    });
    localStorage.setItem('session', JSON.stringify(session));
    currentTab = roleTabs(session.user.role)[0];
    renderApp();
  } catch (error) {
    loginMessage.textContent = t('loginFailed');
  }
});

logoutBtn.addEventListener('click', () => {
  session = null;
  localStorage.removeItem('session');
  setLoggedIn(false);
});

applyLanguage();
if (session) {
  currentTab = roleTabs(session.user.role)[0];
  renderApp();
} else {
  setLoggedIn(false);
}
