/**
 * Экран B6 «Запись подтверждена».
 *
 * Номер записи приходит в адресе, а детали — из GET /api/appointments/:id.
 * Переносить их через адрес или хранилище было бы и длинно, и ненадёжно:
 * показывать надо то, что в самом деле лежит в базе после подтверждения,
 * а не то, что страница отправляла.
 *
 * Эндпоинт требует входа и отдаёт только свою запись — чужая отвечает 404,
 * а не 403. Поэтому отдельной проверки прав здесь нет: её уже сделал сервер.
 */
import { wireScreenLinks, setupTheme, initials } from './shared.js';
import { $, el, get, duration, money } from './booking.js';

wireScreenLinks();
setupTheme();

const id = new URLSearchParams(location.search).get('id');

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

/** Дата берётся из местных полей ответа — сервер их уже посчитал. */
function humanDay(momentField) {
  const [y, m, d] = momentField.local_date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${d} ${MONTHS[m - 1]}, ${weekday}`;
}

function fail(title, text) {
  $('#loading').hidden = true;
  $('#error-title').textContent = title;
  $('#error-text').textContent = text;
  $('#error').hidden = false;
}

async function load() {
  if (!id) {
    fail('Не указана запись', 'В адресе нет номера записи. Откройте её из личного кабинета.');
    return;
  }

  let appointment;
  try {
    appointment = (await get(`/api/appointments/${id}`)).appointment;
  } catch (error) {
    if (error.status === 401) {
      fail('Нужен вход', 'Чтобы открыть запись, войдите в личный кабинет.');
      return;
    }
    if (error.status === 404) {
      fail('Запись не найдена', 'Возможно, она уже отменена или принадлежит другому аккаунту.');
      return;
    }
    fail('Не удалось открыть запись', error.message);
    return;
  }

  const face = $('#sum-face');
  face.textContent = initials(appointment.master.name);
  $('#sum-master').textContent = appointment.master.name;
  $('#sum-spec').textContent = appointment.master.specialization ?? '';

  $('#sum-services').replaceChildren(...appointment.services.map((s) => {
    const row = el('div', 'line');
    const right = el('span', 'line__right');
    right.append(el('span', 'line__dur', duration(s.duration_min)), el('span', 'line__price', money(s.price_kopecks)));
    row.append(el('span', 'line__name', s.name), right);
    return row;
  }));

  $('#sum-when').textContent = humanDay(appointment.starts_at);
  $('#sum-range').textContent =
    `${appointment.starts_at.local_time} – ${appointment.ends_at.local_time} · ${duration(appointment.duration_min)}`;
  $('#sum-total').textContent = `К оплате в студии: ${money(appointment.total_price_kopecks)}`;
  $('#done-sub').textContent = `${humanDay(appointment.starts_at)}, ${appointment.starts_at.local_time} — ждём вас`;

  if (appointment.client_note) {
    $('#sum-note').textContent = appointment.client_note;
    $('#note-row').hidden = false;
  }

  // Можно ли отменить и перенести — решил сервер (поля abilities),
  // и подпись повторяет его ответ, а не наше представление о правилах.
  if (appointment.can_cancel === false) {
    $('#cancel-note').textContent = 'Срок бесплатной отмены уже прошёл — позвоните в студию';
  }

  $('#foot-note').textContent = 'Уведомления о записи приходят в личный кабинет.';

  $('#loading').hidden = true;
  $('#body').hidden = false;
}

load();
