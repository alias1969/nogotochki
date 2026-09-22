/**
 * Заявки мастеров на изменение графика.
 *
 * Мастер предлагает (экран M3), администратор утверждает или отклоняет (A7).
 *
 * Заявка сам график **не меняет** — это прямо оговорено в схеме, раздел 4.8.
 * Утверждение означает «согласен», а не «применено»: дальше администратор
 * правит master_schedules или заводит отклонение обычным путём. Так и должно
 * быть — из фразы «хочу по средам начинать позже» автоматически не следует
 * ни одна конкретная строка графика, а угадывать её за человека опасно:
 * ошибка тут стоит потерянных визитов.
 *
 * Поэтому здесь нет ни одной строки, которая трогала бы расписание.
 * Это переписка, привязанная к мастеру, с фиксированным исходом.
 */
import { getDb, transaction } from '../db/connection.js';
import { conflict, notFound } from '../lib/http-error.js';
import { now } from '../lib/time.js';
import { notify, writeAudit } from './journal.js';

const REQUEST_SQL = `
SELECT r.id, r.master_id, r.message, r.desired_from, r.desired_to, r.status,
       r.admin_comment, r.reviewed_at, r.created_at,
       COALESCE(m.display_name, mu.full_name) AS master_name
  FROM schedule_change_requests r
  JOIN masters m     ON m.id = r.master_id
  LEFT JOIN users mu ON mu.id = m.user_id
`;

/** Кому уходит уведомление о новой заявке: всем действующим администраторам. */
function activeAdmins(db) {
  return db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1").all();
}

/**
 * Создать заявку.
 *
 * Дат может не быть вовсе: «прошу поставить меня на субботы» — тоже
 * заявка. Схема поэтому и держит desired_from/desired_to необязательными,
 * а обязательным — только текст.
 */
export function createRequest({ master, actor, message, desiredFrom, desiredTo }) {
  return transaction((db) => {
    const inserted = db
      .prepare(
        `INSERT INTO schedule_change_requests(master_id, message, desired_from, desired_to)
         VALUES (?, ?, ?, ?)`,
      )
      .run(master.id, message, desiredFrom, desiredTo);

    const id = Number(inserted.lastInsertRowid);

    // Уведомление каждому администратору: заявка, которую никто не увидел,
    // — это не заявка. Канал тот же, что у всего остального в MVP, —
    // личный кабинет.
    for (const admin of activeAdmins(db)) {
      notify(db, {
        userId: admin.id,
        kind: 'schedule_request_created',
        title: 'Заявка на изменение графика',
        body: `${master.name}: ${message}`,
      });
    }

    writeAudit(db, {
      actorUserId: actor.id,
      actorRole: 'master',
      action: 'create',
      entityType: 'schedule_change_request',
      entityId: id,
      details: { master_id: master.id, desired_from: desiredFrom, desired_to: desiredTo },
    });

    return id;
  });
}

export function findRequest(requestId) {
  const row = getDb().prepare(`${REQUEST_SQL} WHERE r.id = ?`).get(requestId);
  if (!row) throw notFound('Заявка не найдена');
  return row;
}

/** Заявки мастера — экран M3. */
export function listForMaster(masterId, { status = null, limit = 100 } = {}) {
  return getDb()
    .prepare(
      `${REQUEST_SQL} WHERE r.master_id = :master_id
        AND (:status IS NULL OR r.status = :status)
        ORDER BY r.created_at DESC LIMIT :limit`,
    )
    .all({ master_id: masterId, status, limit });
}

/** Все заявки — экран A7. По умолчанию сверху те, что ждут ответа. */
export function listAll({ status = null, masterId = null, limit = 200 } = {}) {
  return getDb()
    .prepare(
      `${REQUEST_SQL}
        WHERE (:status IS NULL OR r.status = :status)
          AND (:master_id IS NULL OR r.master_id = :master_id)
        ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC
        LIMIT :limit`,
    )
    .all({ status, master_id: masterId, limit });
}

/**
 * Ответ администратора.
 *
 * Повторно рассмотреть уже рассмотренную заявку нельзя: решение принято,
 * мастер его увидел. Передумали — это новая заявка, а не правка старой,
 * иначе в кабинете мастера «утверждено» однажды превратилось бы
 * в «отклонено» без следа о том, что там было раньше.
 */
export function reviewRequest({ request, admin, decision, comment }) {
  if (request.status !== 'pending') {
    throw conflict('request_already_reviewed', 'Заявка уже рассмотрена');
  }

  return transaction((db) => {
    db.prepare(
      `UPDATE schedule_change_requests
          SET status = :status, admin_comment = :comment,
              reviewed_by = :admin, reviewed_at = :now
        WHERE id = :id AND status = 'pending'`,
    ).run({ status: decision, comment, admin: admin.id, now: now(), id: request.id });

    const masterUser = db
      .prepare('SELECT user_id FROM masters WHERE id = ?')
      .get(request.master_id)?.user_id;

    // Карточка мастера может быть не привязана к аккаунту — тогда
    // уведомлять некого, и это не ошибка.
    if (masterUser) {
      notify(db, {
        userId: masterUser,
        kind: 'schedule_request_reviewed',
        title: decision === 'approved' ? 'Заявка утверждена' : 'Заявка отклонена',
        body: comment ?? (decision === 'approved'
          ? 'Администратор согласовал изменение графика.'
          : 'Администратор отклонил изменение графика.'),
      });
    }

    writeAudit(db, {
      actorUserId: admin.id,
      actorRole: 'admin',
      action: 'update',
      entityType: 'schedule_change_request',
      entityId: request.id,
      details: { decision, comment },
    });
  });
}
