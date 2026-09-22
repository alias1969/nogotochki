/**
 * Пароли и токены.
 *
 * В базе не лежит ни одного секрета в открытом виде — ни пароля, ни токена
 * сессии, ни токена резерва. Здесь собрано всё, что превращает секрет в хеш,
 * чтобы правило было видно одним файлом и не расползалось по сервисам.
 */
import { scryptSync, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../config/env.js';

const KEY_LENGTH = 64;

/**
 * Параметры стойкости scrypt.
 *
 * N — число итераций (оно же цена перебора), r — размер блока, p — параллелизм.
 * Значения совпадают с умолчаниями Node, но выписаны явно: их нельзя менять
 * молча, потому что от них зависит проверка уже сохранённых паролей.
 * Память под один вызов ≈ 128 · N · r ≈ 16 МиБ — укладывается в лимит maxmem.
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/** Параметры в строку хеша: n=16384,r=8,p=1 */
function encodeParams({ N, r, p }) {
  return `n=${N},r=${r},p=${p}`;
}

/**
 * Разбор параметров из сохранённого хеша.
 *
 * Значения берутся из самой строки, а не из константы выше: иначе повышение
 * стойкости завтра сделало бы невходибельными все пароли, захешированные
 * сегодня. Хеши старого формата (без блока параметров) читаются с текущими
 * умолчаниями — тем, с чем они и были созданы.
 */
function decodeParams(text) {
  const out = { ...SCRYPT_PARAMS };
  for (const pair of text.split(',')) {
    const [key, value] = pair.split('=');
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return null;
    if (key === 'n') out.N = n;
    else if (key === 'r') out.r = n;
    else if (key === 'p') out.p = n;
    else return null;
  }
  return out;
}

/**
 * Хеш пароля: scrypt с индивидуальной солью и параметрами стойкости в строке.
 *
 * Формат: scrypt$<параметры>$<соль>$<хеш>. Соль случайная и своя у каждого
 * пароля — одинаковые пароли дают разные хеши, и радужная таблица бесполезна.
 * Параметры лежат рядом с хешем, чтобы их можно было поднять, не ломая вход
 * тем, кто завёл пароль раньше.
 *
 * Перец (PASSWORD_PEPPER) подмешивается из окружения и в базу не попадает:
 * утечки одного лишь файла базы не хватит, чтобы перебирать пароли.
 * Ту же функцию вызывает seed.js — тестовые аккаунты входят наравне с живыми.
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password + env.passwordPepper, salt, KEY_LENGTH, SCRYPT_PARAMS).toString('hex');
  return `scrypt$${encodeParams(SCRYPT_PARAMS)}$${salt}$${hash}`;
}

/**
 * Проверка пароля.
 *
 * Сравнение через timingSafeEqual: обычное === выходит из цикла на первом
 * несовпавшем байте, и по времени ответа хеш можно подбирать посимвольно.
 * Пустой password_hash (аккаунт заведён администратором вручную) не пускает
 * никого — это состояние аккаунта, а не пароль по умолчанию.
 */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || stored === '') return false;

  const parts = stored.split('$');
  // Четыре части — текущий формат, три — прежний, без блока параметров.
  const [scheme, rawParams, salt, hash] =
    parts.length === 4 ? parts : [parts[0], encodeParams(SCRYPT_PARAMS), parts[1], parts[2]];
  if (scheme !== 'scrypt' || !salt || !hash) return false;

  const params = decodeParams(rawParams ?? '');
  if (!params) return false;

  const expected = Buffer.from(hash, 'hex');
  if (expected.length === 0) return false;

  let actual;
  try {
    actual = scryptSync(password + env.passwordPepper, salt, expected.length, params);
  } catch {
    // Параметры из строки могут не пройти проверку maxmem — это испорченный
    // хеш, а не верный пароль.
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Случайный токен на предъявителя: сессия, резерв, ссылка восстановления. */
export function newToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Хеш токена для хранения и поиска.
 *
 * HMAC, а не голый sha256: токен случаен и перебору не поддаётся, но с ключом
 * из окружения по украденной базе нельзя даже сверить догадку.
 * Функция быстрая намеренно — она вызывается на каждом запросе с сессией.
 */
export function hashToken(token) {
  return createHmac('sha256', env.sessionSecret).update(token).digest('hex');
}
