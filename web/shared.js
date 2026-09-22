/**
 * Общее для всех страниц: мелкие помощники, тема и подстановка адресов
 * по карте экранов.
 *
 * Вынесено из app.js, когда к лендингу добавились экраны входа: шапка,
 * переключатель тем и ссылки на другие экраны у них одни и те же,
 * и расходиться двум копиям этого кода нельзя.
 */
import { SCREENS } from './routes.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * data-screen="B1" в разметке → настоящий адрес из routes.js.
 *
 * Разметка называет экран так же, как карта связей, и не знает,
 * как он лежит в файлах.
 */
export function wireScreenLinks(root = document) {
  for (const link of $$('[data-screen]', root)) {
    const href = SCREENS[link.dataset.screen];
    if (href) link.setAttribute('href', href);
  }
}

const SUN = '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z"></path><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"></path></svg>';
const MOON = '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"></path></svg>';

const THEME_KEY = 'nogotochki-theme';

/**
 * Тема в браузере.
 *
 * У вошедшего она хранится на сервере (users.theme) и переезжает между
 * устройствами; localStorage тут — копия под рукой, чтобы страница
 * не мигала светлой, пока едет ответ, и чтобы тема работала до входа.
 *
 * Каждое обращение к хранилищу обёрнуто: в приватном окне и при
 * заблокированных куках оно бросает исключение, а тема — удобство,
 * а не условие работы страницы.
 */
export function readTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* недоступно */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function rememberTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* недоступно */ }
}

/** Применяет тему к документу и к подписи переключателя. */
export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = $('#theme-icon');
  const label = $('#theme-label');
  if (icon) icon.innerHTML = theme === 'dark' ? MOON : SUN;
  if (label) label.textContent = theme === 'dark' ? 'Вечерняя' : 'Дневная';
}

/**
 * Переключатель темы в шапке.
 *
 * onChange, если он передан, получает новое значение — так кабинет
 * сохраняет выбор на сервере. Без него переключатель остаётся
 * чисто браузерным: до входа сохранять некуда.
 */
export function setupTheme({ onChange = null } = {}) {
  let theme = readTheme();
  applyTheme(theme);

  const button = $('#theme-toggle');
  if (!button) return;

  button.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    rememberTheme(theme);
    onChange?.(theme);
  });
}

// --------------------------------------------------------------------------
// Числа и имена для показа
// --------------------------------------------------------------------------

/** Узкий пробел между разрядами — чтобы «2 500 ₽» не разрывалось переносом. */
const NBSP = ' ';

/**
 * Копейки в рубли. Сервер отдаёт целое число копеек намеренно
 * (см. комментарий в server/src/api/views.js), и делить их на 100
 * для показа — работа фронтенда, а не сервера.
 */
export function money(kopecks) {
  const rubles = Math.trunc(kopecks / 100);
  const rest = kopecks % 100;
  const whole = String(rubles).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return rest === 0 ? `${whole}${NBSP}₽` : `${whole},${String(rest).padStart(2, '0')}${NBSP}₽`;
}

/** 90 → «1 ч 30 мин», 60 → «1 ч», 30 → «30 мин». */
export function duration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

/** Инициалы для кружка мастера, когда фотографии нет. */
export function initials(name) {
  return (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

/** Число + правильная форма слова: 1 мастер, 2 мастера, 5 мастеров. */
export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}
