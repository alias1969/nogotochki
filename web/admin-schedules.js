/**
 * Экран A7 «Админ — Графики».
 *
 * Недельный график мастера (просмотр действующей версии + редактор),
 * история версий, отклонения (отпуск/выходной/закрытое время/доп. смена)
 * и заявки мастеров на изменение графика — с согласованием/отклонением
 * по образцу экрана A2 (requestCard/openReject/closeReject).
 */
import {
  $, el, api, initAdminShell, showForbidden, tag, humanDate,
} from './admin-shell.js';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const WEEKDAY_TITLES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const EXCEPTION_KIND_LABEL = {
  vacation: 'Отпуск', day_off: 'Выходной', time_block: 'Закрытое время', extra_shift: 'Доп. смена',
};
const EXCEPTION_KIND_TONE = {
  vacation: 'warning', day_off: 'neutral', time_block: 'error', extra_shift: 'success',
};
const WHOLE_DAY_KINDS = new Set(['vacation', 'day_off']);

const REQUEST_STATUS_LABEL = { pending: 'Ждёт ответа', approved: 'Согласована', rejected: 'Отклонена' };
const REQUEST_STATUS_TONE = { pending: 'warning', approved: 'success', rejected: 'neutral' };

let studio = null;
let masters = [];
let currentMasterId = null;
let latestCurrent = [];
let editorDays = {};

// --------------------------------------------------------------------------
// Мелочи с датами
// --------------------------------------------------------------------------

function localToday(offsetMinutes) {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function shiftDate(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function humanDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** Локальные дата+время формы → момент UTC ISO, через смещение студии. */
function localInstant(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = timeStr.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min) - studio.utc_offset_minutes * 60_000).toISOString();
}

/** Строки недельного графика (current/history/одна версия) → по дням недели. */
function groupIntervalsByWeekday(rows) {
  const map = {};
  for (let w = 1; w <= 7; w += 1) map[w] = [];
  for (const row of rows) map[row.weekday].push({ start: row.work_start, end: row.work_end });
  return map;
}

function renderHeaderDate() {
  const today = localToday(studio.utc_offset_minutes);
  const [y, m, d] = today.split('-').map(Number);
  $('#adm-today-date').textContent = `${d} ${MONTHS[m - 1]} ${y}`;
}

// --------------------------------------------------------------------------
// Выбор мастера
// --------------------------------------------------------------------------

function populateMasterSelect() {
  const select = $('#master-select');
  select.replaceChildren();
  for (const m of masters) {
    const opt = document.createElement('option');
    opt.value = String(m.id);
    opt.textContent = m.name + (m.is_active === false ? ' (неактивен)' : '');
    select.append(opt);
  }
}

function updateMasterMeta() {
  const m = masters.find((item) => item.id === currentMasterId);
  $('#master-meta').textContent = m?.specialization ?? '';
}

function onMasterChange() {
  currentMasterId = Number($('#master-select').value);
  updateMasterMeta();
  closeEditor();
  $('#history-body').hidden = true;
  $('#toggle-history').textContent = 'Показать';
  loadMasterData();
}

// --------------------------------------------------------------------------
// Действующий график
// --------------------------------------------------------------------------

function weekTable(rows) {
  const table = document.createElement('table');
  table.className = 'adm-table';
  const tbody = document.createElement('tbody');
  const map = groupIntervalsByWeekday(rows);
  for (let w = 1; w <= 7; w += 1) {
    const tr = document.createElement('tr');
    const dayTd = document.createElement('td');
    dayTd.textContent = WEEKDAY_TITLES[w - 1];
    const hoursTd = document.createElement('td');
    const intervals = map[w];
    if (intervals.length) {
      hoursTd.textContent = intervals.map((iv) => `${iv.start}–${iv.end}`).join(', ');
    } else {
      hoursTd.textContent = 'выходной';
      hoursTd.className = 'muted';
    }
    tr.append(dayTd, hoursTd);
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

function renderCurrent(rows) {
  latestCurrent = rows;
  const tbody = $('#current-tbody');
  tbody.replaceChildren();
  const map = groupIntervalsByWeekday(rows);
  for (let w = 1; w <= 7; w += 1) {
    const tr = document.createElement('tr');
    const dayTd = document.createElement('td');
    dayTd.textContent = WEEKDAY_TITLES[w - 1];
    const hoursTd = document.createElement('td');
    const intervals = map[w];
    if (intervals.length) {
      hoursTd.textContent = intervals.map((iv) => `${iv.start}–${iv.end}`).join(', ');
    } else {
      hoursTd.textContent = 'выходной';
      hoursTd.className = 'muted';
    }
    tr.append(dayTd, hoursTd);
    tbody.append(tr);
  }
  $('#current-empty').hidden = rows.length !== 0;
}

// --------------------------------------------------------------------------
// Редактор недельного графика
// --------------------------------------------------------------------------

function toggleEditor() {
  if ($('#editor-panel').hidden) openEditor(); else closeEditor();
}

function openEditor() {
  editorDays = groupIntervalsByWeekday(latestCurrent);
  $('#valid-from').value = localToday(studio.utc_offset_minutes);
  $('#valid-from').min = localToday(studio.utc_offset_minutes);
  $('#stranded-notice').hidden = true;
  $('#editor-error').hidden = true;
  renderWeekGrid();
  $('#editor-panel').hidden = false;
  $('#toggle-editor').textContent = 'Свернуть';
}

function closeEditor() {
  $('#editor-panel').hidden = true;
  $('#toggle-editor').textContent = 'Изменить график';
}

function renderWeekGrid() {
  const grid = $('#week-grid');
  grid.replaceChildren();
  for (let w = 1; w <= 7; w += 1) {
    const intervals = editorDays[w];
    const day = el('div', `adm-day${intervals.length === 0 ? ' adm-day--off' : ''}`);
    day.append(el('div', 'adm-day__title', WEEKDAY_SHORT[w - 1]));

    intervals.forEach((iv, idx) => {
      const row = el('div', 'adm-day__interval');
      const startInput = document.createElement('input');
      startInput.type = 'time';
      startInput.className = 'input';
      startInput.value = iv.start || '';
      startInput.setAttribute('aria-label', `${WEEKDAY_SHORT[w - 1]}: начало интервала`);
      startInput.addEventListener('change', (event) => { editorDays[w][idx].start = event.target.value; });

      const endInput = document.createElement('input');
      endInput.type = 'time';
      endInput.className = 'input';
      endInput.value = iv.end || '';
      endInput.setAttribute('aria-label', `${WEEKDAY_SHORT[w - 1]}: конец интервала`);
      endInput.addEventListener('change', (event) => { editorDays[w][idx].end = event.target.value; });

      const del = el('button', 'a7-del', '✕');
      del.type = 'button';
      del.setAttribute('aria-label', 'Удалить интервал');
      del.addEventListener('click', () => { editorDays[w].splice(idx, 1); renderWeekGrid(); });

      row.append(startInput, endInput, del);
      day.append(row);
    });

    const add = el('button', 'adm-day__add', '+ интервал');
    add.type = 'button';
    add.addEventListener('click', () => { editorDays[w].push({ start: '', end: '' }); renderWeekGrid(); });
    day.append(add);

    grid.append(day);
  }
}

function collectDaysPayload() {
  const days = [];
  for (let w = 1; w <= 7; w += 1) {
    for (const iv of editorDays[w]) {
      if (iv.start && iv.end) days.push({ weekday: w, work_start: iv.start, work_end: iv.end });
    }
  }
  return days;
}

function showEditorError(message) {
  const notice = $('#editor-error');
  notice.hidden = false;
  notice.querySelector('p').textContent = message;
}

function renderStrandedList(items) {
  const ul = $('#stranded-list');
  ul.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = `${humanDateShort(item.starts_at.local_date)} ${item.starts_at.local_time}–${item.ends_at.local_time} — ${item.client_name}`;
    ul.append(li);
  }
}

async function saveSchedule() {
  const validFrom = $('#valid-from').value;
  $('#editor-error').hidden = true;
  if (!validFrom) { showEditorError('Укажите дату, с которой действует новый график'); return; }

  const button = $('#save-schedule');
  button.disabled = true;
  try {
    const result = await api(`/api/admin/masters/${currentMasterId}/schedule`, {
      method: 'PUT',
      body: { valid_from: validFrom, days: collectDaysPayload() },
    });
    await loadMasterData();
    if (result.stranded_appointments.length) {
      renderStrandedList(result.stranded_appointments);
      $('#stranded-notice').hidden = false;
    } else {
      $('#stranded-notice').hidden = true;
      closeEditor();
    }
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    showEditorError(error.message);
  } finally {
    button.disabled = false;
  }
}

// --------------------------------------------------------------------------
// История графика
// --------------------------------------------------------------------------

function toggleHistory() {
  const body = $('#history-body');
  const willShow = body.hidden;
  body.hidden = !willShow;
  $('#toggle-history').textContent = willShow ? 'Скрыть' : 'Показать';
}

function renderHistory(rows) {
  const versions = new Map();
  for (const row of rows) {
    const key = `${row.valid_from}|${row.valid_to ?? ''}`;
    if (!versions.has(key)) versions.set(key, { valid_from: row.valid_from, valid_to: row.valid_to, rows: [] });
    versions.get(key).rows.push(row);
  }
  const sorted = [...versions.values()].sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1));

  const list = $('#history-list');
  list.replaceChildren();
  for (const version of sorted) {
    const box = el('div', 'a7-version');
    const head = el('div', 'a7-version__head');
    head.append(el('b', 'body-s', `с ${humanDateShort(version.valid_from)}`));
    head.append(el('span', 'caption muted', version.valid_to ? `по ${humanDateShort(version.valid_to)}` : 'действует сейчас'));
    box.append(head, weekTable(version.rows));
    list.append(box);
  }
  $('#history-empty').hidden = sorted.length > 0;
}

// --------------------------------------------------------------------------
// Отклонения от графика
// --------------------------------------------------------------------------

function exceptionIntervalText(exc) {
  if (WHOLE_DAY_KINDS.has(exc.kind)) {
    const from = exc.starts_at.local_date;
    const to = shiftDate(exc.ends_at.local_date, -1);
    return from === to ? humanDateShort(from) : `${humanDateShort(from)} — ${humanDateShort(to)}`;
  }
  const sameDay = exc.starts_at.local_date === exc.ends_at.local_date;
  const endPrefix = sameDay ? '' : `${humanDateShort(exc.ends_at.local_date)} `;
  return `${humanDateShort(exc.starts_at.local_date)} ${exc.starts_at.local_time} — ${endPrefix}${exc.ends_at.local_time}`;
}

function renderExceptions(list) {
  const box = $('#exceptions-list');
  box.replaceChildren();
  for (const exc of list) {
    const card = el('div', 'adm-req-card');
    const head = el('div', 'adm-req-card__head');
    const row = el('div');
    row.style.display = 'flex';
    row.style.gap = 'var(--s-2)';
    row.style.alignItems = 'center';
    row.style.flexWrap = 'wrap';
    row.append(tag(EXCEPTION_KIND_LABEL[exc.kind] ?? exc.kind, EXCEPTION_KIND_TONE[exc.kind] ?? 'neutral'));
    row.append(el('span', 'body-s num', exceptionIntervalText(exc)));
    head.append(row);
    if (exc.reason) head.append(el('span', 'body-s muted', exc.reason));
    card.append(head);

    const actions = el('div', 'adm-req-card__actions');
    const del = el('button', 'btn btn--outline btn--sm', 'Удалить');
    del.type = 'button';
    del.addEventListener('click', () => deleteException(exc.id));
    actions.append(del);
    card.append(actions);

    box.append(card);
  }
  $('#exceptions-empty').hidden = list.length > 0;
}

async function deleteException(id) {
  if (!confirm('Удалить это отклонение? Действие нельзя отменить.')) return;
  try {
    await api(`/api/admin/schedule-exceptions/${id}`, { method: 'DELETE' });
    await loadMasterData();
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    alert(error.message);
  }
}

// --------------------------------------------------------------------------
// Модалка: добавить отклонение
// --------------------------------------------------------------------------

function updateExceptionFields() {
  const wholeDay = WHOLE_DAY_KINDS.has($('#exc-kind').value);
  $('#exc-dates-fields').hidden = !wholeDay;
  $('#exc-instant-fields').hidden = wholeDay;
}

function openExceptionModal() {
  $('#exc-kind').value = 'vacation';
  $('#exc-date-from').value = localToday(studio.utc_offset_minutes);
  $('#exc-date-to').value = '';
  $('#exc-start-date').value = '';
  $('#exc-start-time').value = '';
  $('#exc-end-date').value = '';
  $('#exc-end-time').value = '';
  $('#exc-reason').value = '';
  $('#exc-affected-notice').hidden = true;
  $('#exception-error').hidden = true;
  updateExceptionFields();
  $('#exception-backdrop').hidden = false;
}

function closeExceptionModal() {
  $('#exception-backdrop').hidden = true;
}

function showExceptionError(message) {
  const notice = $('#exception-error');
  notice.hidden = false;
  notice.querySelector('p').textContent = message;
}

function renderAffectedList(items) {
  const ul = $('#exc-affected-list');
  ul.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = `${humanDateShort(item.starts_at.local_date)} ${item.starts_at.local_time}–${item.ends_at.local_time} — ${item.client_name}`;
    ul.append(li);
  }
}

async function submitException() {
  $('#exception-error').hidden = true;
  const kind = $('#exc-kind').value;
  const reason = $('#exc-reason').value.trim();
  let body;

  if (WHOLE_DAY_KINDS.has(kind)) {
    const dateFrom = $('#exc-date-from').value;
    const dateTo = $('#exc-date-to').value;
    if (!dateFrom) { showExceptionError('Укажите дату начала'); return; }
    body = { kind, date_from: dateFrom, ...(dateTo ? { date_to: dateTo } : {}), ...(reason ? { reason } : {}) };
  } else {
    const sd = $('#exc-start-date').value;
    const st = $('#exc-start-time').value;
    const ed = $('#exc-end-date').value;
    const et = $('#exc-end-time').value;
    if (!sd || !st || !ed || !et) { showExceptionError('Заполните дату и время начала и конца'); return; }
    body = {
      kind, starts_at: localInstant(sd, st), ends_at: localInstant(ed, et), ...(reason ? { reason } : {}),
    };
  }

  const button = $('#exception-save');
  button.disabled = true;
  try {
    const result = await api(`/api/admin/masters/${currentMasterId}/schedule-exceptions`, { method: 'POST', body });
    await loadMasterData();
    if (result.affected_appointments.length) {
      renderAffectedList(result.affected_appointments);
      $('#exc-affected-notice').hidden = false;
    } else {
      closeExceptionModal();
    }
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    showExceptionError(error.message);
  } finally {
    button.disabled = false;
  }
}

function wireExceptionModal() {
  $('#exception-close').addEventListener('click', closeExceptionModal);
  $('#exception-cancel').addEventListener('click', closeExceptionModal);
  $('#exception-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeExceptionModal();
  });
  $('#exc-kind').addEventListener('change', updateExceptionFields);
  $('#open-exception').addEventListener('click', openExceptionModal);
  $('#exception-save').addEventListener('click', submitException);
}

// --------------------------------------------------------------------------
// Заявки мастеров на изменение графика (по образцу A2)
// --------------------------------------------------------------------------

function requestCard(request) {
  const card = el('div', 'adm-req-card');
  const head = el('div', 'adm-req-card__head');

  const nameRow = el('div');
  nameRow.style.display = 'flex';
  nameRow.style.gap = 'var(--s-2)';
  nameRow.style.alignItems = 'center';
  nameRow.style.flexWrap = 'wrap';
  nameRow.append(el('b', 'body-m', request.master?.name ?? 'Мастер'));
  nameRow.append(tag(REQUEST_STATUS_LABEL[request.status] ?? request.status, REQUEST_STATUS_TONE[request.status] ?? 'neutral'));
  head.append(nameRow);

  head.append(el('span', 'body-s muted', request.message ?? ''));

  const period = request.desired_from
    ? `${request.desired_from}${request.desired_to && request.desired_to !== request.desired_from ? ` — ${request.desired_to}` : ''}`
    : '';
  const metaBits = [];
  if (period) metaBits.push(period);
  metaBits.push(`подана ${humanDate(request.created_at, { withWeekday: false })}`);
  if (request.reviewed_at) metaBits.push(`рассмотрена ${humanDate(request.reviewed_at, { withWeekday: false })}`);
  head.append(el('span', 'caption muted num', metaBits.join(' · ')));

  if (request.admin_comment) head.append(el('span', 'body-s muted', `Комментарий: ${request.admin_comment}`));

  card.append(head);

  if (request.status === 'pending') {
    const actions = el('div', 'adm-req-card__actions');
    const approve = el('button', 'btn btn--outline btn--sm', 'Согласовать');
    approve.type = 'button';
    const reject = el('button', 'btn btn--outline btn--sm', 'Отклонить');
    reject.type = 'button';
    approve.addEventListener('click', async () => {
      approve.disabled = true; reject.disabled = true;
      try {
        await api(`/api/admin/schedule-requests/${request.id}/review`, {
          method: 'POST', body: { decision: 'approved', comment: '' },
        });
        loadRequests();
      } catch (error) {
        approve.disabled = false; reject.disabled = false;
        if (error.status === 403) showForbidden(); else alert(error.message);
      }
    });
    reject.addEventListener('click', () => openReject(request, () => loadRequests()));
    actions.append(approve, reject);
    card.append(actions);
  }

  return card;
}

function renderRequests(requests) {
  const box = $('#requests-list');
  box.replaceChildren();
  for (const request of requests) box.append(requestCard(request));
  $('#requests-empty').hidden = requests.length > 0;
}

async function loadRequests() {
  try {
    const status = $('#requests-status-filter').value;
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (currentMasterId) params.set('master_id', String(currentMasterId));
    const { requests } = await api(`/api/admin/schedule-requests?${params.toString()}`);
    renderRequests(requests);
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    alert(error.message);
  }
}

// --------------------------------------------------------------------------
// Модалка отклонения заявки — 1:1 со структурой A2
// --------------------------------------------------------------------------

let rejectTarget = null;
let rejectDone = null;

function openReject(request, onDone) {
  rejectTarget = request;
  rejectDone = onDone;
  $('#reject-subject').textContent = request.message ?? '';
  $('#reject-comment').value = '';
  $('#reject-error').hidden = true;
  $('#reject-backdrop').hidden = false;
  $('#reject-comment').focus();
}

function closeReject() {
  $('#reject-backdrop').hidden = true;
  rejectTarget = null;
  rejectDone = null;
}

function wireRejectModal() {
  $('#reject-close').addEventListener('click', closeReject);
  $('#reject-cancel').addEventListener('click', closeReject);
  $('#reject-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeReject();
  });
  $('#reject-confirm').addEventListener('click', async () => {
    if (!rejectTarget) return;
    const comment = $('#reject-comment').value.trim();
    const button = $('#reject-confirm');
    button.disabled = true;
    try {
      await api(`/api/admin/schedule-requests/${rejectTarget.id}/review`, {
        method: 'POST', body: { decision: 'rejected', comment },
      });
      const done = rejectDone;
      closeReject();
      done?.();
    } catch (error) {
      if (error.status === 403) { showForbidden(); return; }
      const notice = $('#reject-error');
      notice.hidden = false;
      notice.querySelector('p').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

// --------------------------------------------------------------------------
// Загрузка экрана
// --------------------------------------------------------------------------

async function loadMasterData() {
  $('#sch-error').hidden = true;
  try {
    const schedule = await api(`/api/admin/masters/${currentMasterId}/schedule`);
    renderCurrent(schedule.current);
    renderHistory(schedule.history);
    renderExceptions(schedule.exceptions);
    await loadRequests();
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    $('#sch-error-text').textContent = error.message;
    $('#sch-error').hidden = false;
  }
}

async function loadAll() {
  $('#sch-error').hidden = true;
  $('#sch-body').hidden = true;
  $('#sch-skeleton').hidden = false;

  try {
    studio = (await api('/api/studio')).studio;
    renderHeaderDate();

    const { masters: list } = await api('/api/admin/masters');
    masters = list;

    $('#sch-skeleton').hidden = true;
    $('#sch-body').hidden = false;

    if (!masters.length) {
      $('#no-masters').hidden = false;
      $('#master-sections').hidden = true;
      $('#master-select').replaceChildren();
      return;
    }

    $('#no-masters').hidden = true;
    $('#master-sections').hidden = false;
    populateMasterSelect();

    const params = new URLSearchParams(location.search);
    const requested = Number(params.get('master_id'));
    const initial = requested && masters.some((m) => m.id === requested) ? requested : masters[0].id;
    currentMasterId = initial;
    $('#master-select').value = String(initial);
    updateMasterMeta();

    await loadMasterData();
  } catch (error) {
    $('#sch-skeleton').hidden = true;
    if (error.status === 403) { showForbidden(); return; }
    $('#sch-error-text').textContent = error.message;
    $('#sch-error').hidden = false;
  }
}

async function main() {
  const me = await initAdminShell({ active: 'A7' });
  if (!me) return;

  wireRejectModal();
  wireExceptionModal();

  $('#sch-retry').addEventListener('click', loadAll);
  $('#master-select').addEventListener('change', onMasterChange);
  $('#toggle-editor').addEventListener('click', toggleEditor);
  $('#cancel-editor').addEventListener('click', closeEditor);
  $('#save-schedule').addEventListener('click', saveSchedule);
  $('#toggle-history').addEventListener('click', toggleHistory);
  $('#requests-status-filter').addEventListener('change', loadRequests);

  await loadAll();
}

main();
