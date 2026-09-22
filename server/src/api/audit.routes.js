/**
 * Админ-панель: журнал действий — экран A9.
 *
 * Только чтение. Журнал, из которого можно что-то убрать через API,
 * перестаёт быть доказательством: тот, кто сделал лишнее, первым делом
 * уберёт строку об этом. Поэтому здесь нет ни правки, ни удаления,
 * ни даже отметки «прочитано».
 */
import * as v from '../lib/validate.js';
import * as views from './views.js';
import {
  listAudit,
  auditSummary,
  ACTION_TITLES,
  ENTITY_TITLES,
  RECORDED_ACTIONS,
} from '../services/audit.js';
import { localDayBounds, addDays, utcDate } from '../lib/time.js';
import { unprocessable } from '../lib/http-error.js';

const ACTIONS = Object.keys(ACTION_TITLES);
const ENTITIES = Object.keys(ENTITY_TITLES);
const ROLES = ['client', 'master', 'admin'];

export function registerAuditRoutes(router) {
  /**
   * GET /api/admin/audit — записи журнала, новые сверху.
   *
   * Фильтры закрывают два вопроса, которые задают в жизни: «что натворил
   * этот человек» (`actor_user_id`) и «что происходило с этой записью»
   * (`entity_type` + `entity_id`). Под оба есть индексы.
   *
   * Плюс период `from`/`to` местными датами студии, `action`,
   * `actor_role` и листание `before_id`.
   *
   * Поле `details` отдаётся разобранным объектом, а не строкой: в базе
   * это JSON, и заставлять фронтенд разбирать его второй раз незачем.
   */
  router.get('/api/admin/audit', async (ctx) => {
    ctx.requireRole('admin');
    const query = ctx.query;
    const offset = ctx.settings.utc_offset_minutes;

    let from = null;
    let to = null;
    if (query.date) {
      const bounds = localDayBounds(v.date(query.date, 'date'), offset);
      from = bounds.from;
      to = bounds.to;
    } else {
      if (query.from) from = localDayBounds(v.date(query.from, 'from'), offset).from;
      if (query.to) {
        const day = v.date(query.to, 'to');
        if (query.from && day < query.from) throw unprocessable('invalid_range', 'Конец периода раньше начала');
        // Правая граница — начало следующих суток: иначе действие,
        // случившееся в 23:50 последнего дня, выпало бы из выборки.
        to = localDayBounds(utcDate(addDays(`${day}T00:00:00Z`, 1)), offset).from;
      }
    }

    const limit = query.limit ? v.integer(query.limit, 'limit', { min: 1, max: 200 }) : 50;
    const rows = listAudit({
      actorUserId: query.actor_user_id ? v.id(query.actor_user_id, 'actor_user_id') : null,
      actorRole: query.actor_role ? v.oneOf(query.actor_role, 'actor_role', ROLES) : null,
      action: query.action ? v.oneOf(query.action, 'action', ACTIONS) : null,
      entityType: query.entity_type ? v.oneOf(query.entity_type, 'entity_type', ENTITIES) : null,
      entityId: query.entity_id ? v.integer(query.entity_id, 'entity_id', { min: 0 }) : null,
      from,
      to,
      beforeId: query.before_id ? v.id(query.before_id, 'before_id') : null,
      limit,
    });

    return ctx.json(200, {
      entries: rows.map((row) => views.auditEntry(row, ctx.settings)),
      next_before_id: rows.length === limit ? rows[rows.length - 1].id : null,
    });
  });

  /**
   * GET /api/admin/audit/meta — из чего собирать фильтры.
   *
   * Отдаёт и сводку по журналу, и списки значений с человеческими
   * названиями. Отдельно помечено, какие действия сервис записывает
   * на самом деле: схема разрешает больше, чем используется, и показывать
   * администратору фильтр «Вход», который никогда ничего не найдёт,
   * — значит врать интерфейсом.
   */
  router.get('/api/admin/audit/meta', async (ctx) => {
    ctx.requireRole('admin');
    const summary = auditSummary();

    return ctx.json(200, {
      total: summary.total,
      oldest: summary.oldest ? views.moment(summary.oldest, ctx.settings) : null,
      newest: summary.newest ? views.moment(summary.newest, ctx.settings) : null,
      by_action: summary.by_action.map((row) => ({
        action: row.action,
        title: ACTION_TITLES[row.action] ?? row.action,
        count: row.count,
      })),
      actions: ACTIONS.map((action) => ({
        action,
        title: ACTION_TITLES[action],
        recorded: RECORDED_ACTIONS.includes(action),
      })),
      entity_types: ENTITIES.map((entity) => ({ entity_type: entity, title: ENTITY_TITLES[entity] })),
      roles: ROLES,
    });
  });
}
