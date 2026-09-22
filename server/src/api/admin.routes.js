/**
 * Админ-панель: все записи и управление справочниками.
 *
 * Роль проверяется на сервере в каждом обработчике через ctx.requireRole,
 * а не тем, что фронтенд не показал ссылку: скрытая кнопка защитой
 * не считается.
 */
import * as v from '../lib/validate.js';
import * as views from '../api/views.js';
import { listAll, loadAppointmentServices, createAppointment, findAccessible } from '../services/appointments.js';
import { listServices, listMasters } from '../services/catalog.js';
import {
  listCategories,
  findCategory,
  createCategory,
  updateCategory,
  deactivateCategory,
  createService,
  updateService,
  deactivateService,
  createMaster,
  updateMaster,
  deactivateMaster,
} from '../services/admin.js';
import { localDayBounds, addDays, utcDate } from '../lib/time.js';
import { unprocessable } from '../lib/http-error.js';

const STATUSES = ['booked', 'completed', 'no_show', 'cancelled'];

/**
 * Поля услуги из тела запроса.
 *
 * partial=true — режим PATCH: проверяются только присланные поля,
 * остальные остаются как есть. Цена принимается и хранится целым числом
 * копеек: рубли с копейкой дробным числом рано или поздно дают
 * расхождение при суммировании чека.
 */
function serviceFields(body, { partial }) {
  const out = {};
  const has = (field) => body[field] !== undefined;
  const need = (field) => !partial || has(field);

  if (need('category_id')) out.category_id = v.id(body.category_id, 'category_id');
  if (need('name')) out.name = v.string(body.name, 'name', { min: 2, max: 120 });
  if (need('duration_min')) {
    out.duration_min = v.integer(body.duration_min, 'duration_min', { min: 5, max: 600 });
  }
  if (need('price_kopecks')) {
    out.price_kopecks = v.integer(body.price_kopecks, 'price_kopecks', { min: 0, max: 100_000_000 });
  }
  if (!partial || has('description')) {
    out.description = v.optionalString(body.description, 'description', { max: 1000 });
  }
  if (!partial || has('is_active')) {
    out.is_active = (partial ? v.boolean(body.is_active, 'is_active') : body.is_active !== false) ? 1 : 0;
  }
  if (!partial || has('sort_order')) {
    out.sort_order = has('sort_order') ? v.integer(body.sort_order, 'sort_order', { min: 0, max: 9999 }) : 0;
  }
  return out;
}

function masterFields(body, { partial }) {
  const out = {};
  const has = (field) => body[field] !== undefined;

  if (!partial || has('user_id')) {
    out.user_id = body.user_id === null || body.user_id === undefined ? null : v.id(body.user_id, 'user_id');
  }
  if (!partial || has('display_name')) {
    out.display_name = v.optionalString(body.display_name, 'display_name', { max: 120 });
  }
  if (!partial || has('specialization')) {
    out.specialization = v.optionalString(body.specialization, 'specialization', { max: 200 });
  }
  if (!partial || has('bio')) out.bio = v.optionalString(body.bio, 'bio', { max: 2000 });
  if (!partial || has('photo_url')) {
    out.photo_url = v.optionalString(body.photo_url, 'photo_url', { max: 500 });
  }
  if (!partial || has('is_active')) {
    out.is_active = (partial ? v.boolean(body.is_active, 'is_active') : body.is_active !== false) ? 1 : 0;
  }
  if (!partial || has('sort_order')) {
    out.sort_order = has('sort_order') ? v.integer(body.sort_order, 'sort_order', { min: 0, max: 9999 }) : 0;
  }
  if (has('service_ids')) out.service_ids = v.idList(body.service_ids, 'service_ids', { min: 0 });

  // Схема требует, чтобы у карточки было хотя бы одно имя: либо привязанный
  // аккаунт, либо псевдоним. Проверяем здесь, чтобы вместо ошибки SQLite
  // администратор увидел понятное объяснение.
  if (!partial && out.user_id === null && out.display_name === null) {
    throw unprocessable('name_required', 'Укажите аккаунт мастера или имя для карточки');
  }
  return out;
}

export function registerAdminRoutes(router) {
  /**
   * GET /api/admin/appointments — все записи студии.
   *
   * Фильтры date (один день по календарю студии) либо from/to, а также
   * status, master_id, client_id. Местная дата переводится в границы UTC
   * здесь: в базе лежит UTC, а администратор мыслит рабочим днём студии.
   */
  router.get('/api/admin/appointments', async (ctx) => {
    ctx.requireRole('admin');
    const query = ctx.query;
    let dateFrom = null;
    let dateTo = null;

    if (query.date) {
      const bounds = localDayBounds(v.date(query.date, 'date'), ctx.settings.utc_offset_minutes);
      dateFrom = bounds.from;
      dateTo = bounds.to;
    } else if (query.from || query.to) {
      const from = query.from ? v.date(query.from, 'from') : null;
      const to = query.to ? v.date(query.to, 'to') : null;
      if (from && to && to < from) throw unprocessable('invalid_range', 'Конец периода раньше начала');
      if (from) dateFrom = localDayBounds(from, ctx.settings.utc_offset_minutes).from;
      // Правая граница — начало следующих суток: интервал полуоткрытый,
      // иначе визит, начавшийся в 23:50 последнего дня, выпал бы из отчёта.
      if (to) dateTo = localDayBounds(utcDate(addDays(`${to}T00:00:00Z`, 1)), ctx.settings.utc_offset_minutes).from;
    }

    const rows = listAll({
      dateFrom,
      dateTo,
      status: query.status ? v.oneOf(query.status, 'status', STATUSES) : null,
      masterId: query.master_id ? v.id(query.master_id, 'master_id') : null,
      clientId: query.client_id ? v.id(query.client_id, 'client_id') : null,
      limit: query.limit ? v.integer(query.limit, 'limit', { min: 1, max: 500 }) : 200,
    });

    return ctx.json(200, {
      appointments: rows.map((row) =>
        views.appointment(row, loadAppointmentServices(row.id), ctx.settings, { audience: 'admin' }),
      ),
    });
  });

  /**
   * POST /api/admin/appointments — записать клиента вручную.
   *
   * Резерв здесь не нужен: администратор не выбирает время на экране
   * и ни с кем не соревнуется за слот — он его назначает.
   *
   * allow_overlap — осознанное наложение поверх занятого времени: мастер
   * согласился принять двоих, клиент пришёл без записи, предыдущий визит
   * затянулся. Признак читается только здесь; в клиентском
   * POST /api/appointments это поле не читается вовсе.
   *
   * Даже если бы его сюда подложили в обход, значение взвешивается ещё раз
   * внутри createAppointment по таблице прав (CREATE_POLICY.mayOverlap),
   * а запрет продублирован триггером trg_appointments_overlap_flag_insert
   * в самой базе.
   *
   * Созданная запись дальше ведёт себя как обычная: занимает время
   * в календаре и не даёт записаться на него другим. Разрешено одно
   * конкретное наложение, а не право раздавать наложения дальше.
   */
  router.post('/api/admin/appointments', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const body = v.object(await ctx.body());

    const input = {
      clientId: v.id(body.client_id, 'client_id'),
      masterId: v.id(body.master_id, 'master_id'),
      startsAt: v.instant(body.starts_at, 'starts_at'),
      serviceIds: v.idList(body.service_ids, 'service_ids'),
      clientNote: v.optionalString(body.client_note, 'client_note', { max: 500 }),
      adminNote: v.optionalString(body.admin_note, 'admin_note', { max: 500 }),
      allowOverlap: body.allow_overlap === undefined ? false : v.boolean(body.allow_overlap, 'allow_overlap'),
    };

    // Та же функция, что обслуживает клиентский POST /api/appointments.
    // Отличается только то, что в неё передано: у клиента — номер резерва,
    // здесь — мастер, время и услуги. Строку в базу кладёт один и тот же код.
    const id = createAppointment({ actor: admin, input, settings: ctx.settings });
    const row = findAccessible(id, admin);
    return ctx.json(201, {
      appointment: views.appointment(row, loadAppointmentServices(id), ctx.settings, { audience: 'admin' }),
    });
  });

  /**
   * GET /api/admin/service-categories — разделы прайса.
   *
   * Со счётчиками услуг: по ним видно, что стоит за решением выключить
   * категорию. Клиенту категории отдельно не нужны — они приходят
   * вместе с услугами в GET /api/services, уже в порядке вывода.
   */
  router.get('/api/admin/service-categories', async (ctx) => {
    ctx.requireRole('admin');
    return ctx.json(200, {
      categories: listCategories({ includeInactive: true }).map(views.serviceCategory),
    });
  });

  /**
   * POST /api/admin/service-categories — новый раздел прайса.
   *
   * Имя проверяется без учёта регистра: «Уход» и «уход» для человека
   * одно и то же, и второй раздел с отличающейся буквой — почти всегда
   * промах, а не намерение. В базе это же стережёт уникальный индекс,
   * но он ловит только точное совпадение.
   */
  router.post('/api/admin/service-categories', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const body = v.object(await ctx.body());
    const id = createCategory(admin, {
      name: v.string(body.name, 'name', { min: 2, max: 80 }),
      sort_order: body.sort_order === undefined ? 0 : v.integer(body.sort_order, 'sort_order', { min: 0, max: 9999 }),
      is_active: body.is_active === false ? 0 : 1,
    });
    return ctx.json(201, { category: views.serviceCategory(findCategory(id)) });
  });

  /** PATCH /api/admin/service-categories/:id — имя, порядок, признак витрины. */
  router.patch('/api/admin/service-categories/:id', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const categoryId = v.id(ctx.params.id, 'id');
    const body = v.object(await ctx.body());

    const patch = {};
    if (body.name !== undefined) patch.name = v.string(body.name, 'name', { min: 2, max: 80 });
    if (body.sort_order !== undefined) patch.sort_order = v.integer(body.sort_order, 'sort_order', { min: 0, max: 9999 });
    if (body.is_active !== undefined) patch.is_active = v.boolean(body.is_active, 'is_active') ? 1 : 0;

    updateCategory(admin, categoryId, patch);
    return ctx.json(200, { category: views.serviceCategory(findCategory(categoryId)) });
  });

  /**
   * DELETE /api/admin/service-categories/:id — снять раздел с витрины.
   *
   * Именно снять, а не удалить: на категорию ссылаются услуги, а внешний
   * ключ объявлен как ON DELETE RESTRICT. Вместе с категорией исчезли бы
   * услуги, а вместе с ними — состав прошлых визитов.
   *
   * Выключение прячет и саму категорию, и все её услуги. Сколько их —
   * в ответе, чтобы это не стало сюрпризом.
   */
  router.delete('/api/admin/service-categories/:id', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const categoryId = v.id(ctx.params.id, 'id');
    const result = deactivateCategory(admin, categoryId);
    return ctx.json(200, { ok: true, deactivated: true, category_id: categoryId, ...result });
  });

  /** GET /api/admin/services — прайс целиком, включая снятые с витрины. */
  router.get('/api/admin/services', async (ctx) => {
    ctx.requireRole('admin');
    return ctx.json(200, {
      services: listServices({ includeInactive: true }).map((row) => views.service(row, { forAdmin: true })),
    });
  });

  /** POST /api/admin/services — новая услуга. */
  router.post('/api/admin/services', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const body = v.object(await ctx.body());
    const id = createService(admin, serviceFields(body, { partial: false }));
    const row = listServices({ includeInactive: true }).find((item) => item.id === id);
    return ctx.json(201, { service: views.service(row, { forAdmin: true }) });
  });

  /**
   * PATCH /api/admin/services/:id — правка услуги.
   *
   * Уже созданные записи не меняются: в них лежат снимки цены
   * и длительности на момент записи.
   */
  router.patch('/api/admin/services/:id', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const serviceId = v.id(ctx.params.id, 'id');
    const body = v.object(await ctx.body());
    updateService(admin, serviceId, serviceFields(body, { partial: true }));
    const row = listServices({ includeInactive: true }).find((item) => item.id === serviceId);
    return ctx.json(200, { service: views.service(row, { forAdmin: true }) });
  });

  /**
   * DELETE /api/admin/services/:id — снять услугу с витрины.
   *
   * Строка остаётся в базе: на неё ссылаются прошлые записи, и удалить
   * её не даст внешний ключ с ON DELETE RESTRICT. Это и правильно —
   * иначе из отчёта за прошлый месяц пропали бы строки.
   */
  router.delete('/api/admin/services/:id', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const serviceId = v.id(ctx.params.id, 'id');
    deactivateService(admin, serviceId);
    return ctx.json(200, { ok: true, deactivated: true, service_id: serviceId });
  });

  /** GET /api/admin/masters — мастера целиком, включая выключенных. */
  router.get('/api/admin/masters', async (ctx) => {
    ctx.requireRole('admin');
    return ctx.json(200, {
      masters: listMasters({ includeInactive: true }).map((row) => views.master(row, { forAdmin: true })),
    });
  });

  /** POST /api/admin/masters — карточка мастера; аккаунт можно привязать позже. */
  router.post('/api/admin/masters', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const body = v.object(await ctx.body());
    const id = createMaster(admin, masterFields(body, { partial: false }));
    const row = listMasters({ includeInactive: true }).find((item) => item.id === id);
    return ctx.json(201, { master: views.master(row, { forAdmin: true }) });
  });

  /** PATCH /api/admin/masters/:id — правка карточки и набора услуг. */
  router.patch('/api/admin/masters/:id', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const masterId = v.id(ctx.params.id, 'id');
    const body = v.object(await ctx.body());
    updateMaster(admin, masterId, masterFields(body, { partial: true }));
    const row = listMasters({ includeInactive: true }).find((item) => item.id === masterId);
    return ctx.json(200, { master: views.master(row, { forAdmin: true }) });
  });

  /**
   * DELETE /api/admin/masters/:id — убрать мастера из выбора.
   *
   * Уже обещанные визиты при этом не отменяются: их нужно разнести руками.
   * Сколько их осталось — в ответе.
   */
  router.delete('/api/admin/masters/:id', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const masterId = v.id(ctx.params.id, 'id');
    const result = deactivateMaster(admin, masterId);
    return ctx.json(200, { ok: true, deactivated: true, master_id: masterId, ...result });
  });
}
