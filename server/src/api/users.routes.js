/**
 * Админ-панель: пользователи и роли — экран A10.
 *
 * Последний кусок паспорта, где администратор «управляет всем»:
 * роли, контакты, отключение аккаунтов. До этого роль можно было
 * поменять только руками в базе.
 */
import * as v from '../lib/validate.js';
import * as views from './views.js';
import {
  findUser,
  listUsers,
  visitSummary,
  createUser,
  updateUser,
  permissionMatrix,
} from '../services/users.js';

const ROLES = ['user', 'master', 'admin'];

export function registerUserRoutes(router) {
  /**
   * GET /api/admin/permissions — матрица прав.
   *
   * Справочник, а не механизм: права проверяются в коде при каждом
   * запросе, а эта таблица объясняет администратору, кто что может,
   * без чтения исходников (решение 7.15 схемы).
   *
   * Отсюда правило, которое легко нарушить: меняется поведение кода —
   * строку в матрице правит отдельная миграция. Матрица, разошедшаяся
   * с кодом, хуже отсутствующей: она врёт уверенно.
   */
  router.get('/api/admin/permissions', async (ctx) => {
    ctx.requireRole('admin');
    return ctx.json(200, permissionMatrix());
  });

  /**
   * GET /api/admin/users — список.
   *
   * Фильтры: `role`, `active`, `search` и листание `after_id`.
   * Поиск идёт по имени, e-mail и телефону сразу: администратор ищет
   * человека тем, что помнит, а помнит обычно что-то одно.
   */
  router.get('/api/admin/users', async (ctx) => {
    ctx.requireRole('admin');
    const limit = ctx.query.limit ? v.integer(ctx.query.limit, 'limit', { min: 1, max: 200 }) : 50;
    const rows = listUsers({
      role: ctx.query.role ? v.oneOf(ctx.query.role, 'role', ROLES) : null,
      isActive: ctx.query.active === undefined ? null : (v.boolean(ctx.query.active, 'active') ? 1 : 0),
      search: ctx.query.search ? v.string(ctx.query.search, 'search', { min: 1, max: 100 }) : null,
      afterId: ctx.query.after_id ? v.id(ctx.query.after_id, 'after_id') : null,
      limit,
    });

    return ctx.json(200, {
      users: rows.map((row) => views.adminUser(row, ctx.settings)),
      next_after_id: rows.length === limit ? rows[rows.length - 1].id : null,
    });
  });

  /** GET /api/admin/users/:id — карточка с историей визитов. */
  router.get('/api/admin/users/:id', async (ctx) => {
    ctx.requireRole('admin');
    const row = findUser(v.id(ctx.params.id, 'id'));
    const summary = visitSummary(row.id);
    return ctx.json(200, {
      user: views.adminUser(row, ctx.settings),
      visits: {
        ...summary,
        last_visit_at: summary.last_visit_at ? views.moment(summary.last_visit_at, ctx.settings) : null,
      },
    });
  });

  /**
   * POST /api/admin/users — завести аккаунт.
   *
   * Тело: `email`, `full_name`, `phone`, необязательная `role`.
   *
   * Пароль не задаётся: аккаунт создаётся с пустым `password_hash` —
   * предусмотренное схемой состояние «заведён вручную, вход не
   * активирован». Владелец задаёт себе пароль сам, через восстановление
   * по своему e-mail. Так администратор не знает чужих паролей даже
   * в момент выдачи доступа, и заодно подтверждается, что адрес рабочий.
   */
  router.post('/api/admin/users', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const body = v.object(await ctx.body());

    const id = createUser({
      admin,
      data: {
        email: v.email(body.email),
        full_name: v.string(body.full_name, 'full_name', { min: 2, max: 120 }),
        phone: v.phone(body.phone),
        role: body.role === undefined ? 'user' : v.oneOf(body.role, 'role', ROLES),
      },
    });

    return ctx.json(201, {
      user: views.adminUser(findUser(id), ctx.settings),
      activation: 'Владелец аккаунта задаёт пароль сам — через восстановление по e-mail',
    });
  });

  /**
   * PATCH /api/admin/users/:id — контакты, e-mail, роль, активность.
   *
   * Смена роли и отключение закрывают все сессии этого человека: роль
   * зафиксирована в сессии на момент входа, и продолжать работать
   * со старыми правами он не должен.
   *
   * Чего сделать нельзя: сменить роль себе, отключить себя, оставить
   * студию без единого действующего администратора и увести в другую
   * роль мастера с привязанной карточкой. Каждый случай отвечает
   * своим кодом и текстом — человек чаще всего просто промахнулся
   * строкой в списке.
   *
   * Тему оформления администратор не трогает: это выбор владельца.
   */
  router.patch('/api/admin/users/:id', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const user = findUser(v.id(ctx.params.id, 'id'));
    const body = v.object(await ctx.body());

    const patch = {};
    if (body.full_name !== undefined) patch.full_name = v.string(body.full_name, 'full_name', { min: 2, max: 120 });
    if (body.phone !== undefined) patch.phone = v.phone(body.phone);
    if (body.email !== undefined) patch.email = v.email(body.email);
    if (body.role !== undefined) patch.role = v.oneOf(body.role, 'role', ROLES);
    if (body.is_active !== undefined) patch.is_active = v.boolean(body.is_active, 'is_active') ? 1 : 0;

    const result = updateUser({ admin, user, patch });
    return ctx.json(200, {
      user: views.adminUser(findUser(user.id), ctx.settings),
      sessions_revoked: result.sessionsRevoked,
    });
  });
}
