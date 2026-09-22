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
import { serialize } from '../lib/roles.js';
import { now, addMinutes } from '../lib/time.js';

/** Поля пользователя, которые нужны коду. password_hash берётся только при входе. */
const USER_FIELDS = 'id, email, full_name, phone, theme, is_active';

/**
 * Роли человека — из базы, и только из базы.
 *
 * Ни тело запроса, ни заголовок, ни cookie на этот список не влияют:
 * роль, присланная клиентом, — это не проверка прав, а просьба
 * к злоумышленнику назвать себя честно. Список отсортирован, чтобы
 * его можно было сравнивать со снимком в сессии как строку.
 */
export function rolesOf(userId, db = getDb()) {
  return db
    .prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role')
    .all(userId)
    .map((row) => row.role);
}

/** Пользователь вместе со своим списком ролей. Ниже по коду роли есть всегда. */
function withRoles(row, db = getDb()) {
  if (!row) return null;
  return { ...row, roles: rolesOf(row.id, db) };
}

export function findUserById(userId) {
  return withRoles(getDb().prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(userId));
}

function findByEmail(email) {
  return withRoles(
    getDb()
      .prepare(`SELECT ${USER_FIELDS}, password_hash FROM users WHERE email_normalized = ?`)
      .get(email.toLowerCase().trim()),
  );
}

/**
 * Удаляет истёкшие сессии.
 *
 * Доступа такая строка не даёт и без уборки — authenticate берёт только
 * сессии с expires_at > now. Уборка нужна, чтобы таблица не росла вечно:
 * в мёртвой строке лежат хеш токена и строка браузера, а у активного
 * клиента новая сессия появляется на каждое устройство и каждый вход.
 *
 * Вызывается при открытии новой сессии — там, где таблица и так пишется;
 * так же устроен sweepExpiredHolds у резервов. На проверке сессии уборку
 * не делаем: она идёт на каждом запросе сервиса, и запись в базу там
 * обошлась бы дороже, чем те несколько строк, которые она убирает.
 *
 * Отозванные сессии (выход, смена пароля, смена роли) отдельного правила
 * не требуют: revoked_at прекращает доступ сразу, а строка уходит вместе
 * с остальными, когда дойдёт до своего исходного срока.
 */
export function sweepExpiredSessions(db = getDb()) {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()).changes;
}

/**
 * Открывает сессию и возвращает токен.
 *
 * Токен виден ровно один раз — здесь; в базу уходит только его хеш
 * (HMAC с ключом из окружения, см. lib/secrets.js). По украденной базе
 * нельзя ни восстановить токен, ни проверить догадку о нём.
 *
 * Срок жизни ограничен: expires_at = время входа + SESSION_TTL_HOURS,
 * и он проставляется здесь, а не рассчитывается при проверке. Вечных
 * токенов в сервисе нет — даже незамеченная кража перестаёт работать сама.
 * Клиент узнаёт этот срок из ответа и может заранее предложить войти снова.
 *
 * roles_at_login фиксирует список ролей на момент входа: если администратор
 * поменяет роли позже, старая сессия не получит новые права молча,
 * а закроется при ближайшей проверке. Сравнивается список целиком —
 * и выдача роли, и снятие одинаково закрывают сессию.
 */
function openSession(db, user, userAgent) {
  sweepExpiredSessions(db);

  const token = newToken();
  const createdAt = now();
  const expiresAt = addMinutes(createdAt, env.sessionTtlHours * 60);
  db.prepare(
    `INSERT INTO sessions(user_id, token_hash, roles_at_login, user_agent, created_at, last_seen_at, expires_at)
     VALUES (:user_id, :token_hash, :roles, :agent, :created, :created, :expires)`,
  ).run({
    user_id: user.id,
    token_hash: hashToken(token),
    roles: serialize(user.roles),
    agent: userAgent ? userAgent.slice(0, 300) : null,
    created: createdAt,
    expires: expiresAt,
  });
  return { token, expiresAt, expiresInSeconds: env.sessionTtlHours * 3600 };
}

/**
 * Регистрация клиента.
 *
 * Роль всегда одна и всегда 'user': роли master и admin назначает
 * администратор. Тело запроса на список ролей не влияет никак — иначе
 * любой желающий получил бы админ-панель, дописав роль в форму регистрации.
 */
export function register({ email, password, fullName, phone, userAgent }) {
  return transaction((db) => {
    const existing = db
      .prepare('SELECT id FROM users WHERE email_normalized = ?')
      .get(email.toLowerCase().trim());
    if (existing) throw conflict('email_taken', 'Аккаунт с таким e-mail уже существует');

    const inserted = db
      .prepare(
        `INSERT INTO users(email, password_hash, full_name, phone)
         VALUES (:email, :hash, :full_name, :phone)`,
      )
      .run({ email, hash: hashPassword(password), full_name: fullName, phone });

    const id = Number(inserted.lastInsertRowid);
    db.prepare("INSERT INTO user_roles(user_id, role) VALUES (?, 'user')").run(id);

    const user = withRoles(db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(id), db);
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
      `SELECT s.id, s.user_id, s.roles_at_login, s.expires_at
         FROM sessions s
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .get(tokenHash, now());
  if (!session) return null;

  const user = findUserById(session.user_id);
  if (!user || user.is_active !== 1) return null;

  // Список ролей изменился после входа — сессия закрывается, нужен
  // повторный вход. Сравниваются оба списка целиком: и выданная роль,
  // и снятая одинаково делают снимок недействительным.
  if (serialize(user.roles) !== session.roles_at_login) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now(), session.id);
    return null;
  }

  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now(), session.id);
  return { user, sessionId: session.id, tokenHash };
}
