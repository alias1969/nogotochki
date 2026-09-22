/**
 * Регистрация, вход, выход и опознание сессии на каждом запросе.
 *
 * Сессия — строка в таблице sessions, а не самодостаточный токен. Это
 * решение схемы (раздел 7.13): кнопка «Выйти» должна действительно
 * прекращать доступ, а не только стирать cookie в одном браузере.
 */
import { getDb, transaction } from '../db/connection.js';
import { env } from '../config/env.js';
import { conflict, unauthorized } from '../lib/http-error.js';
import { hashPassword, verifyPassword, newToken, hashToken } from '../lib/secrets.js';
import { now, addMinutes } from '../lib/time.js';

/** Поля пользователя, которые нужны коду. password_hash берётся только при входе. */
const USER_FIELDS = 'id, email, full_name, phone, role, theme, is_active';

export function findUserById(userId) {
  return getDb().prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(userId) ?? null;
}

function findByEmail(email) {
  return getDb()
    .prepare(`SELECT ${USER_FIELDS}, password_hash FROM users WHERE email_normalized = ?`)
    .get(email.toLowerCase().trim()) ?? null;
}

/**
 * Открывает сессию и возвращает токен.
 *
 * Токен виден ровно один раз — здесь; в базу уходит только его хеш.
 * role_at_login фиксирует роль на момент входа: если администратор поменяет
 * роль позже, старая сессия не получит новые права молча, а закроется
 * при ближайшей проверке.
 */
function openSession(db, user, userAgent) {
  const token = newToken();
  const createdAt = now();
  db.prepare(
    `INSERT INTO sessions(user_id, token_hash, role_at_login, user_agent, created_at, last_seen_at, expires_at)
     VALUES (:user_id, :token_hash, :role, :agent, :created, :created, :expires)`,
  ).run({
    user_id: user.id,
    token_hash: hashToken(token),
    role: user.role,
    agent: userAgent ? userAgent.slice(0, 300) : null,
    created: createdAt,
    expires: addMinutes(createdAt, env.sessionTtlHours * 60),
  });
  return { token, expiresInSeconds: env.sessionTtlHours * 3600 };
}

/**
 * Регистрация клиента.
 *
 * Роль всегда 'user': роли master и admin назначает администратор, иначе
 * любой желающий получил бы админ-панель, передав role в теле запроса.
 */
export function register({ email, password, fullName, phone, userAgent }) {
  return transaction((db) => {
    const existing = db
      .prepare('SELECT id FROM users WHERE email_normalized = ?')
      .get(email.toLowerCase().trim());
    if (existing) throw conflict('email_taken', 'Аккаунт с таким e-mail уже существует');

    const inserted = db
      .prepare(
        `INSERT INTO users(email, password_hash, full_name, phone, role)
         VALUES (:email, :hash, :full_name, :phone, 'user')`,
      )
      .run({ email, hash: hashPassword(password), full_name: fullName, phone });

    const user = db
      .prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`)
      .get(inserted.lastInsertRowid);
    return { user, session: openSession(db, user, userAgent) };
  });
}

/**
 * Вход.
 *
 * Ответ на неверный e-mail и на неверный пароль одинаковый: иначе форма
 * входа превращается в способ проверить, записан ли человек в студию.
 * Пустой password_hash — аккаунт, заведённый администратором вручную;
 * такой аккаунт не пускает никого, пока владелец не задаст пароль.
 */
export function login({ email, password, userAgent }) {
  const user = findByEmail(email);
  const ok = user !== null && user.is_active === 1 && verifyPassword(password, user.password_hash);
  if (!ok) throw unauthorized('Неверный e-mail или пароль');

  delete user.password_hash;
  return transaction((db) => ({ user, session: openSession(db, user, userAgent) }));
}

/** Выход: сессия помечается revoked_at и больше не проходит проверку. */
export function logout(token) {
  if (!token) return;
  getDb()
    .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(now(), hashToken(token));
}

/**
 * Опознание сессии по токену. Вызывается на каждом запросе.
 *
 * Возвращает null там, где раньше бросал бы 401: решение о том, обязателен
 * ли вход, принимает конкретный маршрут, а не эта функция. Публичным
 * эндпоинтам (услуги, мастера, свободное время) вход не нужен.
 */
export function authenticate(token) {
  if (!token) return null;
  const db = getDb();
  const tokenHash = hashToken(token);
  const session = db
    .prepare(
      `SELECT s.id, s.user_id, s.role_at_login, s.expires_at
         FROM sessions s
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .get(tokenHash, now());
  if (!session) return null;

  const user = findUserById(session.user_id);
  if (!user || user.is_active !== 1) return null;

  // Роль изменилась после входа — сессия закрывается, нужен повторный вход.
  if (user.role !== session.role_at_login) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now(), session.id);
    return null;
  }

  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now(), session.id);
  return { user, sessionId: session.id, tokenHash };
}
