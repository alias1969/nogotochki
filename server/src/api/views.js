/**
 * Что именно уходит наружу.
 *
 * Ни один обработчик не отдаёт строку из базы целиком. Каждое представление
 * собирается здесь поимённо, и это единственное место, где нужно смотреть,
 * чтобы ответить на вопрос «а не видно ли клиенту лишнего».
 *
 * Два правила, которые выражены в коде ниже:
 *   * хеши паролей и токенов не выходят из своих модулей вообще;
 *   * телефон и e-mail клиента видит администратор; клиенту чужие
 *     персональные данные не показываются ни в каком виде, а про мастера
 *     он видит только имя, специализацию и фото.
 *
 * Деньги отдаются целым числом копеек (price_kopecks) — ровно так,
 * как лежат в базе. Рубли с копейками собирает фронтенд при показе:
 * дробные числа в JSON рано или поздно дают копейку расхождения в сумме чека.
 */
import { toLocalParts } from '../lib/time.js';
import { describeSlot } from '../services/availability.js';
import { ACTION_TITLES, ENTITY_TITLES } from '../services/audit.js';

/** Момент времени всегда уходит парой: UTC для расчётов и местное для показа. */
export function moment(instant, settings) {
  if (!instant) return null;
  const local = toLocalParts(instant, settings.utc_offset_minutes);
  return {
    utc: instant,
    local: local.iso,
    local_date: local.date,
    local_time: local.time,
    timezone: settings.timezone,
  };
}

/**
 * Собственный профиль. E-mail и телефон здесь свои, а не чужие.
 *
 * Роли отдаются списком, и поля `role` в ответе нет намеренно: одно
 * значение подталкивало бы клиентский код к сравнению `role === 'admin'`,
 * то есть ровно к той ошибке, от которой список и заведён. Пусть проверка
 * на экране выглядит так же, как на сервере, — поиском в списке.
 */
export function user(row) {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    phone: row.phone,
    roles: row.roles,
    theme: row.theme,
  };
}

export function service(row, { forAdmin = false } = {}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    duration_min: row.duration_min,
    price_kopecks: row.price_kopecks,
    category: { id: row.category_id, name: row.category_name },
    // Признак «на витрине» нужен только админ-панели: клиенту выключенные
    // услуги не приходят вовсе, и поле в его ответе было бы всегда true.
    ...(forAdmin ? { is_active: row.is_active === 1, sort_order: row.sort_order } : {}),
  };
}

export function master(row, { forAdmin = false } = {}) {
  return {
    id: row.id,
    name: row.name,
    specialization: row.specialization,
    bio: row.bio,
    photo_url: row.photo_url,
    service_ids: row.service_ids,
    ...(forAdmin ? { is_active: row.is_active === 1, sort_order: row.sort_order } : {}),
  };
}

/** Услуга внутри записи или резерва — это снимок, а не текущий прайс. */
function lineItem(row) {
  return {
    service_id: row.id,
    name: row.name,
    duration_min: row.duration_min,
    price_kopecks: row.price_kopecks,
  };
}

function totals(items) {
  return {
    duration_min: items.reduce((sum, item) => sum + item.duration_min, 0),
    total_price_kopecks: items.reduce((sum, item) => sum + item.price_kopecks, 0),
  };
}

export function hold(row, services, settings, secondsLeft) {
  return {
    id: row.id,
    master_id: row.master_id,
    starts_at: moment(row.starts_at, settings),
    ends_at: moment(row.ends_at, settings),
    expires_at: moment(row.expires_at, settings),
    expires_in_seconds: secondsLeft,
    reschedule_of_id: row.reschedule_of_id,
    services: services.map(lineItem),
    ...totals(services),
  };
}

/**
 * Слот. Форма задана в availability: ровно такие же объекты уходят
 * в теле ошибки 409, и расходиться этим двум спискам нельзя —
 * фронтенд разбирает их одним и тем же кодом.
 */
export const slot = describeSlot;

/**
 * Кому показывают запись.
 *
 * Флага «для администратора» тут не хватило, когда у мастера появился
 * кабинет: ролей стало три, и каждая видит свой срез. Правило из паспорта
 * дословно: «E-mail клиента виден только администратору; мастеру доступен
 * телефон в своих записях».
 *
 * Поэтому не булево «админ или нет», а кому именно, — иначе третья роль
 * неизбежно получила бы либо слишком много, либо слишком мало.
 */
const CLIENT_FIELDS = {
  // Клиент смотрит на собственный визит: показывать ему его же имя незачем.
  client: null,
  // Мастеру — кому и во сколько, и как позвонить, если клиент опаздывает.
  master: ['id', 'full_name', 'phone'],
  // Администратору — всё, включая e-mail: он ведёт клиентскую базу.
  admin: ['id', 'full_name', 'phone', 'email'],
};

function clientBlock(row, audience) {
  const fields = CLIENT_FIELDS[audience];
  if (!fields) return {};
  const source = {
    id: row.client_id,
    full_name: row.client_name,
    phone: row.client_phone,
    email: row.client_email,
  };
  return { client: Object.fromEntries(fields.map((field) => [field, source[field]])) };
}

/**
 * Запись.
 *
 * `audience` — кому уходит ответ: 'client', 'master' или 'admin'.
 * Служебная пометка администратора и признак наложения видны только ему:
 * для мастера это внутренняя кухня студии, а не свойство визита.
 *
 * abilities — рассчитанные сервером права на отмену и перенос: фронтенд
 * рисует по ним кнопки, но решает всё равно сервер при следующем запросе.
 */
export function appointment(row, services, settings, { audience = 'client', abilities = null } = {}) {
  return {
    id: row.id,
    status: row.status,
    starts_at: moment(row.starts_at, settings),
    ends_at: moment(row.ends_at, settings),
    master: {
      id: row.master_id,
      name: row.master_name,
      specialization: row.master_specialization,
    },
    services: services.map(lineItem),
    ...totals(services),
    client_note: row.client_note,
    reschedule_count: row.reschedule_count,
    created_at: moment(row.created_at, settings),
    ...(row.status === 'cancelled'
      ? {
          cancelled: {
            at: moment(row.cancelled_at, settings),
            by_role: row.cancelled_by_role,
            reason: row.cancel_reason,
          },
        }
      : {}),
    ...(abilities ?? {}),
    ...clientBlock(row, audience),
    ...(audience === 'admin'
      ? {
          admin_note: row.admin_note,
          created_by_role: row.created_by_role,
          master_chosen_by_client: row.master_chosen_by_client === 1,
          // Осознанное наложение видно только администратору.
          allow_overlap: row.allow_overlap === 1,
        }
      : {}),
  };
}

/**
 * Уведомление кабинета.
 *
 * Если уведомление привязано к записи, рядом идёт её время и статус —
 * чтобы список можно было показать строкой «запись 23 сентября в 11:00»
 * без отдельного запроса на каждое уведомление. Ничего сверх этого
 * из записи не берётся: ни клиента, ни заметок.
 *
 * appointment может оказаться пустым и при заполненном appointment_id:
 * внешний ключ объявлен как ON DELETE SET NULL, но строка уведомления
 * живёт своей жизнью, и текст в ней остаётся осмысленным сам по себе.
 */
export function notification(row, settings) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    is_read: row.is_read === 1,
    created_at: moment(row.created_at, settings),
    read_at: row.read_at ? moment(row.read_at, settings) : null,
    appointment: row.appointment_id
      ? {
          id: row.appointment_id,
          starts_at: row.appointment_starts_at ? moment(row.appointment_starts_at, settings) : null,
          status: row.appointment_status ?? null,
        }
      : null,
  };
}

/**
 * Заявка мастера на изменение графика.
 *
 * Имя мастера уходит только администратору: в своём кабинете мастер
 * и так знает, чья это заявка, а лишнее поле — лишний повод забыть,
 * кому что видно.
 */
export function scheduleRequest(row, settings, { audience = 'master' } = {}) {
  return {
    id: row.id,
    message: row.message,
    desired_from: row.desired_from,
    desired_to: row.desired_to,
    status: row.status,
    admin_comment: row.admin_comment,
    created_at: moment(row.created_at, settings),
    reviewed_at: row.reviewed_at ? moment(row.reviewed_at, settings) : null,
    ...(audience === 'admin' ? { master: { id: row.master_id, name: row.master_name } } : {}),
  };
}

/** Названия дней недели — чтобы фронтенд не заводил свою таблицу. */
const WEEKDAY_NAMES = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

/**
 * Строка недельного графика.
 *
 * Время суток отдаётся как есть, без перевода: это местное время студии
 * по определению, и пары «UTC + местное» у него не бывает.
 */
export function scheduleRow(row) {
  return {
    id: row.id,
    weekday: row.weekday,
    weekday_name: WEEKDAY_NAMES[row.weekday - 1],
    work_start: row.work_start,
    work_end: row.work_end,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
  };
}

/** Отклонение от графика. Здесь время — момент, поэтому идёт парой. */
export function scheduleException(row, settings) {
  return {
    id: row.id,
    kind: row.kind,
    starts_at: moment(row.starts_at, settings),
    ends_at: moment(row.ends_at, settings),
    reason: row.reason ?? null,
  };
}

/**
 * Визит, задетый правкой графика.
 *
 * Имя клиента здесь есть, телефона и e-mail нет: ответ уходит
 * администратору, и ему хватит понять, кому звонить, а контакты он
 * возьмёт в карточке записи.
 */
export function strandedAppointment(row, settings) {
  return {
    id: row.id,
    starts_at: moment(row.starts_at, settings),
    ends_at: moment(row.ends_at, settings),
    client_name: row.client_name,
  };
}

const WEEKDAY_TITLES = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

/** День в часах работы студии. У закрытого дня времени нет — и поля пустые. */
export function studioDay(row) {
  return {
    weekday: row.weekday,
    weekday_name: WEEKDAY_TITLES[row.weekday - 1],
    is_closed: row.is_closed === 1,
    open_time: row.open_time,
    close_time: row.close_time,
  };
}

/** Разовое закрытие студии. Даты местные — праздник это календарь. */
export function studioClosure(row) {
  return {
    id: row.id,
    date_from: row.date_from,
    date_to: row.date_to,
    reason: row.reason,
    created_by_name: row.created_by_name ?? null,
  };
}

/**
 * Запись журнала.
 *
 * Кто действовал — именем и ролью на момент действия, а не текущей:
 * роль в строке журнала зафиксирована, и если человека потом разжаловали,
 * запись всё равно должна читаться как «тогда это сделал администратор».
 *
 * entity_id = 0 у настроек студии: у таблицы «ключ — значение» нет
 * числового идентификатора, а поле в схеме обязательное. Ноль здесь
 * означает «настройки целиком», и что именно поменялось, видно в details.
 */
export function auditEntry(row, settings) {
  return {
    id: row.id,
    at: moment(row.created_at, settings),
    actor: {
      id: row.actor_user_id,
      name: row.actor_name,
      email: row.actor_email,
      role: row.actor_role,
    },
    action: row.action,
    action_title: ACTION_TITLES[row.action] ?? row.action,
    entity: {
      type: row.entity_type,
      title: ENTITY_TITLES[row.entity_type] ?? row.entity_type,
      id: row.entity_id,
    },
    details: row.details,
  };
}

/**
 * Категория услуг.
 *
 * Счётчики услуг — не украшение: по ним видно, что стоит за решением
 * выключить категорию, и почему её нельзя удалить.
 */
export function serviceCategory(row) {
  return {
    id: row.id,
    name: row.name,
    sort_order: row.sort_order,
    is_active: row.is_active === 1,
    services_total: row.services_total,
    services_active: row.services_active,
  };
}

/**
 * Пользователь глазами администратора.
 *
 * Хеша пароля здесь нет и быть не может — вместо него признак
 * `has_password`: администратору нужно знать, активирован ли вход,
 * и этого достаточно. `master_id` показывает, привязана ли к аккаунту
 * карточка мастера: от этого зависит, можно ли менять роль.
 */
export function adminUser(row, settings) {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    phone: row.phone,
    roles: row.roles,
    is_active: row.is_active === 1,
    has_password: row.has_password === 1,
    master_id: row.master_id ?? null,
    created_at: moment(row.created_at, settings),
  };
}

/** Настройки студии, которые нужны экранам: правила записи и часовой пояс. */
export function studio(settings) {
  return {
    name: settings.studio_name,
    timezone: settings.timezone,
    utc_offset_minutes: settings.utc_offset_minutes,
    booking_rules: {
      hold_minutes: settings.hold_minutes,
      booking_horizon_days: settings.booking_horizon_days,
      cancel_deadline_hours: settings.cancel_deadline_hours,
      max_client_reschedules: settings.max_client_reschedules,
      slot_step_minutes: settings.slot_step_minutes,
      min_lead_time_minutes: settings.min_lead_time_minutes,
    },
  };
}
