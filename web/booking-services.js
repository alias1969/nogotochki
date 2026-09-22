/**
 * Шаг B1 «Услуги».
 *
 * Услуг можно выбрать несколько. Сумма и длительность в нижней панели
 * не считаются здесь: после каждого изменения набор уходит на
 * GET /api/services/summary, и панель показывает то, что ответил сервер.
 * Складывать копейки во второй раз на клиенте — верный способ однажды
 * разойтись с чеком, который выпишет сервер.
 *
 * Выбор хранится в адресе страницы (selection в routes.js): он же
 * переносится на шаг 2 и возвращается сюда кнопкой «Назад».
 */
import { wireScreenLinks, setupTheme, initials } from './shared.js';
import {
  $, $$, el, selection, renderSteps, summaryLine, setNext,
  get, fetchTotals, skeletonCards, line, money, duration, SCREENS,
} from './booking.js';

wireScreenLinks();
setupTheme();

const box = $('#services');
const chips = $('#cats');
const query = $('#query');

let services = [];                       // весь прайс с сервера
let category = null;                     // null — «Все»
let chosen = new Set(selection.read().services);
const carriedMaster = selection.read().master;   // пришли с карточки мастера

$('#back').href = SCREENS.L1;
$('#bar-note').innerHTML = '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="3"></rect><path d="M2.5 10.5h19"></path></svg><span>Оплата на месте</span>';

function picked() {
  return { services: [...chosen], master: carriedMaster };
}

renderSteps(1, picked());

/**
 * Адрес страницы держится в согласии с выбором.
 *
 * replaceState, а не push: каждое нажатие на услугу — не отдельный шаг
 * истории, иначе «назад» пришлось бы жать столько же раз, сколько
 * было галочек.
 */
function syncUrl() {
  history.replaceState(null, '', selection.href('B1', picked()));
  renderSteps(1, picked());
}

// --------------------------------------------------------------------------
// Панель итога
// --------------------------------------------------------------------------

let totalsSeq = 0;

async function refreshTotals() {
  const ids = [...chosen];
  setNext(ids.length > 0, 'Выберите хотя бы одну услугу');

  if (!ids.length) {
    $('#bar-sum').textContent = summaryLine(null);
    return;
  }

  // Ответы могут вернуться не в том порядке, в каком ушли запросы:
  // показываем только самый свежий.
  const seq = ++totalsSeq;
  $('#bar-sum').textContent = 'Считаем…';
  try {
    const totals = await fetchTotals(ids);
    if (seq !== totalsSeq) return;
    $('#bar-sum').textContent = summaryLine(totals);
  } catch {
    if (seq !== totalsSeq) return;
    // Не выдумываем сумму: честнее сказать, что её сейчас нет.
    $('#bar-sum').textContent = 'Не удалось посчитать итог';
  }
}

// --------------------------------------------------------------------------
// Список
// --------------------------------------------------------------------------

function card(service) {
  const label = el('label', 'pick');

  const input = el('input');
  input.type = 'checkbox';
  input.checked = chosen.has(service.id);
  input.addEventListener('change', () => {
    if (input.checked) chosen.add(service.id); else chosen.delete(service.id);
    label.classList.toggle('is-on', input.checked);
    syncUrl();
    refreshTotals();
  });

  const head = el('div', 'pick__head');
  head.append(el('b', 'pick__name', service.name), el('span', 'pick__price', money(service.price_kopecks)));

  const dur = el('span', 'pick__dur');
  dur.innerHTML = '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5l3 2"></path></svg>';
  dur.append(el('span', null, duration(service.duration_min)));

  const body = el('div', 'pick__body');
  body.append(head, dur);
  if (service.description) body.append(el('p', 'pick__desc', service.description));

  const row = el('div', 'pick__row');
  row.append(input, body);
  label.append(row);
  return label;
}

function draw() {
  const text = query.value.trim().toLowerCase();
  const list = services.filter((s) => {
    const byCat = category === null || s.category.id === category;
    const byText = !text
      || s.name.toLowerCase().includes(text)
      || (s.description ?? '').toLowerCase().includes(text);
    return byCat && byText;
  });

  box.replaceChildren(...list.map(card));
  box.setAttribute('aria-busy', 'false');
  $('#nothing').hidden = list.length > 0;
}

function drawChips() {
  const categories = [];
  for (const service of services) {
    if (!categories.some((c) => c.id === service.category.id)) categories.push(service.category);
  }

  const make = (name, id) => {
    const chip = el('button', 'chip', name);
    chip.type = 'button';
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(category === id));
    chip.addEventListener('click', () => { category = id; drawChips(); draw(); });
    return chip;
  };

  chips.replaceChildren(make('Все', null), ...categories.map((c) => make(c.name, c.id)));
}

async function load() {
  $('#load-error').hidden = true;
  $('#search').hidden = false;
  skeletonCards(box, 4, () => [
    line('skeleton__line--title'), line('skeleton__line--short'), line(), line('skeleton__line--btn'),
  ]);
  try {
    const data = await get('/api/services');
    services = data.services ?? [];

    // Услуга, выбранная раньше и с тех пор снятая с витрины, тихо
    // выпадает из набора: иначе она осталась бы в адресе и в сумме,
    // а в списке её бы не было.
    const alive = new Set(services.map((s) => s.id));
    const before = chosen.size;
    chosen = new Set([...chosen].filter((id) => alive.has(id)));
    if (chosen.size !== before) syncUrl();

    drawChips();
    draw();
    refreshTotals();
  } catch {
    box.replaceChildren();
    box.setAttribute('aria-busy', 'false');
    $('#nothing').hidden = true;
    $('#search').hidden = true;
    $('#cats').hidden = true;
    $('#load-error').hidden = false;
    setNext(false, 'Список услуг не загрузился');
  }
}

query.addEventListener('input', draw);
$('#retry').addEventListener('click', () => { $('#cats').hidden = false; load(); });

$('#next').addEventListener('click', () => {
  if (!chosen.size) return;
  location.href = selection.href('B2', picked());
});

load();
