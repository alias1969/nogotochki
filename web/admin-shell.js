/**
 * Общее для всех восьми экранов админ-панели: боковое меню, шапка,
 * проверка входа и роли, тема, выход.
 *
 * Настоящая защита живёт на сервере: каждый эндпоинт /api/admin/* проверяет
 * роль через ctx.requireRole('admin') (server/src/http/context.js) и при
 * отказе отвечает 403 — так было и до этого файла, для всех разделов API.
 * Проверка здесь другая по смыслу: она не защищает данные (это не в её
 * силах — скрытая кнопка не защита), а просто не показывает пустую панель
 * тому, кому сервер всё равно откажет в каждом запросе. Оба места проверяют
 * права одинаково: есть ли 'admin' в списке ролей человека, а не равна ли
 * его роль строке 'admin' — как в server/src/lib/roles.js (has()), так
 * и здесь (hasAdminRole()).
 *
 * Экран страницы обязан положить в разметку три вещи с этими id:
 *   #admin-shell      — сама панель (меню, шапка, <main>), скрыта до входа;
 *   #admin-forbidden   — сообщение «раздел только для администраторов»;
 *   #adm-nav-<ID>       — пункты меню с data-nav="A2"|"A4"|…, для подсветки текущего.
 */
import {
  $, $$, el, wireScreenLinks, setupTheme, applyTheme, rememberTheme,
  initials, money, duration, plural,
} from './shared.js';
import { SCREENS } from './routes.js';
import { API_BASE } from './config.js';

export { $, $$, el, initials, money, duration, plural, SCREENS };

export const THEME_TO_API = { light: 'day', dark: 'evening' };
export const THEME_FROM_API = { day: 'light', evening: 'dark' };

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

async function saveTheme(theme) {
  try {
    await api('/api/profile', { method: 'PATCH', body: { theme: THEME_TO_API[theme] } });
  } catch { /* останется хотя бы в этом браузере */ }
}

/**
 * Роль проверяется вхождением в список — как на сервере (roles.js: has()),
 * а не сравнением: у человека, кроме admin, может стоять ещё master
 * или user, и именно наличие admin в списке решает, войти ли в панель.
 */
export function hasAdminRole(user) {
  return Boolean(user) && Array.isArray(user.roles) && user.roles.includes('admin');
}

/**
 * Показать состояние «раздел только для администраторов» вместо панели.
 *
 * Вызывается и из initAdminShell (роли не хватило сразу), и разделами
 * самих экранов — если данные защищены отдельной ролью не полностью,
 * например /api/admin/audit, и middle-запрос вернул 403 уже после того,
 * как общий вход был подтверждён.
 */
export function showForbidden() {
  const shell = $('#admin-shell');
  const box = $('#admin-forbidden');
  if (shell) shell.hidden = true;
  if (box) box.hidden = false;
}

function wireLogout() {
  $('#adm-logout')?.addEventListener('click', async (event) => {
    event.preventDefault();
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* гасим и без ответа */ }
    location.href = SCREENS.C1;
  });
}

/**
 * Бутстрап панели.
 *
 * @param active — идентификатор текущего экрана по карте связей: 'A2','A4' и т.д.
 * @returns Promise<AdminUser|null> — объект пользователя из /api/auth/me,
 *   либо null, если панель не показана (нет входа — переход на C1; нет роли —
 *   показано «только для администраторов»). Экрану в обоих случаях
 *   продолжать нечего — он должен просто остановиться.
 */
export async function initAdminShell({ active }) {
  wireScreenLinks();
  setupTheme({ onChange: saveTheme });

  for (const node of $$('[data-nav]')) {
    if (node.dataset.nav === active) node.setAttribute('aria-current', 'page');
  }

  let me;
  try {
    me = (await api('/api/auth/me')).user;
  } catch (error) {
    if (error.status === 401) {
      const back = encodeURIComponent(location.pathname + location.search);
      location.replace(`${SCREENS.C1}?back=${back}`);
      return null;
    }
    throw error;
  }

  if (!hasAdminRole(me)) {
    showForbidden();
    return null;
  }

  const fromServer = THEME_FROM_API[me.theme];
  if (fromServer) { rememberTheme(fromServer); applyTheme(fromServer); }

  const faceEl = $('#adm-user-face');
  const nameEl = $('#adm-user-name');
  if (faceEl) faceEl.textContent = initials(me.full_name);
  if (nameEl) nameEl.textContent = me.full_name ?? '';

  wireLogout();

  const shell = $('#admin-shell');
  const box = $('#admin-forbidden');
  if (shell) shell.hidden = false;
  if (box) box.hidden = true;

  return me;
}

// --------------------------------------------------------------------------
// Мелочи, общие для таблиц и панелей раздела
// --------------------------------------------------------------------------

/** Инициалы + подпись строкой — для ячейки «клиент» / «мастер» в таблицах. */
export function personCell(name, sub) {
  const wrap = el('div');
  wrap.append(el('span', 'adm-table__name', name ?? '—'));
  if (sub) wrap.append(el('span', 'adm-table__sub', sub));
  return wrap;
}

/** Бейдж тона по правилу: подставляется как textContent, тон — data-tone. */
export function tag(text, tone = 'neutral') {
  const node = el('span', 'tag', text);
  node.dataset.tone = tone;
  return node;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

export function humanDate(momentField, { withWeekday = true } = {}) {
  const [y, m, d] = momentField.local_date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return withWeekday ? `${d} ${MONTHS[m - 1]}, ${weekday}` : `${d} ${MONTHS[m - 1]} ${y}`;
}
