/**
 * Проверка входных данных.
 *
 * Правило одно: ни один обработчик не обращается к базе, пока все поля
 * запроса не проверены. Проверки собраны здесь, чтобы формат сообщения
 * об ошибке был одинаковым во всех эндпоинтах, а обработчик читался
 * как список требований к запросу.
 *
 * Каждая функция либо возвращает приведённое значение, либо бросает
 * HttpError 400 с именем поля — клиенту есть что подсветить в форме.
 */
import { badRequest } from './http-error.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// Проверка e-mail нарочно грубая: точная проверка по RFC ловит меньше опечаток,
// чем кажется, а отвергает живые адреса. Настоящая проверка — письмо на адрес.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9]{10,15}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function fail(field, message) {
  return badRequest('validation_failed', message, { field });
}

/** Тело запроса должно быть объектом, а не массивом, числом или null. */
export function object(value, field = 'body') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(field, 'Ожидается объект JSON');
  }
  return value;
}

export function string(value, field, { min = 1, max = 500, trim = true } = {}) {
  if (typeof value !== 'string') throw fail(field, 'Ожидается строка');
  const result = trim ? value.trim() : value;
  if (result.length < min) throw fail(field, `Минимальная длина — ${min}`);
  if (result.length > max) throw fail(field, `Максимальная длина — ${max}`);
  return result;
}

export function optionalString(value, field, options = {}) {
  if (value === undefined || value === null || value === '') return null;
  return string(value, field, options);
}

export function email(value, field = 'email') {
  const result = string(value, field, { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(result)) throw fail(field, 'Неверный формат e-mail');
  return result;
}

/**
 * Пароль проверяется только по длине.
 *
 * Требования вида «заглавная, цифра и спецсимвол» дают пароли, которые
 * люди записывают на бумажке; длина защищает лучше. Верхняя граница нужна
 * не для безопасности, а чтобы scrypt не считал хеш от мегабайтной строки.
 */
export function password(value, field = 'password') {
  return string(value, field, { min: 8, max: 200, trim: false });
}

export function phone(value, field = 'phone') {
  const result = string(value, field, { max: 20 }).replace(/[\s()-]/g, '');
  if (!PHONE_RE.test(result)) throw fail(field, 'Неверный формат телефона');
  return result;
}

export function integer(value, field, { min = null, max = null } = {}) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(parsed)) throw fail(field, 'Ожидается целое число');
  if (min !== null && parsed < min) throw fail(field, `Минимальное значение — ${min}`);
  if (max !== null && parsed > max) throw fail(field, `Максимальное значение — ${max}`);
  return parsed;
}

export function id(value, field) {
  return integer(value, field, { min: 1 });
}

export function boolean(value, field) {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw fail(field, 'Ожидается true или false');
}

/** Календарная дата 'YYYY-MM-DD'. Проверяется не только форма, но и существование дня. */
export function date(value, field = 'date') {
  const result = string(value, field, { max: 10 });
  if (!DATE_RE.test(result)) throw fail(field, 'Ожидается дата в формате ГГГГ-ММ-ДД');
  const parsed = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw fail(field, 'Такой даты не существует');
  }
  return result;
}

/** Момент времени 'YYYY-MM-DDTHH:MM:SSZ' — только UTC, местное время API не принимает. */
export function instant(value, field) {
  const result = string(value, field, { max: 20 });
  if (!INSTANT_RE.test(result)) {
    throw fail(field, 'Ожидается момент времени в UTC, например 2026-09-18T07:30:00Z');
  }
  const parsed = new Date(result);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().replace('.000', '') !== result) {
    throw fail(field, 'Такого момента времени не существует');
  }
  return result;
}

/**
 * Время суток 'HH:MM' — местное время студии.
 *
 * Единственный формат в сервисе, который не UTC, и это осознанно: график
 * мастера — это «работаю с 10:00 до 20:00» в человеческом смысле.
 * Он не должен уезжать при переводе часов, поэтому хранится как время
 * суток, а моментом становится уже при расчёте: дата + время + пояс.
 */
export function timeOfDay(value, field) {
  const result = string(value, field, { max: 5 });
  if (!TIME_RE.test(result)) throw fail(field, 'Ожидается время суток в формате ЧЧ:ММ');
  return result;
}

/** День недели по схеме: 1 — понедельник, 7 — воскресенье. */
export function weekday(value, field) {
  return integer(value, field, { min: 1, max: 7 });
}

export function oneOf(value, field, allowed) {
  const result = string(value, field, { max: 50 });
  if (!allowed.includes(result)) throw fail(field, `Допустимые значения: ${allowed.join(', ')}`);
  return result;
}

/**
 * Список идентификаторов услуг.
 *
 * Принимает и массив из тела запроса, и строку «1,2,3» из query.
 * Повторы запрещены: состав записи хранится с первичным ключом
 * (appointment_id, service_id), и дубль всё равно не сохранится.
 */
export function idList(value, field, { min = 1, max = 20 } = {}) {
  const raw = typeof value === 'string' ? value.split(',').filter((part) => part !== '') : value;
  if (!Array.isArray(raw)) throw fail(field, 'Ожидается список идентификаторов');
  if (raw.length < min) throw fail(field, `Нужно выбрать хотя бы ${min}`);
  if (raw.length > max) throw fail(field, `Не более ${max} элементов`);
  const result = raw.map((item, index) => id(item, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw fail(field, 'Повторяющиеся значения');
  return result;
}
