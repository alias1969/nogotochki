/**
 * Графики мастеров: недельное расписание и отклонения от него.
 *
 * До этого модуля расписание попадало в базу только командой npm run seed —
 * то есть в живой студии сервис нельзя было запустить вообще: расчёт
 * свободного времени целиком опирается на master_schedules, а завести их
 * администратору было нечем.
 *
 * Две таблицы делят работу так:
 *   master_schedules    — постоянный недельный график: «по вторникам
 *                         с 10:00 до 20:00», время суток местное;
 *   schedule_exceptions — разовые отклонения: отпуск, выходной, закрытое
 *                         время и дополнительная смена, моментами в UTC.
 *
 * Свободное время из них не хранится, а вычисляется — см. availability.js.
 * Поэтому здесь нет ни одной строки, которая «пересобирала бы слоты»
 * после правки графика: следующий же расчёт увидит новые данные сам.
 */
import { getDb, transaction } from '../db/connection.js';
import { forbidden, notFound, unprocessable } from '../lib/http-error.js';
import { now, addDays, utcDate, localDate, localDayBounds, weekdayOf, toLocalParts } from '../lib/time.js';
import { writeAudit } from './journal.js';
import { ROLES, has, pickPolicy } from '../lib/roles.js';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/** Отклонения, которые убирают время. Дополнительная смена, наоборот, добавляет. */
const SUBTRACTIVE_KINDS = new Set(['vacation', 'day_off', 'time_block']);

function assertMaster(db, masterId) {
  const master = db.prepare('SELECT id FROM masters WHERE id = ?').get(masterId);
  if (!master) throw notFound('Мастер не найден');
  return master;
}

/**
 * Недельный график и отклонения мастера.
 *
 * Возвращает и историю тоже: строки с истёкшим valid_to никуда не деваются,
 * потому что по ним считалось свободное время в прошлом, и понять задним
 * числом, почему визит оказался возможен, можно только по ним.
 */
export function loadSchedule(masterId, { from = null, to = null, settings }) {
  const db = getDb();
  assertMaster(db, masterId);

  const today = localDate(now(), settings.utc_offset_minutes);
  const rangeFrom = from ?? today;
  const rangeTo = to ?? utcDate(addDays(`${rangeFrom}T00:00:00Z`, settings.booking_horizon_days));

  const weekly = db
    .prepare(
      `SELECT id, weekday, work_start, work_end, valid_from, valid_to, created_at
         FROM master_schedules
        WHERE master_id = ?
        ORDER BY valid_from DESC, weekday, work_start`,
    )
    .all(masterId);

  const bounds = localDayBounds(rangeFrom, settings.utc_offset_minutes);
  const exceptions = db
    .prepare(
      `SELECT id, kind, starts_at, ends_at, reason, created_at
         FROM schedule_exceptions
        WHERE master_id = :master_id
          AND ends_at > :from AND starts_at < :to
        ORDER BY starts_at`,
    )
    .all({
      master_id: masterId,
      from: bounds.from,
      to: localDayBounds(utcDate(addDays(`${rangeTo}T00:00:00Z`, 1)), settings.utc_offset_minutes).from,
    });

  return {
    weekly,
    exceptions,
    range: { from: rangeFrom, to: rangeTo },
    /** Действующие на сегодня строки — то, по чему считается календарь прямо сейчас. */
    current: weekly.filter((row) => row.valid_from <= today && (row.valid_to === null || row.valid_to >= today)),
  };
}

/**
 * Проверка недельного набора до обращения к базе.
 *
 * Интервалы одного дня не должны пересекаться: «10:00–14:00 и 13:00–16:00»
 * — это почти наверняка опечатка, а не намерение. В расчёте такая пара
 * дала бы дублирующиеся точки старта, и мастер увидел бы в календаре
 * одно и то же время дважды.
 */
function normalizeDays(days) {
  const byWeekday = new Map();

  for (const day of days) {
    const intervals = byWeekday.get(day.weekday) ?? [];
    intervals.push({ start: day.work_start, end: day.work_end });
    byWeekday.set(day.weekday, intervals);
  }

  for (const [weekday, intervals] of byWeekday) {
    intervals.sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < intervals.length; i += 1) {
      if (intervals[i].start < intervals[i - 1].end) {
        throw unprocessable('overlapping_intervals', 'Интервалы одного дня пересекаются', {
          weekday,
          intervals: [intervals[i - 1], intervals[i]],
        });
      }
    }
  }
  return byWeekday;
}

/**
 * Дни недели, в которые студия закрыта: график на них бессмысленен.
 *
 * Расчёт свободного времени пересекает график мастера с часами студии,
 * поэтому такая строка молча не дала бы ни одного слота. Лучше сказать
 * администратору сразу, чем оставить его гадать, почему вторник пустой.
 */
function closedWeekdays(db) {
  return new Set(
    db.prepare('SELECT weekday FROM studio_hours WHERE is_closed = 1').all().map((row) => row.weekday),
  );
}

/**
 * Записи, которые не попадают в новый недельный график.
 *
 * Сузили график — и визиты, назначенные на убранные часы, повисли снаружи.
 * Сервис их не отменяет: это решение администратора, а не программы.
 * Но и молчать нельзя, поэтому они возвращаются в ответе.
 *
 * Сверка идёт по недельной сетке в местном времени — по тому самому,
 * что администратор только что задал. Отпуска и часы студии здесь не
 * учитываются: вопрос ровно один — «попадает ли визит в новый график».
 */
function appointmentsOutside({ db, masterId, byWeekday, validFrom, settings }) {
  const bounds = localDayBounds(validFrom, settings.utc_offset_minutes);
  const rows = db
    .prepare(
      `SELECT a.id, a.starts_at, a.ends_at, u.full_name AS client_name
         FROM appointments a
         JOIN users u ON u.id = a.client_id
        WHERE a.master_id = ? AND a.status = 'booked' AND a.starts_at >= ?
        ORDER BY a.starts_at`,
    )
    .all(masterId, bounds.from);

  const offset = settings.utc_offset_minutes;
  return rows.filter((row) => {
    const start = toLocalParts(row.starts_at, offset);
    const end = toLocalParts(row.ends_at, offset);

    // Визит, переходящий местную полночь, в недельную сетку не укладывается
    // по определению: она задана внутри суток.
    if (end.date !== start.date) return true;

    const intervals = byWeekday.get(weekdayOf(start.date)) ?? [];
    return !intervals.some(
      (interval) => interval.start <= start.time && interval.end >= end.time,
    );
  });
}

/**
 * Задать недельный график мастера целиком, начиная с даты.
 *
 * Набор задаётся целиком, а не по одной строке: экран графика — это сетка
 * «понедельник … воскресенье», он присылает состояние, а не разницу.
 * Правка по одной строке потребовала бы эндпоинтов «добавить интервал»
 * и «убрать интервал» и давала бы полурасписание, если второй запрос
 * не дошёл.
 *
 * Прошлое не переписывается. Действующие строки не удаляются, а
 * закрываются датой valid_to = valid_from − 1 день. По ним считалось
 * свободное время в прошлом, и они объясняют, почему визит на прошлой
 * неделе вообще был возможен. Новый график приходит следующей версией.
 */
export function replaceWeeklySchedule({ admin, masterId, validFrom, days, settings }) {
  const byWeekday = normalizeDays(days);

  return transaction((db) => {
    assertMaster(db, masterId);

    const today = localDate(now(), settings.utc_offset_minutes);
    if (validFrom < today) {
      throw unprocessable(
        'valid_from_in_past',
        'График вводится с сегодняшнего дня или позже: задним числом свободное время не пересчитывают',
      );
    }

    const closed = closedWeekdays(db);
    const useless = [...byWeekday.keys()].filter((weekday) => closed.has(weekday));
    if (useless.length > 0) {
      throw unprocessable('studio_closed', 'В эти дни студия закрыта — график на них не даст ни одного слота', {
        weekdays: useless,
      });
    }

    const stranded = appointmentsOutside({ db, masterId, byWeekday, validFrom, settings });

    // Будущие версии графика, ещё не вступившие в силу, заменяются целиком.
    db.prepare('DELETE FROM master_schedules WHERE master_id = ? AND valid_from >= ?').run(masterId, validFrom);

    // Действующие — закрываются накануне новой даты.
    db.prepare(
      `UPDATE master_schedules
          SET valid_to = date(:valid_from, '-1 day')
        WHERE master_id = :master_id
          AND valid_from < :valid_from
          AND (valid_to IS NULL OR valid_to >= :valid_from)`,
    ).run({ master_id: masterId, valid_from: validFrom });

    const insert = db.prepare(
      `INSERT INTO master_schedules(master_id, weekday, work_start, work_end, valid_from)
       VALUES (?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const weekday of WEEKDAYS) {
      for (const interval of byWeekday.get(weekday) ?? []) {
        insert.run(masterId, weekday, interval.start, interval.end, validFrom);
        inserted += 1;
      }
    }

    writeAudit(db, {
      actorUserId: admin.id,
      actorRole: 'admin',
      action: 'update',
      entityType: 'master_schedule',
      entityId: masterId,
      details: {
        valid_from: validFrom,
        intervals: inserted,
        stranded_appointments: stranded.map((row) => row.id),
      },
    });

    return { inserted, stranded };
  });
}

/**
 * Кто какие отклонения заводит.
 *
 * Мастер закрывает только своё время и только видом `time_block` —
 * «занят, не записывайте». Отпуск и выходной он не ставит сам:
 * по паспорту он их *предлагает*, а утверждает администратор
 * (см. schedule_change_requests). Разница не формальная: отпуск сдвигает
 * работу студии и её загрузку, а закрытый час — нет.
 *
 * Дополнительную смену мастер себе тоже не выписывает: вывести человека
 * на работу вне графика — решение студии, а не самого человека.
 */
const EXCEPTION_POLICY = {
  master: { kinds: ['time_block'], ownOnly: true, actorRole: 'master' },
  admin: {
    kinds: ['vacation', 'day_off', 'time_block', 'extra_shift'],
    ownOnly: false,
    actorRole: 'admin',
  },
};

/**
 * Разрешённые человеку виды отклонений — нужно и обработчику для проверки.
 *
 * Объединение по всем его ролям: мастер-администратор вправе и закрыть
 * себе время, и назначить отпуск, хотя по отдельности это права разных ролей.
 */
export function allowedExceptionKinds(user) {
  const kinds = new Set();
  for (const role of ROLES) {
    if (!has(user, role)) continue;
    for (const kind of EXCEPTION_POLICY[role]?.kinds ?? []) kinds.add(kind);
  }
  return [...kinds];
}

function authorizeException({ actor, masterId, kind }) {
  // Самая сильная роль, которой разрешён именно этот вид отклонения:
  // мастер-администратор закрывает себе время как мастер, а отпуск
  // назначает как администратор — и в последнем случае ownOnly не мешает.
  const picked = pickPolicy(actor, EXCEPTION_POLICY, (p) => p.kinds.includes(kind));
  if (!picked) throw forbidden('Эта роль не меняет графики');
  const policy = picked.policy;
  if (!policy.kinds.includes(kind)) {
    throw forbidden(
      kind === 'vacation' || kind === 'day_off'
        ? 'Отпуск и выходной назначает администратор — отправьте заявку на изменение графика'
        : 'Этот вид отклонения вам недоступен',
    );
  }
  if (policy.ownOnly) {
    const own = getDb().prepare('SELECT id FROM masters WHERE user_id = ?').get(actor.id);
    // 404, а не 403: по разнице ответов мастер выяснял бы, какие карточки
    // вообще существуют. Чужой график для него просто не существует.
    if (!own || own.id !== masterId) throw notFound('Мастер не найден');
  }
  return policy;
}

/**
 * Отклонение от графика: отпуск, выходной, закрытое время, доп. смена.
 *
 * Время приходит уже приведённым к UTC — перевод из местных дат делает
 * обработчик, потому что «отпуск с 1 по 10 июля» и «закрыть время
 * с 14:00 до 15:30» — это два разных способа описать интервал,
 * и разбирать их правильнее там, где разбирается остальной запрос.
 */
export function createException({ actor, masterId, kind, startsAt, endsAt, reason }) {
  const policy = authorizeException({ actor, masterId, kind });

  if (endsAt <= startsAt) {
    throw unprocessable('invalid_range', 'Конец интервала должен быть позже начала');
  }

  return transaction((db) => {
    assertMaster(db, masterId);

    // Записи, попавшие под отпуск или закрытое время. Сервис их не трогает —
    // решает человек. Но молчать нельзя, поэтому они уходят в ответе.
    const affected = SUBTRACTIVE_KINDS.has(kind)
      ? db
          .prepare(
            `SELECT a.id, a.starts_at, a.ends_at, u.full_name AS client_name
               FROM appointments a
               JOIN users u ON u.id = a.client_id
              WHERE a.master_id = ? AND a.status = 'booked'
                AND a.starts_at < ? AND a.ends_at > ?
              ORDER BY a.starts_at`,
          )
          .all(masterId, endsAt, startsAt)
      : [];

    const inserted = db
      .prepare(
        `INSERT INTO schedule_exceptions(master_id, kind, starts_at, ends_at, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(masterId, kind, startsAt, endsAt, reason, actor.id);

    const id = Number(inserted.lastInsertRowid);
    writeAudit(db, {
      actorUserId: actor.id,
      actorRole: policy.actorRole,
      action: 'create',
      entityType: 'schedule_exception',
      entityId: id,
      details: { master_id: masterId, kind, starts_at: startsAt, ends_at: endsAt, affected: affected.map((r) => r.id) },
    });

    return { id, affected };
  });
}

/**
 * Снять отклонение.
 *
 * Удаление, а не флаг: отклонение — разовая пометка на календаре,
 * а не справочник, на который кто-то ссылается. Отменённый отпуск
 * не нужно хранить, и время возвращается в свободные само — при
 * следующем расчёте его просто не окажется среди вычитаемых.
 *
 * Мастер снимает только то, что сам же и поставил. Закрытое время,
 * назначенное администратором, он не трогает: раз студия закрыла этот
 * час, отменять решение должна студия.
 */
export function deleteException({ actor, exceptionId }) {
  return transaction((db) => {
    const row = db
      .prepare('SELECT id, master_id, kind, created_by FROM schedule_exceptions WHERE id = ?')
      .get(exceptionId);
    if (!row) throw notFound('Отклонение не найдено');

    const policy = authorizeException({ actor, masterId: row.master_id, kind: row.kind });
    if (policy.ownOnly && row.created_by !== actor.id) {
      throw forbidden('Это время закрыл администратор — снять его может только он');
    }

    db.prepare('DELETE FROM schedule_exceptions WHERE id = ?').run(exceptionId);
    writeAudit(db, {
      actorUserId: actor.id,
      actorRole: policy.actorRole,
      action: 'update',
      entityType: 'schedule_exception',
      entityId: exceptionId,
      details: { removed: true, master_id: row.master_id, kind: row.kind },
    });
    return row;
  });
}
