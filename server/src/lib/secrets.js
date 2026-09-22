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
 * Хеш пароля: scrypt с индивидуальной солью, формат scrypt$<соль>$<хеш>.
 *
 * Перец (PASSWORD_PEPPER) подмешивается из окружения и в базу не попадает:
 * утечки одного лишь файла базы не хватит, чтобы перебирать пароли.
 * Тот же формат использует seed.js — тестовые аккаунты входят наравне с живыми.
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password + env.passwordPepper, salt, KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${hash}`;
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
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password + env.passwordPepper, salt, expected.length);
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
