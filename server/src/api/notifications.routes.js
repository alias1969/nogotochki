/**
 * Уведомления личного кабинета — экран K4.
 *
 * Доступны любой вошедшей роли: уведомления приходят и клиенту (запись
 * создана, отменена, перенесена), и любому аккаунту при смене пароля.
 * Каждый видит только свои — выборка идёт по идентификатору из сессии.
 */
import * as v from '../lib/validate.js';
import * as views from './views.js';
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
} from '../services/notifications.js';

export function registerNotificationRoutes(router) {
  /**
   * GET /api/notifications — свои уведомления.
   *
   * Параметры: `unread=true` — только непрочитанные, `limit` (до 100)
   * и `before_id` для листания. Листание курсором, а не страницами:
   * пока человек читает список, сверху приходят новые, и вторая страница
   * с отступом показала бы часть первой заново.
   *
   * Рядом со списком идёт `unread` — счётчик для значка в шапке, чтобы
   * открытие экрана не требовало второго запроса.
   */
  router.get('/api/notifications', async (ctx) => {
    const user = ctx.requireUser();
    const limit = ctx.query.limit ? v.integer(ctx.query.limit, 'limit', { min: 1, max: 100 }) : 30;
    const beforeId = ctx.query.before_id ? v.id(ctx.query.before_id, 'before_id') : null;
    const onlyUnread = ctx.query.unread ? v.boolean(ctx.query.unread, 'unread') : false;

    const rows = listNotifications(user.id, { onlyUnread, limit, beforeId });
    return ctx.json(200, {
      notifications: rows.map((row) => views.notification(row, ctx.settings)),
      unread: unreadCount(user.id),
      // Следующая страница берётся с этим before_id. null — список кончился.
      next_before_id: rows.length === limit ? rows[rows.length - 1].id : null,
    });
  });

  /**
   * GET /api/notifications/unread-count — только счётчик.
   *
   * Значок в шапке нужен на каждом экране, и тянуть ради него весь
   * список — лишняя работа. Один индексированный COUNT.
   */
  router.get('/api/notifications/unread-count', async (ctx) => {
    const user = ctx.requireUser();
    return ctx.json(200, { unread: unreadCount(user.id) });
  });

  /**
   * POST /api/notifications/:id/read — отметить прочитанным.
   *
   * Повторная отметка не ошибка: `read_at` остаётся моментом первого
   * прочтения и не переписывается. Чужое уведомление отвечает 404.
   */
  router.post('/api/notifications/:id/read', async (ctx) => {
    const user = ctx.requireUser();
    const result = markRead(user.id, v.id(ctx.params.id, 'id'));
    return ctx.json(200, { ok: true, ...result });
  });

  /** POST /api/notifications/read-all — отметить прочитанными все. */
  router.post('/api/notifications/read-all', async (ctx) => {
    const user = ctx.requireUser();
    return ctx.json(200, { ok: true, ...markAllRead(user.id) });
  });
}
