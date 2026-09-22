/**
 * Шаг B5 «Подтверждение».
 *
 * Что здесь происходит по порядку: при открытии слот удерживается через
 * POST /api/holds, по полю expires_in_seconds из ответа идёт таймер,
 * а по кнопке создаётся запись через POST /api/appointments с номером
 * этого резерва.
 *
 * Ни сумма, ни длительность, ни окончание визита здесь не считаются:
 * всё это приходит в ответе на резерв — сервер собрал снимок визита
 * в момент удержания, и показывать надо именно его, а не пересчитанный
 * прайс, который мог измениться между шагами.
 *
 * Текст ошибок — тоже серверный. «Это время уже занято» звучит одинаково
 * и при резерве, и при подтверждении, потому что это один и тот же ответ
 * сервера, а не две наши формулировки.
 */
import { wireScreenLinks, setupTheme, initials } from './shared.js';
import {
  $, el, selection, renderSteps, setNext,
  get, fetchTotals, duration, money, plural, SCREENS,
} from './booking.js';
import { post, showFormError } from './auth.js';
import { API_BASE } from './config.js';

wireScreenLinks();
setupTheme();

const params = new URLSearchParams(location.search);
const picked = selection.read();
let startsAt = params.get('at');
let hold = null;
let studio = null;
let ticker = null;
let confirmed = false;

/**
 * Режим переноса.
 *
 * Отличий от новой записи три, и все три — на стороне сервера:
 * резерв ставится с reschedule_of вместо списка услуг, подтверждает
 * перенос другой эндпоинт, и состав визита приходит из самой записи,
 * а не из прайса. Экран при этом тот же: сводка, таймер, кнопка.
 */
const rescheduleOf = params.get('reschedule');
const isMove = Boolean(rescheduleOf);
let moving = null;            // переносимая запись, если это перенос

const backHref = (() => {
  const p = new URLSearchParams();
  if (isMove) {
    p.set('appointment', rescheduleOf);
    if (startsAt) p.set('at', startsAt);
    return `${SCREENS.K3}?${p}`;
  }
  if (picked.services.length) p.set('services', picked.services.join(','));
  if (picked.master !== null) p.set('master', String(picked.master));
  if (startsAt) p.set('at', startsAt);
  return `${SCREENS.B3}?${p}`;
})();

for (const id of ['back', 'back-to-time', 'edit-time', 'expired-other', 'fatal-other', 'taken-other']) {
  const node = $(`#${id}`);
  if (node) node.href = backHref;
}
// При переносе состав визита не меняется — менять в нём нечего,
// кроме времени. Ссылки «Изменить» у мастера и услуг убираем.
if (isMove) {
  $('#edit-master').hidden = true;
  $('#edit-services').hidden = true;
  $('#go-start').href = SCREENS.K1;
} else {
  $('#edit-master').href = selection.href('B2', picked);
  $('#edit-services').href = selection.href('B1', { services: picked.services, master: null });
  $('#go-start').href = SCREENS.B1;
}

renderSteps(4, picked);

// Панели итога на этом экране нет — кнопка подтверждения стоит в форме.
$('.bar')?.remove();

// --------------------------------------------------------------------------
// Экраны
// --------------------------------------------------------------------------

const PANELS = ['body', 'need-login', 'no-choice', 'expired', 'fatal'];
function show(which) {
  for (const id of PANELS) $(`#${id}`).hidden = id !== which;
}

function localTime(utcIso) {
  return new Date(Date.parse(utcIso) + studio.utc_offset_minutes * 60_000).toISOString().slice(11, 16);
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function humanDay(utcIso) {
  const shifted = new Date(Date.parse(utcIso) + studio.utc_offset_minutes * 60_000);
  return `${shifted.getUTCDate()} ${MONTHS[shifted.getUTCMonth()]}, ${WEEKDAYS[shifted.getUTCDay()]}`;
}

// --------------------------------------------------------------------------
// Таймер резерва
// --------------------------------------------------------------------------

/** Меньше минуты — полоса меняет вид: это последнее предупреждение. */
const WARN_AT = 60;

const CLOCK = '<circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5l3 2"></path>';
const WARN = '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v4.5M12 16h.01"></path>';

function startTimer(seconds) {
  clearInterval(ticker);
  const bar = $('#reserve');
  const text = $('#reserve-text');
  const icon = $('#reserve-icon');
  bar.hidden = false;

  // Считаем от момента, а не уменьшением счётчика: вкладка может заснуть,
  // и тогда счётчик отстанет от настоящего срока на сервере.
  const deadline = Date.now() + seconds * 1000;

  const tick = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

    if (left === 0) {
      clearInterval(ticker);
      bar.dataset.tone = 'warn';
      icon.innerHTML = WARN;
      text.textContent = 'Время больше не закреплено за вами';
      showExpired();
      return;
    }

    if (left < WARN_AT) {
      bar.dataset.tone = 'warn';
      icon.innerHTML = WARN;
      text.textContent = `Резерв истекает: ${mmss}`;
    } else {
      bar.dataset.tone = 'calm';
      icon.innerHTML = CLOCK;
      text.textContent = `Время закреплено за вами: ${mmss}`;
    }
  };

  tick();
  ticker = setInterval(tick, 1000);
}

function showExpired() {
  clearInterval(ticker);
  const held = plural(studio.booking_rules.hold_minutes, 'минуту', 'минуты', 'минут');
  $('#expired-text').textContent = startsAt
    ? `Мы держали ${humanDay(startsAt)}, ${localTime(startsAt)} ${held}. `
      + 'Проверьте, свободно ли это окно, или выберите другое.'
    : 'Проверьте, свободно ли это окно, или выберите другое.';
  show('expired');
}

// --------------------------------------------------------------------------
// «Время заняли»
// --------------------------------------------------------------------------

/**
 * Состояние «время заняли» — на этой же странице.
 *
 * Текст берётся из ответа сервера дословно, варианты — из его же
 * details.free_slots. Своей формулировки здесь нет: сервер единственный
 * знает, что именно случилось с этим окном.
 */
function showTaken(error) {
  const box = $('#taken');
  $('#taken-message').textContent = error?.message ?? 'Это время уже занято';

  const slots = error?.details?.free_slots ?? [];
  const list = $('#taken-slots');

  if (!slots.length) {
    $('#taken-sub').textContent = 'Ближайших свободных окон сервер не предложил — посмотрите другие дни.';
    list.replaceChildren();
  } else {
    $('#taken-sub').textContent = `Ближайшие свободные окна — ${plural(slots.length, 'вариант', 'варианта', 'вариантов')}:`;
    list.replaceChildren(...slots.map((s) => {
      const button = el('button', 'taken__slot');
      button.type = 'button';
      const day = new Date(Date.parse(s.starts_at) + studio.utc_offset_minutes * 60_000);
      button.append(
        el('span', null, `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`),
        el('b', null, s.local_time),
      );
      button.addEventListener('click', () => {
        startsAt = s.starts_at;
        box.hidden = true;
        takeHold();
      });
      return button;
    }));
  }

  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
  setConfirmBusy(false);
  $('#confirm').disabled = true;
}

// --------------------------------------------------------------------------
// Сводка
// --------------------------------------------------------------------------

/**
 * Сводка визита.
 *
 * Обычно берётся из ответа на резерв — это снимок, который сервер
 * сделал в момент удержания. Если резерв не встал (время заняли),
 * снимка нет, и состав показывается по текущему прайсу: человек должен
 * видеть, что именно он выбирал, а не пустую карточку.
 */
function renderSummary(master, visit) {
  const face = $('#sum-face');
  face.replaceChildren();
  if (master.photo_url) {
    const img = el('img');
    img.src = master.photo_url;
    img.alt = '';
    img.addEventListener('error', () => { face.textContent = initials(master.name); });
    face.append(img);
  } else {
    face.textContent = initials(master.name);
  }

  $('#sum-master').textContent = master.name;
  $('#sum-spec').textContent = master.specialization ?? '';

  $('#sum-services').replaceChildren(...visit.services.map((s) => {
    const row = el('div', 'line');
    const right = el('span', 'line__right');
    right.append(el('span', 'line__dur', duration(s.duration_min)), el('span', 'line__price', money(s.price_kopecks)));
    row.append(el('span', 'line__name', s.name), right);
    return row;
  }));

  if (visit.starts_at) {
    $('#sum-when').textContent = `${humanDay(visit.starts_at.utc)} · ${visit.starts_at.local_time}`;
    $('#sum-ends').textContent = `Окончание в ${visit.ends_at.local_time}`;
  } else {
    // Времени за нами нет — обещать окончание нечестно.
    $('#sum-when').textContent = `${humanDay(startsAt)} · ${localTime(startsAt)}`;
    $('#sum-ends').textContent = 'Это время заняли — выберите другое';
  }
  $('#sum-total').textContent = `Итог: ${duration(visit.duration_min)} · ${money(visit.total_price_kopecks)}`;
  $('#foot-note').textContent = 'Отменить или перенести запись можно в личном кабинете не позднее чем за '
    + `${plural(studio.booking_rules.cancel_deadline_hours, 'час', 'часа', 'часов')} до визита.`;
}

/**
 * «Было / станет» в строке времени.
 *
 * Прежнее время не прячем: перенос — это замена одного другим,
 * и человек должен видеть, что именно меняется.
 */
function showWasBecomes() {
  const box = $('#sum-when');
  box.replaceChildren();

  const was = el('span', 'move-line');
  was.append(el('span', 'move-tag', 'было'),
    el('s', 'move-old', `${humanDay(moving.starts_at.utc)} · ${moving.starts_at.local_time}`));

  const now = el('span', 'move-line');
  now.append(el('span', 'move-tag move-tag--new', 'станет'),
    el('b', null, `${humanDay(hold.starts_at.utc)} · ${hold.starts_at.local_time}`));

  box.append(was, now);
  $('#sum-ends').textContent = `Окончание в ${hold.ends_at.local_time}`;
}

// --------------------------------------------------------------------------
// Резерв
// --------------------------------------------------------------------------

function setConfirmBusy(busy) {
  const button = $('#confirm');
  button.disabled = busy;
  $('.spinner', button).hidden = !busy;
  $('.btn__label', button).textContent = busy
    ? 'Подтверждаем'
    : (isMove ? 'Подтвердить перенос' : 'Подтвердить запись');
}

async function takeHold() {
  show('body');
  $('#send-error').hidden = true;
  $('#confirm').disabled = true;

  try {
    // При переносе услуги не перечисляем: сервер берёт их из записи,
    // вместе с её длительностью — снимок визита, а не текущий прайс.
    const body = isMove
      ? { master_id: moving.master.id, starts_at: startsAt, reschedule_of: Number(rescheduleOf) }
      : { master_id: picked.master, starts_at: startsAt, service_ids: picked.services };

    const { ok, status, data } = await post('/api/holds', body);

    if (!ok) {
      if (status === 409) {
        showTaken(data?.error);
        // Карточка справа не должна оставаться пустой: показываем выбор
        // по текущему прайсу, раз снимка резерва не случилось.
        try {
          if (isMove) {
            renderSummary(moving.master, moving);
          } else {
            const [totals, master] = await Promise.all([
              fetchTotals(picked.services),
              get(`/api/masters/${picked.master}`),
            ]);
            renderSummary(master.master, totals);
          }
        } catch { /* сводка останется пустой, состояние «заняли» важнее */ }
        return;
      }
      $('#fatal-title').textContent = 'Не удалось закрепить время';
      $('#fatal-text').textContent = data?.error?.message ?? 'Сервер не ответил. Попробуйте ещё раз.';
      show('fatal');
      return;
    }

    hold = data.hold;
    // Адрес держим в согласии с тем, что реально закреплено.
    const p = new URLSearchParams(location.search);
    p.set('at', startsAt);
    history.replaceState(null, '', `${SCREENS.B5}?${p}`);

    const master = isMove ? { master: moving.master } : await get(`/api/masters/${picked.master}`);
    renderSummary(master.master, hold);
    // Строго после сводки: она пишет в ту же строку времени.
    if (isMove) showWasBecomes();
    startTimer(hold.expires_in_seconds);
    $('#confirm').disabled = false;
  } catch {
    $('#fatal-title').textContent = 'Не удалось связаться с сервером';
    $('#fatal-text').textContent = 'Проверьте соединение и попробуйте ещё раз.';
    show('fatal');
  }
}

// --------------------------------------------------------------------------
// Подтверждение
// --------------------------------------------------------------------------

$('#confirm').addEventListener('click', async () => {
  if (!hold) return;
  $('#send-error').hidden = true;
  $('#taken').hidden = true;
  setConfirmBusy(true);

  try {
    const { ok, status, data } = isMove
      ? await post(`/api/appointments/${rescheduleOf}/reschedule`, { hold_id: hold.id })
      : await post('/api/appointments', {
        hold_id: hold.id,
        client_note: $('#note').value.trim() || undefined,
      });

    if (ok) {
      confirmed = true;
      clearInterval(ticker);
      location.href = `${SCREENS.B6}?id=${data.appointment.id}`;
      return;
    }

    if (status === 409) { showTaken(data?.error); return; }

    if (status === 401) {
      // Сессия кончилась, пока человек заполнял комментарий.
      // Резерв при этом жив: он на токене браузера.
      showNeedLogin(data?.error?.message);
      return;
    }

    // Любая другая ошибка — словами сервера. Резерв не тронут.
    showFormError(data?.error?.message ?? 'Не удалось подтвердить запись, попробуйте ещё раз');
    $('#send-error').hidden = false;
    setConfirmBusy(false);
  } catch {
    showFormError('Не удалось связаться с сервером. Время остаётся закреплённым за вами.');
    $('#send-error').hidden = false;
    setConfirmBusy(false);
  }
});

function showNeedLogin(message) {
  clearInterval(ticker);
  $('#reserve').hidden = true;
  if (message) $('#need-login-text').textContent = message;
  const back = encodeURIComponent(location.pathname + location.search);
  for (const screen of ['C1', 'C2']) {
    const link = $(`[data-screen="${screen}"]`);
    if (link) link.href = `${SCREENS[screen]}?back=${back}`;
  }
  show('need-login');
}

$('#rehold').addEventListener('click', () => { $('#reserve').hidden = true; takeHold(); });
$('#retry').addEventListener('click', takeHold);

/**
 * Уходя со страницы по своей воле, резерв отпускаем сразу.
 *
 * Иначе окно висит занятым ещё десять минут — и у этого клиента,
 * и у всех остальных. keepalive доводит запрос до конца уже после
 * ухода со страницы: обычный fetch браузер успел бы отменить.
 */
function releaseHold() {
  if (!hold || confirmed) return;
  const id = hold.id;
  hold = null;
  clearInterval(ticker);
  fetch(`${API_BASE}/api/holds/${id}`, { method: 'DELETE', credentials: 'include', keepalive: true })
    .catch(() => { /* не дошло — резерв всё равно истечёт сам */ });
}

for (const id of ['back', 'back-to-time', 'edit-time', 'edit-master', 'edit-services']) {
  $(`#${id}`)?.addEventListener('click', releaseHold);
}

// --------------------------------------------------------------------------
// Старт
// --------------------------------------------------------------------------

async function start() {
  const enoughForNew = picked.services.length && picked.master !== null && picked.master !== 'any';
  if (!startsAt || (!isMove && !enoughForNew)) {
    show('no-choice');
    return;
  }

  try {
    studio = (await get('/api/studio')).studio;
  } catch {
    $('#fatal-title').textContent = 'Не удалось связаться с сервером';
    $('#fatal-text').textContent = 'Проверьте соединение и попробуйте ещё раз.';
    show('fatal');
    return;
  }

  // Кто подтверждает, должен быть вошедшим: этого требует сам эндпоинт
  // создания записи. Проверяем заранее, чтобы человек узнал об этом
  // до того, как напишет комментарий, а не после.
  try {
    const me = await get('/api/auth/me');
    const who = $('#who');
    const rows = [
      ['Имя', me.user.full_name],
      ['Телефон', me.user.phone],
      ['E-mail', me.user.email],
    ];
    who.replaceChildren(...rows.filter(([, value]) => value).map(([label, value]) => {
      const row = el('div', 'who__item');
      row.append(el('span', 'who__label', label), el('span', 'who__value', value));
      return row;
    }));
  } catch (error) {
    if (error.status === 401) { showNeedLogin(); return; }
    $('#fatal-title').textContent = 'Не удалось проверить вход';
    $('#fatal-text').textContent = 'Проверьте соединение и попробуйте ещё раз.';
    show('fatal');
    return;
  }

  if (isMove) {
    try {
      moving = (await get(`/api/appointments/${rescheduleOf}`)).appointment;
    } catch (error) {
      $('#fatal-title').textContent = error.status === 404 ? 'Запись не найдена' : 'Не удалось открыть запись';
      $('#fatal-text').textContent = error.status === 404
        ? 'Возможно, она уже отменена или принадлежит другому аккаунту.'
        : error.message;
      show('fatal');
      return;
    }
    // Правила проверяет сервер, но дойти сюда с запретом можно по прямой
    // ссылке — тогда честнее сказать сразу, а не после резерва.
    if (!moving.can_reschedule) {
      $('#fatal-title').textContent = 'Перенести эту запись нельзя';
      $('#fatal-text').textContent = moving.reschedules_left === 0
        ? 'Лимит переносов исчерпан — позвоните в студию.'
        : 'Срок переноса прошёл — позвоните в студию.';
      show('fatal');
      return;
    }
    $('h1', $('#body')).textContent = 'Проверьте и подтвердите перенос';
    $('.bk__sub', $('#body')).textContent = 'Прежнее время освободится сразу после подтверждения';
    $('.btn__label', $('#confirm')).textContent = 'Подтвердить перенос';
    // Комментарий относится к самой записи и при переносе не меняется.
    $('.note-field').hidden = true;
  }

  takeHold();
}

start();
