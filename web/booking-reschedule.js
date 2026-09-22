/**
 * Экран K3 «Перенос записи».
 *
 * Тот же выбор даты и времени, что на шаге 3, но для уже существующей
 * записи. Разница вся в одном параметре: запросы свободного времени идут
 * с reschedule_of, а не со списком услуг.
 *
 * Это не мелочь. При переносе длительность берётся из самой записи,
 * а не из текущего прайса: подорожавшая и удлинившаяся услуга иначе
 * молча раздвинула бы визит и наехала на следующего клиента. Сервер
 * делает это сам (resolveDuration в availability.routes.js) — от экрана
 * требуется только не подсовывать ему service_ids.
 *
 * Тот же reschedule_of исключает из занятого времени саму переносимую
 * запись: иначе её текущий слот выглядел бы занятым ею же.
 *
 * Прежнее время держится за клиентом до подтверждения переноса —
 * освобождает его сервер, и только на последнем шаге.
 */
import { wireScreenLinks, setupTheme, initials } from './shared.js';
import {
  $, el, setNext,
  get, duration, money, plural, SCREENS,
} from './booking.js';

wireScreenLinks();
setupTheme();

const appointmentId = new URLSearchParams(location.search).get('appointment');
let appointment = null;       // переносимая запись целиком
let masterId = null;
let slot = null;              // выбранное окно, как пришло с сервера
let studio = null;
let month = null;             // первое число показываемого месяца, 'YYYY-MM-DD'
let freeDays = new Map();     // дата → число окон, из /availability/days
let today = null;

$('#back').href = SCREENS.K1;
$('#change-master').href = SCREENS.K1;
$('#change-services').href = SCREENS.K1;

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
    const data = await get(`/api/availability/days?master_id=${masterId}`
      + `&from=${from}&to=${to}&reschedule_of=${appointmentId}`);
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
          renderSlots(slots);
          renderEndHint();
          setNext(true);
          // Дата берётся из выбранного дня студии, а не из UTC-строки слота:
          // у вечерних окон местная дата и дата UTC расходятся.
          $('#bar-sum').textContent =
            `Новое время: ${humanDate(selectedDate)} · ${s.local_time}`;
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
        const data = await get(`/api/availability/days?master_id=${masterId}`
          + `&from=${start}&to=${to > last ? last : to}&reschedule_of=${appointmentId}`);
        candidate = (data.days ?? [])[0]?.date ?? null;
      } catch { /* останется подсказками без точного времени */ }
    }
  }

  if (!candidate) {
    text.textContent = 'Свободного времени у этого мастера не нашлось до конца окна записи.';
    return;
  }

  try {
    const data = await get(`/api/availability?master_id=${masterId}`
      + `&date=${candidate}&reschedule_of=${appointmentId}`);
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
  $('#bar-sum').textContent = 'Новое время не выбрано';
  setNext(false, 'Выберите новое время');

  // Заглушка, а не пустая сетка: «ещё грузится» и «всё занято» человек
  // должен различать с первого взгляда.
  showPanel('loading');

  const seq = ++slotsSeq;
  try {
    const data = await get(`/api/availability?master_id=${masterId}`
      + `&date=${date}&reschedule_of=${appointmentId}`);
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
  params.set('appointment', appointmentId);
  if (selectedDate) params.set('date', selectedDate);
  if (slot) params.set('at', slot.starts_at);
  history.replaceState(null, '', `${SCREENS.K3}?${params}`);
}

// --------------------------------------------------------------------------
// Старт
// --------------------------------------------------------------------------

/**
 * Правила переноса решает сервер.
 *
 * can_reschedule и reschedules_left приходят в самой записи, посчитанные
 * по настройкам студии: срок и лимит в три переноса. Экран по ним рисует,
 * а не вычисляет их заново — второе определение лимита рядом с серверным
 * однажды разошлось бы с ним.
 */
function renderAppointment() {
  $('#sum-face').textContent = initials(appointment.master.name);
  $('#sum-master').textContent = appointment.master.name;
  $('#sum-services').textContent = appointment.services.map((x) => x.name).join(' · ');
  $('#sum-totals').textContent =
    `${duration(appointment.duration_min)} · ${money(appointment.total_price_kopecks)}`;
  $('#sum-when').textContent = `${humanDate(appointment.starts_at.local_date)} · ${appointment.starts_at.local_time}`;
  $('#sum-ends').textContent = `Окончание в ${appointment.ends_at.local_time}`;

  const left = appointment.reschedules_left;
  $('#moves-left').textContent = left != null
    ? `Переносов осталось: ${left}`
    : '';
  $('#current').hidden = false;

  // Предупреждение ровно на последнем: раньше пугать незачем, позже поздно.
  $('#last-move').hidden = left !== 1;
}

/** Переносить нельзя — объясняем чем именно и уводим к записям. */
function blockMove() {
  showPanel(null);
  $('#cols').hidden = true;
  $('#pick-title').hidden = true;

  const left = appointment.reschedules_left;
  if (left === 0) {
    $('#cant-title').textContent = 'Лимит переносов исчерпан';
    $('#cant-text').textContent =
      `Эту запись уже переносили ${plural(appointment.reschedule_count, 'раз', 'раза', 'раз')}. `
      + 'Выбрать новое время онлайн больше нельзя — позвоните в студию.';
  } else if (appointment.status !== 'booked') {
    $('#cant-title').textContent = 'Запись уже не действует';
    $('#cant-text').textContent = 'Переносить можно только предстоящие записи.';
  } else {
    $('#cant-title').textContent = 'Срок переноса прошёл';
    $('#cant-text').textContent =
      `Менять время онлайн можно не позднее чем за ${plural(studio.booking_rules.cancel_deadline_hours, 'час', 'часа', 'часов')} `
      + 'до визита. Позвоните в студию — там помогут.';
  }
  $('#cant-move').hidden = false;
  setNext(false, 'Перенос недоступен');
}

async function start() {
  // Индикатор поднимается до первого запроса, а не после ответа:
  // между открытием страницы и ответом сервера человек не должен
  // видеть пустой календарь и пустую панель.
  calendarSkeleton();
  showPanel('loading');
  $('#day-title').textContent = 'Загружаем свободное время';

  if (!appointmentId) {
    showPanel(null);
    $('#cols').hidden = true;
    $('#no-choice-title').textContent = 'Не указана запись';
    $('#no-choice-text').textContent = 'В адресе нет номера записи. Откройте перенос из личного кабинета.';
    $('#no-choice').hidden = false;
    setNext(false, 'Нечего переносить');
    return;
  }

  try {
    const [studioData, data] = await Promise.all([
      get('/api/studio'),
      get(`/api/appointments/${appointmentId}`),
    ]);

    studio = { ...studioData.studio, booking_rules: studioData.studio.booking_rules };
    appointment = data.appointment;
    masterId = appointment.master.id;
    today = studioDate();
    month = firstOfMonth(today);
    currentDuration = appointment.duration_min;

    renderAppointment();
    $('#horizon-note').textContent = `Перенести можно на ${studio.booking_rules.booking_horizon_days} дней вперёд`;

    if (!appointment.can_reschedule) { blockMove(); return; }

    $('#pick-title').hidden = false;
    setNext(false, 'Выберите новое время');
    await loadMonth();

    const wanted = new URLSearchParams(location.search).get('date');
    if (wanted && wanted >= today && wanted <= horizon()) {
      if (firstOfMonth(wanted) !== month) { month = firstOfMonth(wanted); await loadMonth(); }
      if (freeDays.get(wanted)) { selectDay(wanted); return; }
    }

    const firstFree = [...freeDays.keys()].sort()[0];
    if (firstFree) selectDay(firstFree);
  } catch (error) {
    showPanel(null);
    $('#cols').hidden = true;
    if (error.status === 404) {
      $('#no-choice-title').textContent = 'Запись не найдена';
      $('#no-choice-text').textContent = 'Возможно, она уже отменена или принадлежит другому аккаунту.';
    } else if (error.status === 401) {
      $('#no-choice-title').textContent = 'Нужен вход';
      $('#no-choice-text').textContent = 'Чтобы перенести запись, войдите в личный кабинет.';
    } else {
      $('#no-choice-title').textContent = 'Не удалось открыть запись';
      $('#no-choice-text').textContent = error.message;
    }
    $('#no-choice').hidden = false;
    setNext(false, 'Перенос недоступен');
  }
}

$('#prev').addEventListener('click', () => { month = shiftMonth(month, -1); loadMonth(); });
$('#next-month').addEventListener('click', () => { month = shiftMonth(month, 1); loadMonth(); });
$('#retry').addEventListener('click', () => { if (selectedDate) selectDay(selectedDate); else loadMonth(); });

$('#next').addEventListener('click', () => {
  if (!slot) return;
  // Дальше — подтверждение в режиме переноса. Резерв ставит тот экран:
  // он живёт десять минут, и начинать отсчёт там, откуда ещё уходят
  // назад, рано.
  const params = new URLSearchParams();
  params.set('reschedule', appointmentId);
  params.set('at', slot.starts_at);
  location.href = `${SCREENS.B5}?${params}`;
});

start();
