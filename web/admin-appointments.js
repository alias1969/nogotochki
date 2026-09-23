/**
 * Экран A4 «Админ — Записи».
 *
 * Таблица всех записей студии с фильтрами (дата, статус, клиент) и модалки
 * создания, отмены и переноса. Данные настоящие — GET/POST /api/admin/appointments,
 * поиск клиента через GET /api/admin/users, мастера и услуги — полными
 * списками из /api/admin/masters и /api/admin/services (включая неактивных:
 * это решение администратора, а не витрина).
 *
 * Перенос собран из тех же двух эндпоинтов, что и клиентский K3: сначала
 * резерв нового времени (POST /api/holds с reschedule_of), потом
 * подтверждение (POST /api/appointments/:id/reschedule). Мастер при этом
 * не меняется — сервер сверяет его с master_id записи и отказывает
 * при расхождении (422 master_mismatch).
 */
import {
  $, $$, el, api, initAdminShell, showForbidden, tag, money, duration, personCell,
} from './admin-shell.js';

const STATUS_LABEL = {
  booked: 'Предстоит', completed: 'Завершена', no_show: 'Не пришли', cancelled: 'Отменена',
};

function statusTone(status) {
  if (status === 'booked') return 'brand';
  if (status === 'completed') return 'success';
  if (status === 'no_show') return 'error';
  if (status === 'cancelled') return 'neutral';
  return 'neutral';
}

let studio = null;
let masters = [];
let services = [];

// Фильтры текущего списка.
const filters = { date: '', status: '', clientId: null, clientLabel: '' };

function localToday(offsetMinutes) {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** «18.09» + «14:30» из момента API. */
function timeCell(a) {
  const [y, m, d] = a.starts_at.local_date.split('-');
  const wrap = el('div');
  wrap.append(el('b', 'body-m num', a.starts_at.local_time));
  wrap.append(el('span', 'caption muted num', `${d}.${m}.${y}`));
  return wrap;
}

function servicesShort(list) {
  return list.map((s) => s.name).join(', ');
}

// --------------------------------------------------------------------------
// Поиск клиента — переиспользуется в фильтре и в форме создания записи.
// --------------------------------------------------------------------------

function wireClientSearch({ searchBoxEl, inputEl, suggestEl, pickedEl, pickedNameEl, clearBtn, onPick, onClear }) {
  let timer = null;
  let requestId = 0;

  function closeSuggest() {
    suggestEl.hidden = true;
    suggestEl.replaceChildren();
  }

  function showPicked(user) {
    inputEl.value = '';
    searchBoxEl.hidden = true;
    pickedNameEl.textContent = `${user.full_name || 'Без имени'} · ${user.phone || user.email || ''}`;
    pickedEl.hidden = false;
  }

  function showInput() {
    searchBoxEl.hidden = false;
    pickedEl.hidden = true;
  }

  inputEl.addEventListener('input', () => {
    const query = inputEl.value.trim();
    if (timer) clearTimeout(timer);
    if (query.length < 1) { closeSuggest(); return; }
    timer = setTimeout(async () => {
      const myRequest = ++requestId;
      try {
        const { users } = await api(`/api/admin/users?role=user&search=${encodeURIComponent(query)}&limit=10`);
        if (myRequest !== requestId) return;
        suggestEl.replaceChildren();
        if (users.length === 0) {
          suggestEl.append(el('div', 'adm-suggest__empty', 'Никого не нашлось'));
        } else {
          for (const user of users) {
            const item = el('button', 'adm-suggest__item');
            item.type = 'button';
            const body = el('span');
            body.append(el('span', 'adm-suggest__name', user.full_name || 'Без имени'));
            body.append(el('span', 'adm-suggest__sub', [user.phone, user.email].filter(Boolean).join(' · ')));
            item.append(body);
            item.addEventListener('click', () => {
              closeSuggest();
              showPicked(user);
              onPick(user);
            });
            suggestEl.append(item);
          }
        }
        suggestEl.hidden = false;
      } catch (error) {
        if (error.status === 403) { showForbidden(); return; }
        suggestEl.replaceChildren(el('div', 'adm-suggest__empty', 'Не удалось выполнить поиск'));
        suggestEl.hidden = false;
      }
    }, 320);
  });

  clearBtn.addEventListener('click', () => {
    showInput();
    onClear();
  });

  document.addEventListener('click', (event) => {
    if (!suggestEl.hidden && !inputEl.contains(event.target) && !suggestEl.contains(event.target)) {
      closeSuggest();
    }
  });

  return { reset: showInput };
}

// --------------------------------------------------------------------------
// Фильтры
// --------------------------------------------------------------------------

let filterClientSearch = null;

function wireFilters() {
  $('#filter-date').addEventListener('change', () => {
    filters.date = $('#filter-date').value;
    loadAppointments();
  });
  $('#filter-status').addEventListener('change', () => {
    filters.status = $('#filter-status').value;
    loadAppointments();
  });

  filterClientSearch = wireClientSearch({
    searchBoxEl: $('#filter-client-search-box'),
    inputEl: $('#filter-client-input'),
    suggestEl: $('#filter-client-suggest'),
    pickedEl: $('#filter-client-picked'),
    pickedNameEl: $('#filter-client-picked-name'),
    clearBtn: $('#filter-client-clear'),
    onPick: (user) => { filters.clientId = user.id; loadAppointments(); },
    onClear: () => { filters.clientId = null; loadAppointments(); },
  });

  $('#filter-reset').addEventListener('click', () => {
    filters.date = localToday(studio.utc_offset_minutes);
    filters.status = '';
    filters.clientId = null;
    $('#filter-date').value = filters.date;
    $('#filter-status').value = '';
    filterClientSearch.reset();
    loadAppointments();
  });
}

// --------------------------------------------------------------------------
// Таблица
// --------------------------------------------------------------------------

function skeletonRows() {
  const tbody = $('#appts-tbody');
  tbody.replaceChildren();
  for (let i = 0; i < 6; i += 1) {
    const tr = el('tr', 'adm-table-skel');
    const td = el('td');
    td.colSpan = 7;
    td.append(el('span', 'skeleton__line'));
    tr.append(td);
    tbody.append(tr);
  }
}

function actionButton({ title, tone, svgPaths, onClick }) {
  const btn = el('button', `adm-iconbtn${tone ? ` adm-iconbtn--${tone}` : ''}`);
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgPaths}</svg>`;
  btn.addEventListener('click', onClick);
  return btn;
}

async function setStatus(appointment, status) {
  try {
    await api(`/api/appointments/${appointment.id}/status`, { method: 'POST', body: { status } });
    await loadAppointments();
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    alert(error.message);
  }
}

function openCancel(appointment) {
  $('#cancel-subject').textContent = `${appointment.client?.full_name ?? 'Клиент'} · ${appointment.starts_at.local_date.split('-').reverse().join('.')} ${appointment.starts_at.local_time}`;
  $('#cancel-reason').value = '';
  $('#cancel-error').hidden = true;
  $('#cancel-backdrop').hidden = false;
  cancelTarget = appointment;
  $('#cancel-reason').focus();
}

function apptRow(a) {
  const tr = el('tr');

  const timeTd = el('td');
  timeTd.append(timeCell(a));

  const clientTd = el('td');
  clientTd.append(personCell(a.client?.full_name ?? 'Без имени', a.client?.phone ?? ''));

  const masterTd = el('td', null, a.master?.name ?? '—');

  const servicesTd = el('td', null, servicesShort(a.services));

  const statusTd = el('td');
  statusTd.append(tag(STATUS_LABEL[a.status] ?? a.status, statusTone(a.status)));

  const sumTd = el('td', 'num', money(a.total_price_kopecks));

  const actionsTd = el('td', 'adm-table__actions');
  if (a.status === 'booked') {
    actionsTd.append(actionButton({
      title: 'Отметить «Завершена»', svgPaths: '<path d="m5 12.5 4.5 4.5L19 7.5"></path>',
      onClick: () => setStatus(a, 'completed'),
    }));
    actionsTd.append(actionButton({
      title: 'Отметить «Не пришёл»',
      svgPaths: '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v4.5M12 16h.01"></path>',
      onClick: () => setStatus(a, 'no_show'),
    }));
    actionsTd.append(actionButton({
      title: 'Перенести запись',
      svgPaths: '<rect x="3" y="4.5" width="18" height="17" rx="3"></rect><path d="M3 9.5h18M8 2.5v4M16 2.5v4M8.5 15.5l2 2 4-4"></path>',
      onClick: () => openReschedule(a),
    }));
    actionsTd.append(actionButton({
      title: 'Отменить запись', tone: 'danger', svgPaths: '<path d="m6 6 12 12M18 6 6 18"></path>',
      onClick: () => openCancel(a),
    }));
  }

  tr.append(timeTd, clientTd, masterTd, servicesTd, statusTd, sumTd, actionsTd);
  return tr;
}

async function loadAppointments() {
  $('#appts-error').hidden = true;
  $('#appts-body').hidden = false;
  $('#appts-empty').hidden = true;
  skeletonRows();

  const params = new URLSearchParams();
  if (filters.date) params.set('date', filters.date);
  if (filters.status) params.set('status', filters.status);
  if (filters.clientId) params.set('client_id', String(filters.clientId));
  params.set('limit', '200');

  try {
    const { appointments } = await api(`/api/admin/appointments?${params.toString()}`);
    appointments.sort((a, b) => (a.starts_at.utc < b.starts_at.utc ? 1 : -1));

    const tbody = $('#appts-tbody');
    tbody.replaceChildren();
    for (const a of appointments) tbody.append(apptRow(a));

    $('#appts-body').hidden = appointments.length === 0;
    $('#appts-empty').hidden = appointments.length > 0;
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    $('#appts-body').hidden = true;
    $('#appts-error').hidden = false;
  }
}

// --------------------------------------------------------------------------
// Модалка «Создать запись»
// --------------------------------------------------------------------------

let createClientSearch = null;
let createPickedClient = null;
const createSelectedServices = new Set();

function renderMasterSelect() {
  const select = $('#create-master');
  select.replaceChildren(el('option', null, 'Выберите мастера'));
  select.firstChild.value = '';
  for (const master of masters) {
    const option = el('option', null, master.is_active ? master.name : `${master.name} (неактивен)`);
    option.value = String(master.id);
    select.append(option);
  }
}

function renderServicesGrid() {
  const grid = $('#create-services-grid');
  grid.replaceChildren();
  for (const service of services) {
    const label = el('label', 'adm-check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(service.id);
    input.addEventListener('change', () => {
      if (input.checked) createSelectedServices.add(service.id);
      else createSelectedServices.delete(service.id);
    });
    const text = el('span');
    text.append(document.createTextNode(service.is_active ? service.name : `${service.name} (не на витрине)`));
    text.append(el('span', 'adm-check__meta', `${duration(service.duration_min)} · ${money(service.price_kopecks)}`));
    label.append(input, text);
    grid.append(label);
  }
}

function resetCreateForm() {
  $('#create-error').hidden = true;
  $('#create-client-input').value = '';
  createClientSearch?.reset();
  createPickedClient = null;
  createSelectedServices.clear();
  for (const input of $$('#create-services-grid input[type="checkbox"]')) input.checked = false;
  $('#create-master').value = '';
  $('#create-date').value = filters.date || localToday(studio.utc_offset_minutes);
  $('#create-time').value = '';
  $('#create-client-note').value = '';
  $('#create-admin-note').value = '';
  $('#create-overlap').checked = false;
  $('#create-overlap-warning').hidden = true;
}

function openCreate() {
  resetCreateForm();
  $('#create-backdrop').hidden = false;
}

function closeCreate() {
  $('#create-backdrop').hidden = true;
}

function wireCreateModal() {
  $('#appts-create-open').addEventListener('click', openCreate);
  $('#create-close').addEventListener('click', closeCreate);
  $('#create-cancel').addEventListener('click', closeCreate);
  $('#create-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeCreate();
  });

  createClientSearch = wireClientSearch({
    searchBoxEl: $('#create-client-search-box'),
    inputEl: $('#create-client-input'),
    suggestEl: $('#create-client-suggest'),
    pickedEl: $('#create-client-picked'),
    pickedNameEl: $('#create-client-picked-name'),
    clearBtn: $('#create-client-clear'),
    onPick: (user) => { createPickedClient = user; },
    onClear: () => { createPickedClient = null; },
  });

  $('#create-overlap').addEventListener('change', (event) => {
    $('#create-overlap-warning').hidden = !event.target.checked;
  });

  $('#create-submit').addEventListener('click', submitCreate);
}

function showCreateError(message) {
  const notice = $('#create-error');
  notice.hidden = false;
  notice.querySelector('p').textContent = message;
}

async function submitCreate() {
  if (!createPickedClient) { showCreateError('Выберите клиента из базы.'); return; }
  const masterId = $('#create-master').value;
  if (!masterId) { showCreateError('Выберите мастера.'); return; }
  const date = $('#create-date').value;
  const time = $('#create-time').value;
  if (!date || !time) { showCreateError('Укажите дату и время визита.'); return; }
  if (createSelectedServices.size === 0) { showCreateError('Выберите хотя бы одну услугу.'); return; }

  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  // Сервер принимает момент строго 'YYYY-MM-DDTHH:MM:SSZ' (v.instant, без
  // миллисекунд) — toISOString() отдаёт их всегда, поэтому хвост «.000» срезается.
  const startsAt = new Date(Date.UTC(y, m - 1, d, h, min) - studio.utc_offset_minutes * 60_000)
    .toISOString().replace(/\.\d{3}Z$/, 'Z');

  const button = $('#create-submit');
  button.disabled = true;
  $('#create-error').hidden = true;
  try {
    await api('/api/admin/appointments', {
      method: 'POST',
      body: {
        client_id: createPickedClient.id,
        master_id: Number(masterId),
        starts_at: startsAt,
        service_ids: [...createSelectedServices],
        client_note: $('#create-client-note').value.trim() || undefined,
        admin_note: $('#create-admin-note').value.trim() || undefined,
        allow_overlap: $('#create-overlap').checked,
      },
    });
    closeCreate();
    await loadAppointments();
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    showCreateError(error.message);
  } finally {
    button.disabled = false;
  }
}

// --------------------------------------------------------------------------
// Модалка «Отменить запись»
// --------------------------------------------------------------------------

let cancelTarget = null;

function closeCancelModal() {
  $('#cancel-backdrop').hidden = true;
  cancelTarget = null;
}

function wireCancelModal() {
  $('#cancel-close').addEventListener('click', closeCancelModal);
  $('#cancel-back').addEventListener('click', closeCancelModal);
  $('#cancel-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeCancelModal();
  });

  $('#cancel-confirm').addEventListener('click', async () => {
    if (!cancelTarget) return;
    const reason = $('#cancel-reason').value.trim();
    if (!reason) {
      const notice = $('#cancel-error');
      notice.hidden = false;
      notice.querySelector('p').textContent = 'Укажите причину отмены — клиент увидит её в личном кабинете.';
      return;
    }
    const button = $('#cancel-confirm');
    button.disabled = true;
    try {
      await api(`/api/appointments/${cancelTarget.id}/cancel`, { method: 'POST', body: { reason } });
      closeCancelModal();
      await loadAppointments();
    } catch (error) {
      if (error.status === 403) { showForbidden(); return; }
      const notice = $('#cancel-error');
      notice.hidden = false;
      notice.querySelector('p').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

// --------------------------------------------------------------------------
// Модалка «Перенести запись»
// --------------------------------------------------------------------------
//
// Мастер при переносе не меняется — сервер и сам откажет (422 master_mismatch),
// если резерв взят к другому мастеру, поэтому в форме нет его выбора.
// Свободное время ищется с reschedule_of, а не списком услуг: длительность
// сервер берёт из самой записи, и её собственный слот не считается занятым
// (см. GET /api/availability в server/src/api/availability.routes.js).

let reschedTarget = null;
let reschedSelectedSlot = null;
let reschedRequestId = 0;

function closeReschedule() {
  $('#resched-backdrop').hidden = true;
  reschedTarget = null;
  reschedSelectedSlot = null;
}

async function loadReschedSlots(date) {
  const myRequest = ++reschedRequestId;
  const box = $('#resched-slots');
  box.replaceChildren();
  $('#resched-slots-empty').hidden = true;
  $('#resched-slots-loading').hidden = false;
  reschedSelectedSlot = null;

  try {
    const { slots } = await api(
      `/api/availability?master_id=${reschedTarget.master.id}&date=${date}&reschedule_of=${reschedTarget.id}`,
    );
    if (myRequest !== reschedRequestId) return;
    box.replaceChildren();
    for (const slot of slots) {
      const chip = el('button', 'chip', slot.local_time);
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-selected', 'false');
      chip.addEventListener('click', () => {
        for (const other of $$('.chip', box)) other.setAttribute('aria-selected', 'false');
        chip.setAttribute('aria-selected', 'true');
        reschedSelectedSlot = slot;
      });
      box.append(chip);
    }
    $('#resched-slots-empty').hidden = slots.length > 0;
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    if (myRequest !== reschedRequestId) return;
    box.replaceChildren();
    $('#resched-slots-empty').hidden = false;
    $('#resched-slots-empty').textContent = error.message;
  } finally {
    if (myRequest === reschedRequestId) $('#resched-slots-loading').hidden = true;
  }
}

function openReschedule(a) {
  reschedTarget = a;
  reschedSelectedSlot = null;
  $('#resched-subject').textContent =
    `${a.client?.full_name ?? 'Клиент'} · сейчас ${a.starts_at.local_date.split('-').reverse().join('.')} ${a.starts_at.local_time}, мастер ${a.master?.name ?? '—'}`;
  $('#resched-date').value = a.starts_at.local_date;
  $('#resched-reason').value = '';
  $('#resched-error').hidden = true;
  $('#resched-backdrop').hidden = false;
  loadReschedSlots(a.starts_at.local_date);
}

function wireRescheduleModal() {
  $('#resched-close').addEventListener('click', closeReschedule);
  $('#resched-back').addEventListener('click', closeReschedule);
  $('#resched-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeReschedule();
  });
  $('#resched-date').addEventListener('change', () => {
    if (reschedTarget) loadReschedSlots($('#resched-date').value);
  });

  $('#resched-confirm').addEventListener('click', async () => {
    if (!reschedTarget) return;
    const notice = $('#resched-error');
    notice.hidden = true;

    if (!reschedSelectedSlot) {
      notice.hidden = false;
      notice.querySelector('p').textContent = 'Выберите свободное время.';
      return;
    }
    const reason = $('#resched-reason').value.trim();
    if (!reason) {
      notice.hidden = false;
      notice.querySelector('p').textContent = 'Укажите причину переноса — клиент увидит её в личном кабинете.';
      return;
    }

    const button = $('#resched-confirm');
    button.disabled = true;
    let hold = null;
    try {
      // Резерв держит слот на hold_minutes — этого достаточно, чтобы
      // тут же его подтвердить. Мастер не указывается отдельно: сервер
      // сверит его с текущим мастером записи и откажет при расхождении.
      ({ hold } = await api('/api/holds', {
        method: 'POST',
        body: {
          master_id: reschedTarget.master.id,
          starts_at: reschedSelectedSlot.starts_at,
          reschedule_of: reschedTarget.id,
        },
      }));
      await api(`/api/appointments/${reschedTarget.id}/reschedule`, {
        method: 'POST',
        body: { hold_id: hold.id, reason },
      });
      closeReschedule();
      await loadAppointments();
    } catch (error) {
      if (error.status === 403) { showForbidden(); return; }
      // Слот заняли, пока форма была открыта, или резерв не подтвердился
      // по другой причине — резерв не бросаем висеть до истечения таймера.
      if (hold) { try { await api(`/api/holds/${hold.id}`, { method: 'DELETE' }); } catch { /* не критично */ } }
      notice.hidden = false;
      notice.querySelector('p').textContent = error.message;
      loadReschedSlots($('#resched-date').value);
    } finally {
      button.disabled = false;
    }
  });
}

// --------------------------------------------------------------------------
// Загрузка экрана
// --------------------------------------------------------------------------

async function main() {
  const me = await initAdminShell({ active: 'A4' });
  if (!me) return;

  wireFilters();
  wireCreateModal();
  wireCancelModal();
  wireRescheduleModal();
  $('#appts-retry').addEventListener('click', loadAppointments);

  try {
    studio = (await api('/api/studio')).studio;
    const [{ masters: masterRows }, { services: serviceRows }] = await Promise.all([
      api('/api/admin/masters'),
      api('/api/admin/services'),
    ]);
    masters = masterRows;
    services = serviceRows;
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    $('#appts-error').hidden = false;
    $('#appts-body').hidden = true;
    return;
  }

  renderMasterSelect();
  renderServicesGrid();

  filters.date = localToday(studio.utc_offset_minutes);
  $('#filter-date').value = filters.date;

  await loadAppointments();
}

main();
