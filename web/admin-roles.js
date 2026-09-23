/**
 * Экран A10 «Админ — Роли и доступы».
 *
 * Единственный экран панели, который заводит аккаунты и меняет роли.
 * Роль человека — список (`roles`), а не одно значение: везде ниже она
 * проверяется вхождением (`roles.includes('admin')`), а не сравнением
 * с одиночной строкой — так же, как на сервере (server/src/lib/roles.js,
 * has()) и в admin-shell.js (hasAdminRole()).
 *
 * GET /api/admin/permissions — только справочная матрица, без форм.
 * GET /api/admin/users, POST /api/admin/users, PATCH /api/admin/users/:id —
 * список и редактирование ролей/контактов/активности.
 */
import {
  $, el, api, initAdminShell, showForbidden, tag, personCell,
} from './admin-shell.js';

const ROLE_LABEL = { user: 'Клиент', master: 'Мастер', admin: 'Администратор' };
const ROLE_TONE = { user: 'neutral', master: 'info', admin: 'brand' };

const ROLE_FILTERS = [
  { key: null, label: 'Все' },
  { key: 'user', label: 'Клиенты' },
  { key: 'master', label: 'Мастера' },
  { key: 'admin', label: 'Администраторы' },
];

let meId = null;
let currentFilter = null;
let currentSearch = '';
let searchDebounce = null;
let nextAfterId = null;
let editingUserId = null;

// --------------------------------------------------------------------------
// Матрица прав — только для чтения
// --------------------------------------------------------------------------

function permCell(roleInfo) {
  const wrap = el('div', 'arl-cell');
  const ok = Boolean(roleInfo?.allowed);
  const mark = el('span', 'arl-mark', ok ? '✓' : '✕');
  mark.dataset.ok = String(ok);
  wrap.append(mark);
  if (roleInfo?.note) {
    const note = el('span', 'arl-note', roleInfo.note);
    wrap.append(note);
  }
  return wrap;
}

function renderPermissionGroups(data) {
  const roles = Array.isArray(data.roles) ? data.roles : ['user', 'master', 'admin'];
  const box = $('#perm-groups');
  box.replaceChildren();

  for (const group of data.groups) {
    const groupBox = el('div', 'arl-group');
    groupBox.append(el('h3', 'arl-group__title', group.group));

    const table = el('table', 'adm-table');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.append(el('th', null, 'Действие'));
    for (const role of roles) headRow.append(el('th', null, ROLE_LABEL[role] ?? role));
    thead.append(headRow);
    table.append(thead);

    const tbody = el('tbody');
    for (const permission of group.permissions) {
      const row = el('tr');
      row.append(el('td', null, permission.title));
      for (const role of roles) {
        const cell = el('td');
        cell.append(permCell(permission.roles?.[role]));
        row.append(cell);
      }
      tbody.append(row);
    }
    table.append(tbody);
    groupBox.append(table);
    box.append(groupBox);
  }
}

async function loadPermissions() {
  $('#perm-loading').hidden = false;
  $('#perm-error').hidden = true;
  $('#perm-groups').hidden = true;

  try {
    const data = await api('/api/admin/permissions');
    renderPermissionGroups(data);
    $('#perm-loading').hidden = true;
    $('#perm-groups').hidden = false;
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    $('#perm-loading').hidden = true;
    $('#perm-error').hidden = false;
  }
}

// --------------------------------------------------------------------------
// Список пользователей — фильтр, поиск, листание
// --------------------------------------------------------------------------

function renderFilterChips() {
  const box = $('#roles-filter-chips');
  box.replaceChildren();
  for (const filter of ROLE_FILTERS) {
    const btn = el('button', 'chip', filter.label);
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(currentFilter === filter.key));
    btn.addEventListener('click', () => {
      if (currentFilter === filter.key) return;
      currentFilter = filter.key;
      renderFilterChips();
      loadUsers({ reset: true });
    });
    box.append(btn);
  }
}

function userRow(user) {
  const row = el('tr');

  const nameTd = el('td');
  nameTd.append(personCell(user.full_name, user.email));
  row.append(nameTd);

  row.append(el('td', null, user.phone ?? '—'));

  const rolesTd = el('td');
  const rolesWrap = el('div', 'arl-roles');
  for (const role of user.roles ?? []) rolesWrap.append(tag(ROLE_LABEL[role] ?? role, ROLE_TONE[role] ?? 'neutral'));
  rolesTd.append(rolesWrap);
  row.append(rolesTd);

  const statusTd = el('td');
  statusTd.append(tag(user.is_active ? 'Активен' : 'Отключён', user.is_active ? 'success' : 'neutral'));
  row.append(statusTd);

  const actionsTd = el('td', 'adm-table__actions');
  if (user.id !== meId) {
    const editBtn = el('button', 'btn btn--outline btn--sm', 'Изменить');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => openEdit(user));
    actionsTd.append(editBtn);
  } else {
    actionsTd.append(el('span', 'body-s arl-actions-empty', 'это вы'));
  }
  row.append(actionsTd);

  return row;
}

function usersQuery({ reset }) {
  const params = new URLSearchParams();
  if (currentFilter) params.set('role', currentFilter);
  if (currentSearch) params.set('search', currentSearch);
  if (!reset && nextAfterId) params.set('after_id', String(nextAfterId));
  params.set('limit', '50');
  return params.toString();
}

async function loadUsers({ reset }) {
  $('#users-error').hidden = true;
  $('#users-load-more').hidden = true;

  if (reset) {
    nextAfterId = null;
    $('#users-tbody').replaceChildren();
    $('#users-nothing').hidden = true;
    $('#users-table').hidden = false;
    const skelBody = $('#users-tbody');
    for (let i = 0; i < 5; i += 1) {
      const tr = el('tr', 'adm-table-skel');
      const td = el('td');
      td.colSpan = 5;
      td.append(el('span', 'skeleton__line'));
      tr.append(td);
      skelBody.append(tr);
    }
  }

  try {
    const data = await api(`/api/admin/users?${usersQuery({ reset })}`);
    if (reset) $('#users-tbody').replaceChildren();
    for (const user of data.users) $('#users-tbody').append(userRow(user));

    nextAfterId = data.next_after_id;
    $('#users-load-more').hidden = !nextAfterId;

    const isEmpty = reset && data.users.length === 0;
    $('#users-nothing').hidden = !isEmpty;
    $('#users-table').hidden = isEmpty;
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    if (reset) $('#users-tbody').replaceChildren();
    $('#users-error').hidden = false;
  }
}

function wireFilters() {
  renderFilterChips();
  $('#roles-search').addEventListener('input', (event) => {
    clearTimeout(searchDebounce);
    const value = event.target.value.trim();
    searchDebounce = setTimeout(() => {
      currentSearch = value;
      loadUsers({ reset: true });
    }, 300);
  });
}

// --------------------------------------------------------------------------
// Модалка «Завести аккаунт»
// --------------------------------------------------------------------------

function selectedRoles(prefix) {
  const roles = [];
  for (const role of ['user', 'master', 'admin']) {
    if ($(`#${prefix}-role-${role}`).checked) roles.push(role);
  }
  return roles;
}

function showNotice(id, message) {
  const notice = $(`#${id}`);
  notice.hidden = false;
  notice.querySelector('p').textContent = message;
}

function openCreate() {
  $('#create-email').value = '';
  $('#create-name').value = '';
  $('#create-phone').value = '';
  $('#create-role-user').checked = true;
  $('#create-role-master').checked = false;
  $('#create-role-admin').checked = false;
  $('#create-error').hidden = true;
  $('#create-form-view').hidden = false;
  $('#create-success-view').hidden = true;
  $('#create-backdrop').hidden = false;
  $('#create-email').focus();
}

function closeCreate() {
  $('#create-backdrop').hidden = true;
}

function wireCreateModal() {
  $('#create-open').addEventListener('click', openCreate);
  $('#create-close').addEventListener('click', closeCreate);
  $('#create-cancel').addEventListener('click', closeCreate);
  $('#create-done').addEventListener('click', () => {
    closeCreate();
    loadUsers({ reset: true });
  });
  $('#create-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeCreate();
  });

  $('#create-submit').addEventListener('click', async () => {
    const roles = selectedRoles('create');
    if (roles.length === 0) {
      showNotice('create-error', 'Отметьте хотя бы одну роль');
      return;
    }

    const button = $('#create-submit');
    button.disabled = true;
    try {
      const data = await api('/api/admin/users', {
        method: 'POST',
        body: {
          email: $('#create-email').value.trim(),
          full_name: $('#create-name').value.trim(),
          phone: $('#create-phone').value.trim(),
          roles,
        },
      });
      $('#create-activation-text').textContent = data.activation;
      $('#create-form-view').hidden = true;
      $('#create-success-view').hidden = false;
    } catch (error) {
      if (error.status === 403) { showForbidden(); return; }
      showNotice('create-error', error.message);
    } finally {
      button.disabled = false;
    }
  });
}

// --------------------------------------------------------------------------
// Модалка «Изменить пользователя»
// --------------------------------------------------------------------------

function openEdit(user) {
  editingUserId = user.id;
  $('#edit-name').value = user.full_name ?? '';
  $('#edit-phone').value = user.phone ?? '';
  $('#edit-email').value = user.email ?? '';
  for (const role of ['user', 'master', 'admin']) {
    $(`#edit-role-${role}`).checked = (user.roles ?? []).includes(role);
  }
  $('#edit-active').checked = Boolean(user.is_active);
  $('#edit-error').hidden = true;
  $('#edit-backdrop').hidden = false;
}

function closeEdit() {
  $('#edit-backdrop').hidden = true;
  editingUserId = null;
}

function wireEditModal() {
  $('#edit-close').addEventListener('click', closeEdit);
  $('#edit-cancel').addEventListener('click', closeEdit);
  $('#edit-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeEdit();
  });

  $('#edit-submit').addEventListener('click', async () => {
    if (!editingUserId) return;
    const roles = selectedRoles('edit');
    if (roles.length === 0) {
      showNotice('edit-error', 'Отметьте хотя бы одну роль');
      return;
    }

    const button = $('#edit-submit');
    button.disabled = true;
    try {
      await api(`/api/admin/users/${editingUserId}`, {
        method: 'PATCH',
        body: {
          full_name: $('#edit-name').value.trim(),
          phone: $('#edit-phone').value.trim(),
          email: $('#edit-email').value.trim(),
          roles,
          is_active: $('#edit-active').checked,
        },
      });
      closeEdit();
      await loadUsers({ reset: true });
    } catch (error) {
      if (error.status === 403) { showForbidden(); return; }
      showNotice('edit-error', error.message);
    } finally {
      button.disabled = false;
    }
  });
}

// --------------------------------------------------------------------------

async function main() {
  const me = await initAdminShell({ active: 'A10' });
  if (!me) return;
  meId = me.id;

  wireFilters();
  wireCreateModal();
  wireEditModal();
  $('#perm-retry').addEventListener('click', loadPermissions);
  $('#users-retry').addEventListener('click', () => loadUsers({ reset: true }));
  $('#users-load-more').addEventListener('click', () => loadUsers({ reset: false }));

  await Promise.all([loadPermissions(), loadUsers({ reset: true })]);
}

main();
