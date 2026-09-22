/**
 * Загрузка и выручка мастера.
 *
 * Паспорт: мастер «видит свою загрузку и выручку по своим услугам».
 * Три решения, которые определяют все цифры ниже.
 *
 * 1. Выручкой считаются только завершённые визиты.
 *    `no_show` и `cancelled` денег не принесли, а `booked` ещё не принёс —
 *    он показывается отдельной строкой «ожидается», чтобы его не путали
 *    с заработанным. Отчёт, где будущее смешано с прошлым, нельзя
 *    ни проверить, ни сравнить с кассой.
 *
 * 2. Цены берутся из снимков appointment_services, а не из прайса.
 *    Иначе отчёт за прошлый месяц менялся бы каждый раз, когда
 *    администратор правит цену. Это прямо заложено в схеме (раздел 7.7),
 *    и здесь тот самый случай, ради которого снимки и делались.
 *
 * 3. Загрузка считается от рабочих часов по графику, а не от суток.
 *    «Занято 6 часов» само по себе ничего не говорит: это полный день
 *    или треть смены. Знаменатель берётся из недельного графика на каждую
 *    дату периода, минус отпуска и закрытое время, плюс дополнительные смены.
 */
import { getDb } from '../db/connection.js';
import { unprocessable } from '../lib/http-error.js';
import {
  addDays,
  utcDate,
  fromLocal,
  localDayBounds,
  weekdayOf,
  minutesBetween,
} from '../lib/time.js';

/** Предел периода за один запрос: расчёт идёт по каждому дню отдельно. */
const MAX_DAYS = 366;

/** Пересечение двух интервалов в минутах; 0, если не пересекаются. */
function overlapMinutes(aFrom, aTo, bFrom, bTo) {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  return to > from ? minutesBetween(from, to) : 0;
}

/**
 * Сколько минут мастер должен был работать за период по графику.
 *
 * Считается по дням: недельные интервалы, действующие на эту дату,
 * переводятся в моменты UTC, из них вычитается закрытое время и отпуска,
 * прибавляются дополнительные смены.
 *
 * Часы студии здесь не пересекаются с графиком намеренно. Знаменатель
 * должен отвечать на вопрос «сколько я обязан был отработать», а это
 * ровно график мастера; расхождение графика с часами студии — ошибка
 * администратора, и прятать её, тихо обрезав знаменатель, не стоит.
 */
function scheduledMinutes({ masterId, from, to, offset }) {
  const db = getDb();
  const weekly = db
    .prepare(
      `SELECT weekday, work_start, work_end, valid_from, valid_to
         FROM master_schedules
        WHERE master_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)`,
    )
    .all(masterId, to, from);

  const bounds = { from: localDayBounds(from, offset).from, to: localDayBounds(utcDate(addDays(`${to}T00:00:00Z`, 1)), offset).from };
  const exceptions = db
    .prepare(
      `SELECT kind, starts_at, ends_at FROM schedule_exceptions
        WHERE master_id = ? AND starts_at < ? AND ends_at > ?`,
    )
    .all(masterId, bounds.to, bounds.from);

  let total = 0;
  let day = from;
  while (day <= to) {
    const weekday = weekdayOf(day);
    for (const row of weekly) {
      if (row.weekday !== weekday) continue;
      if (row.valid_from > day) continue;
      if (row.valid_to !== null && row.valid_to < day) continue;

      const start = fromLocal(day, row.work_start, offset);
      const end = fromLocal(day, row.work_end, offset);
      let minutes = minutesBetween(start, end);

      for (const exception of exceptions) {
        if (exception.kind === 'extra_shift') continue;
        minutes -= overlapMinutes(start, end, exception.starts_at, exception.ends_at);
      }
      total += Math.max(0, minutes);
    }
    day = utcDate(addDays(`${day}T00:00:00Z`, 1));
  }

  // Дополнительные смены прибавляются целиком: они и есть работа
  // вне недельного графика.
  for (const exception of exceptions) {
    if (exception.kind !== 'extra_shift') continue;
    total += overlapMinutes(exception.starts_at, exception.ends_at, bounds.from, bounds.to);
  }

  return total;
}

/**
 * Сводка мастера за период.
 *
 * from и to — местные даты студии включительно: человек мыслит рабочими
 * днями, а не сутками UTC.
 */
export function masterWorkload({ masterId, from, to, settings }) {
  if (to < from) throw unprocessable('invalid_range', 'Конец периода раньше начала');
  const days = minutesBetween(`${from}T00:00:00Z`, `${to}T00:00:00Z`) / (60 * 24) + 1;
  if (days > MAX_DAYS) throw unprocessable('range_too_long', `За один запрос — не более ${MAX_DAYS} дней`);

  const offset = settings.utc_offset_minutes;
  const bounds = {
    from: localDayBounds(from, offset).from,
    to: localDayBounds(utcDate(addDays(`${to}T00:00:00Z`, 1)), offset).from,
  };
  const db = getDb();

  const byStatus = db
    .prepare(
      `SELECT a.status,
              COUNT(*) AS visits,
              COALESCE(SUM((strftime('%s', a.ends_at) - strftime('%s', a.starts_at)) / 60), 0) AS minutes,
              COALESCE(SUM((SELECT SUM(s.price_kopecks) FROM appointment_services s
                             WHERE s.appointment_id = a.id)), 0) AS kopecks
         FROM appointments a
        WHERE a.master_id = ? AND a.starts_at >= ? AND a.starts_at < ?
        GROUP BY a.status`,
    )
    .all(masterId, bounds.from, bounds.to);

  const pick = (status) => byStatus.find((row) => row.status === status)
    ?? { visits: 0, minutes: 0, kopecks: 0 };

  const completed = pick('completed');
  const booked = pick('booked');

  // Выручка по услугам — только по завершённым визитам и только
  // по снимкам цен. Название услуги берётся актуальное: переименование
  // это уточнение формулировки, а не новая услуга.
  const byService = db
    .prepare(
      `SELECT s.id, s.name,
              COUNT(*) AS visits,
              SUM(asv.price_kopecks) AS kopecks,
              SUM(asv.duration_min)  AS minutes
         FROM appointment_services asv
         JOIN appointments a ON a.id = asv.appointment_id
         JOIN services s     ON s.id = asv.service_id
        WHERE a.master_id = ? AND a.status = 'completed'
          AND a.starts_at >= ? AND a.starts_at < ?
        GROUP BY s.id, s.name
        ORDER BY kopecks DESC`,
    )
    .all(masterId, bounds.from, bounds.to);

  const scheduled = scheduledMinutes({ masterId, from, to, offset });

  return {
    range: { from, to },
    scheduled_minutes: scheduled,
    busy_minutes: completed.minutes,
    // Доля отработанного от запланированного. null, если график на период
    // пуст: делить на ноль нечестнее, чем честно сказать «неизвестно».
    utilization_percent: scheduled > 0 ? Math.round((completed.minutes / scheduled) * 1000) / 10 : null,
    completed: { visits: completed.visits, minutes: completed.minutes, revenue_kopecks: completed.kopecks },
    upcoming: { visits: booked.visits, minutes: booked.minutes, expected_kopecks: booked.kopecks },
    no_show: { visits: pick('no_show').visits, lost_kopecks: pick('no_show').kopecks },
    cancelled: { visits: pick('cancelled').visits },
    by_service: byService.map((row) => ({
      service_id: row.id,
      name: row.name,
      visits: row.visits,
      minutes: row.minutes,
      revenue_kopecks: row.kopecks,
    })),
  };
}

/** Текущий месяц по календарю студии — период по умолчанию. */
export function currentMonth(settings, moment) {
  const localToday = utcDate(addDays(moment, 0));
  const date = new Date(`${localToday}T00:00:00Z`);
  date.setUTCMinutes(date.getUTCMinutes() + settings.utc_offset_minutes);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  return { from: first, to: last };
}
