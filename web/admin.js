/**
 * Экран A2 «Админ — Сегодня».
 *
 * Показатели дня и заявки мастеров на изменение графика — настоящие
 * данные, а не прототипный мок: GET /api/admin/appointments?date=... даёт
 * список визитов на сегодня, GET /api/admin/schedule-requests?status=pending —
 * заявки, ждущие ответа.
 */
import {
  $, el, money, duration, initials, tag, api, initAdminShell, showForbidden,
} from './admin-shell.js';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

let settings = null;

function localToday(offsetMinutes) {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Понедельник=1 … воскресенье=7, как того просит схема (weekday()). */
function isoWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

function statusTone(status) {
  if (status === 'booked') return 'brand';
  if (status === 'completed') return 'success';
  if (status === 'no_show') return 'error';
  if (status === 'cancelled') return 'neutral';
  return 'neutral';
}

const STATUS_LABEL = {
  booked: 'Предстоит', completed: 'Завершена', no_show: 'Не пришли', cancelled: 'Отменена',
};

function apptRow(a) {
  const [h, min] = a.starts_at.local_time.split(':');
  const row = el('div', 'adm-appt-row');
  const time = el('div', 'adm-appt-row__time');
  time.append(el('b', 'body-m num', `${h}:${min}`));
  time.append(el('span', 'caption muted num', duration(a.duration_min)));
  const face = el('span', 'avatar avatar--sm', initials(a.client?.full_name ?? ''));
  const body = el('div', 'adm-appt-row__body');
  body.append(el('b', 'body-m', a.client?.full_name ?? 'Без имени'));
  body.append(el('span', 'body-s muted', a.services.map((s) => s.name).join(' · ')));
  body.append(el('span', 'caption muted', `Мастер: ${a.master?.name ?? '—'}`));
  const right = el('div', 'adm-appt-row__right');
  right.append(tag(STATUS_LABEL[a.status] ?? a.status, statusTone(a.status)));
  right.append(el('span', 'body-s num', money(a.total_price_kopecks)));
  row.append(time, face, body, right);
  return row;
}

function requestCard(request, { onDone }) {
  const card = el('div', 'adm-req-card');
  const head = el('div', 'adm-req-card__head');
  head.append(el('b', 'body-m', request.master?.name ?? 'Мастер'));
  head.append(el('span', 'body-s muted', request.message ?? ''));
  const period = request.desired_from
    ? `${request.desired_from}${request.desired_to && request.desired_to !== request.desired_from ? ` — ${request.desired_to}` : ''}`
    : '';
  if (period) head.append(el('span', 'caption muted num', period));
  card.append(head);

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
      onDone();
    } catch (error) {
      approve.disabled = false; reject.disabled = false;
      if (error.status === 403) showForbidden(); else alert(error.message);
    }
  });
  reject.addEventListener('click', () => openReject(request, onDone));
  actions.append(approve, reject);
  card.append(actions);
  return card;
}

// --------------------------------------------------------------------------
// Модалка отклонения заявки
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
// Показатели
// --------------------------------------------------------------------------

function statCard({ label, value, hint, tone = null }) {
  const card = el('div', `adm-stat${tone ? ` adm-stat--${tone}` : ''}`);
  const head = el('div', 'adm-stat__head');
  head.append(el('span', 'adm-stat__label', label));
  card.append(head);
  card.append(el('b', 'adm-stat__value num', value));
  if (hint) card.append(el('span', 'adm-stat__hint', hint));
  return card;
}

function renderStats(appointments) {
  const total = appointments.length;
  const cancelled = appointments.filter((a) => a.status === 'cancelled').length;
  const noShow = appointments.filter((a) => a.status === 'no_show').length;
  const revenue = appointments
    .filter((a) => a.status === 'booked' || a.status === 'completed')
    .reduce((sum, a) => sum + a.total_price_kopecks, 0);

  const box = $('#adm-stats');
  box.replaceChildren(
    statCard({ label: 'записей сегодня', value: String(total), hint: 'всего в календаре на сегодня' }),
    statCard({
      label: 'отмен', value: String(cancelled), hint: cancelled ? 'проверьте причины в записях' : 'ни одной',
      tone: cancelled ? 'warn' : null,
    }),
    statCard({
      label: 'неявок', value: String(noShow), hint: noShow ? 'отмечены как «не пришли»' : 'ни одной',
      tone: noShow ? 'error' : null,
    }),
    statCard({ label: 'ожидаемая выручка', value: money(revenue), hint: 'оплата на месте' }),
  );
}

// --------------------------------------------------------------------------
// Загрузка экрана
// --------------------------------------------------------------------------

async function loadToday() {
  $('#today-error').hidden = true;
  $('#today-body').hidden = true;

  try {
    settings = (await api('/api/studio')).studio;
    const today = localToday(settings.utc_offset_minutes);

    const [{ appointments }, { studio_hours: hours }, { requests }] = await Promise.all([
      api(`/api/admin/appointments?date=${today}`),
      api('/api/admin/studio-hours'),
      api('/api/admin/schedule-requests?status=pending'),
    ]);

    appointments.sort((a, b) => (a.starts_at.utc < b.starts_at.utc ? -1 : 1));

    const [y, m, d] = today.split('-').map(Number);
    const weekdayName = WEEKDAYS_RU[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    $('#adm-today-date').textContent = `${d} ${MONTHS[m - 1]} ${y}`;
    $('#adm-today-title').textContent = `${d} ${MONTHS[m - 1]}, ${weekdayName}`;

    const todayHours = hours.find((row) => row.weekday === isoWeekday(today));
    $('#adm-today-hours').textContent = todayHours && !todayHours.is_closed
      ? `Студия открыта до ${todayHours.close_time}`
      : 'Сегодня студия закрыта';

    renderStats(appointments);

    const list = $('#today-appointments');
    list.replaceChildren();
    for (const a of appointments) list.append(apptRow(a));
    $('#today-appointments-empty').hidden = appointments.length > 0;

    renderRequests(requests);

    $('#today-body').hidden = false;
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    $('#today-error').hidden = false;
  }
}

function renderRequests(requests) {
  const box = $('#attention-list');
  box.replaceChildren();
  for (const request of requests) {
    box.append(requestCard(request, () => loadToday()));
  }
  $('#attention-empty').hidden = requests.length > 0;
  $('#attention-count').textContent = requests.length ? `${requests.length} в работе` : 'всё закрыто';
  $('#attention-count').dataset.tone = requests.length ? 'warning' : 'success';

  const navBadge = document.getElementById('nav-badge-schedules');
  if (navBadge) {
    navBadge.hidden = requests.length === 0;
    navBadge.textContent = String(requests.length);
  }
}

async function main() {
  const me = await initAdminShell({ active: 'A2' });
  if (!me) return;
  wireRejectModal();
  $('#today-retry').addEventListener('click', loadToday);
  await loadToday();
}

main();
