/**
 * Витрина: услуги и мастера.
 *
 * Читается без входа — клиент должен видеть прайс и мастеров до регистрации.
 * Поэтому здесь нет ни одного поля из users, кроме имени мастера:
 * e-mail и телефон сотрудника на витрине делать нечего.
 */
import { getDb } from '../db/connection.js';
import { notFound } from '../lib/http-error.js';

/**
 * Список услуг.
 *
 * includeInactive доступен только администратору: клиенту скрытая услуга
 * не показывается, но администратору на экране A5 нужен полный список,
 * иначе выключенную услугу нельзя включить обратно.
 */
export function listServices({ includeInactive = false, masterId = null } = {}) {
  return getDb()
    .prepare(
      `SELECT s.id, s.name, s.description, s.duration_min, s.price_kopecks,
              s.is_active, s.sort_order,
              c.id AS category_id, c.name AS category_name
         FROM services s
         JOIN service_categories c ON c.id = s.category_id
        WHERE (:include_inactive = 1 OR (s.is_active = 1 AND c.is_active = 1))
          AND (:master_id IS NULL OR EXISTS (
                SELECT 1 FROM master_services ms
                 WHERE ms.service_id = s.id AND ms.master_id = :master_id))
        ORDER BY c.sort_order, s.sort_order, s.name`,
    )
    .all({ include_inactive: includeInactive ? 1 : 0, master_id: masterId });
}

/**
 * Активные услуги по списку идентификаторов — основа расчёта длительности и суммы.
 *
 * Возвращает их в том порядке, в каком клиент выбрал: порядок услуг внутри
 * визита сохраняется в position и виден мастеру.
 */
export function findActiveServices(serviceIds) {
  if (serviceIds.length === 0) return [];
  const placeholders = serviceIds.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT id, name, duration_min, price_kopecks
         FROM services
        WHERE is_active = 1 AND id IN (${placeholders})`,
    )
    .all(...serviceIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return serviceIds.map((id) => byId.get(id)).filter((row) => row !== undefined);
}

/**
 * Список мастеров.
 *
 * Имя собирается как COALESCE(display_name, full_name): карточка мастера
 * может существовать до привязки аккаунта, и тогда имя берётся из неё,
 * а у привязанной карточки псевдоним перекрывает паспортное имя.
 */
export function listMasters({ includeInactive = false, serviceIds = null } = {}) {
  const db = getDb();
  const masters = db
    .prepare(
      `SELECT m.id, COALESCE(m.display_name, u.full_name) AS name,
              m.specialization, m.bio, m.photo_url, m.is_active, m.sort_order
         FROM masters m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE (:include_inactive = 1 OR m.is_active = 1)
        ORDER BY m.sort_order, name`,
    )
    .all({ include_inactive: includeInactive ? 1 : 0 });

  const links = db.prepare('SELECT master_id, service_id FROM master_services').all();
  const byMaster = new Map();
  for (const link of links) {
    if (!byMaster.has(link.master_id)) byMaster.set(link.master_id, []);
    byMaster.get(link.master_id).push(link.service_id);
  }

  const withServices = masters.map((master) => ({
    ...master,
    service_ids: (byMaster.get(master.id) ?? []).sort((a, b) => a - b),
  }));

  // Фильтр «кто умеет всё выбранное» — для шага B2, где мастер выбирается
  // после услуг. Мастер, который делает только часть набора, не подходит.
  if (serviceIds && serviceIds.length > 0) {
    return withServices.filter((master) =>
      serviceIds.every((id) => master.service_ids.includes(id)),
    );
  }
  return withServices;
}

/**
 * Карточка мастера по аккаунту, из-под которого пришёл запрос.
 *
 * Роль `master` в users и карточка в masters — две разные вещи (раздел 7.2
 * схемы): карточку заводят до того, как у мастера появляется вход, а аккаунт
 * может остаться без карточки, если администратор завёл роль и не связал.
 * Поэтому кабинет мастера начинается с этой функции, а не с проверки роли.
 */
export function findMasterByUser(userId) {
  return getDb()
    .prepare(
      `SELECT m.id, COALESCE(m.display_name, u.full_name) AS name,
              m.specialization, m.bio, m.photo_url, m.is_active
         FROM masters m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.user_id = ?`,
    )
    .get(userId) ?? null;
}

export function findMaster(masterId, { includeInactive = false } = {}) {
  const master = listMasters({ includeInactive: true }).find((item) => item.id === masterId);
  if (!master || (!includeInactive && master.is_active !== 1)) throw notFound('Мастер не найден');
  return master;
}
