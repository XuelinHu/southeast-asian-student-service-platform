// 管理台前端。
//
// 整个页面由 /api/admin/resources 下发的元数据驱动：菜单、表格列、筛选器、
// 编辑表单都不在这里写死字段名，新增业务表只需要在 src/config/resources.js 里加一条。

import { state, api, esc, el, $, toast, confirmDialog, formatCell, setSession, applyI18n } from './core.js';

const view = { resource: null, page: 1, pageSize: 20, q: '', sortBy: '', sortOrder: 'desc', filters: {} };
let meta = { items: [], enumLabels: {}, enumTones: {} };
let current = null; // 当前资源的元数据
let lastResult = null;
const dicts = () => ({ enumLabels: meta.enumLabels, enumTones: meta.enumTones });
const optionCache = new Map();

const gate = $('#adminGate');
const shell = $('#adminShell');
const gateMessage = $('#gateMessage');
const sidebarNav = $('#sidebarNav');
const toolbarFilters = $('#toolbarFilters');
const searchInput = $('#searchInput');
const pageSizeSelect = $('#pageSizeSelect');
const tableScroll = $('#tableScroll');
const pagination = $('#pagination');
const drawerHost = $('#drawerHost');

// ---------------------------------------------------------------------------
// URL 状态：刷新/分享链接后停留在同一个菜单与查询条件
// ---------------------------------------------------------------------------

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return {
    resource: params.get('resource'),
    page: Number(params.get('page')) || 1,
    pageSize: Number(params.get('pageSize')) || 20,
    q: params.get('q') || '',
    sortBy: params.get('sortBy') || '',
    sortOrder: params.get('sortOrder') === 'asc' ? 'asc' : 'desc',
    filters: params.get('filters') ? safeParse(params.get('filters')) : {}
  };
}

function safeParse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeHash() {
  const params = new URLSearchParams();
  params.set('resource', view.resource);
  params.set('page', String(view.page));
  params.set('pageSize', String(view.pageSize));
  if (view.q) params.set('q', view.q);
  if (view.sortBy) {
    params.set('sortBy', view.sortBy);
    params.set('sortOrder', view.sortOrder);
  }
  const activeFilters = Object.fromEntries(Object.entries(view.filters).filter(([, v]) => v !== '' && v != null));
  if (Object.keys(activeFilters).length) params.set('filters', JSON.stringify(activeFilters));
  // replaceState 避免每次翻页都往历史里塞一条
  history.replaceState(null, '', `#${params.toString()}`);
}

// ---------------------------------------------------------------------------
// 下拉选项
// ---------------------------------------------------------------------------

async function loadOptions(resourceKey, field) {
  const cacheKey = `${resourceKey}:${field}`;
  if (optionCache.has(cacheKey)) return optionCache.get(cacheKey);
  const promise = api(`/api/admin/${resourceKey}/options?field=${encodeURIComponent(field)}`)
    .then((body) => body.items || [])
    .catch(() => []);
  optionCache.set(cacheKey, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// 侧边栏
// ---------------------------------------------------------------------------

function renderSidebar() {
  const groups = new Map();
  for (const item of meta.items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }

  sidebarNav.innerHTML = Array.from(groups.entries())
    .map(
      ([group, items]) => `
      <div class="nav-group">
        <p class="nav-group-title">${esc(group)}</p>
        ${items
          .map(
            (item) =>
              `<button class="nav-item ${item.key === view.resource ? 'active' : ''}" data-key="${esc(item.key)}">${esc(item.label)}</button>`
          )
          .join('')}
      </div>`
    )
    .join('');

  sidebarNav.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => {
      selectResource(button.dataset.key);
      // 窄屏下选完菜单就把抽屉收起来，否则要再点一次遮罩才看得见内容
      closeSidebar();
    });
  });
}

// ---------------------------------------------------------------------------
// 窄屏抽屉
// ---------------------------------------------------------------------------

const sidebar = $('#adminSidebar');
const sidebarScrim = $('#sidebarScrim');
const sidebarToggle = $('#sidebarToggle');

function openSidebar() {
  sidebar.classList.add('opened');
  sidebarScrim.classList.remove('hidden');
  sidebarToggle.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  sidebar.classList.remove('opened');
  sidebarScrim.classList.add('hidden');
  sidebarToggle.setAttribute('aria-expanded', 'false');
}

function bindSidebar() {
  sidebarToggle.addEventListener('click', () => {
    if (sidebar.classList.contains('opened')) closeSidebar();
    else openSidebar();
  });
  sidebarScrim.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebar();
  });
  // 转回宽屏时把抽屉状态清掉，否则侧边栏会留着 .opened 的阴影
  window.matchMedia('(max-width: 900px)').addEventListener('change', (event) => {
    if (!event.matches) closeSidebar();
  });
}

function selectResource(key) {
  if (key === view.resource) return;
  view.resource = key;
  view.page = 1;
  view.q = '';
  view.sortBy = '';
  view.sortOrder = 'desc';
  view.filters = {};
  current = meta.items.find((item) => item.key === key) || null;
  searchInput.value = '';
  renderSidebar();
  renderToolbar();
  writeHash();
  load();
}

// ---------------------------------------------------------------------------
// 工具栏
// ---------------------------------------------------------------------------

function renderToolbar() {
  $('#viewTitle').textContent = current?.label || '—';
  $('#viewSubtitle').textContent = current ? `${current.group} · 共 ${lastResult?.total ?? '…'} 条记录` : '';
  searchInput.placeholder = current?.searchPlaceholder || '输入关键词搜索';
  searchInput.disabled = !current;

  const canCreate = Boolean(current?.canCreate);
  $('#createBtn').classList.toggle('hidden', !canCreate);

  toolbarFilters.innerHTML = Object.entries(current?.filters || {})
    .map(([name, filter]) => {
      const value = view.filters[name] ?? '';
      if (filter.values) {
        const options = filter.values
          .map(
            (v) =>
              `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(meta.enumLabels[v] || v)}</option>`
          )
          .join('');
        return `<label class="filter-field"><span>${esc(filter.label)}</span>
          <select data-filter="${esc(name)}"><option value="">全部</option>${options}</select></label>`;
      }
      if (filter.option) {
        // 选项异步加载，先占位
        return `<label class="filter-field"><span>${esc(filter.label)}</span>
          <select data-filter="${esc(name)}" data-option="${esc(filter.option)}"><option value="">全部</option></select></label>`;
      }
      return `<label class="filter-field"><span>${esc(filter.label)}</span>
        <input type="text" data-filter="${esc(name)}" value="${esc(value)}" placeholder="全部" /></label>`;
    })
    .join('');

  toolbarFilters.querySelectorAll('[data-filter]').forEach((node) => {
    const name = node.dataset.filter;
    const trigger = () => {
      view.filters[name] = node.value;
      view.page = 1;
      writeHash();
      load();
    };
    // 文本输入用回车/失焦触发，下拉即时触发
    if (node.tagName === 'SELECT') node.addEventListener('change', trigger);
    else {
      node.addEventListener('change', trigger);
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') trigger();
      });
    }
  });

  // 异步补齐 option 类型的筛选项
  for (const [name, filter] of Object.entries(current?.filters || {})) {
    if (!filter.option) continue;
    loadOptions(view.resource, filter.option).then((items) => {
      const select = toolbarFilters.querySelector(`[data-filter="${CSS.escape(name)}"]`);
      if (!select) return;
      const selected = view.filters[name] ?? '';
      select.innerHTML =
        '<option value="">全部</option>' +
        items
          .map(
            (item) =>
              `<option value="${esc(item.value)}" ${String(selected) === String(item.value) ? 'selected' : ''}>${esc(item.label)}</option>`
          )
          .join('');
    });
  }
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

function buildQuery() {
  const params = new URLSearchParams();
  params.set('page', String(view.page));
  params.set('pageSize', String(view.pageSize));
  if (view.q) params.set('q', view.q);
  if (view.sortBy) {
    params.set('sortBy', view.sortBy);
    params.set('sortOrder', view.sortOrder);
  }
  for (const [name, value] of Object.entries(view.filters)) {
    if (value !== '' && value != null) params.set(name, value);
  }
  return params.toString();
}

async function load() {
  if (!current) return;
  tableScroll.innerHTML = '<p class="table-placeholder">加载中…</p>';
  try {
    lastResult = await api(`/api/admin/${view.resource}?${buildQuery()}`);
    renderTable(lastResult);
    renderPagination(lastResult);
    $('#viewSubtitle').textContent = `${current.group} · 共 ${lastResult.total} 条记录`;
  } catch (error) {
    tableScroll.innerHTML = `<p class="table-placeholder">加载失败：${esc(error.message)}</p>`;
    pagination.innerHTML = '';
  }
}

function renderTable(result) {
  const columns = current.columns || [];
  const canEdit = current.canUpdate;
  const canDelete = current.canDelete;
  const rowActions = current.rowActions || [];
  const hasActions = canEdit || canDelete || rowActions.length;

  const head = columns
    .map((column) => {
      if (!column.sortable) return `<th>${esc(column.label)}</th>`;
      const active = view.sortBy === column.sortable;
      const arrow = active ? (view.sortOrder === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="sortable" data-sort="${esc(column.sortable)}">${esc(column.label)}${arrow}</th>`;
    })
    .join('');

  // 没数据时也保留表头，否则空菜单看起来像页面坏了
  const totalColumns = columns.length + (hasActions ? 1 : 0);
  const emptyText = view.q || Object.keys(view.filters).length ? '没有匹配的记录' : '暂无数据';

  const body = (result.items.length
    ? result.items
    : [null]
  )
    .map((row) => {
      if (!row) return `<tr><td class="table-placeholder" colspan="${totalColumns}">${emptyText}</td></tr>`;

      const cells = columns
        .map((column) => `<td>${formatCell(row[column.key], column, dicts())}</td>`)
        .join('');

      const actions = [];
      if (rowActions.includes('resetPassword')) {
        actions.push(`<button class="row-action" data-act="reset" data-id="${esc(row.id)}">重置密码</button>`);
      }
      if (rowActions.includes('toggleStatus')) {
        const next = row.status === 'active' ? 'disabled' : 'active';
        actions.push(
          `<button class="row-action ${next === 'disabled' ? 'danger' : ''}" data-act="status" data-id="${esc(row.id)}" data-next="${next}">${next === 'disabled' ? '禁用' : '启用'}</button>`
        );
      }
      if (rowActions.includes('permissions')) {
        actions.push(`<button class="row-action" data-act="permissions" data-id="${esc(row.id)}">权限</button>`);
      }
      if (canEdit) actions.push(`<button class="row-action" data-act="edit" data-id="${esc(row.id)}">编辑</button>`);
      if (canDelete) actions.push(`<button class="row-action danger" data-act="delete" data-id="${esc(row.id)}">删除</button>`);

      return `<tr>${cells}${hasActions ? `<td class="cell-actions">${actions.join('')}</td>` : ''}</tr>`;
    })
    .join('');

  tableScroll.innerHTML = `<table class="admin-table">
      <thead><tr>${head}${hasActions ? '<th class="cell-actions">操作</th>' : ''}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;

  tableScroll.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (view.sortBy === key) view.sortOrder = view.sortOrder === 'asc' ? 'desc' : 'asc';
      else {
        view.sortBy = key;
        view.sortOrder = 'desc';
      }
      view.page = 1;
      writeHash();
      load();
    });
  });

  tableScroll.querySelectorAll('.row-action').forEach((button) => {
    button.addEventListener('click', () => handleRowAction(button.dataset, result.items));
  });
}

function renderPagination(result) {
  const totalPages = Math.max(result.totalPages, 1);
  pagination.innerHTML = `
    <span>共 ${result.total} 条，第 ${result.page} / ${totalPages} 页</span>
    <div class="pagination-controls">
      <button data-page="1" ${result.page <= 1 ? 'disabled' : ''}>首页</button>
      <button data-page="${result.page - 1}" ${result.page <= 1 ? 'disabled' : ''}>上一页</button>
      <input type="number" min="1" max="${totalPages}" value="${result.page}" id="pageJump" />
      <button data-page="${result.page + 1}" ${result.page >= totalPages ? 'disabled' : ''}>下一页</button>
      <button data-page="${totalPages}" ${result.page >= totalPages ? 'disabled' : ''}>末页</button>
    </div>`;

  pagination.querySelectorAll('[data-page]').forEach((button) => {
    button.addEventListener('click', () => gotoPage(Number(button.dataset.page)));
  });
  $('#pageJump').addEventListener('change', (event) => gotoPage(Number(event.target.value)));
}

function gotoPage(page) {
  const totalPages = Math.max(lastResult?.totalPages || 1, 1);
  const target = Math.min(Math.max(page || 1, 1), totalPages);
  if (target === view.page) return;
  view.page = target;
  writeHash();
  load();
}

// ---------------------------------------------------------------------------
// 行操作
// ---------------------------------------------------------------------------

async function handleRowAction(dataset, items) {
  const row = items.find((item) => String(item.id) === String(dataset.id));
  if (!row) return;

  if (dataset.act === 'edit') return openDrawer('edit', row);
  if (dataset.act === 'delete') return removeRow(row);
  if (dataset.act === 'permissions') return openPermissions(row);

  if (dataset.act === 'status') {
    const label = dataset.next === 'disabled' ? '禁用' : '启用';
    if (!(await confirmDialog(`确定要${label}用户「${row.username}」吗？`, { danger: dataset.next === 'disabled' }))) return;
    try {
      await api(`/api/admin/users/${row.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: dataset.next }) });
      toast(`已${label}`);
      load();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }

  if (dataset.act === 'reset') {
    openResetPassword(row);
  }
}

async function removeRow(row) {
  const name = row.student_no || row.name || row.username || row.code || `#${row.id}`;
  if (!(await confirmDialog(`确定删除「${name}」吗？此操作不可撤销。`, { confirmText: '删除', danger: true }))) return;
  try {
    await api(`/api/admin/${view.resource}/${row.id}`, { method: 'DELETE' });
    toast('已删除');
    // 删掉当前页最后一条时回退一页，避免停在空页
    if (lastResult.items.length === 1 && view.page > 1) view.page -= 1;
    writeHash();
    load();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openResetPassword(row) {
  const drawer = el(`
    <div class="drawer-overlay">
      <aside class="drawer">
        <header class="drawer-header">
          <h3>重置密码 · ${esc(row.username)}</h3>
          <button class="ghost-button" data-act="close">关闭</button>
        </header>
        <div class="drawer-body">
          <form class="drawer-form" id="resetForm">
            <label><span>新密码 <span class="required-mark">*</span></span>
              <input name="newPassword" type="text" autocomplete="new-password" />
              <span class="field-hint">至少 8 位，需同时包含字母和数字。重置后该用户在其他设备的登录会失效。</span>
            </label>
            <p class="form-error" id="resetError"></p>
          </form>
        </div>
        <footer class="drawer-footer">
          <button class="ghost-button" data-act="close">取消</button>
          <button class="primary-button" id="resetSave">确认重置</button>
        </footer>
      </aside>
    </div>`);

  const close = () => drawer.remove();
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer || event.target.dataset.act === 'close') close();
  });
  drawer.querySelector('#resetSave').addEventListener('click', async () => {
    const newPassword = drawer.querySelector('[name="newPassword"]').value;
    const errorNode = drawer.querySelector('#resetError');
    errorNode.textContent = '';
    try {
      const result = await api(`/api/admin/users/${row.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ newPassword })
      });
      close();
      toast(result.message || '密码已重置');
    } catch (error) {
      errorNode.textContent = error.message;
    }
  });

  drawerHost.appendChild(drawer);
}

// ---------------------------------------------------------------------------
// 权限矩阵抽屉（角色管理菜单的行操作）
//
// 勾选矩阵是整份替换：保存时把抽屉里所有行的四个权限位一起 PUT 回去。
// 因此凡是抽屉读到的字段都必须原样回传——尤其是 teacherTypes，
// 漏传等于把「班级维护仅限班主任与教务」这条收窄悄悄抹掉。
// ---------------------------------------------------------------------------

const PERMISSION_ACTIONS = [
  { key: 'canView', label: '查看' },
  { key: 'canCreate', label: '新增' },
  { key: 'canUpdate', label: '修改' },
  { key: 'canDelete', label: '删除' }
];

const TEACHER_TYPE_KEYS = ['course_teacher', 'head_teacher', 'counselor', 'admin_teacher'];

async function openPermissions(row) {
  let payload;
  try {
    payload = await api(`/api/admin/roles/${row.id}/menus`);
  } catch (error) {
    return toast(error.message, 'error');
  }

  const { role, menus } = payload;
  // 超管在 canAccess 里短路，这份勾选对它不生效，服务端也会拒收，这里只读展示
  const readOnly = Boolean(role.isSuper);
  const hasTeacherScoped = menus.some((menu) => menu.teacherScoped);

  const groups = new Map();
  for (const menu of menus) {
    const group = menu.group || '其他';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(menu);
  }

  const headCells = PERMISSION_ACTIONS.map((action) => {
    if (readOnly) return `<th>${action.label}</th>`;
    return `<th><label class="perm-head"><input type="checkbox" data-col="${action.key}" /><span>${action.label}</span></label></th>`;
  }).join('');

  const body = Array.from(groups.entries())
    .map(
      ([group, items]) => `
      <tr class="perm-group"><td colspan="${PERMISSION_ACTIONS.length + (hasTeacherScoped ? 2 : 1)}">${esc(group)}</td></tr>
      ${items
        .map((menu) => {
          const cells = PERMISSION_ACTIONS.map(
            (action) =>
              `<td class="perm-cell"><input type="checkbox" data-action="${action.key}" ${
                menu[action.key] ? 'checked' : ''
              } ${readOnly ? 'disabled' : ''} /></td>`
          ).join('');

          const teacherCell = hasTeacherScoped
            ? `<td class="perm-cell perm-teacher">${
                menu.teacherScoped
                  ? TEACHER_TYPE_KEYS.map((key) => {
                      const checked = String(menu.teacherTypes || '')
                        .split(',')
                        .map((value) => value.trim())
                        .includes(key);
                      return `<label class="perm-chip"><input type="checkbox" data-tt="${key}" ${
                        checked ? 'checked' : ''
                      } ${readOnly ? 'disabled' : ''} /><span>${esc(meta.enumLabels[key] || key)}</span></label>`;
                    }).join('')
                  : '<span class="field-hint">—</span>'
              }</td>`
            : '';

          return `<tr data-menu="${esc(menu.menuKey)}" data-teacher-scoped="${menu.teacherScoped ? '1' : '0'}">
            <td>${esc(menu.label)}</td>${cells}${teacherCell}</tr>`;
        })
        .join('')}`
    )
    .join('');

  const drawer = el(`
    <div class="drawer-overlay">
      <aside class="drawer drawer-wide">
        <header class="drawer-header">
          <h3>权限矩阵 · ${esc(role.name)}</h3>
          <button class="ghost-button" data-act="close">关闭</button>
        </header>
        <div class="drawer-body">
          ${
            readOnly
              ? '<p class="perm-notice">超级管理员对所有菜单都有全部权限，此矩阵对它不生效，只作展示。</p>'
              : `<div class="perm-toolbar">
                   <button class="ghost-button" data-act="all">全选</button>
                   <button class="ghost-button" data-act="none">全部清空</button>
                   <span class="field-hint">不勾「查看」的菜单不会保存；教师类型不勾表示不限类型。</span>
                 </div>`
          }
          ${
            hasTeacherScoped
              ? '<p class="field-hint">「教师类型」只对教师角色生效：勾选后该角色仅这些类型的教师能操作本菜单。</p>'
              : ''
          }
          <div class="perm-scroll">
            <table class="perm-table">
              <thead><tr><th>菜单</th>${headCells}${hasTeacherScoped ? '<th>教师类型</th>' : ''}</tr></thead>
              <tbody>${body}</tbody>
            </table>
          </div>
          <p class="form-error" id="permError"></p>
        </div>
        <footer class="drawer-footer">
          <button class="ghost-button" data-act="close">取消</button>
          ${readOnly ? '' : '<button class="primary-button" id="permSave">保存</button>'}
        </footer>
      </aside>
    </div>`);

  const rowNodes = Array.from(drawer.querySelectorAll('tbody tr[data-menu]'));

  // 看不到就谈不上增删改：与服务端 normalizeMenuGrant 的规整保持一致，
  // 让用户在选择的那一刻就看到另外三个框被锁住，而不是提交后才被悄悄清零。
  const syncRow = (tr) => {
    const viewBox = tr.querySelector('[data-action="canView"]');
    if (!viewBox) return;
    for (const action of ['canCreate', 'canUpdate', 'canDelete']) {
      const box = tr.querySelector(`[data-action="${action}"]`);
      if (!box || readOnly) continue;
      box.disabled = !viewBox.checked;
      if (!viewBox.checked) box.checked = false;
    }
    tr.classList.toggle('perm-row-off', !viewBox.checked);
  };

  rowNodes.forEach(syncRow);

  const close = () => drawer.remove();
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer || event.target.dataset.act === 'close') close();
  });

  drawer.addEventListener('change', (event) => {
    const column = event.target.dataset.col;
    if (column) {
      // 表头勾选框：整列开关。查看列关掉时逐行联动会顺带清掉另外三列。
      for (const tr of rowNodes) {
        const box = tr.querySelector(`[data-action="${column}"]`);
        if (box && !box.disabled) box.checked = event.target.checked;
      }
      rowNodes.forEach(syncRow);
      return;
    }
    if (event.target.dataset.action === 'canView') syncRow(event.target.closest('tr'));
  });

  const setAll = (value) => {
    for (const tr of rowNodes) {
      const viewBox = tr.querySelector('[data-action="canView"]');
      if (!viewBox) continue;
      viewBox.checked = value;
      for (const action of ['canCreate', 'canUpdate', 'canDelete']) {
        const box = tr.querySelector(`[data-action="${action}"]`);
        if (box) box.checked = value;
      }
      syncRow(tr);
    }
    drawer.querySelectorAll('[data-col]').forEach((box) => {
      box.checked = value;
    });
  };

  drawer.querySelector('[data-act="all"]')?.addEventListener('click', () => setAll(true));
  drawer.querySelector('[data-act="none"]')?.addEventListener('click', () => setAll(false));

  drawer.querySelector('#permSave')?.addEventListener('click', async () => {
    const errorNode = drawer.querySelector('#permError');
    errorNode.textContent = '';

    const body = rowNodes.map((tr) => {
      const checked = (action) => Boolean(tr.querySelector(`[data-action="${action}"]`)?.checked);
      const canView = checked('canView');
      const teacherTypes =
        tr.dataset.teacherScoped === '1'
          ? Array.from(tr.querySelectorAll('[data-tt]:checked')).map((node) => node.dataset.tt)
          : null;

      return {
        menuKey: tr.dataset.menu,
        canView,
        canCreate: canView && checked('canCreate'),
        canUpdate: canView && checked('canUpdate'),
        canDelete: canView && checked('canDelete'),
        teacherTypes: teacherTypes && teacherTypes.length ? teacherTypes : null
      };
    });

    try {
      const result = await api(`/api/admin/roles/${role.id}/menus`, {
        method: 'PUT',
        body: JSON.stringify({ menus: body })
      });
      close();
      toast(result.message || '权限已保存');
    } catch (error) {
      errorNode.textContent = error.message;
    }
  });

  drawerHost.appendChild(drawer);
}

// ---------------------------------------------------------------------------
// 新增 / 编辑抽屉
// ---------------------------------------------------------------------------

async function openDrawer(mode, row) {
  const fields = Object.entries(current.fields || {});
  if (!fields.length) return;

  // 先把需要用到的下拉选项都取回来，再渲染，避免表单先空后跳
  const optionNames = Array.from(new Set(fields.map(([, f]) => f.option).filter(Boolean)));
  const optionData = {};
  await Promise.all(
    optionNames.map(async (name) => {
      optionData[name] = await loadOptions(view.resource, name);
    })
  );

  const inputs = fields
    .map(([name, field]) => {
      const value = row?.[field.key] ?? '';
      const label = `<span>${esc(field.label)}${field.required ? ' <span class="required-mark">*</span>' : ''}</span>`;

      if (field.option) {
        const options = (optionData[field.option] || [])
          .map(
            (item) =>
              `<option value="${esc(item.value)}" ${String(value) === String(item.value) ? 'selected' : ''}>${esc(item.label)}</option>`
          )
          .join('');
        return `<label>${label}<select name="${esc(name)}"><option value="">未指定</option>${options}</select></label>`;
      }
      if (field.type === 'enum') {
        const options = (field.values || [])
          .map(
            (v) => `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(meta.enumLabels[v] || v)}</option>`
          )
          .join('');
        return `<label>${label}<select name="${esc(name)}"><option value="">未指定</option>${options}</select></label>`;
      }
      if (field.type === 'boolean') {
        return `<label>${label}<select name="${esc(name)}">
            <option value="">未指定</option>
            <option value="1" ${value === 1 || value === true ? 'selected' : ''}>是</option>
            <option value="0" ${value === 0 || value === false ? 'selected' : ''}>否</option>
          </select></label>`;
      }
      if (field.type === 'date') {
        return `<label>${label}<input type="date" name="${esc(name)}" value="${esc(String(value).slice(0, 10))}" /></label>`;
      }
      if (field.type === 'datetime') {
        const text = value ? String(value).replace(' ', 'T').slice(0, 16) : '';
        return `<label>${label}<input type="datetime-local" name="${esc(name)}" value="${esc(text)}" /></label>`;
      }
      if (field.type === 'int' || field.type === 'decimal') {
        const step = field.type === 'decimal' ? '0.01' : '1';
        return `<label>${label}<input type="number" step="${step}" name="${esc(name)}" value="${esc(value)}" ${
          field.min !== undefined ? `min="${field.min}"` : ''
        } ${field.max !== undefined ? `max="${field.max}"` : ''} /></label>`;
      }
      return `<label>${label}<input type="text" name="${esc(name)}" value="${esc(value)}" ${
        field.maxLength ? `maxlength="${field.maxLength}"` : ''
      } /></label>`;
    })
    .join('');

  const title = mode === 'create' ? `新增 · ${current.label}` : `编辑 · ${current.label}`;
  const drawer = el(`
    <div class="drawer-overlay">
      <aside class="drawer">
        <header class="drawer-header">
          <h3>${esc(title)}</h3>
          <button class="ghost-button" data-act="close">关闭</button>
        </header>
        <div class="drawer-body">
          <form class="drawer-form" id="drawerForm">${inputs}</form>
          <p class="form-error" id="drawerError"></p>
        </div>
        <footer class="drawer-footer">
          <button class="ghost-button" data-act="close">取消</button>
          <button class="primary-button" id="drawerSave">保存</button>
        </footer>
      </aside>
    </div>`);

  const close = () => drawer.remove();
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer || event.target.dataset.act === 'close') close();
  });

  drawer.querySelector('#drawerSave').addEventListener('click', async () => {
    const form = drawer.querySelector('#drawerForm');
    const errorNode = drawer.querySelector('#drawerError');
    errorNode.textContent = '';

    const body = {};
    for (const [name, field] of fields) {
      const raw = form.elements[name].value;
      if (raw === '') {
        // 编辑时留空表示「不改」，新增时交给后端按必填校验
        if (mode === 'create') body[name] = null;
        continue;
      }
      if (field.type === 'boolean') body[name] = raw === '1';
      else if (field.type === 'int') body[name] = Number.parseInt(raw, 10);
      else if (field.type === 'decimal') body[name] = Number(raw);
      else body[name] = raw;
    }

    try {
      if (mode === 'create') {
        await api(`/api/admin/${view.resource}`, { method: 'POST', body: JSON.stringify(body) });
        toast('新增成功');
      } else {
        await api(`/api/admin/${view.resource}/${row.id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('保存成功');
      }
      close();
      load();
    } catch (error) {
      errorNode.textContent = error.message;
    }
  });

  drawerHost.appendChild(drawer);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function bindToolbar() {
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      view.q = searchInput.value.trim();
      view.page = 1;
      writeHash();
      load();
    }, 320);
  });

  pageSizeSelect.addEventListener('change', () => {
    view.pageSize = Number(pageSizeSelect.value);
    view.page = 1;
    writeHash();
    load();
  });

  $('#resetBtn').addEventListener('click', () => {
    view.q = '';
    view.filters = {};
    view.sortBy = '';
    view.sortOrder = 'desc';
    view.page = 1;
    searchInput.value = '';
    renderToolbar();
    writeHash();
    load();
  });

  bindSidebar();

  $('#refreshBtn').addEventListener('click', load);

  $('#createBtn').addEventListener('click', () => openDrawer('create'));

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* 退出失败也要清本地会话 */
    }
    setSession(null);
    location.href = '/';
  });
}

async function boot() {
  applyI18n();

  if (!state.session?.token) {
    gateMessage.textContent = '尚未登录，请先在门户页登录后再进入管理台。';
    return;
  }

  // 有没有管理台权限由服务端下发的菜单集合决定，前端不再维护角色白名单：
  // 角色是库里的数据，写死一份在前端就会出现"加了菜单但进不去"。
  let payload;
  try {
    payload = await api('/api/admin/resources');
    meta = { items: payload.items, enumLabels: payload.enumLabels || {}, enumTones: payload.enumTones || {} };
  } catch (error) {
    gateMessage.textContent = `加载菜单失败：${error.message}`;
    return;
  }

  if (!meta.items.length) {
    const roleName = payload.user?.roleName || state.session.user?.role || '';
    gateMessage.textContent = `当前账号角色为「${roleName}」，没有任何管理台菜单权限。`;
    return;
  }

  gate.classList.add('hidden');
  shell.classList.remove('hidden');
  $('#userBadge').textContent = `${payload.user?.name || state.session.user.displayName} · ${
    payload.user?.roleName || payload.user?.role || ''
  }`;

  const restored = readHash();
  view.pageSize = restored.pageSize;
  view.q = restored.q;
  view.sortBy = restored.sortBy;
  view.sortOrder = restored.sortOrder;
  view.filters = restored.filters;
  view.page = restored.page;
  pageSizeSelect.value = String(restored.pageSize);
  searchInput.value = restored.q;

  current = meta.items.find((item) => item.key === restored.resource) || meta.items[0] || null;
  view.resource = current?.key || null;

  renderSidebar();
  renderToolbar();
  writeHash();
  load();
  bindToolbar();
}

boot();
