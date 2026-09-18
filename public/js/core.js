// 前端公共层：会话、请求封装、i18n、转义、提示条、格式化。
// 门户页、管理台、智能体弹框都从这里取，避免各自实现一套。

export const state = {
  lang: localStorage.getItem('lang') || 'zh',
  session: readSession()
};

function readSession() {
  try {
    return JSON.parse(localStorage.getItem('session') || 'null');
  } catch {
    return null;
  }
}

export function setSession(session) {
  state.session = session;
  if (session) localStorage.setItem('session', JSON.stringify(session));
  else localStorage.removeItem('session');
}

export function setLang(lang) {
  state.lang = lang;
  localStorage.setItem('lang', lang);
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/**
 * 统一请求封装。失败时抛出带 status 的 Error，调用方按需展示。
 * 401 分两种：带着 token 被拒按会话失效处理（清会话、提示重新登录），
 * 没带 token 的按普通错误抛出，保留服务端原话。
 */
export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const sentToken = state.session?.token;
  if (sentToken) headers.Authorization = `Bearer ${sentToken}`;

  const response = await fetch(path, { ...options, headers });

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 200) };
    }
  }

  // 401 要分两种。带着 token 被拒 = 会话真的失效了，清掉并提示重新登录；
  // 没带 token 的请求收到 401 = 这一次请求本身没通过认证，最典型的是登录时
  // 密码错。以前不分青红皂白按前者处理，于是密码打错的人被告知「登录状态已
  // 失效，请重新登录」，服务端回的「账号或密码错误」被丢掉，照着提示查不出
  // 问题在哪。这两种情况的区别就是请求里有没有 Authorization。
  if (response.status === 401 && sentToken) {
    setSession(null);
    const error = new Error('登录状态已失效，请重新登录');
    error.status = 401;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(body?.message || response.statusText || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

// ---------------------------------------------------------------------------
// i18n（门户页用；管理台的字段文案由服务端注册表下发）
// ---------------------------------------------------------------------------

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
    registerTitle: '注册账号',
    registerButton: '注册',
    toRegister: '还没有账号？去注册',
    toLogin: '已有账号？去登录',
    confirmPassword: '确认密码',
    displayName: '姓名',
    email: '邮箱',
    phone: '手机号',
    studentNo: '学号（选填）',
    englishName: '英文姓名',
    registerHintStudent: '填写学号可同时建立学生档案，留空则只创建登录账号。',
    changePassword: '修改密码',
    currentPassword: '当前密码',
    newPassword: '新密码',
    changePasswordButton: '确认修改',
    profile: '个人中心',
    saveProfile: '保存资料',
    adminConsole: '管理台',
    openAdmin: '进入管理台',
    demoUsers: '演示账号',
    noData: '暂无数据',
    loginFailed: '登录失败，请检查账号或密码。',
    loadFailed: '数据加载失败，请确认后台和数据库已启动。',
    passwordMismatch: '两次输入的密码不一致',
    registerOk: '注册成功，请使用新账号登录',
    profileSaved: '资料已保存',
    passwordChanged: '密码已修改，其他设备的登录已失效',
    requiredHint: '带 * 为必填'
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
    registerTitle: 'Create Account',
    registerButton: 'Register',
    toRegister: 'No account yet? Register',
    toLogin: 'Already registered? Sign in',
    confirmPassword: 'Confirm password',
    displayName: 'Name',
    email: 'Email',
    phone: 'Phone',
    studentNo: 'Student No. (optional)',
    englishName: 'English name',
    registerHintStudent: 'Fill in a student number to also create a student profile; leave it blank to only create a login account.',
    changePassword: 'Change Password',
    currentPassword: 'Current password',
    newPassword: 'New password',
    changePasswordButton: 'Update password',
    profile: 'My Profile',
    saveProfile: 'Save profile',
    adminConsole: 'Admin Console',
    openAdmin: 'Open admin console',
    demoUsers: 'Demo accounts',
    noData: 'No data',
    loginFailed: 'Sign-in failed. Check your username or password.',
    loadFailed: 'Failed to load data. Confirm the API and database are running.',
    passwordMismatch: 'The two passwords do not match',
    registerOk: 'Registered. Please sign in with the new account.',
    profileSaved: 'Profile saved',
    passwordChanged: 'Password updated. Other sessions have been signed out.',
    requiredHint: 'Fields marked * are required'
  }
};

export function t(key) {
  return i18n[state.lang]?.[key] || i18n.zh[key] || key;
}

export function applyI18n(root = document) {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  });
}

// ---------------------------------------------------------------------------
// DOM 工具
// ---------------------------------------------------------------------------

/**
 * 转义：所有来自接口的值都要经过它再拼进 innerHTML。
 * 库里的姓名、课程名等都是用户可写字段，直接拼就是存储型 XSS。
 */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 由 HTML 字符串建 DOM，只用于我们自己拼的模板（值必须已 esc）。 */
export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

// ---------------------------------------------------------------------------
// 提示条
// ---------------------------------------------------------------------------

let toastHost = null;

export function toast(message, tone = 'ok') {
  if (!toastHost) {
    toastHost = el('<div class="toast-host"></div>');
    document.body.appendChild(toastHost);
  }
  const node = el(`<div class="toast toast-${tone}">${esc(message)}</div>`);
  toastHost.appendChild(node);
  setTimeout(() => node.classList.add('toast-in'), 10);
  setTimeout(() => {
    node.classList.remove('toast-in');
    setTimeout(() => node.remove(), 250);
  }, 3200);
}

// ---------------------------------------------------------------------------
// 确认框（原生 confirm 在部分安卓 WebView 里会被拦截，所以自己实现）
// ---------------------------------------------------------------------------

export function confirmDialog(message, { confirmText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = el(`
      <div class="modal-overlay">
        <div class="modal-card">
          <p class="modal-message">${esc(message)}</p>
          <div class="modal-actions">
            <button class="ghost-button" data-act="cancel">取消</button>
            <button class="${danger ? 'danger-button' : 'primary-button'}" data-act="ok">${esc(confirmText)}</button>
          </div>
        </div>
      </div>`);
    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
    };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(false);
      if (event.target.dataset.act === 'cancel') close(false);
      if (event.target.dataset.act === 'ok') close(true);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  });
}

// ---------------------------------------------------------------------------
// 单元格格式化
// ---------------------------------------------------------------------------

const EMPTY = '—';

function looksLikeDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

/**
 * 按注册表声明的列类型渲染单元格内容。
 * @param {*} value   接口返回值
 * @param {object} column displayColumns 里的一项
 * @param {object} dicts { enumLabels, enumTones }
 */
export function formatCell(value, column, dicts = {}) {
  if (value === null || value === undefined || value === '') return EMPTY;

  switch (column.type) {
    case 'enum': {
      const label = dicts.enumLabels?.[value] || value;
      const tone = dicts.enumTones?.[value] || '';
      return `<span class="status ${esc(tone)}">${esc(label)}</span>`;
    }
    case 'boolean':
      return value === 1 || value === true || value === '1'
        ? '<span class="status ok">是</span>'
        : '<span class="status muted-badge">否</span>';
    case 'date':
      return esc(String(value).slice(0, 10));
    case 'datetime': {
      const text = looksLikeDate(value) ? value.replace('T', ' ').slice(0, 19) : String(value);
      return esc(text);
    }
    case 'percent':
      return `${esc(value)}%`;
    case 'days': {
      const days = Number(value);
      if (!Number.isFinite(days)) return esc(value);
      // 剩余天数直接决定风险观感，这里给颜色
      const tone = days < 0 ? 'danger' : days <= 60 ? 'warning' : '';
      const text = days < 0 ? `已过期 ${Math.abs(days)} 天` : `${days} 天`;
      return `<span class="status ${tone}">${esc(text)}</span>`;
    }
    case 'truncate': {
      const text = String(value);
      return `<span title="${esc(text)}">${esc(text.length > 40 ? `${text.slice(0, 40)}…` : text)}</span>`;
    }
    default:
      return esc(value);
  }
}
