/**
 * Управление пользователями и ролями — экран A10.
 *
 * Здесь собраны все правки чужих аккаунтов. Своё человек правит сам
 * (profile.js), и эти два пути не пересекаются: администратор может
 * то, чего не может владелец аккаунта (роль, отключение, e-mail),
 * а владелец — то, что администратору решать не за что (тема оформления).
 *
 * Пароли администратор не задаёт и не видит никогда. Аккаунт создаётся
 * с пустым password_hash — это предусмотренное схемой состояние
 * «заведён вручную, вход не активирован», — а владелец задаёт себе
 * пароль сам, через восстановление по своему e-mail. Так администратор
 * не знает чужих паролей даже в момент выдачи доступа.
 */
import { getDb, transaction } from '../db/connection.js';
import { conflict, notFound, unprocessable } from '../lib/http-error.js';
import { now } from '../lib/time.js';
import { writeAudit } from './journal.js';
import { ROLES } from '../lib/roles.js';
import { setClause, placeholders } from '../db/sql.js';

/**
 * Колонки users, которые вправе править администратор.
 *
 * Роли здесь нет намеренно: они лежат в user_roles и правятся отдельно.
 * Нет и theme — это выбор владельца аккаунта, — и password_hash:
 * пароль администратор не задаёт никогда.
 */
const EDITABLE_COLUMNS = ['full_name', 'phone', 'email', 'is_active'];

const USER_SQL = `
SELECT u.id, u.email, u.full_name, u.phone, u.is_active,
       u.created_at, u.updated_at,
       (u.password_hash IS NOT NULL) AS has_password,
       m.id AS master_id
  FROM users u
  LEFT JOIN masters m ON m.user_id = u.id
`;

/**
 * Дописывает каждому найденному человеку его список ролей.
 *
 * Одним запросом на всю страницу, а не по запросу на строку: список
 * пользователей открывается с фильтром и листанием, и запрос на каждую
 * строку превратил бы один экран в полсотни обращений к базе.
 */
function attachRoles(rows, db = getDb()) {
  if (rows.length === 0) return rows;
  const byUser = new Map(rows.map((row) => [row.id, []]));
  const found = db
    .prepare(
      `SELECT user_id, role FROM user_roles
        WHERE user_id IN (${placeholders(rows.length)}) ORDER BY user_id, role`,
    )
    .all(...rows.map((row) => row.id));
  for (const item of found) byUser.get(item.user_id)?.push(item.role);
  return rows.map((row) => ({ ...row, roles: byUser.get(row.id) ?? [] }));
}

export function findUser(userId) {
  const row = getDb().prepare(`${USER_SQL} WHERE u.id = ?`).get(userId);
  if (!row) throw notFound('Пользователь не найден');
  return attachRoles([row])[0];
}

/**
 * Список пользователей.
 *
 * Фильтр `role` спрашивает «у кого эта роль есть», а не «чья роль равна»:
 * мастер, который заодно администратор, обязан находиться в обоих списках.
 *
 * Поиск идёт по имени, e-mail и телефону сразу: администратор ищет
 * человека тем, что помнит, а помнит он обычно что-то одно.
 *
 * По имени — через свою функцию ulower, а не встроенную lower:
 * встроенная знает только латиницу и «Ольгу» по запросу «ольга»
 * не находит (см. connection.js).
 * Листание курсором по возрастающему id — та же причина, что
 * и в уведомлениях: пока идёт листание, снизу добавляются новые строки.
 */
export function listUsers({ role = null, isActive = null, search = null, limit = 50, afterId = null } = {}) {
  const pattern = search ? `%${search.toLowerCase()}%` : null;
  const rows = getDb()
    .prepare(
      `${USER_SQL}
        WHERE (:role IS NULL
               OR EXISTS (SELECT 1 FROM user_roles ur
                           WHERE ur.user_id = u.id AND ur.role = :role))
          AND (:is_active IS NULL OR u.is_active = :is_active)
          AND (:pattern IS NULL OR ulower(u.full_name) LIKE :pattern
               OR u.email_normalized LIKE :pattern
               OR u.phone LIKE :pattern)
          AND (:after_id IS NULL OR u.id > :after_id)
        ORDER BY u.id
        LIMIT :limit`,
    )
    .all({ role, is_active: isActive, pattern, after_id: afterId, limit });
  return attachRoles(rows);
}

/** Сводка по визитам — карточка клиента на экране A8 без второго запроса. */
export function visitSummary(userId) {
  const byStatus = getDb()
    .prepare(
      `SELECT status, COUNT(*) AS visits FROM appointments
        WHERE client_id = ? GROUP BY status`,
    )
    .all(userId);
  const count = (status) => byStatus.find((row) => row.status === status)?.visits ?? 0;

  const last = getDb()
    .prepare(
      `SELECT starts_at FROM appointments
        WHERE client_id = ? AND status = 'completed'
        ORDER BY starts_at DESC LIMIT 1`,
    )
    .get(userId);

  return {
    total: byStatus.reduce((sum, row) => sum + row.visits, 0),
    completed: count('completed'),
    booked: count('booked'),
    no_show: count('no_show'),
    cancelled: count('cancelled'),
    last_visit_at: last?.starts_at ?? null,
  };
}

function assertEmailFree(db, email, exceptId = null) {
  const taken = db
    .prepare('SELECT id FROM users WHERE email_normalized = ?')
    .get(email.toLowerCase().trim());
  if (taken && taken.id !== exceptId) {
    throw conflict('email_taken', 'Аккаунт с таким e-mail уже существует');
  }
}

/** Выдать роли списком. granted_by — кто выдал, для разбора «откуда у него права». */
function grantRoles(db, userId, roles, grantedBy) {
  const insert = db.prepare(
    `INSERT INTO user_roles(user_id, role, granted_by) VALUES (?, ?, ?)
     ON CONFLICT(user_id, role) DO NOTHING`,
  );
  for (const role of roles) insert.run(userId, role, grantedBy);
}

/**
 * Создать аккаунт.
 *
 * Без пароля — владелец задаёт его себе сам через восстановление.
 * Роли по умолчанию — только `user`: так администратор заводит клиента,
 * который пришёл без записи, чтобы визит и контакты не потерялись.
 * Ролей можно выдать сразу несколько: мастер, который и сам ходит
 * в студию как клиент, заводится одной строкой.
 */
export function createUser({ admin, data }) {
  return transaction((db) => {
    assertEmailFree(db, data.email);

    const inserted = db
      .prepare(
        `INSERT INTO users(email, full_name, phone, is_active)
         VALUES (:email, :full_name, :phone, 1)`,
      )
      .run({ email: data.email, full_name: data.full_name, phone: data.phone });

    const id = Number(inserted.lastInsertRowid);
    grantRoles(db, id, data.roles, admin.id);

    writeAudit(db, {
      actorUserId: admin.id,
      actorRole: 'admin',
      action: 'create',
      entityType: 'user',
      entityId: id,
      details: { roles: data.roles, email: data.email },
    });
    return id;
  });
}

/**
 * Сколько действующих администраторов останется, если применить правку.
 *
 * Считается до записи: студия без единого администратора — это студия,
 * в которую больше никто не войдёт с правами, и чинить это придётся
 * руками в базе.
 *
 * Роль администратора теперь одна из нескольких, поэтому вопрос звучит
 * «у скольких людей роль admin есть», а не «у скольких она единственная».
 */
function activeAdminsAfter(db, user, patch) {
  const current = db
    .prepare(
      `SELECT COUNT(*) AS count FROM users u
        WHERE u.is_active = 1
          AND EXISTS (SELECT 1 FROM user_roles ur
                       WHERE ur.user_id = u.id AND ur.role = 'admin')`,
    )
    .get().count;

  const wasAdmin = user.roles.includes('admin') && user.is_active === 1;
  const willBeAdmin =
    (patch.roles ?? user.roles).includes('admin') &&
    (patch.is_active ?? user.is_active) === 1;

  return current - (wasAdmin ? 1 : 0) + (willBeAdmin ? 1 : 0);
}

/**
 * Изменить чужой аккаунт: контакты, e-mail, роли, признак активности.
 *
 * Роли приходят списком и заменяют прежний целиком: администратор видит
 * на экране набор галочек и присылает то, что на нём отмечено. Присылать
 * «добавь эту, убери ту» было бы правдивее по смыслу, но на экране всё
 * равно виден весь набор, и разница между «список пуст» и «ничего
 * не менять» стала бы неразличимой.
 *
 * Четыре правила, каждое закрывает свою дыру.
 *
 * 1. Себя администратор не разжалует и не отключит. Формально это частный
 *    случай правила о последнем администраторе, но сообщение нужно другое:
 *    человек чаще всего просто промахнулся строкой в списке.
 *
 * 2. Последнего действующего администратора нельзя ни разжаловать,
 *    ни отключить. Иначе в студию не войдёт никто.
 *
 *    Через этот эндпоинт до проверки дойти нельзя: тот, кто её вызвал,
 *    сам действующий администратор, а себя он трогать не может (правило 1).
 *    Проверка оставлена сознательно, как страховка: она сторожит инвариант
 *    «хотя бы один администратор», а не конкретный сценарий, и сработает,
 *    если правило 1 когда-нибудь ослабят или появится другой путь правки —
 *    перенос владения, массовый импорт, служебный скрипт.
 *
 * 3. У мастера с привязанной карточкой нельзя отнять роль master.
 *    Карточка осталась бы висеть на аккаунте, который в кабинет мастера
 *    уже не попадает. Сначала отвязать карточку, потом снимать роль.
 *    Остальные роли при этом меняются свободно: выдать мастеру роль
 *    администратора карточке не мешает — ради этого списки и заведены.
 *
 * 4. Список ролей не бывает пустым. Аккаунт без единой роли — это не
 *    «клиент», а человек, которому недоступны даже собственные записи.
 *
 * Смена ролей и отключение закрывают все сессии этого человека: список
 * ролей зафиксирован в сессии на момент входа, и продолжать работать
 * со старыми правами он не должен.
 */
export function updateUser({ admin, user, patch }) {
  const fields = Object.keys(patch);
  if (fields.length === 0) {
    throw unprocessable('nothing_to_update', 'Не передано ни одного поля');
  }

  // Список сравнивается как множество: порядок галочек на экране
  // не должен выглядеть сменой ролей.
  const nextRoles = patch.roles === undefined ? null : [...new Set(patch.roles)].sort();
  const rolesChange = nextRoles !== null && nextRoles.join(',') !== [...user.roles].sort().join(',');
  const deactivates = patch.is_active === 0 && user.is_active === 1;

  if (nextRoles !== null && nextRoles.length === 0) {
    throw unprocessable('roles_empty', 'У аккаунта должна остаться хотя бы одна роль');
  }

  if ((rolesChange || deactivates) && user.id === admin.id) {
    throw unprocessable(
      'self_demotion',
      rolesChange
        ? 'Нельзя менять роли самому себе — попросите другого администратора'
        : 'Нельзя отключить собственный аккаунт',
    );
  }

  if (rolesChange && user.master_id !== null && !nextRoles.includes('master')) {
    throw conflict(
      'master_card_linked',
      'К аккаунту привязана карточка мастера — сначала отвяжите её на экране мастеров',
      { master_id: user.master_id },
    );
  }

  return transaction((db) => {
    if (rolesChange || patch.is_active !== undefined) {
      if (activeAdminsAfter(db, user, { ...patch, roles: nextRoles ?? user.roles }) < 1) {
        throw unprocessable(
          'last_admin',
          'Это последний действующий администратор — студия останется без доступа',
        );
      }
    }
    if (patch.email !== undefined) assertEmailFree(db, patch.email, user.id);

    // Роли лежат в отдельной таблице, поэтому в UPDATE users они не идут.
    const { roles, ...columns } = patch;
    const { fields: columnNames, clause, params } = setClause(columns, EDITABLE_COLUMNS);
    if (columnNames.length > 0) {
      db.prepare(`UPDATE users SET ${clause}, updated_at = :now WHERE id = :id`)
        .run({ ...params, now: now(), id: user.id });
    }

    if (rolesChange) {
      const removed = user.roles.filter((role) => !nextRoles.includes(role));
      if (removed.length > 0) {
        db.prepare(
          `DELETE FROM user_roles WHERE user_id = ? AND role IN (${placeholders(removed.length)})`,
        ).run(user.id, ...removed);
      }
      grantRoles(db, user.id, nextRoles.filter((role) => !user.roles.includes(role)), admin.id);
      db.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(now(), user.id);
    }

    // Список ролей зафиксирован в сессии на момент входа — со старыми
    // правами работать нельзя. Отключённый аккаунт тем более не должен
    // остаться с живой сессией.
    let revoked = 0;
    if (rolesChange || deactivates) {
      revoked = db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(now(), user.id).changes;
    }

    writeAudit(db, {
      actorUserId: admin.id,
      actorRole: 'admin',
      // Смена ролей — отдельное действие в журнале: его ищут отдельно
      // и смотрят внимательнее остальных правок.
      action: rolesChange ? 'role_change' : 'update',
      entityType: 'user',
      entityId: user.id,
      details: {
        ...Object.fromEntries(
          columnNames.map((field) => [field, { from: user[field], to: patch[field] }]),
        ),
        ...(rolesChange ? { roles: { from: user.roles, to: nextRoles } } : {}),
        sessions_revoked: revoked,
      },
    });

    return { sessionsRevoked: revoked };
  });
}

/** Справочная матрица прав — экран A10. Правами не управляет, только описывает. */
export function permissionMatrix() {
  const rows = getDb()
    .prepare(
      `SELECT role, permission_key, permission_group, title, is_allowed, note
         FROM role_permissions ORDER BY permission_group, permission_key, role`,
    )
    .all();

  const byKey = new Map();
  for (const row of rows) {
    if (!byKey.has(row.permission_key)) {
      byKey.set(row.permission_key, {
        key: row.permission_key,
        group: row.permission_group,
        title: row.title,
        roles: {},
      });
    }
    byKey.get(row.permission_key).roles[row.role] = {
      allowed: row.is_allowed === 1,
      note: row.note,
    };
  }

  const groups = new Map();
  for (const item of byKey.values()) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }

  return {
    roles: ROLES,
    groups: [...groups.entries()].map(([name, permissions]) => ({ group: name, permissions })),
  };
}
