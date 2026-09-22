/**
 * Записи: создание, чтение, перенос, отмена.
 *
 * Здесь сосредоточены правила, за нарушение которых клиент получает 409
 * или 422, — лимит переносов, срок отмены, занятость времени. Ни одно
 * из них не живёт в коде числом: все приходят из settings.
 */
import { getDb, transaction } from '../db/connection.js';
import { conflict, forbidden, notFound, unprocessable } from '../lib/http-error.js';
import { has, pickPolicy } from '../lib/roles.js';
import { now, addMinutes, minutesBetween } from '../lib/time.js';
import { assertSlotFree, slotTakenError, findConflicts } from './availability.js';
import { isSlotConflict } from '../db/constraints.js';
import { loadHoldServices, findOwnedHold } from './holds.js';
import { findActiveServices } from './catalog.js';
import { writeAudit, notify, notifyBothSides, masterUserId } from './journal.js';

const APPOINTMENT_FIELDS = `a.id, a.client_id, a.master_id, a.starts_at, a.ends_at, a.status,
       a.cancelled_by_role, a.cancel_reason, a.cancelled_at, a.reschedule_count,
       a.master_chosen_by_client, a.created_by_role, a.client_note, a.admin_note,
       a.allow_overlap, a.created_at, a.updated_at`;

const APPOINTMENT_SQL = `
SELECT ${APPOINTMENT_FIELDS},
       COALESCE(m.display_name, mu.full_name) AS master_name,
       m.specialization AS master_specialization,
       cu.full_name AS client_name, cu.phone AS client_phone, cu.email AS client_email
  FROM appointments a
  JOIN masters m      ON m.id  = a.master_id
  LEFT JOIN users mu  ON mu.id = m.user_id
  JOIN users cu       ON cu.id = a.client_id
`;

/** Состав записи со снимками цены и длительности; название — актуальное из прайса. */
export function loadAppointmentServices(appointmentId) {
  return getDb()
    .prepare(
      `SELECT asv.service_id AS id, s.name, asv.duration_min, asv.price_kopecks, asv.position
         FROM appointment_services asv
         JOIN services s ON s.id = asv.service_id
        WHERE asv.appointment_id = ?
        ORDER BY asv.position`,
    )
    .all(appointmentId);
}

function findRow(appointmentId) {
  const row = getDb().prepare(`${APPOINTMENT_SQL} WHERE a.id = ?`).get(appointmentId);
  if (!row) throw notFound('Запись не найдена');
  return row;
}

/**
 * Запись, к которой у пользователя есть доступ. Третья проверка из трёх:
 * после «вошёл ли» и «есть ли роль» — «его ли это объект».
 *
 * Клиент видит только свои записи, и отбор идёт по идентификатору из сессии,
 * а не по параметру запроса. Чужая запись даёт 404, а не 403: по разнице
 * ответов можно было бы перебором выяснить, кто и когда записан.
 *
 * Роли складываются, а не выбирают одну ветку: доступ есть, если его даёт
 * хотя бы одна роль из списка. Мастер, записавшийся к коллеге, обязан
 * видеть и свой визит как клиент, и записи своего дня как мастер —
 * с проверкой «самой сильной роли» первое он бы потерял.
 */
export function findAccessible(appointmentId, user) {
  const row = findRow(appointmentId);

  // Администратор — все записи студии.
  if (has(user, 'admin')) return row;

  // Клиент — те, где клиент он сам.
  if (has(user, 'user') && row.client_id === user.id) return row;

  // Мастер — записи своего расписания.
  if (has(user, 'master')) {
    const master = getDb().prepare('SELECT id FROM masters WHERE user_id = ?').get(user.id);
    if (master && master.id === row.master_id) return row;
  }

  throw notFound('Запись не найдена');
}

/** Записи клиента. scope=upcoming — предстоящие, past — история, включая отменённые. */
export function listForClient(clientId, { scope = 'all', limit = 100 } = {}) {
  const moment = now();
  const condition =
    scope === 'upcoming'
      ? "AND a.status = 'booked' AND a.ends_at > :now"
      : scope === 'past'
        ? "AND (a.status <> 'booked' OR a.ends_at <= :now)"
        : '';
  return getDb()
    .prepare(
      `${APPOINTMENT_SQL} WHERE a.client_id = :client_id ${condition}
        ORDER BY CASE WHEN a.starts_at > :now THEN 0 ELSE 1 END, a.starts_at
        LIMIT :limit`,
    )
    .all({ client_id: clientId, now: moment, limit });
}

/** Все записи студии — экран A4. Фильтры необязательны, но сужают выборку в базе, а не в коде. */
export function listAll({ dateFrom = null, dateTo = null, status = null, masterId = null, clientId = null, limit = 200 } = {}) {
  return getDb()
    .prepare(
      `${APPOINTMENT_SQL}
        WHERE (:date_from IS NULL OR a.starts_at >= :date_from)
          AND (:date_to   IS NULL OR a.starts_at <  :date_to)
          AND (:status    IS NULL OR a.status = :status)
          AND (:master_id IS NULL OR a.master_id = :master_id)
          AND (:client_id IS NULL OR a.client_id = :client_id)
        ORDER BY a.starts_at
        LIMIT :limit`,
    )
    .all({
      date_from: dateFrom,
      date_to: dateTo,
      status,
      master_id: masterId,
      client_id: clientId,
      limit,
    });
}
// =====================================================================
// ЗАПИСЬ В ТАБЛИЦУ appointments
// =====================================================================
//
// Ниже ровно три функции, которые меняют таблицу записей:
// createAppointment, reschedule и cancel. Второго пути нет ни для одной
// из трёх ролей — ни клиентского, ни мастерского, ни администраторского.
//
// Различия между ролями вынесены в таблицы прав (CREATE_POLICY,
// RESCHEDULE_POLICY, CANCEL_POLICY). Роль влияет на то, откуда берутся
// данные и что разрешено, но не на то, каким кодом строка попадает в базу.
//
// Почему так. Раньше запись создавали две функции: клиентская через резерв
// и администраторская напрямую. Обе делали одно и то же — вставляли строку,
// раскладывали снимки услуг, ловили конфликт, слали уведомление, — и любая
// правка требовала одинаковых изменений в двух местах. Забыть второе место
// легко, а цена ошибки здесь — двойная запись или потерянное уведомление.
// Теперь INSERT INTO appointments в коде сервиса ровно один.

/**
 * Что каждая роль может при создании записи.
 *
 * `source` — откуда берутся мастер, время и услуги:
 *   'hold'   — только из резерва, который клиент держит на экране
 *              подтверждения; из запроса эти поля не читаются вообще;
 *   'direct' — прямо из запроса: администратор назначает время сам.
 *
 * `occupancyOnly` — как проверяется время. Клиент ходит по сетке свободных
 * слотов и обязан попасть в неё точно: шаг, рабочие часы мастера, часы
 * студии, минимальный срок до визита, горизонт календаря. Администратор
 * ничему из этого не подчиняется — он записывает пришедшего без записи
 * прямо сейчас и ставит визит на 14:37, если так сложилось; для него
 * проверяется только занятость.
 *
 * Мастер записей не создаёт. Это не упущение: по паспорту он работает
 * со своим расписанием и своими записями — закрывает время, отмечает
 * «Завершена» и «Не пришёл», отменяет и переносит. Клиентов в студию
 * записывают клиент и администратор, и схема закрепляет это ограничением
 * CHECK (created_by_role IN ('client', 'admin')): даже если бы этот код
 * пропустил мастера, база строку не приняла бы.
 */
const CREATE_POLICY = {
  user: {
    source: 'hold',
    occupancyOnly: false,
    createdByRole: 'client',
    mayBookOthers: false,
    mayOverlap: false,
    mayAdminNote: false,
  },
  master: {
    source: null,
    refusal: 'Мастер не записывает клиентов — запись создаёт клиент или администратор',
  },
  admin: {
    source: 'direct',
    occupancyOnly: true,
    createdByRole: 'admin',
    mayBookOthers: true,
    mayOverlap: true,
    mayAdminNote: true,
  },
};

/**
 * План записи: что именно ляжет в строку.
 *
 * Роли готовят его по-разному, дальше он одинаков для всех. Это и есть
 * место стыка: ниже по течению разницы между ролями уже нет.
 */
function planFromHold({ actor, input, policy }) {
  const hold = findOwnedHold(input.holdId, input.owner);
  if (hold.reschedule_of_id !== null) {
    throw forbidden('Этот резерв взят для переноса — подтвердите его на записи');
  }
  const services = loadHoldServices(hold.id);
  if (services.length === 0) {
    throw unprocessable('hold_without_services', 'В резерве нет услуг — начните выбор заново');
  }

  return {
    clientId: actor.id,
    masterId: hold.master_id,
    startsAt: hold.starts_at,
    endsAt: hold.ends_at,
    services,
    // Клиент выбирал мастера сам — на этом пути другого варианта нет.
    masterChosenByClient: 1,
    allowOverlap: false,
    createdByRole: policy.createdByRole,
    createdByUserId: actor.id,
    clientNote: input.clientNote,
    adminNote: null,
    occupancyOnly: policy.occupancyOnly,
    hold,
  };
}

function planDirect({ actor, input, policy }) {
  const db = getDb();

  const clientId = policy.mayBookOthers ? input.clientId : actor.id;
  const client = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(clientId);
  if (!client) throw unprocessable('client_not_found', 'Такого клиента нет');
  // Роль клиента должна быть в списке, а не быть единственной: мастер,
  // который ходит в свою же студию, записывается как обычный клиент.
  const clientRoles = db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(clientId).map((r) => r.role);
  if (!clientRoles.includes('user')) {
    throw unprocessable('not_a_client', 'У этого аккаунта нет роли клиента — записать его нельзя');
  }
  if (client.is_active !== 1) throw unprocessable('client_inactive', 'Аккаунт клиента отключён');

  const master = db.prepare('SELECT id FROM masters WHERE id = ? AND is_active = 1').get(input.masterId);
  if (!master) throw notFound('Мастер не найден');

  const services = findActiveServices(input.serviceIds);
  if (services.length !== input.serviceIds.length) {
    throw unprocessable('service_unavailable', 'Одна из выбранных услуг недоступна');
  }
  const cannotDo = input.serviceIds.filter(
    (serviceId) => !db.prepare('SELECT 1 FROM master_services WHERE master_id = ? AND service_id = ?')
      .get(input.masterId, serviceId),
  );
  if (cannotDo.length > 0) {
    throw unprocessable('master_cannot_do_service', 'Этот мастер не выполняет выбранные услуги', {
      service_ids: cannotDo,
    });
  }

  const duration = services.reduce((sum, service) => sum + service.duration_min, 0);

  return {
    clientId,
    masterId: input.masterId,
    startsAt: input.startsAt,
    endsAt: addMinutes(input.startsAt, duration),
    services,
    // Мастера подобрал не клиент, а тот, кто оформляет запись за него.
    masterChosenByClient: 0,
    // Признак наложения взвешивается здесь и только здесь: если роли он
    // не положен, значение из запроса не доезжает до плана. Проверка роли
    // не размазана по обработчикам — она в одном месте, в таблице прав.
    allowOverlap: policy.mayOverlap ? Boolean(input.allowOverlap) : false,
    createdByRole: policy.createdByRole,
    createdByUserId: actor.id,
    clientNote: input.clientNote,
    adminNote: policy.mayAdminNote ? input.adminNote : null,
    occupancyOnly: policy.occupancyOnly,
    hold: null,
  };
}

/**
 * Единственная функция создания записи — для всех ролей.
 *
 * Три рубежа защиты от двойной записи, и здесь видны все три:
 *
 *   1. Резерв в slot_holds — слот исчезает из выдачи у остальных
 *      ещё на этапе оформления, до всякой вставки. Работает на клиентском
 *      пути; администратор время назначает и ни с кем за него не спорит.
 *   2. Проверка занятости внутри транзакции BEGIN IMMEDIATE. Не
 *      перестраховка: между постановкой резерва и подтверждением
 *      администратор мог закрыть это время вручную.
 *   3. База: триггер trg_appointments_no_overlap_insert против пересечения
 *      интервалов и уникальный индекс ux_appointments_master_slot против
 *      совпадения минуты начала.
 *
 * Рубежи не дублируют друг друга, а закрывают разные окна. Между шагом 2
 * и вставкой остаётся зазор в доли секунды — его и закрывает база.
 * Обратно, одной базы мало: без шагов 1 и 2 клиент видел бы занятое время
 * в календаре и узнавал о конфликте только по отказу в последний момент.
 */
export function createAppointment({ actor, input, settings }) {
  // Из ролей выбирается самая сильная, которой создание разрешено:
  // администратор-мастер записывает как администратор, а мастер, который
  // записывается сам, — как клиент.
  const picked = pickPolicy(actor, CREATE_POLICY, (p) => p.source !== null);
  if (!picked) throw forbidden('Эта роль не может создавать записи');
  if (!picked.allowed) throw forbidden(picked.policy.refusal);
  const policy = picked.policy;

  const plan = policy.source === 'hold'
    ? planFromHold({ actor, input, policy })
    : planDirect({ actor, input, policy });

  return transaction((db) => {
    // Шаг 2. Наложение — единственный случай, когда проверку пропускают
    // сознательно; право на это уже взвешено в плане.
    if (!plan.allowOverlap) {
      const duration = minutesBetween(plan.startsAt, plan.endsAt);
      if (plan.occupancyOnly) {
        const conflicts = findConflicts({
          masterId: plan.masterId,
          startsAt: plan.startsAt,
          endsAt: plan.endsAt,
        });
        if (conflicts.any) {
          throw slotTakenError({ masterId: plan.masterId, startsAt: plan.startsAt, totalMinutes: duration, settings });
        }
      } else {
        assertSlotFree({
          masterId: plan.masterId,
          starts_at: plan.startsAt,
          totalMinutes: duration,
          settings,
          excludeHoldId: plan.hold?.id ?? null,
        });
      }
    }

    let inserted;
    try {
      inserted = db
        .prepare(
          `INSERT INTO appointments(client_id, master_id, starts_at, ends_at, status,
                                    master_chosen_by_client, allow_overlap,
                                    created_by_role, created_by_user_id, client_note, admin_note)
           VALUES (:client_id, :master_id, :starts_at, :ends_at, 'booked',
                   :master_chosen, :allow_overlap, :created_by_role, :created_by, :client_note, :admin_note)`,
        )
        .run({
          client_id: plan.clientId,
          master_id: plan.masterId,
          starts_at: plan.startsAt,
          ends_at: plan.endsAt,
          master_chosen: plan.masterChosenByClient,
          allow_overlap: plan.allowOverlap ? 1 : 0,
          created_by_role: plan.createdByRole,
          created_by: plan.createdByUserId,
          client_note: plan.clientNote,
          admin_note: plan.adminNote,
        });
    } catch (error) {
      // Сработал третий рубеж: триггер против пересечения интервалов
      // или уникальный индекс. Значит, гонку мы проиграли — слот заняли
      // в те же доли секунды, между проверкой и вставкой. Сюда же
      // попадает наложение, упёршееся в запрет двух одинаковых записей
      // одному клиенту к одному мастеру.
      //
      // Клиенту уходит 409 с человеческим объяснением и ближайшими
      // свободными слотами. Текст ошибки SQLite наружу не показывается:
      // в нём имя триггера и внутренности схемы.
      if (isSlotConflict(error)) {
        throw slotTakenError({
          masterId: plan.masterId,
          startsAt: plan.startsAt,
          totalMinutes: minutesBetween(plan.startsAt, plan.endsAt),
          settings,
          excludeHoldId: plan.hold?.id ?? null,
        });
      }
      throw error;
    }

    const appointmentId = Number(inserted.lastInsertRowid);
    const addService = db.prepare(
      `INSERT INTO appointment_services(appointment_id, service_id, position, duration_min, price_kopecks)
       VALUES (?, ?, ?, ?, ?)`,
    );
    plan.services.forEach((service, index) => {
      addService.run(appointmentId, service.id, index, service.duration_min, service.price_kopecks);
    });

    // Резерв не удаляется, а помечается использованным и гасится: по нему
    // видно, из какого резерва выросла запись, и он перестаёт занимать время.
    if (plan.hold) {
      db.prepare('UPDATE slot_holds SET appointment_id = ?, expires_at = ? WHERE id = ?')
        .run(appointmentId, now(), plan.hold.id);
    }

    const byClient = plan.createdByRole === 'client';

    // Клиент получает квитанцию всегда, даже если записался сам.
    notify(db, {
      userId: plan.clientId,
      kind: 'booking_created',
      title: byClient ? 'Запись подтверждена' : 'Вас записали',
      body: byClient
        ? 'Вы записаны. Детали визита — в личном кабинете.'
        : 'Администратор оформил запись. Детали визита — в личном кабинете.',
      appointmentId,
    });

    // Мастеру — новость: у него в расписании появился визит.
    const masterUser = masterUserId(db, plan.masterId);
    if (masterUser) {
      notify(db, {
        userId: masterUser,
        kind: 'booking_created',
        title: 'Новая запись',
        body: 'В вашем расписании появился визит. Подробности — в кабинете.',
        appointmentId,
      });
    }

    // В журнал идут действия над чужими записями. Своя запись клиента —
    // не чужая, поэтому на клиентском пути журнал молчит.
    if (!byClient) {
      writeAudit(db, {
        actorUserId: actor.id,
        actorRole: plan.createdByRole,
        action: 'create',
        entityType: 'appointment',
        entityId: appointmentId,
        details: {
          client_id: plan.clientId,
          master_id: plan.masterId,
          starts_at: plan.startsAt,
          allow_overlap: plan.allowOverlap,
        },
      });
    }

    return appointmentId;
  });
}

/** Сколько часов осталось до визита — по нему считается право на отмену и перенос. */
function hoursUntil(startsAt, moment = now()) {
  return minutesBetween(moment, startsAt) / 60;
}

/**
 * Права клиента над своей записью.
 *
 * Считаются в одном месте и уходят в ответ вместе с записью: фронтенд
 * рисует по ним кнопки и не повторяет правила у себя. Скрытая кнопка
 * при этом защитой не считается — сервер проверяет всё заново.
 */
export function clientAbilities(row, settings, moment = now()) {
  const inTime = hoursUntil(row.starts_at, moment) >= settings.cancel_deadline_hours;
  const active = row.status === 'booked';
  return {
    can_cancel: active && inTime,
    can_reschedule: active && inTime && row.reschedule_count < settings.max_client_reschedules,
    reschedules_left: Math.max(0, settings.max_client_reschedules - row.reschedule_count),
    cancel_deadline_hours: settings.cancel_deadline_hours,
  };
}

/**
 * Что каждая роль может при переносе и отмене.
 *
 * Все три роли ходят через одни и те же две функции; различаются только
 * значения в этих таблицах. Раньше роли разбирались условиями внутри
 * функций, и мастер просто не был предусмотрен — он получал отказ там,
 * где по паспорту имеет право действовать.
 *
 * `deadline` — обязан ли уложиться в срок отмены. У клиента это правило
 *   студии: не позднее чем за cancel_deadline_hours. Мастер и
 *   администратор работают с чужим визитом и по другим основаниям —
 *   мастер заболел, студия закрылась, — поэтому срок на них не действует.
 * `reason` — обязательна ли причина. Мастер и администратор трогают чужую
 *   запись, и клиент должен увидеть в кабинете не просто «отменено».
 * `countsAgainstLimit` — увеличивает ли перенос счётчик клиента. Лимит
 *   в три переноса — ограничение для клиента, а не для студии: перенос,
 *   сделанный мастером или администратором, его не расходует.
 */
const CHANGE_POLICY = {
  user:   { deadline: true,  reason: false, countsAgainstLimit: true,  actorRole: 'client' },
  master: { deadline: false, reason: true,  countsAgainstLimit: false, actorRole: 'master' },
  admin:  { deadline: false, reason: true,  countsAgainstLimit: false, actorRole: 'admin'  },
};

/**
 * Общая часть переноса и отмены: кто действует и вправе ли он.
 *
 * Доступ к самой записи проверен раньше, в findAccessible: клиент видит
 * свои записи, мастер — записи своего дня, администратор — все. Здесь
 * проверяется уже не «видно ли», а «можно ли менять».
 */
function authorizeChange({ appointment, actor, reason, settings, action }) {
  const picked = pickPolicy(actor, CHANGE_POLICY);
  if (!picked) throw forbidden('Эта роль не может менять записи');
  const policy = picked.policy;

  if (appointment.status !== 'booked') {
    throw conflict('appointment_not_active', 'Запись уже завершена или отменена');
  }
  if (policy.deadline && hoursUntil(appointment.starts_at) < settings.cancel_deadline_hours) {
    throw unprocessable(
      'deadline_passed',
      `${action} можно не позднее чем за ${settings.cancel_deadline_hours} ч до визита — позвоните администратору`,
    );
  }
  if (policy.reason && !reason) {
    throw unprocessable('reason_required', `Укажите причину: ${action.toLowerCase()} чужую запись без объяснения нельзя`);
  }
  return policy;
}

/**
 * Перенос: меняется время той же записи, новая не создаётся.
 *
 * Иначе история клиента распалась бы на цепочку записей-призраков, а лимит
 * переносов пришлось бы считать обходом по ссылкам.
 */
export function reschedule({ appointment, hold, actor, reason = null, settings }) {
  const policy = authorizeChange({ appointment, actor, reason, settings, action: 'Перенести запись' });

  if (policy.countsAgainstLimit && appointment.reschedule_count >= settings.max_client_reschedules) {
    throw unprocessable(
      'reschedule_limit_reached',
      `Запись можно переносить не более ${settings.max_client_reschedules} раз`,
    );
  }
  if (hold.reschedule_of_id !== appointment.id) {
    throw conflict('hold_mismatch', 'Резерв взят не для этой записи');
  }
  if (hold.master_id !== appointment.master_id) {
    throw unprocessable('master_mismatch', 'Перенос возможен только к тому же мастеру');
  }

  // Длительность визита при переносе не меняется — она снимок, а не прайс.
  // Возьми её из текущих цен, и подорожавшая услуга молча раздвинула бы
  // визит, наехав на следующего клиента.
  const duration = minutesBetween(appointment.starts_at, appointment.ends_at);

  return transaction((db) => {
    assertSlotFree({
      masterId: appointment.master_id,
      starts_at: hold.starts_at,
      totalMinutes: duration,
      settings,
      excludeHoldId: hold.id,
      excludeAppointmentId: appointment.id,
    });

    // Перенос сбрасывает allow_overlap в 0. Разрешение на наложение
    // давалось под конкретное время: администратор знал, кого и в какой
    // слот он ставит вторым. На новом времени это решение не действует,
    // и запись обязана пройти проверку заново.
    //
    // Третий рубеж и здесь: перенос ловит trg_appointments_no_overlap_update.
    try {
      db.prepare(
        `UPDATE appointments
            SET starts_at = :starts_at, ends_at = :ends_at,
                reschedule_count = reschedule_count + :increment,
                allow_overlap = 0,
                updated_at = :now
          WHERE id = :id AND status = 'booked'`,
      ).run({
        starts_at: hold.starts_at,
        ends_at: addMinutes(hold.starts_at, duration),
        increment: policy.countsAgainstLimit ? 1 : 0,
        now: now(),
        id: appointment.id,
      });
    } catch (error) {
      if (isSlotConflict(error)) {
        throw slotTakenError({
          masterId: appointment.master_id,
          startsAt: hold.starts_at,
          totalMinutes: duration,
          settings,
          excludeHoldId: hold.id,
          excludeAppointmentId: appointment.id,
        });
      }
      throw error;
    }

    db.prepare('UPDATE slot_holds SET appointment_id = ?, expires_at = ? WHERE id = ?')
      .run(appointment.id, now(), hold.id);

    notifyBothSides(db, {
      appointmentId: appointment.id,
      clientId: appointment.client_id,
      masterId: appointment.master_id,
      actorRole: policy.actorRole,
      client: {
        kind: 'booking_rescheduled',
        title: 'Запись перенесена',
        body: reason
          ? `Время визита изменилось. Причина: ${reason}`
          : 'Время визита изменилось. Новое время — в личном кабинете.',
      },
      master: {
        kind: 'booking_rescheduled',
        title: 'Визит перенесён',
        body: 'Время визита в вашем расписании изменилось.',
      },
    });

    if (policy.actorRole !== 'client') {
      writeAudit(db, {
        actorUserId: actor.id,
        actorRole: policy.actorRole,
        action: 'reschedule',
        entityType: 'appointment',
        entityId: appointment.id,
        details: { from: appointment.starts_at, to: hold.starts_at, reason },
      });
    }
  });
}

/**
 * Кто отмечает исход визита.
 *
 * Клиента здесь нет, и это не забывчивость. «Завершена» и «Не пришёл» —
 * свидетельство студии о том, что произошло, а не мнение клиента о своём
 * визите. Дай клиенту эту кнопку, и любой желающий закроет себе
 * неудобный визит как состоявшийся, а вместе с ним и выручку в отчёте.
 * По паспорту исход отмечают мастер (экран M2) и администратор (A4).
 */
const STATUS_POLICY = {
  master: { actorRole: 'master' },
  admin: { actorRole: 'admin' },
};

/** Чем может закончиться визит. Отмена сюда не входит — у неё свой путь. */
export const OUTCOME_STATUSES = ['completed', 'no_show'];

/**
 * Отметить исход визита: «Завершена» или «Не пришёл».
 *
 * Отдельная функция, а не параметр отмены, хотя обе меняют status.
 * У отмены свои поля (кто отменил, когда, почему) и свои правила
 * (срок, обязательная причина), а у исхода — свои. Общего между ними
 * только имя колонки, и объединять их значило бы получить функцию,
 * половина аргументов которой в каждом вызове лишняя.
 *
 * Исправление ошибки разрешено: мастер промахнулся кнопкой и поставил
 * «Не пришёл» вместо «Завершена» — он же это и чинит. А вот отменённую
 * запись этим путём не воскресить: возврат из отмены — другое решение,
 * с другими последствиями (время могли занять), и делаться оно должно
 * осознанно, а не переключателем статуса.
 */
export function setStatus({ appointment, actor, status, note }) {
  const picked = pickPolicy(actor, STATUS_POLICY);
  if (!picked) throw forbidden('Исход визита отмечает мастер или администратор');
  const policy = picked.policy;

  if (appointment.status === 'cancelled') {
    throw conflict('appointment_cancelled', 'Запись отменена — исход визита у неё не отмечают');
  }

  // Повторное нажатие не ошибка: кнопку могли нажать дважды.
  if (appointment.status === status) {
    return { changed: false, status };
  }

  // Визит, который ещё не начался, не может ни состояться, ни не состояться.
  // Правило действует и на администратора: «изменить статус задним числом»
  // из паспорта — это про прошедшие визиты, а не про будущие.
  if (appointment.starts_at > now()) {
    throw unprocessable(
      'visit_not_started',
      'Визит ещё не начался — исход можно отметить не раньше его начала',
    );
  }

  return transaction((db) => {
    db.prepare(
      `UPDATE appointments SET status = :status, updated_at = :now
        WHERE id = :id AND status <> 'cancelled'`,
    ).run({ status, now: now(), id: appointment.id });

    writeAudit(db, {
      actorUserId: actor.id,
      actorRole: policy.actorRole,
      action: 'status_change',
      entityType: 'appointment',
      entityId: appointment.id,
      details: { from: appointment.status, to: status, note },
    });

    return { changed: true, status, from: appointment.status };
  });
}

/**
 * Отмена.
 *
 * Запись не удаляется: меняется статус, проставляется, кто и когда отменил,
 * и она остаётся в истории клиента. Время освобождается само — при
 * следующем расчёте отменённой записи в занятых просто не окажется.
 */
export function cancel({ appointment, actor, reason, settings }) {
  const policy = authorizeChange({ appointment, actor, reason, settings, action: 'Отменить запись' });

  return transaction((db) => {
    db.prepare(
      `UPDATE appointments
          SET status = 'cancelled', cancelled_at = :now, cancelled_by_role = :role,
              cancelled_by_user_id = :actor, cancel_reason = :reason, updated_at = :now
        WHERE id = :id AND status = 'booked'`,
    ).run({
      now: now(),
      role: policy.actorRole,
      actor: actor.id,
      reason,
      id: appointment.id,
    });

    // Резерв переноса, взятый под эту запись, больше не нужен — время назад.
    db.prepare('DELETE FROM slot_holds WHERE reschedule_of_id = ? AND appointment_id IS NULL')
      .run(appointment.id);

    notifyBothSides(db, {
      appointmentId: appointment.id,
      clientId: appointment.client_id,
      masterId: appointment.master_id,
      actorRole: policy.actorRole,
      client: {
        kind: 'booking_cancelled',
        title: 'Запись отменена',
        body: reason ? `Причина: ${reason}` : 'Запись отменена. Время снова свободно.',
      },
      master: {
        kind: 'booking_cancelled',
        title: 'Визит отменён',
        body: reason ? `Визит отменён. Причина: ${reason}` : 'Визит отменён — время снова свободно.',
      },
    });

    if (policy.actorRole !== 'client') {
      writeAudit(db, {
        actorUserId: actor.id,
        actorRole: policy.actorRole,
        action: 'cancel',
        entityType: 'appointment',
        entityId: appointment.id,
        details: { reason },
      });
    }
  });
}
