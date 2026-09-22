/**
 * Свой профиль — экран K5 у клиента, M4 у мастера.
 *
 * Меняется ровно три поля: имя, телефон и тема оформления. Всё остальное,
 * что лежит в той же строке users, человек о себе не решает:
 *
 *   role      — назначает администратор. Иначе любой клиент выписал бы
 *               себе админ-панель одним полем в теле запроса.
 *   is_active — отключение аккаунта тоже решение студии, а не своё.
 *   password  — своя операция со своими правилами: нужен текущий пароль
 *               и сброс остальных сессий (см. passwords.js).
 *   email     — намеренно не здесь, объяснение ниже.
 *
 * Поля, которых в списке нет, не читаются из запроса вовсе. Не «читаются
 * и отбрасываются», а не читаются: прислать role: 'admin' можно, попасть
 * в базу оно не может.
 *
 * Почему e-mail не меняется самостоятельно. Это логин и единственный
 * способ восстановить доступ. Опечатка в нём выбрасывает человека
 * из аккаунта безвозвратно: ссылка восстановления уйдёт на адрес,
 * которого он не читает. Защищаться от этого принято подтверждением
 * по новому адресу — а отправки писем в MVP нет (паспорт: «интеграция
 * с e-mail или Telegram не входит в MVP»). Пока её нет, e-mail меняет
 * администратор, который может убедиться, кто перед ним.
 */
import { getDb, transaction } from '../db/connection.js';
import { badRequest } from '../lib/http-error.js';
import { now } from '../lib/time.js';

/** Что человек вправе поменять у себя. Список закрытый и короткий. */
const EDITABLE = ['full_name', 'phone', 'theme'];

export function updateProfile({ user, patch }) {
  const fields = EDITABLE.filter((field) => patch[field] !== undefined);
  if (fields.length === 0) {
    throw badRequest('nothing_to_update', 'Не передано ни одного поля профиля');
  }

  return transaction((db) => {
    const assignments = fields.map((field) => `${field} = :${field}`).join(', ');
    db.prepare(`UPDATE users SET ${assignments}, updated_at = :now WHERE id = :id`).run({
      ...Object.fromEntries(fields.map((field) => [field, patch[field]])),
      now: now(),
      id: user.id,
    });

    return db
      .prepare('SELECT id, email, full_name, phone, role, theme FROM users WHERE id = ?')
      .get(user.id);
  });
}

/** Свой профиль целиком. Чужой не отдаёт никому: выборка по номеру из сессии. */
export function loadProfile(userId) {
  return getDb()
    .prepare('SELECT id, email, full_name, phone, role, theme, created_at FROM users WHERE id = ?')
    .get(userId);
}
