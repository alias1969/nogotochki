/**
 * Часы работы студии и разовые нерабочие дни.
 *
 * Обе таблицы участвуют в расчёте свободного времени с первого дня,
 * но задать их до сих пор было нечем: часы приезжали из наполнения
 * тестовыми данными, а нерабочих дней не было вовсе.
 *
 * Разделение труда со схемой: studio_hours — постоянная рамка
 * («по воскресеньям закрыто»), studio_closures — разовые исключения
 * («2 января санитарный день»). Закрытие студии отдельной таблицей,
 * а не отпуском каждому мастеру, — решение 7.18: иначе при найме
 * нового мастера пришлось бы вручную повторять ему все прошлые праздники.
 */
import { getDb, transaction } from '../db/connection.js';
import { notFound, unprocessable } from '../lib/http-error.js';
import { now, localDayBounds, addDays, utcDate } from '../lib/time.js';
import { writeAudit } from './journal.js';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

export function loadStudioHours() {
  return getDb()
    .prepare('SELECT weekday, is_closed, open_time, close_time FROM studio_hours ORDER BY weekday')
    .all();
}

/**
 * Записи, которые окажутся вне новых часов студии.
 *
 * Как и при сужении графика мастера — сервис их не отменяет, но
 * возвращает списком. Проверяются только будущие: прошлое уже случилось,
 * и менять его оценку задним числом бессмысленно.
 */
function appointmentsOutsideHours(db, hours, offset) {
  const byWeekday = new Map(hours.map((row) => [row.weekday, row]));
  const rows = db
    .prepare(
      `SELECT a.id, a.starts_at, a.ends_at, u.full_name AS client_name
         FROM appointments a
         JOIN users u ON u.id = a.client_id
        WHERE a.status = 'booked' AND a.starts_at > ?
        ORDER BY a.starts_at`,
    )
    .all(now());

  return rows.filter((row) => {
    const local = new Date(new Date(row.starts_at).getTime() + offset * 60_000);
    const localEnd = new Date(new Date(row.ends_at).getTime() + offset * 60_000);
    const weekday = ((local.getUTCDay() + 6) % 7) + 1;
    const day = byWeekday.get(weekday);
    if (!day || day.is_closed === 1) return true;

    const time = (date) => date.toISOString().slice(11, 16);
    return time(local) < day.open_time || time(localEnd) > day.close_time;
  });
}

/**
 * Задать часы работы студии — все семь дней сразу.
 *
 * Именно все семь, а не выборочно. Отсутствующая строка в studio_hours
 * означает не «круглосуточно», а «расчёт не найдёт рабочих интервалов»:
 * день молча выпадет из календаря, и никто не поймёт, почему у мастера
 * по средам нет записей. Схема прямо предупреждает об этом в разделе 5.
 */
export function replaceStudioHours({ admin, days, settings }) {
  const seen = new Set(days.map((day) => day.weekday));
  const missing = WEEKDAYS.filter((weekday) => !seen.has(weekday));
  if (missing.length > 0 || seen.size !== days.length) {
    throw unprocessable('incomplete_week', 'Нужны все семь дней недели, по одному разу', {
      missing,
    });
  }

  return transaction((db) => {
    const stranded = appointmentsOutsideHours(db, days, settings.utc_offset_minutes);

    const write = db.prepare(
      `INSERT INTO studio_hours(weekday, is_closed, open_time, close_time)
       VALUES (:weekday, :is_closed, :open_time, :close_time)
       ON CONFLICT(weekday) DO UPDATE SET
         is_closed = excluded.is_closed,
         open_time = excluded.open_time,
         close_time = excluded.close_time`,
    );
    for (const day of days) {
      write.run({
        weekday: day.weekday,
        is_closed: day.is_closed ? 1 : 0,
        open_time: day.is_closed ? null : day.open_time,
        close_time: day.is_closed ? null : day.close_time,
      });
    }

    writeAudit(db, {
      actorUserId: admin.id,
      actorRole: 'admin',
      action: 'update',
      entityType: 'settings',
      entityId: 0,
      details: { studio_hours: days, stranded: stranded.map((row) => row.id) },
    });

    return { stranded };
  });
}

/** Разовые нерабочие дни: праздники, санитарный день. */
export function listClosures({ from = null, limit = 200 } = {}) {
  return getDb()
    .prepare(
      `SELECT c.id, c.date_from, c.date_to, c.reason, c.created_at,
              u.full_name AS created_by_name
         FROM studio_closures c
         LEFT JOIN users u ON u.id = c.created_by
        WHERE (:from IS NULL OR c.date_to >= :from)
        ORDER BY c.date_from
        LIMIT :limit`,
    )
    .all({ from, limit });
}

export function createClosure({ admin, dateFrom, dateTo, reason, settings }) {
  if (dateTo < dateFrom) throw unprocessable('invalid_range', 'Конец периода раньше начала');

  return transaction((db) => {
    const bounds = {
      from: localDayBounds(dateFrom, settings.utc_offset_minutes).from,
      to: localDayBounds(utcDate(addDays(`${dateTo}T00:00:00Z`, 1)), settings.utc_offset_minutes).from,
    };

    // Студия закрывается — а визиты на эти дни уже назначены.
    // Отменять их за администратора сервис не станет, но и промолчать нельзя.
    const affected = db
      .prepare(
        `SELECT a.id, a.starts_at, a.ends_at, u.full_name AS client_name
           FROM appointments a
           JOIN users u ON u.id = a.client_id
          WHERE a.status = 'booked' AND a.starts_at >= ? AND a.starts_at < ?
          ORDER BY a.starts_at`,
      )
      .all(bounds.from, bounds.to);

    const inserted = db
      .prepare(
        `INSERT INTO studio_closures(date_from, date_to, reason, created_by)
         VALUES (?, ?, ?, ?)`,
      )
      .run(dateFrom, dateTo, reason, admin.id);

    const id = Number(inserted.lastInsertRowid);
    writeAudit(db, {
      actorUserId: admin.id,
      actorRole: 'admin',
      action: 'create',
      entityType: 'settings',
      entityId: id,
      details: { closure: { date_from: dateFrom, date_to: dateTo, reason }, affected: affected.map((r) => r.id) },
    });

    return { id, affected };
  });
}

/** Снять закрытие — время возвращается в свободные само. */
export function deleteClosure({ admin, closureId }) {
  return transaction((db) => {
    const row = db.prepare('SELECT id, date_from, date_to FROM studio_closures WHERE id = ?').get(closureId);
    if (!row) throw notFound('Закрытие не найдено');

    db.prepare('DELETE FROM studio_closures WHERE id = ?').run(closureId);
    writeAudit(db, {
      actorUserId: admin.id,
      actorRole: 'admin',
      action: 'update',
      entityType: 'settings',
      entityId: closureId,
      details: { removed_closure: { date_from: row.date_from, date_to: row.date_to } },
    });
    return row;
  });
}
