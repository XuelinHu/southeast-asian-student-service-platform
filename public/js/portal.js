// 门户页：公共服务（登录 / 注册 / 修改密码 / 个人中心）+ 角色概览。
// 管理类列表页在 /admin.html，这里只放每个角色日常要看的那几屏。

import { state, api, esc, $, $$, toast, setSession, setLang, applyI18n, t } from './core.js';

let currentTab = null;

const authArea = $('#authArea');
const workspace = $('#workspace');
const tabsNode = $('#tabs');
const summaryGrid = $('#summaryGrid');
const primaryView = $('#primaryView');
const sideView = $('#sideView');
const adminLink = $('#adminLink');
const logoutBtn = $('#logoutBtn');

// ---------------------------------------------------------------------------
// 登录 / 注册
// ---------------------------------------------------------------------------

function switchAuthPanel(name) {
  $$('.auth-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.panel === name));
  $('#loginForm').classList.toggle('hidden', name !== 'login');
  $('#registerForm').classList.toggle('hidden', name !== 'register');
  $('#loginMessage').textContent = '';
  $('#registerMessage').textContent = '';
}

function setLoggedIn(value) {
  authArea.classList.toggle('hidden', value);
  workspace.classList.toggle('hidden', !value);
  logoutBtn.classList.toggle('hidden', !value);
  // 能不能进管理台由服务端下发的菜单决定。以前这里写死 ['admin','teacher']，
  // 角色改成库里的数据之后，超级管理员与审计员有菜单却看不到入口。
  adminLink.classList.toggle('hidden', adminMenus().length === 0);
}

/** 当前账号在管理台能打开的菜单 key，由服务端按 role_menus 算好下发。 */
function adminMenus() {
  return state.session?.user?.adminMenus || [];
}

/**
 * 页签按"服务端会不会给我数据"来定：
 *   学生        个人中心 / 我的成绩 / 账号安全
 *   有学生菜单   概览（/api/management/dashboard 就是挂在这个菜单上的）
 *   其余（如审计员）只有账号安全 —— 给个点开就报 403 的概览页签不如不给
 */
function roleTabs() {
  const menus = adminMenus();
  if (menus.includes('students')) return ['dashboard', 'account'];
  if (state.session?.user?.role === 'student') return ['profile', 'grades', 'account'];
  return ['account'];
}

const TAB_LABELS = {
  profile: '个人中心',
  grades: '我的成绩',
  account: '账号安全',
  dashboard: '概览'
};

function metric(label, value, tone = '') {
  return `<div class="metric"><span class="muted">${esc(label)}</span><strong class="${esc(tone)}">${esc(value)}</strong></div>`;
}

function table(headers, rows) {
  if (!rows.length) return `<p class="muted">${t('noData')}</p>`;
  return `<div class="portal-table-scroll"><table class="data-table">
      <thead><tr>${headers.map((item) => `<th>${esc(item)}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>`;
}

function renderTabs() {
  const list = roleTabs();
  if (!list.includes(currentTab)) currentTab = list[0];
  tabsNode.innerHTML = list
    .map((tab) => `<button class="tab-button ${tab === currentTab ? 'active' : ''}" data-tab="${tab}">${esc(TAB_LABELS[tab])}</button>`)
    .join('');
  tabsNode.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      currentTab = button.dataset.tab;
      renderApp();
    });
  });
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

async function renderDashboard() {
  const data = await api('/api/management/dashboard');
  summaryGrid.innerHTML = [
    metric('学生人数', data.students),
    metric('教师人数', data.teachers),
    metric('签证预警', data.visaWarnings, data.visaWarnings > 0 ? 'warning' : ''),
    metric('成绩异常', data.gradeExceptions, data.gradeExceptions > 0 ? 'danger' : '')
  ].join('');

  primaryView.innerHTML = `
    <h2>概览</h2>
    <p class="muted">${
      state.session.user.dataScope === 'all'
        ? '你可以进入管理台，按菜单分页管理业务数据。'
        : '你可以进入管理台，查看本人所带班级的学生、成绩与学习情况。'
    }</p>
    <p><a class="primary-button button-link" href="/admin.html">进入管理台</a></p>`;
  sideView.innerHTML = `<h3>当前账号</h3><p class="status">${esc(state.session.user.displayName)} · ${esc(
    state.session.user.roleName || state.session.user.role
  )}</p>`;
}

async function renderStudentProfile() {
  const me = await api('/api/students/me');
  if (!me) {
    summaryGrid.innerHTML = '';
    primaryView.innerHTML = `
      <h2>个人中心</h2>
      <p class="muted">该账号还没有关联的学生档案。注册时填写学号即可自动建立档案。</p>`;
    sideView.innerHTML = `<h3>账号</h3><p class="status">${esc(state.session.user.username)}</p>`;
    return;
  }

  summaryGrid.innerHTML = [
    metric('学号', me.student_no || '-'),
    metric('国籍', me.nationality_zh || me.nationality_en || '-'),
    metric('班级', me.class_name || '-'),
    metric('状态', me.status || '-')
  ].join('');

  const rows = [
    ['中文名', me.chinese_name],
    ['英文名', me.english_name],
    ['性别', me.gender],
    ['出生日期', (me.birth_date || '').slice(0, 10)],
    ['护照号', me.passport_no],
    ['护照有效期', (me.passport_expiry || '').slice(0, 10)],
    ['专业', me.major],
    ['学院', me.college],
    ['邮箱', me.email],
    ['手机号', me.phone],
    ['紧急联系人', me.emergency_contact],
    ['入学年份', me.enrollment_year]
  ];

  primaryView.innerHTML = `
    <h2>个人中心</h2>
    <div class="profile-list">
      ${rows
        .map(([label, value]) => `<div><span>${esc(label)}</span>${esc(value || '—')}</div>`)
        .join('')}
    </div>
    <p class="muted" style="margin-top:16px">如需修改档案信息，请联系教务老师。</p>`;
  sideView.innerHTML = `<h3>说明</h3><p class="muted">学生端仅展示本人数据，账号资料可在「账号安全」中修改。</p>`;
}

// 每页 10 条：成绩单在手机上要能一屏看完一页，翻页按钮才够得着
const GRADES_PAGE_SIZE = 10;
let gradesPage = 1;

async function renderStudentGrades(page = gradesPage) {
  const me = await api('/api/students/me');
  if (!me) {
    gradesPage = 1;
    summaryGrid.innerHTML = '';
    primaryView.innerHTML = '<h2>我的成绩</h2><p class="muted">尚未建立学生档案，暂无成绩数据。</p>';
    sideView.innerHTML = '';
    return;
  }

  // /api/grades/student/:studentId 返回统一分页信封 { items, page, pageSize, total, totalPages }
  const result = await api(`/api/grades/student/${me.id}?page=${page}&pageSize=${GRADES_PAGE_SIZE}`);
  const grades = result.items || [];
  gradesPage = result.page;

  // 指标按本页数据算不出口径，所以改成"累计"的说法：
  // total 是全部课程数，通过/异常/均分只在只有一页时才等于全量口径。
  const passed = grades.filter((g) => g.passed === 1 || g.passed === true).length;
  const exceptions = grades.filter((g) => g.adapt_status === 'exception').length;
  const avg = grades.filter((g) => g.adapted_score != null);
  const avgScore = avg.length
    ? (avg.reduce((sum, g) => sum + Number(g.adapted_score), 0) / avg.length).toFixed(1)
    : '—';

  const multiPage = result.totalPages > 1;
  summaryGrid.innerHTML = [
    metric('课程数', result.total),
    metric(multiPage ? '本页均分' : '平均适配分', avgScore),
    metric(multiPage ? '本页通过' : '通过', passed),
    metric(multiPage ? '本页异常' : '异常', exceptions, exceptions > 0 ? 'danger' : '')
  ].join('');

  primaryView.innerHTML = `
    <h2>我的成绩</h2>
    ${
      grades.length
        ? table(
            ['课程', '来源学校', '原始成绩', '适配成绩', '适配 GPA', '审核状态'],
            grades.map(
              (item) => `<tr>
          <td>${esc(item.course_name || '—')}</td>
          <td>${esc(item.source_school_name || item.source_country_code || '—')}</td>
          <td>${esc(item.original_grade || '—')}</td>
          <td>${esc(item.adapted_score ?? '—')}</td>
          <td>${esc(item.adapted_gpa ?? '—')}</td>
          <td><span class="status ${item.adapt_status === 'exception' ? 'danger' : ''}">${esc(item.audit_status || '—')}</span></td>
        </tr>`
            )
          )
        : '<p class="muted">暂无成绩记录。</p>'
    }
    ${gradesPager(result)}`;

  primaryView.querySelectorAll('[data-grades-page]').forEach((button) => {
    button.addEventListener('click', () => renderStudentGrades(Number(button.dataset.gradesPage)));
  });
  sideView.innerHTML = `<h3>成绩适配</h3><p class="muted">系统保留原始成绩、适配成绩、规则版本、审核状态与异常原因，支持跨国家、跨学校成绩归一化。</p>`;
}

/** 成绩单翻页条。只有一页时不渲染。 */
function gradesPager(result) {
  if (!result.totalPages || result.totalPages <= 1) return '';
  return `<div class="pager">
      <button class="ghost-button" data-grades-page="${result.page - 1}" ${result.page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="muted">第 ${result.page} / ${result.totalPages} 页</span>
      <button class="ghost-button" data-grades-page="${result.page + 1}" ${
        result.page >= result.totalPages ? 'disabled' : ''
      }>下一页</button>
    </div>`;
}

async function renderAccount() {
  const me = await api('/api/auth/me');
  summaryGrid.innerHTML = [
    metric('账号', me.username),
    metric('角色', me.role),
    metric('状态', me.status),
    metric('最后登录', me.lastLoginAt ? String(me.lastLoginAt).replace('T', ' ').slice(0, 19) : '—')
  ].join('');

  primaryView.innerHTML = `
    <h2>账号安全</h2>
    <form class="account-form" id="profileForm">
      <label><span>姓名</span><input name="displayName" value="${esc(me.displayName || '')}" required /></label>
      <label><span>邮箱</span><input name="email" type="email" value="${esc(me.email || '')}" /></label>
      <label><span>手机号</span><input name="phone" value="${esc(me.phone || '')}" /></label>
      <button class="primary-button" type="submit">保存资料</button>
      <p class="form-ok" id="profileMessage"></p>
    </form>`;

  sideView.innerHTML = `
    <h3>${esc(t('changePassword'))}</h3>
    <form class="account-form" id="passwordForm">
      <label><span>${esc(t('currentPassword'))}</span><input name="currentPassword" type="password" autocomplete="current-password" required /></label>
      <label><span>${esc(t('newPassword'))}</span><input name="newPassword" type="password" autocomplete="new-password" required /></label>
      <label><span>${esc(t('confirmPassword'))}</span><input name="confirmPassword" type="password" autocomplete="new-password" required /></label>
      <button class="primary-button" type="submit">${esc(t('changePasswordButton'))}</button>
      <p class="message" id="passwordMessage"></p>
    </form>`;

  $('#profileForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const message = $('#profileMessage');
    message.textContent = '';
    try {
      await api('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: form.get('displayName'),
          email: form.get('email'),
          phone: form.get('phone')
        })
      });
      message.textContent = t('profileSaved');
      toast(t('profileSaved'));
    } catch (error) {
      message.textContent = error.message;
    }
  });

  $('#passwordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const message = $('#passwordMessage');
    message.textContent = '';

    if (form.get('newPassword') !== form.get('confirmPassword')) {
      message.textContent = t('passwordMismatch');
      return;
    }
    try {
      const result = await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: form.get('currentPassword'),
          newPassword: form.get('newPassword')
        })
      });
      // 改密会让旧 token 全部失效，后端回传了一个新的，这里换上，避免自己被踢下线
      if (result.token) {
        setSession({ ...state.session, token: result.token });
      }
      message.textContent = t('passwordChanged');
      toast(t('passwordChanged'));
      event.target.reset();
    } catch (error) {
      message.textContent = error.message;
    }
  });
}

async function renderApp() {
  if (!state.session) return;
  setLoggedIn(true);
  renderTabs();
  // 三个区域一起清空：只清主视图的话，切换账号或页签时上一个账号的指标数字
  // 会一直挂在页面上，直到新请求返回 —— 慢网络下就是几秒钟的错数据。
  primaryView.innerHTML = '<p class="muted">加载中…</p>';
  summaryGrid.innerHTML = '';
  sideView.innerHTML = '';
  try {
    if (currentTab === 'dashboard') await renderDashboard();
    if (currentTab === 'profile') await renderStudentProfile();
    if (currentTab === 'grades') await renderStudentGrades();
    if (currentTab === 'account') await renderAccount();
  } catch (error) {
    primaryView.innerHTML = `<p class="message">${esc(t('loadFailed'))}</p><code>${esc(error.message)}</code>`;
    sideView.innerHTML = '';
  }
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

$$('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchAuthPanel(tab.dataset.panel));
});

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const message = $('#loginMessage');
  message.textContent = '';
  try {
    const session = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: form.get('username'), password: form.get('password') })
    });
    setSession(session);
    currentTab = roleTabs()[0];
    renderApp();
  } catch (error) {
    message.textContent = error.message || t('loginFailed');
  }
});

$('#registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const message = $('#registerMessage');
  message.textContent = '';

  if (form.get('password') !== form.get('confirmPassword')) {
    message.textContent = t('passwordMismatch');
    return;
  }

  try {
    await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: form.get('username'),
        password: form.get('password'),
        displayName: form.get('displayName'),
        email: form.get('email') || undefined,
        phone: form.get('phone') || undefined,
        studentNo: form.get('studentNo') || undefined,
        englishName: form.get('englishName') || undefined
      })
    });
    event.target.reset();
    switchAuthPanel('login');
    $('#loginMessage').textContent = t('registerOk');
    toast(t('registerOk'));
  } catch (error) {
    message.textContent = error.message;
  }
});

$('#langToggle').addEventListener('click', () => {
  setLang(state.lang === 'zh' ? 'en' : 'zh');
  applyI18n();
  if (state.session) {
    renderTabs();
    renderApp();
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* 退出失败也要清本地会话 */
  }
  setSession(null);
  setLoggedIn(false);
});

applyI18n();
if (state.session) {
  currentTab = roleTabs()[0];
  renderApp();
} else {
  setLoggedIn(false);
}
