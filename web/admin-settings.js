/**
 * Экран A11 «Админ — Настройки».
 *
 * Три независимые панели, у каждой свои данные, своя загрузка и своё
 * сохранение — как в cabinet-profile.js:
 *
 *   1. Студия и правила записи — таблица «ключ — значение»
 *      (GET/PATCH /api/admin/settings). Список настроек присылает сервер
 *      сам — тип, границы и группу (studio/time/booking) отдаёт схема,
 *      здесь ничего не захардкожено про диапазоны.
 *   2. Часы работы — семь строк, ровно по одной на день недели
 *      (GET/PUT /api/admin/studio-hours).
 *   3. Нерабочие дни — список разовых закрытий с добавлением и снятием
 *      (GET/POST/DELETE /api/admin/studio-closures).
 */
import {
  $, el, api, initAdminShell, showForbidden, humanDate,
} from './admin-shell.js';

const ICON_TRASH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"></path></svg>';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function iconButton(iconSvg, label, onClick, { danger = false } = {}) {
  const btn = el('button', `adm-iconbtn${danger ? ' adm-iconbtn--danger' : ''}`);
  btn.type = 'button';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = iconSvg;
  btn.addEventListener('click', onClick);
  return btn;
}

// ============================================================================
// Панель 1. Студия и правила записи
// ============================================================================

let loadedSettings = [];
let settingsInputs = {};

/** Текстовое или числовое поле формы — <label class="field">… — как в разметке. */
function settingField(spec) {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'field__label', spec.title));

  let input;
  if (spec.key === 'studio_about') {
    input = document.createElement('textarea');
    input.className = 'input';
    input.rows = 4;
  } else {
    input = document.createElement('input');
    input.className = 'input';
    input.type = spec.type === 'int' ? 'number' : 'text';
  }
  input.name = spec.key;
  if (spec.type === 'int') {
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = '1';
    input.value = String(spec.value);
  } else {
    if (spec.max_length) input.maxLength = spec.max_length;
    input.value = spec.value ?? '';
  }
  wrap.append(input);
  return { wrap, input };
}

/** Строка правила записи — заголовок+описание слева, число справа. */
function bookingRuleRow(spec) {
  const row = el('div', 'adm-settings-rule');

  const body = el('div', 'adm-settings-rule__body');
  body.append(el('b', 'body-m', spec.title));
  if (spec.description) body.append(el('span', 'body-s muted', spec.description));
  row.append(body);

  const control = el('div', 'adm-settings-rule__control');
  const input = document.createElement('input');
  input.className = 'input';
  input.type = 'number';
  input.name = spec.key;
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = '1';
  input.value = String(spec.value);
  control.append(input);
  row.append(control);

  return { row, input };
}

function buildSettingsForm(list) {
  settingsInputs = {};
  const byKey = (key) => list.find((s) => s.key === key);

  const row1 = $('#settings-studio-row1');
  row1.replaceChildren();
  for (const key of ['studio_name', 'studio_address']) {
    const spec = byKey(key);
    if (!spec) continue;
    const { wrap, input } = settingField(spec);
    settingsInputs[key] = input;
    row1.append(wrap);
  }

  const phoneWrap = $('#settings-studio-phone-wrap');
  phoneWrap.replaceChildren();
  const phoneSpec = byKey('studio_phone');
  if (phoneSpec) {
    const { wrap, input } = settingField(phoneSpec);
    settingsInputs.studio_phone = input;
    phoneWrap.append(wrap);
  }

  const aboutWrap = $('#settings-studio-about-wrap');
  aboutWrap.replaceChildren();
  const aboutSpec = byKey('studio_about');
  if (aboutSpec) {
    const { wrap, input } = settingField(aboutSpec);
    settingsInputs.studio_about = input;
    aboutWrap.append(wrap);
  }

  const timeRow = $('#settings-time-row');
  timeRow.replaceChildren();
  for (const key of ['timezone', 'utc_offset_minutes']) {
    const spec = byKey(key);
    if (!spec) continue;
    const { wrap, input } = settingField(spec);
    settingsInputs[key] = input;
    timeRow.append(wrap);
  }

  const rulesBox = $('#settings-booking-rules');
  rulesBox.replaceChildren();
  for (const spec of list.filter((s) => s.group === 'booking')) {
    const { row, input } = bookingRuleRow(spec);
    settingsInputs[spec.key] = input;
    rulesBox.append(row);
  }

  $('#settings-form-error').hidden = true;
  $('#settings-form-success').hidden = true;
}

function showSettingsError(message) {
  const notice = $('#settings-form-error');
  notice.querySelector('p').textContent = message;
  notice.hidden = false;
  $('#settings-form-success').hidden = true;
}

function showSettingsSuccess(message) {
  const notice = $('#settings-form-success');
  notice.querySelector('p').textContent = message;
  notice.hidden = false;
  $('#settings-form-error').hidden = true;
}

async function loadSettingsPanel() {
  $('#settings-error').hidden = true;
  $('#settings-skeleton').hidden = false;
  $('#form-settings').hidden = true;

  try {
    const { settings } = await api('/api/admin/settings');
    loadedSettings = settings;
    buildSettingsForm(settings);
    $('#settings-skeleton').hidden = true;
    $('#form-settings').hidden = false;
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    $('#settings-skeleton').hidden = true;
    $('#settings-error').hidden = false;
  }
}

async function onSubmitSettings(event) {
  event.preventDefault();

  const patch = {};
  for (const spec of loadedSettings) {
    const input = settingsInputs[spec.key];
    if (!input) continue;

    if (spec.type === 'int') {
      const value = Number(input.value);
      if (!Number.isInteger(value)) { showSettingsError(`${spec.title}: ожидается целое число`); return; }
      if (value !== Number(spec.value)) patch[spec.key] = value;
    } else {
      const value = input.value.trim();
      if (value !== (spec.value ?? '')) patch[spec.key] = value;
    }
  }

  if (Object.keys(patch).length === 0) {
    showSettingsSuccess('Изменений нет — нечего сохранять.');
    return;
  }

  const button = event.submitter ?? event.target.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const { updated, settings } = await api('/api/admin/settings', { method: 'PATCH', body: { settings: patch } });
    loadedSettings = settings;
    buildSettingsForm(settings);
    const titleByKey = new Map(settings.map((s) => [s.key, s.title]));
    showSettingsSuccess(`Обновлено: ${updated.map((key) => titleByKey.get(key) ?? key).join(', ')}`);
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    showSettingsError(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

// ============================================================================
// Панель 2. Часы работы
// ============================================================================

let hourControls = [];

function hourRow(day) {
  const tr = document.createElement('tr');

  const tdName = document.createElement('td');
  tdName.textContent = day.weekday_name;
  tr.append(tdName);

  const closedInput = document.createElement('input');
  closedInput.type = 'checkbox';
  closedInput.checked = Boolean(day.is_closed);
  closedInput.setAttribute('aria-label', `${day.weekday_name}: студия закрыта`);
  const tdClosed = document.createElement('td');
  tdClosed.append(closedInput);
  tr.append(tdClosed);

  const openInput = document.createElement('input');
  openInput.type = 'time';
  openInput.className = 'input adm-hours-time';
  openInput.value = day.open_time ?? '';
  const tdOpen = document.createElement('td');
  tdOpen.append(openInput);
  tr.append(tdOpen);

  const closeInput = document.createElement('input');
  closeInput.type = 'time';
  closeInput.className = 'input adm-hours-time';
  closeInput.value = day.close_time ?? '';
  const tdClose = document.createElement('td');
  tdClose.append(closeInput);
  tr.append(tdClose);

  const syncDisabled = () => {
    openInput.disabled = closedInput.checked;
    closeInput.disabled = closedInput.checked;
  };
  syncDisabled();
  closedInput.addEventListener('change', syncDisabled);

  return {
    tr, weekday: day.weekday, closedInput, openInput, closeInput,
  };
}

function renderHoursTable(rows) {
  const tbody = $('#hours-tbody');
  tbody.replaceChildren();
  hourControls = [...rows]
    .sort((a, b) => a.weekday - b.weekday)
    .map((day) => {
      const built = hourRow(day);
      tbody.append(built.tr);
      return built;
    });
}

async function loadHoursPanel() {
  $('#hours-error').hidden = true;
  $('#hours-skeleton').hidden = false;
  $('#hours-body').hidden = true;

  try {
    const { studio_hours: hours } = await api('/api/admin/studio-hours');
    renderHoursTable(hours);
    $('#hours-skeleton').hidden = true;
    $('#hours-body').hidden = false;
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    $('#hours-skeleton').hidden = true;
    $('#hours-error').hidden = false;
  }
}

async function onSaveHours() {
  const days = hourControls.map(({
    weekday, closedInput, openInput, closeInput,
  }) => ({
    weekday,
    is_closed: closedInput.checked,
    open_time: closedInput.checked ? null : (openInput.value || null),
    close_time: closedInput.checked ? null : (closeInput.value || null),
  }));

  $('#hours-form-error').hidden = true;
  $('#hours-form-success').hidden = true;
  $('#hours-stranded').hidden = true;

  const button = $('#hours-save');
  button.disabled = true;
  try {
    const { studio_hours: hours, stranded_appointments: stranded } = await api('/api/admin/studio-hours', {
      method: 'PUT',
      body: { days },
    });
    renderHoursTable(hours);
    $('#hours-form-success').querySelector('p').textContent = 'Часы работы сохранены.';
    $('#hours-form-success').hidden = false;

    if (stranded.length) {
      const list = stranded
        .map((a) => `${humanDate(a.starts_at, { withWeekday: false })}, ${a.starts_at.local_time} — ${a.client_name}`)
        .join('; ');
      $('#hours-stranded').querySelector('p').textContent
        = `Эти визиты оказались вне новых часов работы, разнесите их вручную: ${list}`;
      $('#hours-stranded').hidden = false;
    }
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    $('#hours-form-error').querySelector('p').textContent = error.message;
    $('#hours-form-error').hidden = false;
  } finally {
    button.disabled = false;
  }
}

// ============================================================================
// Панель 3. Нерабочие дни
// ============================================================================

let closures = [];

function humanDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function closureDateLabel(c) {
  if (c.date_to && c.date_to !== c.date_from) return `${humanDateShort(c.date_from)} — ${humanDateShort(c.date_to)}`;
  return humanDateShort(c.date_from);
}

function closureRow(c) {
  const tr = document.createElement('tr');

  const tdDate = document.createElement('td');
  tdDate.textContent = closureDateLabel(c);
  tr.append(tdDate);

  const tdReason = document.createElement('td');
  tdReason.textContent = c.reason;
  tr.append(tdReason);

  const tdBy = document.createElement('td');
  tdBy.textContent = c.created_by_name ?? '—';
  tr.append(tdBy);

  const tdActions = document.createElement('td');
  const actions = el('div', 'adm-table__actions');
  actions.append(iconButton(ICON_TRASH, 'Снять нерабочий день', () => removeClosure(c), { danger: true }));
  tdActions.append(actions);
  tr.append(tdActions);

  return tr;
}

function renderClosures() {
  const tbody = $('#closures-tbody');
  tbody.replaceChildren();
  const sorted = [...closures].sort((a, b) => (a.date_from < b.date_from ? -1 : 1));
  for (const c of sorted) tbody.append(closureRow(c));
  $('#closures-table').hidden = closures.length === 0;
  $('#closures-empty').hidden = closures.length > 0;
}

function showClosuresError(message) {
  const notice = $('#closures-form-error');
  notice.querySelector('p').textContent = message;
  notice.hidden = false;
}

async function loadClosuresPanel() {
  $('#closures-error').hidden = true;
  try {
    const { closures: list } = await api('/api/admin/studio-closures');
    closures = list;
    renderClosures();
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    $('#closures-table').hidden = true;
    $('#closures-empty').hidden = true;
    $('#closures-error').hidden = false;
  }
}

async function onAddClosure() {
  const dateFrom = $('#closure-from').value;
  const dateTo = $('#closure-to').value;
  const reason = $('#closure-reason').value.trim();

  $('#closures-form-error').hidden = true;
  $('#closures-affected').hidden = true;

  if (!dateFrom) { showClosuresError('Укажите дату начала'); return; }
  if (reason.length < 2) { showClosuresError('Укажите причину — минимум 2 символа'); return; }

  const body = { date_from: dateFrom, reason };
  if (dateTo) body.date_to = dateTo;

  const button = $('#closure-add');
  button.disabled = true;
  try {
    const { closure, affected_appointments: affected } = await api('/api/admin/studio-closures', {
      method: 'POST',
      body,
    });
    closures.push(closure);
    renderClosures();
    $('#closure-from').value = '';
    $('#closure-to').value = '';
    $('#closure-reason').value = '';

    if (affected.length) {
      const list = affected
        .map((a) => `${humanDate(a.starts_at, { withWeekday: false })}, ${a.starts_at.local_time} — ${a.client_name}`)
        .join('; ');
      $('#closures-affected').querySelector('p').textContent
        = `На эти дни уже есть записи, разнесите их вручную: ${list}`;
      $('#closures-affected').hidden = false;
    }
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    showClosuresError(error.message);
  } finally {
    button.disabled = false;
  }
}

async function removeClosure(c) {
  const ok = confirm(`Снять нерабочий день «${c.reason}» (${closureDateLabel(c)})? Время снова станет доступно для записи.`);
  if (!ok) return;

  try {
    await api(`/api/admin/studio-closures/${c.id}`, { method: 'DELETE' });
    closures = closures.filter((item) => item.id !== c.id);
    renderClosures();
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    alert(error.message);
  }
}

// ============================================================================
// Загрузка экрана
// ============================================================================

async function main() {
  const me = await initAdminShell({ active: 'A11' });
  if (!me) return;

  $('#settings-retry').addEventListener('click', loadSettingsPanel);
  $('#form-settings').addEventListener('submit', onSubmitSettings);

  $('#hours-retry').addEventListener('click', loadHoursPanel);
  $('#hours-save').addEventListener('click', onSaveHours);

  $('#closures-retry').addEventListener('click', loadClosuresPanel);
  $('#closure-add').addEventListener('click', onAddClosure);

  await Promise.all([loadSettingsPanel(), loadHoursPanel(), loadClosuresPanel()]);
}

main();
