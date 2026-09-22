/**
 * Резервы слота.
 *
 * Слот закрепляется за клиентом на hold_minutes с момента выбора времени —
 * ровно столько, сколько занимает оформление. Резерв живёт отдельно
 * от записи, потому что на шаге B4 клиент может быть ещё не авторизован:
 * он держится на токене браузера, а не на аккаунте.
 *
 * Истечение не требует ни таймера, ни фоновой задачи: при расчёте
 * свободного времени учитываются только резервы с expires_at > now,
 * а строки истёкших удаляет sweepExpiredHolds при следующем расчёте.
 */
import { getDb, transaction } from '../db/connection.js';
import { conflict, forbidden, notFound, unprocessable } from '../lib/http-error.js';
import { now, addMinutes, minutesBetween } from '../lib/time.js';
import { findActiveServices } from './catalog.js';
import { assertSlotFree, sweepExpiredHolds } from './availability.js';

const HOLD_FIELDS = `id, master_id, client_id, session_token_hash, starts_at, ends_at,
                     expires_at, appointment_id, reschedule_of_id, created_at`;

/** Состав резерва — снимок цен и длительностей на момент выбора услуг. */
export function loadHoldServices(holdId) {
  return getDb()
    .prepare(
      `SELECT hs.service_id AS id, s.name, hs.duration_min, hs.price_kopecks, hs.position
         FROM slot_hold_services hs
         JOIN services s ON s.id = hs.service_id
        WHERE hs.hold_id = ?
        ORDER BY hs.position`,
    )
    .all(holdId);
}

/**
 * Резерв, который ещё не истёк и принадлежит этому браузеру или аккаунту.
 *
 * Проверка идёт по двум признакам сразу: гостю принадлежит резерв
 * с его токеном, вошедшему — резерв с его client_id. Владелец подставляется
 * из сессии, а не берётся из тела запроса: иначе чужой резерв можно было бы
 * довести до записи, зная только его номер.
 */
export function findOwnedHold(holdId, owner) {
  const hold = getDb().prepare(`SELECT ${HOLD_FIELDS} FROM slot_holds WHERE id = ?`).get(holdId);
  if (!hold) throw notFound('Резерв не найден или уже истёк');

  const mine =
    (owner.userId !== null && hold.client_id === owner.userId) ||
    (hold.client_id === null && hold.session_token_hash === owner.tokenHash);
  if (!mine) throw forbidden('Этот резерв принадлежит другому посетителю');

  if (hold.appointment_id !== null) {
    throw conflict('hold_already_used', 'По этому резерву уже создана запись');
  }
  if (hold.expires_at <= now()) {
    throw conflict('hold_expired', 'Время удержания истекло — выберите слот заново');
  }
  return hold;
}

/**
 * Создаёт резерв.
 *
 * Три проверки в одной транзакции: услуги существуют и активны, мастер их
 * выполняет, слот свободен. Транзакция открыта как BEGIN IMMEDIATE — между
 * проверкой и вставкой никто не успеет занять то же время.
 */
export function createHold({
  masterId,
  startsAt,
  serviceIds,
  owner,
  settings,
  rescheduleOf = null,
}) {
  const services = findActiveServices(serviceIds);
  if (services.length !== serviceIds.length) {
    throw unprocessable('service_unavailable', 'Одна из выбранных услуг больше не доступна');
  }

  const master = getDb()
    .prepare('SELECT id FROM masters WHERE id = ? AND is_active = 1')
    .get(masterId);
  if (!master) throw notFound('Мастер не найден');

  const cannotDo = serviceIds.filter(
    (serviceId) =>
      !getDb()
        .prepare('SELECT 1 FROM master_services WHERE master_id = ? AND service_id = ?')
        .get(masterId, serviceId),
  );
  if (cannotDo.length > 0) {
    throw unprocessable('master_cannot_do_service', 'Этот мастер не выполняет выбранные услуги', {
      service_ids: cannotDo,
    });
  }

  // При переносе длительность обязана прийти из снимка записи, а не из прайса:
  // если услуга успела подорожать и удлиниться, перенос не должен молча
  // раздвинуть визит и наехать на следующего клиента.
  const totalMinutes =
    rescheduleOf !== null
      ? minutesBetween(rescheduleOf.starts_at, rescheduleOf.ends_at)
      : services.reduce((sum, service) => sum + service.duration_min, 0);

  return transaction((db) => {
    assertSlotFree({
      masterId,
      starts_at: startsAt,
      totalMinutes,
      settings,
      excludeAppointmentId: rescheduleOf?.id ?? null,
    });

    const expiresAt = addMinutes(now(), settings.hold_minutes);
    const inserted = db
      .prepare(
        `INSERT INTO slot_holds(session_token_hash, client_id, master_id, starts_at, ends_at,
                                expires_at, reschedule_of_id)
         VALUES (:token, :client_id, :master_id, :starts_at, :ends_at, :expires_at, :reschedule_of)`,
      )
      .run({
        token: owner.tokenHash,
        client_id: owner.userId,
        master_id: masterId,
        starts_at: startsAt,
        ends_at: addMinutes(startsAt, totalMinutes),
        expires_at: expiresAt,
        reschedule_of: rescheduleOf?.id ?? null,
      });

    const holdId = Number(inserted.lastInsertRowid);
    const addService = db.prepare(
      `INSERT INTO slot_hold_services(hold_id, service_id, position, duration_min, price_kopecks)
       VALUES (?, ?, ?, ?, ?)`,
    );
    services.forEach((service, index) => {
      addService.run(holdId, service.id, index, service.duration_min, service.price_kopecks);
    });

    return db.prepare(`SELECT ${HOLD_FIELDS} FROM slot_holds WHERE id = ?`).get(holdId);
  });
}

/** Снятие резерва: клиент ушёл с экрана подтверждения — время освобождается сразу. */
export function releaseHold(holdId, owner) {
  const hold = findOwnedHold(holdId, owner);
  getDb().prepare('DELETE FROM slot_holds WHERE id = ?').run(hold.id);
}

/**
 * Привязывает резервы гостя к вошедшему аккаунту.
 *
 * Вызывается сразу после входа и регистрации: по карте связей резерв,
 * взятый до авторизации, обязан пережить шаг входа, иначе клиент
 * возвращается на экран подтверждения с потерянным временем.
 */
export function attachHoldsToUser(guestTokenHash, userId) {
  if (!guestTokenHash) return 0;
  sweepExpiredHolds();
  return getDb()
    .prepare(
      `UPDATE slot_holds SET client_id = ?
        WHERE session_token_hash = ? AND client_id IS NULL
          AND appointment_id IS NULL AND expires_at > ?`,
    )
    .run(userId, guestTokenHash, now()).changes;
}

/** Сколько секунд осталось на таймере экрана подтверждения. */
export function secondsLeft(hold, moment = now()) {
  return Math.max(0, Math.round((new Date(hold.expires_at) - new Date(moment)) / 1000));
}
