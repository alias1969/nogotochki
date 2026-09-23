/**
 * Экран A8 «Админ — Клиенты».
 *
 * База клиентов: поиск, фильтр по активности, карточка с контактами,
 * переключателем активности, сводкой визитов и историей записей.
 *
 * Заведение новых аккаунтов и роли — экран A10, здесь их нет: PATCH
 * с этого экрана шлёт только {full_name, phone, email, is_active}.
 */
import {
  $, el, api, initAdminShell, showForbidden, tag, money, personCell, humanDate,
} from './admin-shell.js';

const PAGE_LIMIT = 50;

const STATUS_LABEL = {
  booked: 'Предстоит', completed: 'Завершена', no_show: 'Не пришёл', cancelled: 'Отменена',
};

function statusTone(status) {
  if (status === 'booked') return 'brand';
  if (status === 'completed') return 'success';
  if (status === 'no_show') return 'error';
  if (status === 'cancelled') return 'neutral';
  return 'neutral';
}

// --------------------------------------------------------------------------
// Список клиентов
// --------------------------------------------------------------------------

const list = {
  search: '',
  active: '',
  nextAfterId: null,
  loading: false,
};

function buildListQuery({ afterId = null } = {}) {
  const params = new URLSearchParams();
  params.set('role', 'user');
  params.set('limit', String(PAGE_LIMIT));
  if (list.search.trim()) params.set('search', list.search.trim());
  if (list.active !== '') params.set('active', list.active);
  if (afterId) params.set('after_id', String(afterId));
  return params.toString();
}

function activityTag(user) {
  return user.is_active ? tag('Активен', 'success') : tag('Отключён', 'neutral');
}

function clientRow(user) {
  const row = el('tr');
  row.dataset.userId = String(user.id);

  const nameTd = el('td');
  nameTd.append(personCell(user.full_name || 'Без имени', user.email || 'e-mail не указан'));
  row.append(nameTd);

  row.append(el('td', null, user.phone || '—'));

  const statusTd = el('td');
  statusTd.append(activityTag(user));
  row.append(statusTd);

  const actionsTd = el('td', 'adm-table__actions');
  const openBtn = el('button', 'btn btn--outline btn--sm', 'Карточка');
  openBtn.type = 'button';
  openBtn.addEventListener('click', () => openClient(user.id));
  actionsTd.append(openBtn);
  row.append(actionsTd);

  return row;
}

function skeletonRows(count = 6) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const row = el('tr', 'adm-table-skel');
    for (let c = 0; c < 4; c += 1) {
      const td = el('td');
      td.append(el('span', 'skeleton__line'));
      row.append(td);
    }
    rows.push(row);
  }
  return rows;
}

async function loadClients({ reset = false } = {}) {
  if (list.loading) return;
  list.loading = true;

  $('#clients-error').hidden = true;
  $('#clients-more').disabled = true;

  const tbody = $('#clients-rows');
  if (reset) {
    list.nextAfterId = null;
    tbody.replaceChildren(...skeletonRows());
    $('#clients-empty').hidden = true;
    $('#clients-more').hidden = true;
  }

  try {
    const query = buildListQuery({ afterId: reset ? null : list.nextAfterId });
    const data = await api(`/api/admin/users?${query}`);

    if (reset) tbody.replaceChildren();
    for (const user of data.users) tbody.append(clientRow(user));

    list.nextAfterId = data.next_after_id ?? null;
    $('#clients-more').hidden = !list.nextAfterId;

    $('#clients-empty').hidden = tbody.children.length > 0;
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    if (reset) tbody.replaceChildren();
    $('#clients-error').hidden = false;
  } finally {
    list.loading = false;
    $('#clients-more').disabled = false;
  }
}

let searchDebounce = null;
function wireFilters() {
  $('#clients-search').addEventListener('input', (event) => {
    list.search = event.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadClients({ reset: true }), 300);
  });
  $('#clients-active-filter').addEventListener('change', (event) => {
    list.active = event.target.value;
    loadClients({ reset: true });
  });
  $('#clients-retry').addEventListener('click', () => loadClients({ reset: true }));
  $('#clients-more').addEventListener('click', () => loadClients({ reset: false }));
}

// --------------------------------------------------------------------------
// Обновление строки в уже показанном списке после правок в карточке
// --------------------------------------------------------------------------

function patchRowInPlace(user) {
  const row = $(`#clients-rows tr[data-user-id="${user.id}"]`);
  if (!row) return;
  const cells = row.querySelectorAll('td');
  cells[0].replaceChildren(personCell(user.full_name || 'Без имени', user.email || 'e-mail не указан'));
  cells[1].textContent = user.phone || '—';
  cells[2].replaceChildren(activityTag(user));
}

// --------------------------------------------------------------------------
// Карточка клиента
// --------------------------------------------------------------------------

const card = {
  userId: null,
  original: { full_name: '', phone: '', email: '' },
};

function statBlock(label, value) {
  const box = el('div', 'client-stat');
  box.append(el('span', 'client-stat__label', label));
  box.append(el('b', 'client-stat__value num', value));
  return box;
}

function renderVisitStats(visits) {
  const box = $('#client-stats');
  box.replaceChildren(
    statBlock('всего визитов', String(visits.total ?? 0)),
    statBlock('завершено', String(visits.completed ?? 0)),
    statBlock('предстоит', String(visits.booked ?? 0)),
    statBlock('не пришёл', String(visits.no_show ?? 0)),
    statBlock('отменено', String(visits.cancelled ?? 0)),
    statBlock('последний визит', visits.last_visit_at ? humanDate(visits.last_visit_at, { withWeekday: false }) : '—'),
  );
}

function historyRow(appt) {
  const row = el('div', 'client-hist__row');
  const body = el('div', 'client-hist__body');
  body.append(el('b', 'body-s num', `${humanDate(appt.starts_at, { withWeekday: false })}, ${appt.starts_at.local_time}`));
  const servicesStr = (appt.services || []).map((s) => s.name).join(' · ');
  body.append(el('span', 'caption muted', `${appt.master?.name ?? '—'} · ${servicesStr || 'без услуг'}`));
  row.append(body);

  const right = el('div', 'client-hist__right');
  right.append(tag(STATUS_LABEL[appt.status] ?? appt.status, statusTone(appt.status)));
  right.append(el('span', 'caption num', money(appt.total_price_kopecks)));
  row.append(right);

  return row;
}

async function loadHistory(userId) {
  const box = $('#client-history');
  box.replaceChildren();
  $('#client-history-empty').hidden = true;
  try {
    const { appointments } = await api(`/api/admin/appointments?client_id=${userId}&limit=200`);
    appointments.sort((a, b) => (a.starts_at.utc < b.starts_at.utc ? 1 : -1));
    for (const appt of appointments) box.append(historyRow(appt));
    $('#client-history-empty').hidden = appointments.length > 0;
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    $('#client-history-empty').hidden = false;
    $('#client-history-empty').textContent = 'Не удалось загрузить историю записей';
  }
}

function fillContactForm(user) {
  $('#client-modal-name').textContent = user.full_name || 'Без имени';
  $('#client-name').value = user.full_name || '';
  $('#client-phone').value = user.phone || '';
  $('#client-email').value = user.email || '';
  $('#client-active').checked = Boolean(user.is_active);
  $('#client-active-label').textContent = user.is_active ? 'Активен' : 'Отключён';
  card.original = {
    full_name: user.full_name || '',
    phone: user.phone || '',
    email: user.email || '',
  };
}

function showModalNotice(text) {
  const notice = $('#client-notice');
  notice.hidden = false;
  notice.querySelector('p').textContent = text;
  $('#client-error-notice').hidden = true;
}

function showModalError(text) {
  const notice = $('#client-error-notice');
  notice.hidden = false;
  notice.querySelector('p').textContent = text;
  $('#client-notice').hidden = true;
}

async function loadClientCard(userId) {
  $('#client-modal-loading').hidden = false;
  $('#client-modal-error').hidden = true;
  $('#client-modal-content').hidden = true;
  $('#client-notice').hidden = true;
  $('#client-error-notice').hidden = true;

  try {
    const { user, visits } = await api(`/api/admin/users/${userId}`);
    card.userId = user.id;
    fillContactForm(user);
    renderVisitStats(visits);
    $('#client-modal-loading').hidden = true;
    $('#client-modal-content').hidden = false;
    await loadHistory(userId);
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    $('#client-modal-loading').hidden = true;
    $('#client-modal-error').hidden = false;
  }
}

function openClient(userId) {
  card.userId = userId;
  $('#client-modal-backdrop').hidden = false;
  loadClientCard(userId);
}

function closeClient() {
  $('#client-modal-backdrop').hidden = true;
  card.userId = null;
}

async function saveContacts() {
  if (!card.userId) return;
  const values = {
    full_name: $('#client-name').value.trim(),
    phone: $('#client-phone').value.trim(),
    email: $('#client-email').value.trim(),
  };

  const patch = {};
  for (const key of Object.keys(values)) {
    if (values[key] !== card.original[key]) patch[key] = values[key];
  }

  if (Object.keys(patch).length === 0) {
    showModalNotice('Изменений нет');
    return;
  }

  const button = $('#client-save');
  button.disabled = true;
  try {
    const { user } = await api(`/api/admin/users/${card.userId}`, { method: 'PATCH', body: patch });
    fillContactForm(user);
    patchRowInPlace(user);
    showModalNotice('Контакты сохранены');
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    showModalError(error.message);
  } finally {
    button.disabled = false;
  }
}

async function toggleActive(event) {
  if (!card.userId) return;
  const checkbox = event.target;
  const nextActive = checkbox.checked;
  checkbox.disabled = true;
  try {
    const { user, sessions_revoked: sessionsRevoked } = await api(`/api/admin/users/${card.userId}`, {
      method: 'PATCH', body: { is_active: nextActive },
    });
    fillContactForm(user);
    patchRowInPlace(user);
    showModalNotice(
      nextActive
        ? 'Клиент снова активен'
        : `Клиент отключён. Закрыто сессий: ${sessionsRevoked ?? 0}`,
    );
  } catch (error) {
    checkbox.checked = !nextActive;
    if (error.status === 403) { showForbidden(); return; }
    showModalError(error.message);
  } finally {
    checkbox.disabled = false;
  }
}

function wireModal() {
  $('#client-modal-close').addEventListener('click', closeClient);
  $('#client-modal-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeClient();
  });
  $('#client-modal-retry').addEventListener('click', () => loadClientCard(card.userId));
  $('#client-save').addEventListener('click', saveContacts);
  $('#client-active').addEventListener('change', toggleActive);
}

// --------------------------------------------------------------------------

async function main() {
  const me = await initAdminShell({ active: 'A8' });
  if (!me) return;
  wireFilters();
  wireModal();
  await loadClients({ reset: true });
}

main();
