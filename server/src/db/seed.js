/**
 * Тестовые данные для разработки.
 *
 * Наполняет базу связным набором, на котором можно щупать сервис:
 * три роли, два мастера с профилями, пять услуг, недельные графики
 * и несколько записей на ближайшие дни, чтобы календарь не был пустым.
 *
 * Повторный запуск не создаёт дублей и не стирает базу:
 *   * справочники добавляются с фиксированными идентификаторами
 *     через INSERT ... ON CONFLICT DO UPDATE — повторный запуск обновляет
 *     описания и ничего не плодит;
 *   * пароли при повторном запуске не перехешируются: если аккаунт уже есть,
 *     его password_hash остаётся прежним;
 *   * записи помечены как тестовые (admin_note = 'seed') и при каждом запуске
 *     пересоздаются заново — иначе «ближайшие дни» со временем уехали бы
 *     в прошлое, и календарь опять опустел бы.
 *
 * В продакшене не запускается.
 *
 * Запуск: npm run seed
 */
import { scryptSync, randomBytes } from 'node:crypto';

import { env } from '../config/env.js';
import { getDb, closeDb, transaction } from './connection.js';
import { runMigrations } from './migrate.js';

/** Метка тестовых записей: по ней они находятся и пересоздаются. */
const SEED_MARK = 'seed';

/**
 * Хеш пароля для тестовых данных.
 *
 * Настоящая проверка входа появится в коде авторизации; здесь ровно столько,
 * сколько нужно, чтобы в базе не оказалось пароля в открытом виде.
 * Формат: scrypt$<соль>$<хеш>, перец подмешивается из окружения.
 */
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password + env.passwordPepper, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

// --------------------------------------------------------------------------
// Справочные данные
// --------------------------------------------------------------------------

const SETTINGS = [
  ['studio_name', 'Ноготочки', 'Название студии в шапке и подвале'],
  ['studio_address', 'Москва, ул. Примерная, 1', 'Адрес на лендинге'],
  ['studio_phone', '+7 900 000-00-00', 'Телефон на лендинге'],
  ['studio_about', 'Маленькая студия с тёплым светом и вниманием к деталям.', 'Блок «О студии»'],
  ['timezone', 'Europe/Moscow', 'Часовой пояс студии для вывода на экран'],
  ['utc_offset_minutes', '180', 'Смещение пояса в минутах — используется в расчётах'],
  ['hold_minutes', '10', 'Сколько живёт резерв слота'],
  ['booking_horizon_days', '90', 'На сколько дней вперёд открыт календарь'],
  ['cancel_deadline_hours', '24', 'За сколько часов клиент может отменить'],
  ['max_client_reschedules', '3', 'Лимит переносов клиентом'],
  ['slot_step_minutes', '15', 'Шаг сетки свободного времени'],
  ['min_lead_time_minutes', '120', 'Минимальный срок до визита'],
  ['buffer_after_minutes', '0', 'Технический перерыв после визита'],
];

/** 1 = понедельник ... 7 = воскресенье. */
const STUDIO_HOURS = [
  [1, 0, '09:00', '21:00'], [2, 0, '09:00', '21:00'], [3, 0, '09:00', '21:00'],
  [4, 0, '09:00', '21:00'], [5, 0, '09:00', '21:00'], [6, 0, '10:00', '18:00'],
  [7, 1, null, null],
];

const CATEGORIES = [
  [1, 'Ногтевой сервис', 1],
  [2, 'Уход', 2],
];

/** id, категория, название, описание, минуты, копейки, порядок */
const SERVICES = [
  [1, 1, 'Маникюр', 'Аппаратный маникюр с обработкой кутикулы', 60, 250000, 1],
  [2, 1, 'Покрытие гель-лаком', 'Однотонное покрытие в один слой', 30, 150000, 2],
  [3, 1, 'Снятие покрытия', 'Бережное снятие прежнего гель-лака', 15, 50000, 3],
  [4, 1, 'Дизайн ногтей', 'Роспись, втирка или стразы на два-четыре ногтя', 30, 90000, 4],
  [5, 2, 'СПА-уход за руками', 'Скраб, массаж и питательная маска', 45, 180000, 5],
];

/** id, e-mail, пароль, имя, телефон, роль, тема */
const USERS = [
  [1, env.seedAdminEmail, env.seedAdminPassword, 'Елена Администратор', '+79000000001', 'admin', 'day'],
  [2, 'olga@nogotochki.local', 'master12345', 'Ольга Петровна Смирнова', '+79000000002', 'master', 'evening'],
  [3, 'irina@nogotochki.local', 'master12345', 'Ирина Андреевна Волкова', '+79000000003', 'master', 'day'],
  [4, 'anna@example.com', 'client12345', 'Анна Королёва', '+79000000004', 'user', 'day'],
  // Клиент, заведённый администратором вручную: аккаунт есть, входа ещё нет.
  [5, 'walkin@example.com', null, 'Мария Ковалёва', '+79000000005', 'user', 'day'],
];

/** id, user_id, псевдоним, специализация, о себе, порядок */
const MASTERS = [
  [1, 2, 'Ольга', 'Маникюр и покрытие',
    'Двенадцать лет за столом. Любит аккуратную классику и плотные однотонные покрытия. ' +
    'Работает только аппаратом, без пропилов.', 1],
  // display_name пустой: имя берётся из users.full_name
  [2, 3, null, 'Дизайн и уход',
    'Пришла в профессию из графики, поэтому дизайн — её часть работы, а не дополнение. ' +
    'Ведёт СПА-уход и сложную роспись.', 2],
];

const MASTER_SERVICES = [
  [1, [1, 2, 3]],        // Ольга: маникюр, покрытие, снятие
  [2, [1, 2, 3, 4, 5]],  // Ирина: всё, включая дизайн и уход
];

/**
 * Недельные графики. Ольга работает пн–пт с перерывом на обед,
 * Ирина — вт–сб сплошным днём.
 */
const SCHEDULES = [
  ...[1, 2, 3, 4, 5].flatMap((weekday) => [
    [1, weekday, '10:00', '14:00'],
    [1, weekday, '15:00', '20:00'],
  ]),
  ...[2, 3, 4, 5, 6].map((weekday) => [2, weekday, '11:00', '19:00']),
];

// --------------------------------------------------------------------------
// Работа со временем
// --------------------------------------------------------------------------

const iso = (date) => `${date.toISOString().slice(0, 19)}Z`;
const ymd = (date) => date.toISOString().slice(0, 10);

/** Номер дня недели по схеме: 1 = понедельник ... 7 = воскресенье. */
function weekdayOf(date) {
  return ((date.getUTCDay() + 6) % 7) + 1;
}

/** Местное время студии -> момент UTC. */
function localToUtc(dateStr, timeStr, offsetMinutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - offsetMinutes * 60000);
}

/**
 * Ближайшая дата, в которую мастер работает: не раньше, чем через
 * fromDays дней, с учётом графика мастера, часов студии и закрытий.
 */
function findWorkingDate(db, masterId, fromDays) {
  const today = new Date();
  for (let shift = fromDays; shift < fromDays + 21; shift += 1) {
    const day = new Date(Date.UTC(
      today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + shift,
    ));
    const date = ymd(day);
    const weekday = weekdayOf(day);

    const works = db.prepare(
      `SELECT 1 FROM master_schedules
        WHERE master_id = ? AND weekday = ? AND ? >= valid_from
          AND (valid_to IS NULL OR ? <= valid_to) LIMIT 1`,
    ).get(masterId, weekday, date, date);
    if (!works) continue;

    const open = db.prepare(
      'SELECT 1 FROM studio_hours WHERE weekday = ? AND is_closed = 0',
    ).get(weekday);
    if (!open) continue;

    const closed = db.prepare(
      'SELECT 1 FROM studio_closures WHERE ? BETWEEN date_from AND date_to',
    ).get(date);
    if (closed) continue;

    return date;
  }
  throw new Error(`Не нашёл рабочий день для мастера ${masterId}`);
}

// --------------------------------------------------------------------------
// Заполнение
// --------------------------------------------------------------------------

function seedReferenceData(db) {
  const setting = db.prepare(
    `INSERT INTO settings(key, value, description) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                      description = excluded.description`,
  );
  for (const row of SETTINGS) setting.run(...row);

  const hours = db.prepare(
    `INSERT INTO studio_hours(weekday, is_closed, open_time, close_time) VALUES (?, ?, ?, ?)
       ON CONFLICT(weekday) DO UPDATE SET is_closed = excluded.is_closed,
                                          open_time = excluded.open_time,
                                          close_time = excluded.close_time`,
  );
  for (const row of STUDIO_HOURS) hours.run(...row);

  const category = db.prepare(
    `INSERT INTO service_categories(id, name, sort_order) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order`,
  );
  for (const row of CATEGORIES) category.run(...row);

  const service = db.prepare(
    `INSERT INTO services(id, category_id, name, description, duration_min, price_kopecks, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET category_id = excluded.category_id,
                                     name = excluded.name,
                                     description = excluded.description,
                                     duration_min = excluded.duration_min,
                                     price_kopecks = excluded.price_kopecks,
                                     sort_order = excluded.sort_order`,
  );
  for (const row of SERVICES) service.run(...row);

  // password_hash намеренно не в списке обновляемых полей: у существующего
  // аккаунта пароль остаётся прежним, и повторный запуск его не трогает.
  const user = db.prepare(
    `INSERT INTO users(id, email, password_hash, full_name, phone, role, theme)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email,
                                     full_name = excluded.full_name,
                                     phone = excluded.phone,
                                     role = excluded.role,
                                     theme = excluded.theme`,
  );
  for (const [id, email, password, fullName, phone, role, theme] of USERS) {
    user.run(id, email, password === null ? null : hashPassword(password), fullName, phone, role, theme);
  }

  // Закрытие студии ссылается на администратора, поэтому идёт после users.
  db.prepare(
    `INSERT INTO studio_closures(id, date_from, date_to, reason, created_by) VALUES (1, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET date_from = excluded.date_from,
                                     date_to = excluded.date_to,
                                     reason = excluded.reason`,
  ).run('2027-01-01', '2027-01-08', 'Новогодние праздники');

  const master = db.prepare(
    `INSERT INTO masters(id, user_id, display_name, specialization, bio, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id,
                                     display_name = excluded.display_name,
                                     specialization = excluded.specialization,
                                     bio = excluded.bio,
                                     sort_order = excluded.sort_order`,
  );
  for (const row of MASTERS) master.run(...row);

  const masterService = db.prepare(
    'INSERT OR IGNORE INTO master_services(master_id, service_id) VALUES (?, ?)',
  );
  for (const [masterId, serviceIds] of MASTER_SERVICES) {
    for (const serviceId of serviceIds) masterService.run(masterId, serviceId);
  }

  // Графики пересоздаются целиком: у них нет естественного ключа,
  // а набор строк должен точно соответствовать списку выше.
  db.prepare('DELETE FROM master_schedules').run();
  const schedule = db.prepare(
    `INSERT INTO master_schedules(master_id, weekday, work_start, work_end, valid_from)
       VALUES (?, ?, ?, ?, '2026-01-01')`,
  );
  for (const row of SCHEDULES) schedule.run(...row);
}

/**
 * Записи на ближайшие дни. Пересоздаются при каждом запуске, чтобы даты
 * всегда оставались в будущем, а календарь — непустым.
 */
function seedAppointments(db) {
  db.prepare('DELETE FROM appointments WHERE admin_note = ?').run(SEED_MARK);

  const offset = Number(
    db.prepare("SELECT value FROM settings WHERE key = 'utc_offset_minutes'").get().value,
  );

  /** Клиент, мастер, услуги, через сколько дней, местное время, статус. */
  const PLAN = [
    { client: 4, master: 1, services: [1, 2], inDays: 1, at: '10:00', status: 'booked' },
    { client: 5, master: 2, services: [1, 4], inDays: 2, at: '12:00', status: 'booked' },
    { client: 4, master: 1, services: [3, 1, 2], inDays: 4, at: '15:00', status: 'booked' },
    // Одна прошедшая — чтобы экран «История» тоже было чем проверить.
    { client: 4, master: 2, services: [5], inDays: -7, at: '11:00', status: 'completed' },
  ];

  const insertAppointment = db.prepare(
    `INSERT INTO appointments(client_id, master_id, starts_at, ends_at, status,
                              master_chosen_by_client, created_by_role, created_by_user_id, admin_note)
       VALUES (?, ?, ?, ?, ?, 1, 'client', ?, ?)`,
  );
  const insertService = db.prepare(
    `INSERT INTO appointment_services(appointment_id, service_id, position, duration_min, price_kopecks)
       VALUES (?, ?, ?, ?, ?)`,
  );
  const findService = db.prepare('SELECT duration_min, price_kopecks FROM services WHERE id = ?');

  const created = [];
  for (const item of PLAN) {
    const date = item.inDays >= 0
      ? findWorkingDate(db, item.master, item.inDays)
      : ymd(new Date(Date.now() + item.inDays * 86400000));

    const services = item.services.map((id) => ({ id, ...findService.get(id) }));
    const total = services.reduce((sum, s) => sum + s.duration_min, 0);
    const startsAt = localToUtc(date, item.at, offset);
    const endsAt = new Date(startsAt.getTime() + total * 60000);

    const { lastInsertRowid } = insertAppointment.run(
      item.client, item.master, iso(startsAt), iso(endsAt), item.status, item.client, SEED_MARK,
    );
    services.forEach((service, index) => {
      insertService.run(lastInsertRowid, service.id, index, service.duration_min, service.price_kopecks);
    });
    created.push({ date, at: item.at, total, status: item.status, master: item.master });
  }
  return created;
}

export function seed({ silent = false } = {}) {
  if (env.isProduction) {
    throw new Error('Тестовые данные нельзя заливать в продакшен (NODE_ENV=production).');
  }

  runMigrations({ silent: true });
  const db = getDb();

  const appointments = transaction(() => {
    seedReferenceData(db);
    return seedAppointments(db);
  });

  if (!silent) report(db, appointments);
  return appointments;
}

function report(db, appointments) {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const money = (kopecks) => `${(kopecks / 100).toLocaleString('ru-RU')} ₽`;

  console.log('\nСправочники');
  for (const table of ['settings', 'studio_hours', 'service_categories', 'services',
    'users', 'masters', 'master_services', 'master_schedules', 'studio_closures']) {
    console.log(`  ${table.padEnd(20)} ${String(count(table)).padStart(3)}`);
  }

  console.log('\nПользователи');
  for (const row of db.prepare(
    `SELECT id, role, full_name, email,
            CASE WHEN password_hash IS NULL THEN 'входа нет'
                 ELSE substr(password_hash, 1, 7) || '…' END AS pwd
       FROM users ORDER BY id`).all()) {
    console.log(`  ${row.role.padEnd(6)} ${row.full_name.padEnd(26)} ${row.email.padEnd(28)} ${row.pwd}`);
  }

  console.log('\nМастера');
  for (const row of db.prepare(
    `SELECT m.id, COALESCE(m.display_name, u.full_name) AS name, m.specialization,
            (SELECT COUNT(*) FROM master_services WHERE master_id = m.id) AS services,
            (SELECT COUNT(*) FROM master_schedules WHERE master_id = m.id) AS shifts
       FROM masters m JOIN users u ON u.id = m.user_id ORDER BY m.sort_order`).all()) {
    console.log(`  ${row.name.padEnd(26)} ${row.specialization.padEnd(22)} услуг: ${row.services}, смен в неделю: ${row.shifts}`);
  }

  console.log('\nУслуги');
  for (const row of db.prepare(
    `SELECT s.name, s.duration_min, s.price_kopecks, c.name AS category
       FROM services s JOIN service_categories c ON c.id = s.category_id
      ORDER BY s.sort_order`).all()) {
    console.log(`  ${row.name.padEnd(24)} ${String(row.duration_min).padStart(3)} мин  ${money(row.price_kopecks).padStart(10)}   ${row.category}`);
  }

  console.log('\nЗаписи');
  for (const row of db.prepare(
    `SELECT a.id, a.starts_at, a.ends_at, a.status,
            u.full_name AS client, COALESCE(m.display_name, mu.full_name) AS master,
            (SELECT GROUP_CONCAT(s.name, ' + ') FROM appointment_services x
               JOIN services s ON s.id = x.service_id WHERE x.appointment_id = a.id) AS services,
            (SELECT SUM(price_kopecks) FROM appointment_services WHERE appointment_id = a.id) AS total
       FROM appointments a
       JOIN users u ON u.id = a.client_id
       JOIN masters m ON m.id = a.master_id
       JOIN users mu ON mu.id = m.user_id
      ORDER BY a.starts_at`).all()) {
    const local = db.prepare(
      "SELECT strftime('%d.%m %H:%M', datetime(?, '+' || (SELECT value FROM settings WHERE key='utc_offset_minutes') || ' minutes')) AS t",
    ).get(row.starts_at).t;
    console.log(`  ${local}  ${row.master.padEnd(26)} ${row.client.padEnd(18)} ${row.status.padEnd(10)} ${money(row.total).padStart(10)}  ${row.services}`);
  }

  console.log('\nВход');
  console.log(`  администратор  ${env.seedAdminEmail} / ${env.seedAdminPassword}`);
  console.log('  мастера        olga@nogotochki.local, irina@nogotochki.local / master12345');
  console.log('  клиент         anna@example.com / client12345');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    seed();
  } finally {
    closeDb();
  }
}
