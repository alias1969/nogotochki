/**
 * Общее для экранов кабинета: шапка, счётчик уведомлений, проверка входа
 * и разбор записи в человеческий вид.
 *
 * Кабинет показывает только свои данные, и следит за этим сервер: выборка
 * идёт по идентификатору из сессии, а не по параметру запроса. Поэтому
 * здесь нет ни одной проверки «моё ли это» — она была бы показной.
 */
import {
  $, $$, el, wireScreenLinks, setupTheme, applyTheme, rememberTheme,
  initials, money, duration,
} from './shared.js';
import { SCREENS } from './routes.js';
import { API_BASE } from './config.js';

export { $, $$, el, initials, money, duration, applyTheme, rememberTheme, SCREENS };

/**
 * Тема на сервере и тема в браузере — одно и то же значение
 * в двух видах. В базе day/evening, в разметке light/dark.
 */
export const THEME_TO_API = { light: 'day', dark: 'evening' };
export const THEME_FROM_API = { day: 'light', evening: 'dark' };

/** Сохранить выбор темы в профиле. Молча: это не то, ради чего пришли. */
export async function saveTheme(theme) {
  try {
    await api('/api/profile', { method: 'PATCH', body: { theme: THEME_TO_API[theme] } });
  } catch { /* останется хотя бы в этом браузере */ }
}

export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined
      ? { Accept: 'application/json' }
      : { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message ?? `Запрос ${path} не удался`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

// --------------------------------------------------------------------------
// Даты
// --------------------------------------------------------------------------

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

/**
 * Дата из местных полей ответа.
 *
 * Сервер уже перевёл момент в пояс студии и прислал local_date —
 * пересчитывать его из UTC по второму разу незачем.
 */
export function humanDate(momentField, { withWeekday = true } = {}) {
  const [y, m, d] = momentField.local_date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return withWeekday ? `${d} ${MONTHS[m - 1]}, ${weekday}` : `${d} ${MONTHS[m - 1]} ${y}`;
}

/** «сегодня в 15:00», «вчера в 9:20», иначе полная дата — для ленты уведомлений. */
export function relativeDate(momentField) {
  const days = Math.floor((Date.now() - Date.parse(momentField.utc)) / 86_400_000);
  const time = momentField.local_time;
  if (days <= 0) return `сегодня в ${time}`;
  if (days === 1) return `вчера в ${time}`;
  return `${humanDate(momentField, { withWeekday: false })}, ${time}`;
}

// --------------------------------------------------------------------------
// Статусы записи
// --------------------------------------------------------------------------

const CHECK = '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"></path></svg>';
const CROSS = '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>';
const CLOCK = '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5l3 2"></path></svg>';

/**
 * Подпись и тон статуса.
 *
 * «Отменена вами» и «отменена студией» различаются по полю
 * cancelled.by_role: сервер пишет туда 'client', 'master' или 'admin'
 * (STATUS_POLICY в services/appointments.js). Для человека это разные
 * события, и одна общая «Отменена» скрыла бы, кто это сделал.
 */
const CANCELLED_BY = {
  client: { label: 'Отменена вами', tone: 'cx-user' },
  master: { label: 'Отменена мастером', tone: 'cx-admin' },
  admin: { label: 'Отменена студией', tone: 'cx-admin' },
};

export function statusOf(appointment) {
  switch (appointment.status) {
    case 'booked': return { label: 'Предстоит', tone: 'upcoming', icon: CLOCK };
    case 'completed': return { label: 'Завершена', tone: 'done', icon: CHECK };
    case 'no_show': return { label: 'Не пришли', tone: 'warn', icon: CROSS };
    case 'cancelled': {
      const by = CANCELLED_BY[appointment.cancelled?.by_role]
        ?? { label: 'Отменена', tone: 'cx-user' };
      return { ...by, icon: CROSS };
    }
    default: return { label: appointment.status, tone: 'cx-user', icon: CLOCK };
  }
}

// --------------------------------------------------------------------------
// Шапка
// --------------------------------------------------------------------------

/**
 * Шапка кабинета: имя, колокольчик со счётчиком, кнопка записи.
 *
 * Счётчик берётся отдельным лёгким запросом unread-count — на экране
 * уведомлений он приходит вместе со списком, и второй раз не нужен.
 */
export async function setupCabinet(current, { unread = null } = {}) {
  wireScreenLinks();
  // Переключатель в шапке пишет выбор и на сервер: иначе тема,
  // переключённая здесь, откатывалась бы к серверной на следующей
  // же загрузке страницы.
  setupTheme({ onChange: saveTheme });

  for (const node of $$('[data-nav]')) {
    if (node.dataset.nav === current) node.setAttribute('aria-current', 'page');
  }

  let me;
  try {
    me = (await api('/api/auth/me')).user;
  } catch (error) {
    if (error.status === 401) {
      // Кабинет без входа не показывают. Возвращаемся сюда же после входа.
      const back = encodeURIComponent(location.pathname + location.search);
      location.replace(`${SCREENS.C1}?back=${back}`);
      return null;
    }
    throw error;
  }

  // Тема из профиля — она и есть та, что переезжает между устройствами.
  const fromServer = THEME_FROM_API[me.theme];
  if (fromServer) { rememberTheme(fromServer); applyTheme(fromServer); }

  const name = (me.full_name ?? '').split(/\s+/)[0] ?? '';
  $('#user-name').textContent = name;
  $('#user-face').textContent = initials(me.full_name);

  const count = unread ?? (await api('/api/notifications/unread-count').catch(() => ({ unread: 0 }))).unread;
  showUnread(count);
  return me;
}

export function showUnread(count) {
  const badge = $('#bell-count');
  if (!badge) return;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.hidden = !count;
  const bell = $('#bell');
  if (bell) {
    bell.setAttribute('aria-label', count ? `Уведомления, непрочитанных: ${count}` : 'Уведомления');
  }
}

// --------------------------------------------------------------------------
// Сообщение об успешном действии
// --------------------------------------------------------------------------

export function toast(title, text) {
  const box = $('#toast');
  if (!box) return;
  $('#toast-title').textContent = title;
  $('#toast-text').textContent = text;
  box.hidden = false;
}

export function setupToast() {
  $('#toast-close')?.addEventListener('click', () => { $('#toast').hidden = true; });
}
