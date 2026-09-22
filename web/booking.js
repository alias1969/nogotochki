/**
 * Общее для шагов записи: лента шагов, панель итога и запрос к API.
 *
 * Выбор клиента здесь не хранится — он живёт в адресе страницы
 * (selection в routes.js). Этот модуль его только читает и пишет.
 */
import { API_BASE } from './config.js';
import { $, $$, el, money, duration, plural } from './shared.js';
import { SCREENS, selection } from './routes.js';

export { selection };

/** Шаги пути записи в том порядке, в каком их проходят. */
export const STEPS = [
  { screen: 'B1', title: 'Услуги' },
  { screen: 'B2', title: 'Мастер' },
  { screen: 'B3', title: 'Время' },
  { screen: 'B5', title: 'Подтверждение' },
];

const CHECK = '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"></path></svg>';

/**
 * Лента шагов.
 *
 * Пройденные — ссылки: по листу «Переходы» с каждого шага есть возврат,
 * и выбор при этом сохраняется, поэтому в адрес ссылки кладётся то же,
 * что несёт текущая страница. Будущие шаги — просто текст: туда ещё
 * нечего нести, и ссылка туда обещала бы работающий переход.
 *
 * @param current номер текущего шага, с единицы
 * @param picked  что уже выбрано — уходит в адреса пройденных шагов
 */
export function renderSteps(current, picked) {
  const row = $('#steps-row');
  const nodes = [];

  STEPS.forEach((step, index) => {
    const number = index + 1;
    if (index > 0) nodes.push(el('i', 'steps__line'));

    const done = number < current;
    const now = number === current;
    const kind = done ? 'done' : (now ? 'now' : 'next');

    // Ссылкой становится только пройденный шаг с известным адресом.
    const node = done && step.screen
      ? el('a', `step step--${kind}`)
      : el('span', `step step--${kind}`);
    if (done && step.screen) node.href = selection.href(step.screen, picked);
    if (now) node.setAttribute('aria-current', 'step');

    const mark = el('i', 'step__mark');
    if (done) mark.innerHTML = CHECK; else mark.textContent = String(number);

    node.append(mark, document.createTextNode(step.title));
    nodes.push(node);
  });

  row.replaceChildren(...nodes);

  // Та же лента для узкого экрана — полосой и подписью «Шаг N из 4».
  $('#step-title').textContent = STEPS[current - 1].title;
  $('#step-count').textContent = `Шаг ${current} из ${STEPS.length}`;
  $('#step-bar').style.width = `${(current / STEPS.length) * 100}%`;
}

// --------------------------------------------------------------------------
// Панель итога
// --------------------------------------------------------------------------

/**
 * Строка «Выбрано N услуг · время · сумма».
 *
 * Числа берутся из ответа сервера (GET /api/services/summary) и здесь
 * только раскладываются по строке: сумма и длительность считаются
 * в одном месте, и это место — сервер.
 */
export function summaryLine(totals) {
  if (!totals || !totals.services.length) return 'Услуги не выбраны';
  const count = plural(totals.services.length, 'услуга', 'услуги', 'услуг');
  return `Выбрано ${count} · ${duration(totals.duration_min)} · ${money(totals.total_price_kopecks)}`;
}

/**
 * Состояние кнопки «Далее».
 *
 * Пока идти некуда, кнопка выключена, а рядом сказано, чего не хватает:
 * выключенная кнопка без объяснения оставляет человека гадать.
 */
export function setNext(enabled, hint) {
  const button = $('#next');
  const note = $('#next-hint');
  button.disabled = !enabled;
  note.hidden = enabled;
  if (!enabled && hint) note.textContent = hint;
}

// --------------------------------------------------------------------------
// Запрос
// --------------------------------------------------------------------------

export async function get(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
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

/** Итог выбранного набора — с сервера. Пустой набор туда не отправляем. */
export async function fetchTotals(serviceIds) {
  if (!serviceIds.length) return null;
  return get(`/api/services/summary?service_ids=${serviceIds.join(',')}`);
}

// --------------------------------------------------------------------------
// Заглушки на время загрузки
// --------------------------------------------------------------------------

export function skeletonCards(box, count, build) {
  box.replaceChildren(...Array.from({ length: count }, () => {
    const card = el('div', 'card skeleton');
    card.setAttribute('aria-hidden', 'true');
    card.append(...build());
    return card;
  }));
  box.setAttribute('aria-busy', 'true');
}

export const line = (extra = '') => el('span', `skeleton__line ${extra}`.trim());

export { el, $, $$, money, duration, plural, SCREENS };
