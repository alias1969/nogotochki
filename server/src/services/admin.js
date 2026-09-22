/**
 * Управление справочниками: услуги и мастера.
 *
 * Правило удаления из схемы: справочник, на который ссылаются записи,
 * не удаляется, а выключается флагом is_active. Иначе отчёт за прошлый
 * месяц потерял бы половину строк вместе с удалённой услугой, а внешние
 * ключи с ON DELETE RESTRICT просто не дали бы выполнить удаление.
 *
 * Поэтому DELETE здесь означает «снять с витрины», а не «стереть».
 */
import { getDb, transaction } from '../db/connection.js';
import { conflict, notFound, unprocessable } from '../lib/http-error.js';
import { now } from '../lib/time.js';
import { writeAudit, actorRoleOf } from './journal.js';

/**
 * Категории услуг.
 *
 * Тонкий справочник: имя и порядок вывода. Ценность у него ровно одна —
 * разбить прайс на разделы, и поэтому единственное правило, которое
 * здесь важно соблюсти, — чтобы категорий-близнецов не заводилось.
 */
export function listCategories({ includeInactive = false } = {}) {
  return getDb()
    .prepare(
      `SELECT c.id, c.name, c.sort_order, c.is_active,
              (SELECT COUNT(*) FROM services s WHERE s.category_id = c.id) AS services_total,
              (SELECT COUNT(*) FROM services s WHERE s.category_id = c.id AND s.is_active = 1) AS services_active
         FROM service_categories c
        WHERE (:include_inactive = 1 OR c.is_active = 1)
        ORDER BY c.sort_order, c.name`,
    )
    .all({ include_inactive: includeInactive ? 1 : 0 });
}

export function findCategory(categoryId) {
  const row = listCategories({ includeInactive: true }).find((item) => item.id === categoryId);
  if (!row) throw notFound('Категория не найдена');
  return row;
}

/**
 * Проверка имени на близнеца.
 *
 * В базе стоит обычный уникальный индекс, он ловит точное совпадение.
 * Здесь проверка вежливее: «Уход» и «уход» для человека одно и то же,
 * и лучше сказать это словами, чем дать завести второй раздел
 * с отличающейся буквой. ulower — своя функция: встроенный lower()
 * в SQLite не знает кириллицы (см. connection.js).
 */
function assertCategoryNameFree(db, name, exceptId = null) {
  const taken = db
    .prepare('SELECT id, name FROM service_categories WHERE ulower(name) = ulower(?)')
    .get(name);
  if (taken && taken.id !== exceptId) {
    throw conflict('category_exists', `Категория «${taken.name}» уже есть`, { category_id: taken.id });
  }
}

export function createCategory(actor, data) {
  return transaction((db) => {
    assertCategoryNameFree(db, data.name);
    const inserted = db
      .prepare('INSERT INTO service_categories(name, sort_order, is_active) VALUES (:name, :sort_order, :is_active)')
      .run(data);

    const id = Number(inserted.lastInsertRowid);
    writeAudit(db, {
      actorUserId: actor.id,
      actorRole: actorRoleOf(actor),
      action: 'create',
      entityType: 'service',
      entityId: id,
      details: { category: data.name },
    });
    return id;
  });
}

export function updateCategory(actor, categoryId, patch) {
  return transaction((db) => {
    const existing = db.prepare('SELECT id FROM service_categories WHERE id = ?').get(categoryId);
    if (!existing) throw notFound('Категория не найдена');
    if (patch.name !== undefined) assertCategoryNameFree(db, patch.name, categoryId);

    const fields = Object.keys(patch);
    if (fields.length === 0) throw unprocessable('nothing_to_update', 'Не передано ни одного поля');

    const assignments = fields.map((field) => `${field} = :${field}`).join(', ');
    db.prepare(`UPDATE service_categories SET ${assignments} WHERE id = :id`)
      .run({ ...patch, id: categoryId });

    writeAudit(db, {
      actorUserId: actor.id,
      actorRole: actorRoleOf(actor),
      action: 'update',
      entityType: 'service',
      entityId: categoryId,
      details: { category: patch },
    });
    return categoryId;
  });
}

/**
 * Снять категорию с витрины.
 *
 * Удалить её нельзя: на категорию ссылаются услуги, а внешний ключ
 * объявлен как ON DELETE RESTRICT. Это и правильно — вместе с категорией
 * исчезли бы услуги, а вместе с ними состав прошлых визитов.
 *
 * Выключение прячет с витрины и саму категорию, и все её услуги: расчёт
 * прайса пересекает оба признака. Сколько услуг уходит со сцены —
 * возвращается в ответе, чтобы это не стало сюрпризом.
 */
export function deactivateCategory(actor, categoryId) {
  const category = findCategory(categoryId);
  updateCategory(actor, categoryId, { is_active: 0 });
  return { hidden_services: category.services_active };
}

function assertCategory(db, categoryId) {
  const row = db.prepare('SELECT id FROM service_categories WHERE id = ?').get(categoryId);
  if (!row) throw unprocessable('category_not_found', 'Такой категории услуг нет');
}

export function createService(actor, data) {
  return transaction((db) => {
    assertCategory(db, data.category_id);
    let inserted;
    try {
      inserted = db
        .prepare(
          `INSERT INTO services(category_id, name, description, duration_min, price_kopecks,
                                is_active, sort_order)
           VALUES (:category_id, :name, :description, :duration_min, :price_kopecks,
                   :is_active, :sort_order)`,
        )
        .run(data);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw conflict('service_exists', 'Услуга с таким названием в этой категории уже есть');
      }
      throw error;
    }
    const id = Number(inserted.lastInsertRowid);
    writeAudit(db, {
      actorUserId: actor.id,
      actorRole: actorRoleOf(actor),
      action: 'create',
      entityType: 'service',
      entityId: id,
      details: { name: data.name },
    });
    return id;
  });
}

/**
 * Частичное обновление: меняются только переданные поля.
 *
 * Правка цены и длительности не трогает уже созданные записи — в них лежат
 * снимки, сделанные в момент записи. Это осознанное дублирование из схемы:
 * иначе подорожание маникюра задним числом переписало бы прошлую выручку.
 */
export function updateService(actor, serviceId, patch) {
  return transaction((db) => {
    const existing = db.prepare('SELECT id FROM services WHERE id = ?').get(serviceId);
    if (!existing) throw notFound('Услуга не найдена');
    if (patch.category_id !== undefined) assertCategory(db, patch.category_id);

    const fields = Object.keys(patch);
    if (fields.length === 0) return serviceId;
    const assignments = fields.map((field) => `${field} = :${field}`).join(', ');
    try {
      db.prepare(`UPDATE services SET ${assignments}, updated_at = :updated_at WHERE id = :id`)
        .run({ ...patch, updated_at: now(), id: serviceId });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw conflict('service_exists', 'Услуга с таким названием в этой категории уже есть');
      }
      throw error;
    }

    writeAudit(db, {
      actorUserId: actor.id,
      actorRole: actorRoleOf(actor),
      action: 'update',
      entityType: 'service',
      entityId: serviceId,
      details: patch,
    });
    return serviceId;
  });
}

/** Снятие услуги с витрины. Будущие записи с ней остаются в силе — их проводит мастер. */
export function deactivateService(actor, serviceId) {
  return updateService(actor, serviceId, { is_active: 0 });
}

/**
 * Карточка мастера.
 *
 * user_id необязателен: карточку можно завести до того, как у мастера
 * появится вход в кабинет. Если аккаунт указан, его роль должна быть master —
 * иначе мастер не сможет войти в свой кабинет, а клиент увидел бы
 * в списке мастеров администратора.
 */
function assertMasterAccount(db, userId, masterId = null) {
  if (userId === null) return;
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) throw unprocessable('user_not_found', 'Такого пользователя нет');
  if (user.role !== 'master') {
    throw unprocessable('user_not_master', 'У аккаунта должна быть роль master');
  }
  const taken = db.prepare('SELECT id FROM masters WHERE user_id = ?').get(userId);
  if (taken && taken.id !== masterId) {
    throw conflict('account_already_linked', 'К этому аккаунту уже привязана карточка мастера');
  }
}

export function createMaster(actor, data) {
  return transaction((db) => {
    assertMasterAccount(db, data.user_id);
    const { service_ids: serviceIds, ...fields } = data;
    const inserted = db
      .prepare(
        `INSERT INTO masters(user_id, display_name, specialization, bio, photo_url,
                             is_active, sort_order)
         VALUES (:user_id, :display_name, :specialization, :bio, :photo_url,
                 :is_active, :sort_order)`,
      )
      .run(fields);
    const id = Number(inserted.lastInsertRowid);
    if (serviceIds) setMasterServices(db, id, serviceIds);

    writeAudit(db, {
      actorUserId: actor.id,
      actorRole: actorRoleOf(actor),
      action: 'create',
      entityType: 'master',
      entityId: id,
      details: { user_id: data.user_id },
    });
    return id;
  });
}

export function updateMaster(actor, masterId, patch) {
  return transaction((db) => {
    const existing = db.prepare('SELECT id FROM masters WHERE id = ?').get(masterId);
    if (!existing) throw notFound('Мастер не найден');
    const { service_ids: serviceIds, ...fields } = patch;
    if (fields.user_id !== undefined) assertMasterAccount(db, fields.user_id, masterId);

    if (Object.keys(fields).length > 0) {
      const assignments = Object.keys(fields).map((field) => `${field} = :${field}`).join(', ');
      db.prepare(`UPDATE masters SET ${assignments}, updated_at = :updated_at WHERE id = :id`)
        .run({ ...fields, updated_at: now(), id: masterId });
    }
    if (serviceIds) setMasterServices(db, masterId, serviceIds);

    writeAudit(db, {
      actorUserId: actor.id,
      actorRole: actorRoleOf(actor),
      action: 'update',
      entityType: 'master',
      entityId: masterId,
      details: patch,
    });
    return masterId;
  });
}

/**
 * Набор услуг мастера задаётся целиком, а не по одной.
 *
 * Экран A6 — это список с галочками: он присылает состояние, а не разницу.
 * Перезапись всего набора избавляет от эндпоинтов «добавить» и «убрать»
 * и от расхождения, когда одна из двух команд не дошла.
 */
function setMasterServices(db, masterId, serviceIds) {
  for (const serviceId of serviceIds) {
    const service = db.prepare('SELECT id FROM services WHERE id = ?').get(serviceId);
    if (!service) throw unprocessable('service_not_found', `Услуги ${serviceId} нет`);
  }
  db.prepare('DELETE FROM master_services WHERE master_id = ?').run(masterId);
  const link = db.prepare('INSERT INTO master_services(master_id, service_id) VALUES (?, ?)');
  for (const serviceId of serviceIds) link.run(masterId, serviceId);
}

/**
 * Выключение мастера.
 *
 * Будущие записи к нему при этом остаются: выключение убирает мастера
 * из выбора на новых записях, а не отменяет уже обещанные визиты.
 * Сколько их — возвращается в ответе, чтобы администратор знал,
 * что с ними ещё предстоит разобраться.
 */
export function deactivateMaster(actor, masterId) {
  const upcoming = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM appointments
        WHERE master_id = ? AND status = 'booked' AND starts_at > ?`,
    )
    .get(masterId, now()).count;
  updateMaster(actor, masterId, { is_active: 0 });
  return { upcoming_appointments: upcoming };
}
