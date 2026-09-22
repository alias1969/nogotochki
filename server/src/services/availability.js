/**
 * Расчёт свободного времени мастера.
 *
 * Таблицы заранее нарезанных слотов в схеме нет — и не должно быть.
 * Свободное время собирается в момент запроса из шести источников:
 * график мастера, часы студии, закрытия студии, отклонения графика,
 * действующие записи и живые резервы. Порядок расчёта и опорный запрос
 * описаны в docs/db-schema.md, раздел 5.
 *
 * Ключевая мысль: «свободен» — свойство пары «время + длительность»,
 * а не времени самого по себе. Точка 10:00 свободна для маникюра на час
 * и занята для комплекса на три. Поэтому расчёт всегда получает на вход
 * суммарную длительность выбранных услуг T.
 */
import { getDb } from '../db/connection.js';
import { conflict, unprocessable } from '../lib/http-error.js';
import { now, addMinutes, addDays, localDate, utcDate, toLocalParts } from '../lib/time.js';

/**
 * Опорный запрос из документа схемы.
 *
 * Считается целиком в SQLite, а не в JavaScript: все шесть источников
 * лежат в базе, и вытаскивать их в память, чтобы вычесть интервалы руками,
 * означало бы переписать на JS то, что движок уже умеет.
 *
 * Границы рабочего интервала берутся за сутки в обе стороны от местной даты:
 * смена по местному календарю в UTC может начаться «вчера» или кончиться «завтра».
 */
const SLOTS_SQL = `
WITH RECURSIVE
q AS (SELECT :master_id AS master_id, :day AS day, :total_min AS total_min, :now AS now),
cfg AS (SELECT :off_min AS off_min, :step AS step, :buf AS buf),

-- шаги 0-2: график мастера, пересечённый с часами студии, плюс дополнительные смены
work AS (
  SELECT strftime('%Y-%m-%dT%H:%M:%SZ',
           datetime(q.day||'T'||max(ms.work_start,sh.open_time)||':00',
                    (-c.off_min)||' minutes')) AS w_start,
         strftime('%Y-%m-%dT%H:%M:%SZ',
           datetime(q.day||'T'||min(ms.work_end,sh.close_time)||':00',
                    (-c.off_min)||' minutes')) AS w_end
  FROM q, cfg c
  JOIN masters m           ON m.id = q.master_id AND m.is_active = 1
  JOIN master_schedules ms ON ms.master_id = q.master_id
       AND ms.weekday = ((CAST(strftime('%w', q.day) AS INTEGER) + 6) % 7) + 1
       AND q.day >= ms.valid_from
       AND (ms.valid_to IS NULL OR q.day <= ms.valid_to)
  JOIN studio_hours sh     ON sh.weekday = ms.weekday AND sh.is_closed = 0
  WHERE max(ms.work_start, sh.open_time) < min(ms.work_end, sh.close_time)
    AND NOT EXISTS (SELECT 1 FROM studio_closures sc
                    WHERE q.day BETWEEN sc.date_from AND sc.date_to)
  UNION ALL
  -- дополнительная смена уже хранится моментами UTC, переводить нечего
  SELECT e.starts_at, e.ends_at
  FROM q JOIN schedule_exceptions e
    ON e.master_id = q.master_id AND e.kind = 'extra_shift'
   AND e.starts_at < :day_end AND e.ends_at > :day_start
),

-- шаг 5: сетка шагом slot_step_minutes от начала каждого рабочего интервала
grid(t) AS (
  SELECT w_start FROM work
  UNION
  SELECT strftime('%Y-%m-%dT%H:%M:%SZ',
                  datetime(g.t, '+'||(SELECT step FROM cfg)||' minutes'))
  FROM grid g WHERE g.t < (SELECT max(w_end) FROM work)
),
cand AS (
  SELECT g.t AS starts_at,
    strftime('%Y-%m-%dT%H:%M:%SZ', datetime(g.t,'+'||q.total_min||' minutes'))          AS ends_at,
    strftime('%Y-%m-%dT%H:%M:%SZ', datetime(g.t,'+'||(q.total_min+c.buf)||' minutes'))  AS busy_until
  FROM grid g, q, cfg c
)

SELECT cand.starts_at, cand.ends_at
FROM cand, q
WHERE EXISTS (SELECT 1 FROM work w                              -- помещается в рабочее время
              WHERE cand.starts_at >= w.w_start AND cand.ends_at <= w.w_end)
  AND NOT EXISTS (SELECT 1 FROM schedule_exceptions e           -- шаг 3: отпуск, выходной, блок
        WHERE e.master_id = q.master_id AND e.kind <> 'extra_shift'
          AND e.starts_at < cand.busy_until AND e.ends_at > cand.starts_at)
  AND NOT EXISTS (SELECT 1 FROM appointments a                  -- шаг 4: действующие записи
        WHERE a.master_id = q.master_id AND a.status = 'booked'
          AND a.id IS NOT :exclude_appointment_id
          AND a.starts_at < cand.busy_until AND a.ends_at > cand.starts_at)
  AND NOT EXISTS (SELECT 1 FROM slot_holds h                    -- шаг 4: живые резервы
        WHERE h.master_id = q.master_id AND h.expires_at > q.now
          AND h.id IS NOT :exclude_hold_id
          AND h.starts_at < cand.busy_until AND h.ends_at > cand.starts_at)
  AND cand.starts_at >= :not_before                             -- шаг 7: не раньше срока
  AND cand.starts_at <  :not_after                              -- шаг 7: не дальше горизонта
ORDER BY cand.starts_at;
`;

/**
 * Удаляет истёкшие резервы.
 *
 * Время освобождается и без уборки — при расчёте учитываются только резервы
 * с expires_at > now. Уборка нужна, чтобы таблица не росла бесконечно,
 * и вызывается на входе в расчёт: там, где резервы и так читаются.
 * Резерв, ставший записью, не трогаем — по нему видно, как запись появилась.
 */
export function sweepExpiredHolds() {
  return getDb()
    .prepare('DELETE FROM slot_holds WHERE expires_at <= ? AND appointment_id IS NULL')
    .run(now()).changes;
}

/**
 * Проверяет горизонт записи и возвращает границы, в которые обязан попасть слот.
 *
 * Обе границы считаются от «сейчас», а не от начала суток: правило
 * «записаться не позже чем за два часа» должно работать и в день визита.
 */
export function bookingWindow(settings, moment = now()) {
  return {
    notBefore: addMinutes(moment, settings.min_lead_time_minutes),
    notAfter: addDays(moment, settings.booking_horizon_days),
  };
}

/**
 * Свободные точки старта мастера на местную дату студии.
 *
 * excludeHoldId и excludeAppointmentId нужны, чтобы собственный резерв
 * или переносимая запись не загораживали клиенту его же время: на экране
 * подтверждения и при переносе он должен видеть то время, которое держит сам.
 */
export function findFreeSlots({
  masterId,
  date,
  totalMinutes,
  settings,
  excludeHoldId = null,
  excludeAppointmentId = null,
  moment = now(),
}) {
  sweepExpiredHolds();

  const window = bookingWindow(settings, moment);
  if (date > localDate(window.notAfter, settings.utc_offset_minutes)) {
    throw unprocessable(
      'outside_booking_horizon',
      `Календарь открыт на ${settings.booking_horizon_days} дней вперёд`,
    );
  }

  // Сутки по местному календарю студии, выраженные в UTC, плюс запас
  // на смену, которая пересекает полночь по Гринвичу.
  const dayStart = addDays(`${date}T00:00:00Z`, -1);
  const dayEnd = addDays(`${date}T00:00:00Z`, 2);

  return getDb()
    .prepare(SLOTS_SQL)
    .all({
      master_id: masterId,
      day: date,
      total_min: totalMinutes,
      now: moment,
      off_min: settings.utc_offset_minutes,
      step: settings.slot_step_minutes,
      buf: settings.buffer_after_minutes,
      day_start: dayStart,
      day_end: dayEnd,
      not_before: window.notBefore,
      not_after: window.notAfter,
      exclude_hold_id: excludeHoldId,
      exclude_appointment_id: excludeAppointmentId,
    })
    // Сетка строится от начала смены и может уйти за местную полночь,
    // если смена мастера заканчивается уже в следующих сутках UTC.
    .filter((slot) => localDate(slot.starts_at, settings.utc_offset_minutes) === date);
}

/**
 * Что именно мешает занять интервал: чужие визиты и живые резервы.
 *
 * Отличается от findFreeSlots тем, что не знает ни про сетку шагом
 * slot_step_minutes, ни про график мастера, ни про срок «не раньше чем
 * за два часа». Это нужно ручной записи администратором: он ставит
 * клиента на 14:37, если так сложилось, и записывает пришедшего
 * без записи прямо сейчас. Единственное, о чём его стоит предупредить,
 * — что время уже занято; всё остальное он решает сам.
 */
export function findConflicts({ masterId, startsAt, endsAt, excludeAppointmentId = null, moment = now() }) {
  sweepExpiredHolds();
  const db = getDb();

  const appointments = db
    .prepare(
      `SELECT id, starts_at, ends_at FROM appointments
        WHERE master_id = :master_id AND status = 'booked'
          AND id IS NOT :exclude
          AND starts_at < :ends_at AND ends_at > :starts_at
        ORDER BY starts_at`,
    )
    .all({
      master_id: masterId,
      exclude: excludeAppointmentId,
      starts_at: startsAt,
      ends_at: endsAt,
    });

  const holds = db
    .prepare(
      `SELECT id, starts_at, ends_at FROM slot_holds
        WHERE master_id = :master_id AND expires_at > :now
          AND appointment_id IS NULL
          AND starts_at < :ends_at AND ends_at > :starts_at
        ORDER BY starts_at`,
    )
    .all({ master_id: masterId, now: moment, starts_at: startsAt, ends_at: endsAt });

  return { appointments, holds, any: appointments.length > 0 || holds.length > 0 };
}

/**
 * Слот в том виде, в каком он уходит наружу.
 *
 * Живёт здесь, а не в представлениях, потому что нужен двоим: обычному
 * ответу со свободным временем и телу ошибки 409, которая рождается
 * глубоко внутри сервисов и до представлений не доходит.
 */
export function describeSlot(row, settings) {
  return {
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    local_time: toLocalParts(row.starts_at, settings.utc_offset_minutes).time,
  };
}

/** Насколько далеко дней вперёд искать замену занятому времени. */
const SUGGEST_DAYS = 7;

/**
 * Ближайшие свободные слоты этого мастера — то, что клиент видит вместо
 * отказа «время занято».
 *
 * Ближайшие считаются по расстоянию от того времени, которое клиент
 * пытался занять, в обе стороны: если его 15:00 увели, 14:45 подходит
 * ему лучше, чем 19:00, хотя хронологически оно раньше. Сначала
 * набираются кандидаты по дням вперёд, потом отбираются ближайшие,
 * а в ответ уходят уже по возрастанию времени — списком, а не вразнобой.
 */
export function suggestFreeSlots({
  masterId,
  startsAt,
  totalMinutes,
  settings,
  limit = 5,
  excludeHoldId = null,
  excludeAppointmentId = null,
  moment = now(),
}) {
  const candidates = [];
  let day = localDate(startsAt, settings.utc_offset_minutes);
  const horizon = localDate(
    addDays(moment, settings.booking_horizon_days),
    settings.utc_offset_minutes,
  );

  for (let index = 0; index < SUGGEST_DAYS && candidates.length < limit; index += 1) {
    if (day > horizon) break;
    try {
      candidates.push(
        ...findFreeSlots({
          masterId,
          date: day,
          totalMinutes,
          settings,
          excludeHoldId,
          excludeAppointmentId,
          moment,
        }),
      );
    } catch {
      // Подсказка — это любезность, а не обязанность: если конкретный день
      // посчитать не вышло, клиент всё равно должен получить понятный 409,
      // а не вторую ошибку поверх первой.
    }
    day = utcDate(addDays(`${day}T00:00:00Z`, 1));
  }

  const target = new Date(startsAt).getTime();
  return candidates
    .sort((a, b) => Math.abs(new Date(a.starts_at) - target) - Math.abs(new Date(b.starts_at) - target))
    .slice(0, limit)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .map((slot) => describeSlot(slot, settings));
}

/**
 * Ошибка «время занято» с готовой заменой.
 *
 * Собрана одной функцией, потому что этот ответ рождается в трёх разных
 * местах — при постановке резерва, при создании записи и при переносе —
 * и клиент во всех трёх случаях должен получить одно и то же: код 409,
 * человеческое объяснение и список того, что ещё свободно.
 */
export function slotTakenError(options) {
  return conflict('slot_taken', 'Это время уже занято — выберите другое', {
    master_id: options.masterId,
    free_slots: suggestFreeSlots(options),
  });
}

/**
 * Свободен ли конкретный момент под длительность totalMinutes.
 *
 * Вызывается дважды: при постановке резерва и ещё раз внутри транзакции
 * создания записи. Второй раз — не перестраховка: между резервом
 * и подтверждением администратор мог закрыть время вручную.
 */
export function assertSlotFree(options) {
  const { starts_at: startsAt, settings } = options;
  const date = localDate(startsAt, settings.utc_offset_minutes);
  const free = findFreeSlots({ ...options, date });
  if (!free.some((slot) => slot.starts_at === startsAt)) {
    throw slotTakenError({ ...options, startsAt });
  }
}

/** Даты местного календаря, в которых у мастера есть хотя бы один слот. */
export function findFreeDays({ masterId, from, to, totalMinutes, settings, moment = now() }) {
  const days = [];
  let cursor = from;
  while (cursor <= to) {
    const slots = findFreeSlots({ masterId, date: cursor, totalMinutes, settings, moment });
    if (slots.length > 0) days.push({ date: cursor, slots_count: slots.length });
    cursor = utcDate(addDays(`${cursor}T00:00:00Z`, 1));
  }
  return days;
}
