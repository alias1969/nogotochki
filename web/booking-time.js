/**
 * Шаг B3 «Дата и время».
 *
 * Свободное время здесь не вычисляется ни в одном месте. Календарь
 * закрашивается по ответу GET /api/availability/days, сетка окон —
 * по GET /api/availability, окончание визита берётся из поля ends_at
 * того же слота. Всё, что делает этот файл с этими числами, — переводит
 * момент UTC в часовой пояс студии по utc_offset_minutes из /api/studio
 * и раскладывает окна по частям дня.
 *
 * Почему так. «Свободно» — свойство пары «время + длительность»,
 * и считается оно из графика мастера, часов студии, закрытий, живых
 * записей и чужих резервов. Половины этих данных на странице нет
 * и быть не должно; посчитанная здесь сетка расходилась бы с сервером
 * ровно в тот момент, когда это дороже всего — при подтверждении.
 */
import { wireScreenLinks, setupTheme } from './shared.js';
import {
  $, el, selection, renderSteps, summaryLine, setNext,
  get, fetchTotals, duration, money, plural, SCREENS,
} from './booking.js';

wireScreenLinks();
setupTheme();

const chosen = selection.read();
let picked = { services: chosen.services, master: chosen.master };
let slot = null;              // выбранное окно целиком, как пришло с сервера
let studio = null;
let month = null;             // первое число показываемого месяца, 'YYYY-MM-DD'
let freeDays = new Map();     // дата → число окон, из /availability/days
let today = null;

renderSteps(3, picked);

$('#back').href = selection.href('B2', picked);
$('#edit-master').href = selection.href('B2', picked);
$('#pick-master').href = selection.href('B2', { services: picked.services, master: null });
$('#change-master').href = selection.href('B2', { services: picked.services, master: null });
$('#change-services').href = selection.href('B1', { services: picked.services, master: null });
$('#go-start').href = SCREENS.B1;

// --------------------------------------------------------------------------
// Даты
// --------------------------------------------------------------------------

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/** Дата как её видит студия, а не браузер: часовые пояса могут не совпадать. */
function studioDate(instant = Date.now()) {
  const shifted = new Date(instant + studio.utc_offset_minutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Момент UTC → время в поясе студии. Само значение пришло с сервера. */
function localTime(utcIso) {
  const shifted = new Date(Date.parse(utcIso) + studio.utc_offset_minutes * 60_000);
  return shifted.toISOString().slice(11, 16);
}

const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const parse = (date) => date.split('-').map(Number);
const addDays = (date, days) => {
  const [y, m, d] = parse(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const firstOfMonth = (date) => { const [y, m] = parse(date); return iso(y, m - 1, 1); };
const shiftMonth = (date, by) => { const [y, m] = parse(date); return iso(y, m - 1 + by, 1); };

function humanDate(date) {
  const [y, m, d] = parse(date);
  const weekday = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'][
    new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${d} ${MONTHS[m - 1]}, ${weekday}`;
}

/** Последний день, на который открыта запись. Горизонт задаёт студия. */
function horizon() {
  return addDays(today, studio.booking_rules.booking_horizon_days);
}

// --------------------------------------------------------------------------
// Календарь
// --------------------------------------------------------------------------

/**
 * Сетка-заглушка календаря.
 *
 * Показывается до первого ответа сервера. Пустая рамка на её месте
 * читалась бы как «у мастера вообще нет времени» — то есть ровно как
 * ответ, которого ещё нет.
 */
function calendarSkeleton() {
  const box = $('#cal');
  const nodes = WEEKDAYS.map((wd) => el('span', 'cal__wd', wd));
  for (let i = 0; i < 35; i += 1) {
    const cell = el('span', 'day day--skeleton');
    cell.setAttribute('aria-hidden', 'true');
    nodes.push(cell);
  }
  box.replaceChildren(...nodes);
  box.setAttribute('aria-busy', 'true');
}

function renderCalendar() {
  const box = $('#cal');
  const [y, m] = parse(month);
  $('#month-title').textContent = `${MONTHS_NOM[m - 1]} ${y}`;

  const nodes = WEEKDAYS.map((wd) => el('span', 'cal__wd', wd));

  // Неделя начинается с понедельника: getUTCDay даёт 0 для воскресенья.
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const lead = (first + 6) % 7;
  for (let i = 0; i < lead; i += 1) {
    const blank = el('span', 'day');
    blank.dataset.state = 'empty';
    nodes.push(blank);
  }

  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = horizon();

  for (let d = 1; d <= daysInMonth; d += 1) {
    const date = iso(y, m - 1, d);
    const button = el('button', 'day', String(d));
    button.type = 'button';

    const free = freeDays.get(date) ?? 0;
    const past = date < today;
    const beyond = date > last;

    // Прошедшее и то, что за горизонтом, остаётся на месте — бледным
    // и недоступным: туда записаться нельзя ни при каких условиях.
    if (past || beyond) button.dataset.state = 'past';
    else if (!free) button.dataset.state = 'full';

    // День без окон видно, что он без окон, но нажать его можно:
    // тогда панель справа скажет, когда у мастера ближайшее время
    // и что можно поменять. Мёртвая клетка этого не объясняет.
    button.disabled = past || beyond;
    if (date === today) button.dataset.today = 'true';
    button.setAttribute('aria-pressed', String(date === selectedDate));
    button.setAttribute('aria-label', `${humanDate(date)}${free ? `, свободных окон: ${free}` : ', свободных окон нет'}`);

    if (!button.disabled) button.addEventListener('click', () => selectDay(date));
    nodes.push(button);
  }

  box.replaceChildren(...nodes);
  box.setAttribute('aria-busy', 'false');

  $('#prev').disabled = month <= firstOfMonth(today);
  $('#next-month').disabled = month >= firstOfMonth(last);
}

async function loadMonth() {
  calendarSkeleton();
  const [y, m] = parse(month);
  const from = month < today ? today : month;
  const to = iso(y, m - 1, new Date(Date.UTC(y, m, 0)).getUTCDate());

  try {
    const data = await get(`/api/availability/days?master_id=${picked.master}`
      + `&from=${from}&to=${to}&service_ids=${picked.services.join(',')}`);
    freeDays = new Map((data.days ?? []).map((d) => [d.date, d.slots_count]));
  } catch {
    // Календарь без ответа сервера не раскрашиваем наугад: все дни
    // остаются недоступными, а объяснение уходит в панель окон.
    freeDays = new Map();
    showSlotsError();
  }
  renderCalendar();
}

// --------------------------------------------------------------------------
// Окна
// --------------------------------------------------------------------------

let selectedDate = null;
let slotsSeq = 0;

const PARTS = [
  { name: 'Утро', from: 0, to: 12 * 60, empty: 'Утром свободного времени нет' },
  { name: 'День', from: 12 * 60, to: 17 * 60, empty: 'Днём свободного времени нет' },
  { name: 'Вечер', from: 17 * 60, to: 24 * 60, empty: 'Вечером свободного времени нет' },
];

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function showPanel(which) {
  $('#slots-loading').hidden = which !== 'loading';
  $('#groups').hidden = which !== 'slots';
  $('#end-hint').hidden = which !== 'slots';
  $('#day-full').hidden = which !== 'full';
  $('#slots-error').hidden = which !== 'error';
}

function showSlotsError() {
  showPanel('error');
  $('#slots-count').textContent = '';
  setNext(false, 'Свободное время не загрузилось');
}

function renderEndHint() {
  const hint = $('#end-hint');
  const total = duration(currentDuration);
  if (!slot) {
    hint.textContent = `Услуги займут ${total} — выберите начало, и покажем окончание`;
    return;
  }
  // Окончание — поле ends_at выбранного окна, а не сумма, посчитанная здесь.
  hint.replaceChildren(
    document.createTextNode(`Услуги займут ${total}, окончание в `),
    el('b', null, localTime(slot.ends_at)),
  );
}

let currentDuration = 0;

function renderSlots(slots) {
  const box = $('#groups');
  const nodes = [];

  for (const part of PARTS) {
    const list = slots.filter((s) => {
      const minutes = minutesOf(s.local_time);
      return minutes >= part.from && minutes < part.to;
    });

    const group = el('div', 'group');
    group.append(el('span', 'overline', part.name));

    if (!list.length) {
      // Часть дня не выкидываем: без неё не видно, что там вообще
      // бывает время. Какие именно часы заняты, сервер не сообщает.
      group.append(el('span', 'group__empty', part.empty));
    } else {
      const row = el('div', 'group__row');
      for (const s of list) {
        const button = el('button', 'slot', s.local_time);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(slot?.starts_at === s.starts_at));
        button.setAttribute('aria-label', `${s.local_time}, окончание в ${localTime(s.ends_at)}`);
        button.addEventListener('click', () => {
          slot = s;
          picked = { ...picked };
          renderSlots(slots);
          renderEndHint();
          setNext(true);
          syncUrl();
        });
        row.append(button);
      }
      group.append(row);
    }
    nodes.push(group);
  }

  box.replaceChildren(...nodes);
}

/**
 * Ближайшее свободное время — из того же ответа сервера.
 *
 * Сначала ищем ближайший день с окнами среди уже загруженных, при
 * необходимости заглядываем в следующий месяц. Точное время берём
 * первым окном этого дня — опять же, запросом, а не догадкой.
 */
async function showNearest(fromDate) {
  const text = $('#nearest-text');
  const jump = $('#jump');
  jump.hidden = true;

  let candidate = [...freeDays.keys()].filter((d) => d > fromDate).sort()[0] ?? null;

  if (!candidate) {
    const start = addDays(fromDate, 1);
    const last = horizon();
    if (start <= last) {
      try {
        const to = start > last ? last : addDays(start, 30);
        const data = await get(`/api/availability/days?master_id=${picked.master}`
          + `&from=${start}&to=${to > last ? last : to}&service_ids=${picked.services.join(',')}`);
        candidate = (data.days ?? [])[0]?.date ?? null;
      } catch { /* останется подсказками без точного времени */ }
    }
  }

  if (!candidate) {
    text.textContent = 'Свободного времени у этого мастера не нашлось до конца окна записи.';
    return;
  }

  try {
    const data = await get(`/api/availability?master_id=${picked.master}`
      + `&date=${candidate}&service_ids=${picked.services.join(',')}`);
    const first = (data.slots ?? [])[0];
    const [, m, d] = parse(candidate);
    text.textContent = first
      ? `Ближайшее окно под ваши услуги — ${d} ${MONTHS[m - 1]}, ${first.local_time}`
      : `Ближайший свободный день — ${d} ${MONTHS[m - 1]}`;
    jump.hidden = false;
    jump.onclick = () => {
      if (firstOfMonth(candidate) !== month) {
        month = firstOfMonth(candidate);
        loadMonth().then(() => selectDay(candidate));
      } else {
        selectDay(candidate);
      }
    };
  } catch {
    const [, m, d] = parse(candidate);
    text.textContent = `Ближайший свободный день — ${d} ${MONTHS[m - 1]}`;
  }
}

async function selectDay(date) {
  selectedDate = date;
  slot = null;
  syncUrl();
  renderCalendar();

  $('#day-title').textContent = humanDate(date);
  $('#slots-count').textContent = '';
  setNext(false, 'Выберите время');

  // Заглушка, а не пустая сетка: «ещё грузится» и «всё занято» человек
  // должен различать с первого взгляда.
  showPanel('loading');

  const seq = ++slotsSeq;
  try {
    const data = await get(`/api/availability?master_id=${picked.master}`
      + `&date=${date}&service_ids=${picked.services.join(',')}`);
    if (seq !== slotsSeq) return;

    currentDuration = data.duration_min;
    const slots = data.slots ?? [];

    if (!slots.length) {
      showPanel('full');
      $('#slots-count').textContent = 'свободных окон нет';
      showNearest(date);
      return;
    }

    $('#slots-count').textContent = `свободно ${plural(slots.length, 'окно', 'окна', 'окон')}`;
    renderSlots(slots);
    renderEndHint();
    showPanel('slots');
  } catch {
    if (seq !== slotsSeq) return;
    showSlotsError();
  }
}

// --------------------------------------------------------------------------
// Адрес и переход дальше
// --------------------------------------------------------------------------

function syncUrl() {
  const params = new URLSearchParams();
  if (picked.services.length) params.set('services', picked.services.join(','));
  if (picked.master !== null) params.set('master', String(picked.master));
  if (selectedDate) params.set('date', selectedDate);
  if (slot) params.set('at', slot.starts_at);
  history.replaceState(null, '', `${SCREENS.B3}?${params}`);
}

// --------------------------------------------------------------------------
// Старт
// --------------------------------------------------------------------------

async function start() {
  // Индикатор поднимается до первого запроса, а не после ответа:
  // между открытием страницы и ответом сервера человек не должен
  // видеть пустой календарь и пустую панель.
  calendarSkeleton();
  showPanel('loading');
  $('#day-title').textContent = 'Загружаем свободное время';

  // Без услуг или мастера шаг 3 показывать нечего.
  if (!picked.services.length || picked.master === null) {
    showPanel(null);
    $('#cols').hidden = true;
    $('#no-choice').hidden = false;
    setNext(false, 'Сначала выберите услуги и мастера');
    return;
  }

  // «Любой мастер» API свободного времени не поддерживает: и календарь,
  // и слоты, и резерв требуют master_id.
  if (picked.master === 'any') {
    showPanel(null);
    $('#cols').hidden = true;
    $('#need-master').hidden = false;
    setNext(false, 'Нужен конкретный мастер');
    return;
  }

  try {
    const [studioData, totals, master] = await Promise.all([
      get('/api/studio'),
      fetchTotals(picked.services),
      get(`/api/masters/${picked.master}`),
    ]);

    studio = { ...studioData.studio, ...studioData.studio.booking_rules, booking_rules: studioData.studio.booking_rules };
    today = studioDate();
    month = firstOfMonth(today);
    currentDuration = totals.duration_min;

    $('#chosen-names').textContent = `${master.master.name} · ${totals.services.map((s) => s.name).join(' · ')}`;
    $('#chosen-totals').textContent = `${duration(totals.duration_min)} · ${money(totals.total_price_kopecks)}`;
    $('#bar-sum').textContent = summaryLine(totals);
    $('#bar-note').textContent = `Мы закрепим это время за вами на ${studio.booking_rules.hold_minutes} минут`;
    $('#horizon-note').textContent = `Запись открыта на ${studio.booking_rules.booking_horizon_days} дней вперёд`;

    setNext(false, 'Выберите время');
    await loadMonth();

    // Дата из адреса — чтобы возврат на шаг 3 открывал тот же день.
    const wanted = new URLSearchParams(location.search).get('date');
    if (wanted && wanted >= today && wanted <= horizon()) {
      if (firstOfMonth(wanted) !== month) { month = firstOfMonth(wanted); await loadMonth(); }
      if (freeDays.get(wanted)) { selectDay(wanted); return; }
    }

    // Иначе открываем первый день, где есть окна: пустая панель
    // на входе ничего не говорит человеку.
    const firstFree = [...freeDays.keys()].sort()[0];
    if (firstFree) selectDay(firstFree);
  } catch {
    $('#cols').hidden = false;
    $('#cal').replaceChildren();
    $('#cal').setAttribute('aria-busy', 'false');
    $('#day-title').textContent = 'Выберите день';
    showSlotsError();
  }
}

$('#prev').addEventListener('click', () => { month = shiftMonth(month, -1); loadMonth(); });
$('#next-month').addEventListener('click', () => { month = shiftMonth(month, 1); loadMonth(); });
$('#retry').addEventListener('click', () => { if (selectedDate) selectDay(selectedDate); else loadMonth(); });

$('#next').addEventListener('click', () => {
  if (!slot) return;
  // Дальше — шаг 4/5. Резерв ставит тот экран: резерв живёт 10 минут,
  // и начинать отсчёт на экране, с которого ещё можно уйти назад, рано.
  const params = new URLSearchParams();
  params.set('services', picked.services.join(','));
  params.set('master', String(picked.master));
  params.set('at', slot.starts_at);
  location.href = `booking-confirm.html?${params}`;
});

start();
