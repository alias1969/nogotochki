/**
 * Экран K4 «Личный кабинет — Уведомления».
 *
 * Список приходит из GET /api/notifications вместе со счётчиком
 * непрочитанных — второй запрос ради значка в шапке не нужен.
 *
 * Листание курсором (before_id), а не страницами: пока человек читает,
 * сверху приходят новые, и вторая страница с отступом показала бы часть
 * первой заново. Курсор от этого защищён.
 */
import {
  $, el, api, setupCabinet, setupToast, showUnread,
  relativeDate, SCREENS,
} from './cabinet.js';

setupToast();

const list = $('#list');
let nextBeforeId = null;
let unread = 0;

/** Значок по виду уведомления. Неизвестный вид получает нейтральный. */
const ICONS = {
  appointment_created: '<path d="M3 9.5h18M8 2.5v4M16 2.5v4"></path><rect x="3" y="4.5" width="18" height="17" rx="3"></rect><path d="m8.5 14.5 2.5 2.5 4.5-4.5"></path>',
  appointment_cancelled: '<circle cx="12" cy="12" r="9"></circle><path d="m9 9 6 6M15 9l-6 6"></path>',
  appointment_rescheduled: '<path d="M3.5 12a8.5 8.5 0 1 0 2.7-6.2"></path><path d="M3 4.5v4h4"></path>',
  appointment_reminder: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5l3 2"></path>',
  password_changed: '<rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path>',
};
const FALLBACK = '<circle cx="12" cy="12" r="9"></circle><path d="M12 8.5h.01M11.4 12h1.2v4.2h-1.2z"></path>';

function icon(kind) {
  const span = el('span', 'nt__icon');
  span.innerHTML = `<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind] ?? FALLBACK}</svg>`;
  return span;
}

function card(n) {
  const box = el('div', 'nt');
  box.dataset.unread = String(!n.is_read);

  const head = el('div', 'nt__head');
  head.append(el('b', 'nt__title', n.title));
  if (!n.is_read) {
    const mark = el('span', 'nt__new');
    mark.append(el('i'), el('span', null, 'новое'));
    head.append(mark);
  }

  const body = el('div', 'nt__body');
  body.append(head);
  if (n.body) body.append(el('p', 'nt__text', n.body));
  body.append(el('span', 'nt__date', relativeDate(n.created_at)));

  box.append(icon(n.kind), body);

  // Уведомление о записи ведёт к ней: в предстоящие, если она ещё будет,
  // иначе в историю.
  if (n.appointment) {
    const link = el('a', 'nt__link');
    const past = n.appointment.status && n.appointment.status !== 'booked';
    link.href = past ? SCREENS.K2 : SCREENS.K1;
    link.append(
      el('span', null, past ? 'В историю' : 'К записи'),
    );
    link.insertAdjacentHTML('beforeend', '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>');
    link.addEventListener('click', () => { if (!n.is_read) markRead(n, box); });
    box.append(link);
  }

  // Прочитанным отмечаем по нажатию, а не при показе: «пришло в список»
  // и «человек прочитал» — разные события, и счётчик должен считать второе.
  if (!n.is_read) {
    box.style.cursor = 'pointer';
    box.addEventListener('click', (event) => {
      if (event.target.closest('a')) return;
      markRead(n, box);
    });
  }

  return box;
}

async function markRead(n, box) {
  if (n.is_read) return;
  n.is_read = true;
  box.dataset.unread = 'false';
  box.querySelector('.nt__new')?.remove();
  box.style.cursor = '';
  unread = Math.max(0, unread - 1);
  showUnread(unread);
  updateSubline();
  try {
    await api(`/api/notifications/${n.id}/read`, { method: 'POST', body: {} });
  } catch {
    // Не дошло — вернём как было, чтобы счётчик не врал.
    n.is_read = false;
    box.dataset.unread = 'true';
    unread += 1;
    showUnread(unread);
    updateSubline();
  }
}

function updateSubline() {
  $('#subline').textContent = unread
    ? `Непрочитанных: ${unread}`
    : 'Все уведомления прочитаны';
  $('#mark-all').disabled = unread === 0;
}

function show(which) {
  for (const id of ['loading', 'empty', 'list', 'load-error']) $(`#${id}`).hidden = id !== which;
  if (which !== 'list') $('#more').hidden = true;
}

async function load({ append = false } = {}) {
  if (!append) show('loading');
  try {
    const query = append && nextBeforeId ? `?before_id=${nextBeforeId}` : '';
    const data = await api(`/api/notifications${query}`);
    const items = data.notifications ?? [];
    unread = data.unread ?? 0;
    nextBeforeId = data.next_before_id;

    if (!append && !items.length) {
      showUnread(0);
      updateSubline();
      show('empty');
      return;
    }

    const cards = items.map(card);
    if (append) list.append(...cards); else list.replaceChildren(...cards);

    show('list');
    $('#more').hidden = !nextBeforeId;
    showUnread(unread);
    updateSubline();
  } catch (error) {
    if (!append) {
      $('#error-text').textContent = error.message;
      show('load-error');
    }
  }
}

$('#mark-all').addEventListener('click', async () => {
  const button = $('#mark-all');
  button.disabled = true;
  try {
    await api('/api/notifications/read-all', { method: 'POST', body: {} });
    await load();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
});

$('#more').addEventListener('click', () => load({ append: true }));
$('#retry').addEventListener('click', () => load());

(async () => {
  // Счётчик придёт вместе со списком, поэтому в шапку его не тянем отдельно.
  if (await setupCabinet('K4', { unread: 0 })) load();
})();
