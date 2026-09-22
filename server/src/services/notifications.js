/**
 * Чтение уведомлений личного кабинета — экран K4.
 *
 * Писать их сервис умел с самого начала: запись, отмена, перенос и смена
 * пароля кладут строку в notifications. Прочитать их было нечем — то есть
 * единственный канал, который паспорт вообще разрешает («уведомления
 * приходят только внутри личного кабинета»), был подключён наполовину.
 *
 * Здесь только чтение и отметка о прочтении. Создаются уведомления там,
 * где происходит событие, — в journal.js, внутри той же транзакции, что
 * и само действие: уведомление об отмене без отмены хуже, чем его отсутствие.
 */
import { getDb, transaction } from '../db/connection.js';
import { notFound } from '../lib/http-error.js';
import { now } from '../lib/time.js';

/**
 * Список уведомлений пользователя.
 *
 * Выборка идёт по идентификатору из сессии, а не по параметру запроса:
 * если фильтровать по присланному номеру, рано или поздно кто-то подставит
 * чужой. Поэтому userId сюда приходит из опознанной сессии и ниоткуда больше.
 *
 * Листание курсором по убывающему id, а не через OFFSET: пока человек
 * читает список, сверху приходят новые уведомления, и вторая страница
 * с OFFSET показала бы часть первой заново.
 */
export function listNotifications(userId, { onlyUnread = false, limit = 30, beforeId = null } = {}) {
  return getDb()
    .prepare(
      `SELECT n.id, n.kind, n.title, n.body, n.is_read, n.created_at, n.read_at,
              n.appointment_id,
              a.starts_at AS appointment_starts_at,
              a.status    AS appointment_status
         FROM notifications n
         LEFT JOIN appointments a ON a.id = n.appointment_id
        WHERE n.user_id = :user_id
          AND (:only_unread = 0 OR n.is_read = 0)
          AND (:before_id IS NULL OR n.id < :before_id)
        ORDER BY n.id DESC
        LIMIT :limit`,
    )
    .all({
      user_id: userId,
      only_unread: onlyUnread ? 1 : 0,
      before_id: beforeId,
      limit,
    });
}

/**
 * Сколько непрочитанных.
 *
 * Отдельным запросом и отдельным эндпоинтом: значок в шапке нужен
 * на каждом экране, и тянуть ради него весь список — лишняя работа.
 * Индекс ix_notifications_user (user_id, is_read, created_at DESC)
 * закрывает этот счёт целиком.
 */
export function unreadCount(userId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(userId).count;
}

/**
 * Отметить одно уведомление прочитанным.
 *
 * Чужое уведомление отвечает 404, а не 403: по разнице ответов можно было бы
 * перебором выяснить, сколько их у другого человека и когда они приходят.
 *
 * Повторная отметка не ошибка: пользователь мог нажать дважды, а вкладка —
 * отправить запрос ещё раз. Уже прочитанное просто остаётся прочитанным,
 * и read_at не переписывается — это момент первого прочтения.
 */
export function markRead(userId, notificationId) {
  return transaction((db) => {
    const row = db
      .prepare('SELECT id, is_read FROM notifications WHERE id = ? AND user_id = ?')
      .get(notificationId, userId);
    if (!row) throw notFound('Уведомление не найдено');

    if (row.is_read === 0) {
      db.prepare('UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ?')
        .run(now(), notificationId);
    }
    return { id: notificationId, unread: unreadCount(userId) };
  });
}

/** Отметить прочитанными все. Возвращает, сколько строк это затронуло. */
export function markAllRead(userId) {
  return transaction((db) => {
    const changed = db
      .prepare('UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0')
      .run(now(), userId).changes;
    return { marked: changed, unread: 0 };
  });
}
