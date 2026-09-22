/**
 * Работа со временем.
 *
 * Правило сервиса: в базе и в теле ответов моменты времени всегда в UTC,
 * строкой 'YYYY-MM-DDTHH:MM:SSZ'. Часовой пояс студии применяется
 * в одном-единственном месте — при подготовке ответа для показа на экране,
 * и приезжает не из кода, а из settings.utc_offset_minutes.
 *
 * Поэтому здесь нет ни одной функции, которая читала бы часовой пояс
 * операционной системы: сервер может стоять где угодно, на расчёт это
 * влиять не должно.
 */

/** Текущий момент в формате базы. Точность до секунды — миллисекунды схеме не нужны. */
export function now() {
  return toInstant(new Date());
}

export function toInstant(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function addMinutes(instant, minutes) {
  return toInstant(new Date(new Date(instant).getTime() + minutes * 60_000));
}

export function addDays(instant, days) {
  return addMinutes(instant, days * 24 * 60);
}

export function minutesBetween(from, to) {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000);
}

/** Календарная дата момента в UTC. Для дат студии используйте localDate. */
export function utcDate(instant) {
  return instant.slice(0, 10);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** '+03:00' из 180 минут — для поля со смещением в ответе. */
export function formatOffset(offsetMinutes) {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Момент UTC → как его видит студия.
 *
 * Возвращает разобранные части, а не готовую подпись: как именно показать
 * «21 сентября, 13:00» решает фронтенд, а не API.
 */
export function toLocalParts(instant, offsetMinutes) {
  const shifted = new Date(new Date(instant).getTime() + offsetMinutes * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    time: shifted.toISOString().slice(11, 16),
    iso: `${shifted.toISOString().slice(0, 19)}${formatOffset(offsetMinutes)}`,
  };
}

/** Дата по календарю студии — то, что клиент считает «этим днём». */
export function localDate(instant, offsetMinutes) {
  return toLocalParts(instant, offsetMinutes).date;
}

/** Местная дата и время суток студии → момент UTC. Обратная операция к toLocalParts. */
export function fromLocal(date, time, offsetMinutes) {
  return addMinutes(`${date}T${time}:00Z`, -offsetMinutes);
}

/** Границы местных суток в UTC — половина интервала открыта: [начало, начало следующего дня). */
export function localDayBounds(date, offsetMinutes) {
  const from = fromLocal(date, '00:00', offsetMinutes);
  return { from, to: addDays(from, 1) };
}

/** 1 = понедельник … 7 = воскресенье, как в схеме (JS отдаёт 0 = воскресенье). */
export function weekdayOf(date) {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}
