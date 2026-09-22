/**
 * Восстановление и смена пароля.
 *
 * Три операции, у которых одна общая обязанность: после смены пароля
 * прежние сессии не должны продолжать работать. Ради этого сессии
 * и лежат в базе (раздел 7.13 схемы) — иначе восстановление пароля
 * не решало бы ту задачу, ради которой его обычно и делают: выгнать
 * того, кто уже сидит в аккаунте.
 *
 * Токен ссылки — такой же секрет на предъявителя, как токен сессии,
 * и хранится так же: в базе только хеш. Утечка базы не должна давать
 * возможность войти в чужой аккаунт по ссылке восстановления.
 */
import { getDb, transaction } from '../db/connection.js';
import { env } from '../config/env.js';
import { conflict, unauthorized, unprocessable } from '../lib/http-error.js';
import { hashPassword, verifyPassword, newToken, hashToken } from '../lib/secrets.js';
import { now, addMinutes } from '../lib/time.js';
import { writeAudit, notify, actorRoleOf } from './journal.js';

/**
 * Не чаще одной ссылки в минуту на аккаунт.
 *
 * Без этого форма «забыли пароль» превращается в кнопку «завалить
 * человека письмами»: адрес вводит кто угодно, а письма приходят владельцу.
 */
const MIN_INTERVAL_MINUTES = 1;

/** Сессия считается живой, если revoked_at пуст и срок не вышел. */
function revokeSessions(db, userId, { except = null } = {}) {
  return db
    .prepare(
      `UPDATE sessions SET revoked_at = :now
        WHERE user_id = :user_id AND revoked_at IS NULL
          AND (:except IS NULL OR id <> :except)`,
    )
    .run({ now: now(), user_id: userId, except }).changes;
}

/** Все ещё не использованные ссылки этого аккаунта гасятся. */
function burnTokens(db, userId) {
  return db
    .prepare(
      `UPDATE password_reset_tokens SET used_at = ?
        WHERE user_id = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .run(now(), userId, now()).changes;
}

/**
 * Запрос ссылки восстановления.
 *
 * Возвращает токен, если ссылку нужно отправить, и null во всех
 * остальных случаях — включая случай «такого e-mail нет». Обработчик
 * в обоих случаях отвечает одинаково: иначе форма восстановления
 * превращается в способ проверить, записан ли человек в студию.
 * Та же причина, по которой не различаются ошибки входа.
 *
 * Аккаунт с пустым password_hash — заведённый администратором вручную —
 * ссылку получает. Это и есть предусмотренный схемой способ забрать
 * такой аккаунт себе: пароля нет, значит и войти по нему нельзя,
 * а восстановление как раз и задаёт первый пароль.
 */
export function requestReset(email) {
  const db = getDb();
  const user = db
    .prepare('SELECT id, is_active FROM users WHERE email_normalized = ?')
    .get(email.toLowerCase().trim());

  if (!user || user.is_active !== 1) return null;

  const recent = db
    .prepare(
      `SELECT id FROM password_reset_tokens
        WHERE user_id = ? AND used_at IS NULL AND created_at > ?`,
    )
    .get(user.id, addMinutes(now(), -MIN_INTERVAL_MINUTES));
  if (recent) return null;

  const token = newToken();
  transaction((db2) => {
    // Прежние ссылки гасятся: рабочей остаётся только последняя.
    // Иначе старое письмо, найденное в почте через месяц, всё ещё
    // открывало бы вход.
    burnTokens(db2, user.id);
    db2
      .prepare(
        `INSERT INTO password_reset_tokens(user_id, token_hash, expires_at)
         VALUES (?, ?, ?)`,
      )
      .run(user.id, hashToken(token), addMinutes(now(), env.passwordResetTtlMinutes));
  });

  return token;
}

/**
 * Состояние ссылки — для экрана, на который человек попал по письму.
 *
 * Отдельная проверка нужна, чтобы не предлагать придумать пароль
 * и только потом сообщить, что ссылка протухла.
 */
export function checkResetToken(token) {
  const row = getDb()
    .prepare(
      `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?`,
    )
    .get(hashToken(token));

  if (!row) return { valid: false, reason: 'unknown' };
  if (row.used_at !== null) return { valid: false, reason: 'used' };
  if (row.expires_at <= now()) return { valid: false, reason: 'expired' };
  return { valid: true, userId: row.user_id, tokenId: row.id, expiresAt: row.expires_at };
}

/**
 * Смена пароля по ссылке.
 *
 * Ссылка одноразовая: used_at проставляется в той же транзакции, что
 * и новый пароль. Повторный переход по тому же письму — уже отказ.
 *
 * Все сессии аккаунта закрываются, без исключений. Человек, который
 * восстанавливает пароль, чаще всего делает это именно потому, что
 * в аккаунт зашёл кто-то другой; оставить тому живую сессию — значит
 * не сделать ничего.
 */
export function resetPassword({ token, password }) {
  const state = checkResetToken(token);
  if (!state.valid) {
    throw conflict(`reset_token_${state.reason}`, {
      unknown: 'Ссылка недействительна — запросите восстановление заново',
      used: 'Ссылка уже использована — запросите восстановление заново',
      expired: 'Срок действия ссылки истёк — запросите восстановление заново',
    }[state.reason]);
  }

  return transaction((db) => {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(password), now(), state.userId);
    db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?').run(now(), state.tokenId);
    burnTokens(db, state.userId);

    const revoked = revokeSessions(db, state.userId);

    // В журнал идёт сам факт смены. Ни старого, ни нового пароля,
    // ни токена: журнал читают люди, и попадать в него секретам незачем.
    writeAudit(db, {
      actorUserId: state.userId,
      actorRole: 'client',
      action: 'password_change',
      entityType: 'user',
      entityId: state.userId,
      details: { by: 'reset_link', sessions_revoked: revoked },
    });

    notify(db, {
      userId: state.userId,
      kind: 'system',
      title: 'Пароль изменён',
      body: 'Пароль восстановлен по ссылке из письма. Все прежние входы закрыты.',
    });

    return { userId: state.userId, sessionsRevoked: revoked };
  });
}

/**
 * Смена пароля изнутри кабинета.
 *
 * Текущий пароль обязателен: без него любой, кто подсел за незакрытый
 * ноутбук, менял бы пароль и забирал аккаунт себе.
 *
 * Текущая сессия остаётся живой, остальные закрываются. Выкидывать
 * человека из вкладки, в которой он только что сменил пароль, — вредная
 * строгость; смысл в том, чтобы выгнать всех остальных.
 */
export function changePassword({ user, sessionId, currentPassword, newPassword }) {
  const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);

  if (!verifyPassword(currentPassword, row.password_hash)) {
    throw unauthorized('Текущий пароль указан неверно');
  }
  if (currentPassword === newPassword) {
    throw unprocessable('password_unchanged', 'Новый пароль совпадает с текущим');
  }

  return transaction((db) => {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(newPassword), now(), user.id);
    burnTokens(db, user.id);

    const revoked = revokeSessions(db, user.id, { except: sessionId });

    writeAudit(db, {
      actorUserId: user.id,
      actorRole: actorRoleOf(user),
      action: 'password_change',
      entityType: 'user',
      entityId: user.id,
      details: { by: 'cabinet', sessions_revoked: revoked },
    });

    notify(db, {
      userId: user.id,
      kind: 'system',
      title: 'Пароль изменён',
      body: revoked > 0
        ? `Пароль изменён. Другие входы (${revoked}) закрыты.`
        : 'Пароль изменён.',
    });

    return { sessionsRevoked: revoked };
  });
}
