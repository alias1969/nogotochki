/**
 * Чтение журнала действий — экран A9.
 *
 * Писать в журнал сервис умел с самого начала: отмена чужой записи,
 * правка графика, смена роли, изменение настроек. Прочитать написанное
 * было нечем — то есть журнал существовал, но не работал: смысл записи
 * «кто, что и когда» появляется только в тот момент, когда кто-то
 * приходит разбираться.
 *
 * Здесь **только чтение**, и это не упущение. Журнал, из которого можно
 * что-то убрать через API, перестаёт быть доказательством: тот, кто
 * сделал лишнее, первым делом уберёт строку об этом. Поэтому ни правки,
 * ни удаления здесь нет и быть не должно — даже у администратора.
 */
import { getDb } from '../db/connection.js';

/**
 * Что пишется в журнал на самом деле.
 *
 * Схема разрешает больше значений, чем сервис использует: `login`,
 * `logout` и `export` заложены на будущее, но пока не пишутся —
 * входы в журнал не идут, экспорта данных ещё нет. Названия нужны
 * для фильтров на экране, и держать их рядом с кодом честнее, чем
 * показывать администратору фильтр, который никогда ничего не найдёт.
 */
export const ACTION_TITLES = {
  create: 'Создание',
  update: 'Изменение',
  cancel: 'Отмена',
  reschedule: 'Перенос',
  status_change: 'Смена статуса',
  role_change: 'Смена роли',
  password_change: 'Смена пароля',
  login: 'Вход',
  logout: 'Выход',
  export: 'Экспорт',
};

export const ENTITY_TITLES = {
  appointment: 'Запись',
  master_schedule: 'График мастера',
  schedule_exception: 'Отклонение от графика',
  schedule_change_request: 'Заявка на изменение графика',
  service: 'Услуга или категория',
  master: 'Карточка мастера',
  user: 'Пользователь',
  settings: 'Настройки студии',
  report: 'Отчёт',
};

/** Действия, которые сервис действительно записывает сегодня. */
export const RECORDED_ACTIONS = [
  'create', 'update', 'cancel', 'reschedule', 'status_change', 'role_change', 'password_change',
];

/**
 * Разбор поля details.
 *
 * В базе это строка JSON, но полагаться на неё вслепую нельзя: строки
 * писались разными версиями кода, а журнал живёт дольше любой из них.
 * Не разобралось — отдаём как текст, а не роняем весь экран из-за одной
 * старой строки.
 */
function parseDetails(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/**
 * Записи журнала, новые сверху.
 *
 * Фильтры закрывают два разных вопроса, которые задают в жизни:
 * «что натворил этот человек» (actor_user_id) и «что происходило
 * с этой записью» (entity_type + entity_id). Под оба есть индексы —
 * ix_audit_actor и ix_audit_entity, оба с created_at DESC.
 *
 * Листание курсором по убывающему id: журнал пополняется во время
 * чтения, и страницы с отступом показывали бы одно и то же дважды.
 */
export function listAudit({
  actorUserId = null,
  actorRole = null,
  action = null,
  entityType = null,
  entityId = null,
  from = null,
  to = null,
  beforeId = null,
  limit = 50,
} = {}) {
  const rows = getDb()
    .prepare(
      `SELECT a.id, a.actor_user_id, a.actor_role, a.action, a.entity_type, a.entity_id,
              a.details, a.created_at,
              u.full_name AS actor_name, u.email AS actor_email
         FROM audit_log a
         JOIN users u ON u.id = a.actor_user_id
        WHERE (:actor_user_id IS NULL OR a.actor_user_id = :actor_user_id)
          AND (:actor_role IS NULL OR a.actor_role = :actor_role)
          AND (:action      IS NULL OR a.action = :action)
          AND (:entity_type IS NULL OR a.entity_type = :entity_type)
          AND (:entity_id   IS NULL OR a.entity_id = :entity_id)
          AND (:from IS NULL OR a.created_at >= :from)
          AND (:to   IS NULL OR a.created_at <  :to)
          AND (:before_id IS NULL OR a.id < :before_id)
        ORDER BY a.id DESC
        LIMIT :limit`,
    )
    .all({
      actor_user_id: actorUserId,
      actor_role: actorRole,
      action,
      entity_type: entityType,
      entity_id: entityId,
      from,
      to,
      before_id: beforeId,
      limit,
    });

  return rows.map((row) => ({ ...row, details: parseDetails(row.details) }));
}

/** Сводка по журналу: сколько записей и какого возраста. */
export function auditSummary() {
  const totals = getDb()
    .prepare('SELECT COUNT(*) AS total, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM audit_log')
    .get();
  const byAction = getDb()
    .prepare('SELECT action, COUNT(*) AS count FROM audit_log GROUP BY action ORDER BY count DESC')
    .all();
  return { ...totals, by_action: byAction };
}
