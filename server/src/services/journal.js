/**
 * Журнал действий и уведомления в кабинете.
 *
 * Две небольшие таблицы, которые пишутся из одних и тех же мест, поэтому
 * собраны в один файл. Обе записи делаются внутри той же транзакции,
 * что и само действие: уведомление об отмене без отмены — хуже, чем
 * отсутствие уведомления.
 */

/**
 * Журнал. Пишется на действия над чужими объектами: администратор отменил
 * запись клиента, изменил услугу, выключил мастера. Свои собственные
 * действия клиента в журнал не идут — журнал нужен, чтобы разобраться,
 * кто поменял чужое.
 */
export function writeAudit(db, { actorUserId, actorRole, action, entityType, entityId, details = null }) {
  db.prepare(
    `INSERT INTO audit_log(actor_user_id, actor_role, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    actorUserId,
    actorRole,
    action,
    entityType,
    entityId,
    details === null ? null : JSON.stringify(details),
  );
}

/** Уведомление внутри личного кабинета. За его пределы MVP ничего не отправляет. */
export function notify(db, { userId, kind, title, body, appointmentId = null }) {
  db.prepare(
    `INSERT INTO notifications(user_id, kind, title, body, appointment_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, kind, title, body, appointmentId);
}

/**
 * Аккаунт мастера по номеру карточки — кому слать уведомление.
 *
 * Может вернуть null: карточка заводится до того, как у мастера появляется
 * вход, и тогда уведомлять некого. Это нормальное состояние, а не ошибка.
 */
export function masterUserId(db, masterId) {
  return db.prepare('SELECT user_id FROM masters WHERE id = ?').get(masterId)?.user_id ?? null;
}

/**
 * Оповестить обе стороны визита.
 *
 * Клиент получает уведомление всегда — в том числе о собственном действии.
 * Список уведомлений для него не лента новостей, а история его визита:
 * «записались, перенесли, отменили» должно читаться целиком, без дыр
 * на тех шагах, которые он делал сам.
 *
 * Мастеру своё же действие не дублируется: он нажал «Отменить» и видит
 * результат на экране, а лишняя строка в кабинете обесценивает остальные.
 * Ему важны чужие действия с его расписанием — записался клиент,
 * администратор передвинул визит.
 */
export function notifyBothSides(db, { appointmentId, clientId, masterId, actorRole, client, master }) {
  if (client) notify(db, { userId: clientId, appointmentId, ...client });
  if (!master || actorRole === 'master') return;
  const userId = masterUserId(db, masterId);
  if (userId) notify(db, { userId, appointmentId, ...master });
}

/** Роль в журнале и в полях отмены: клиент называется client, а не user. */
export function actorRoleOf(user) {
  return user.role === 'user' ? 'client' : user.role;
}
