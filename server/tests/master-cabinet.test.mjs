/**
 * Кабинет мастера — чтение.
 *
 * Главная проверка здесь не «эндпоинты отвечают», а граница, заданная
 * паспортом дословно: «Записи и контакты клиентов других мастеров ему
 * недоступны» и «E-mail клиента виден только администратору; мастеру
 * доступен телефон в своих записях». Поэтому половина проверок ниже —
 * про то, чего мастер видеть не должен.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:master
 */
import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.API_URL ?? 'http://localhost:3000';
const DB_FILE = process.env.DATABASE_FILE ?? 'data/nogotochki.db';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  ok ? (pass++, console.log('  ok  ', name)) : (fail++, console.log('  FAIL', name, extra));
};

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');

const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).body.token;
const AT = await login('admin@nogotochki.local', 'admin12345');
const OLGA = await login('olga@nogotochki.local', 'master12345');   // мастер 1
const IRINA = await login('irina@nogotochki.local', 'master12345'); // мастер 2

const client = await (async () => {
  const r = await call('POST', '/api/auth/register', {
    body: { email: `mc-${Date.now()}@example.com`, password: 'secret12345',
            full_name: 'Пётр Клиентов', phone: '+79001239988' },
  });
  return { token: r.body.token, id: r.body.user.id, email: r.body.user.email };
})();

const created = [];
async function book(masterId, offsetDays) {
  const from = new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  const days = (await call('GET', `/api/availability/days?master_id=${masterId}&from=${from}&service_ids=1`)).body.days;
  const date = days[0].date;
  const slots = (await call('GET', `/api/availability?master_id=${masterId}&date=${date}&service_ids=1`)).body.slots;
  const r = await call('POST', '/api/admin/appointments', {
    token: AT, body: { client_id: client.id, master_id: masterId, starts_at: slots[0].starts_at, service_ids: [1] },
  });
  created.push(r.body.appointment.id);
  return { id: r.body.appointment.id, date, startsAt: slots[0].starts_at };
}

// =====================================================================
console.log('\n1. Кто я как мастер');
let r = await call('GET', '/api/master/me', { token: OLGA });
check('карточка читается', r.status === 200, JSON.stringify(r.body).slice(0, 200));
check('номер карточки, а не аккаунта', r.body.master.id === 1, r.body.master.id);
check('имя из карточки', r.body.master.name === 'Ольга', r.body.master.name);
check('видны свои услуги', r.body.services.length === 3, r.body.services.length);
check('пришли правила студии', r.body.studio.booking_rules?.hold_minutes === 10);

r = await call('GET', '/api/master/me', { token: client.token });
check('клиент в кабинет мастера не входит → 403', r.status === 403, r.status);
r = await call('GET', '/api/master/me', { token: AT });
check('администратор — тоже 403, у него своя панель', r.status === 403, r.status);
r = await call('GET', '/api/master/me');
check('без входа → 401', r.status === 401, r.status);

// Роль мастера без привязанной карточки.
const orphan = await (async () => {
  const email = `orphan-${Date.now()}@example.com`;
  const res = await call('POST', '/api/auth/register', {
    body: { email, password: 'secret12345', full_name: 'Без Карточки', phone: '+79005550000' } });
  db.prepare("UPDATE users SET role = 'master' WHERE id = ?").run(res.body.user.id);
  db.prepare("UPDATE sessions SET role_at_login = 'master' WHERE user_id = ?").run(res.body.user.id);
  return { id: res.body.user.id, token: await login(email, 'secret12345') };
})();
r = await call('GET', '/api/master/me', { token: orphan.token });
check('роль без карточки объяснена, а не пустой кабинет', r.status === 403 && /карточка/i.test(r.body.error.message),
  `${r.status} ${r.body.error?.message}`);

// =====================================================================
console.log('\n2. Свои записи');
const mine = await book(1, 7);
const foreign = await book(2, 7);

r = await call('GET', '/api/master/appointments', { token: OLGA });
check('список читается', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('своя запись в списке', r.body.appointments.some((a) => a.id === mine.id));
check('чужой записи в списке нет', !r.body.appointments.some((a) => a.id === foreign.id));
check('все записи — свои', r.body.appointments.every((a) => a.master.id === 1));

const own = r.body.appointments.find((a) => a.id === mine.id);
check('видно имя клиента', own.client?.full_name === 'Пётр Клиентов', JSON.stringify(own.client));
check('видно телефон клиента', own.client?.phone === '+79001239988', own.client?.phone);
check('e-mail клиента не отдаётся', !('email' in own.client), JSON.stringify(own.client));
check('во всём ответе нет e-mail клиента', !JSON.stringify(r.body).includes(client.email));
check('служебной пометки администратора нет', !('admin_note' in own));
check('признака наложения нет', !('allow_overlap' in own));
check('клиентских кнопок нет', !('can_cancel' in own) && !('reschedules_left' in own));
check('состав визита и сумма на месте',
  own.services.length === 1 && own.total_price_kopecks === 250000, JSON.stringify(own.services));

r = await call('GET', `/api/master/appointments?date=${mine.date}`, { token: OLGA });
check('фильтр по дню работает', r.body.appointments.every((a) => a.starts_at.local_date === mine.date),
  JSON.stringify(r.body.appointments.map((a) => a.starts_at.local_date)));
r = await call('GET', '/api/master/appointments?scope=upcoming', { token: OLGA });
check('только предстоящие', r.body.appointments.every((a) => new Date(a.starts_at.utc) > new Date()));
r = await call('GET', '/api/master/appointments?status=booked', { token: OLGA });
check('фильтр по статусу', r.body.appointments.every((a) => a.status === 'booked'));
r = await call('GET', '/api/master/appointments?status=выдумка', { token: OLGA });
check('незнакомый статус → 400', r.status === 400, r.status);
r = await call('GET', '/api/master/appointments?from=2026-10-10&to=2026-10-01', { token: OLGA });
check('период задом наперёд → 422', r.status === 422, r.status);

// Ирина видит своё и не видит Ольгино.
r = await call('GET', '/api/master/appointments', { token: IRINA });
check('у второго мастера свой список',
  r.body.appointments.some((a) => a.id === foreign.id) && !r.body.appointments.some((a) => a.id === mine.id));

// Одиночная запись — те же правила.
r = await call('GET', `/api/appointments/${mine.id}`, { token: OLGA });
check('своя запись по номеру открывается', r.status === 200 && r.body.appointment.client.phone === '+79001239988');
check('и здесь без e-mail', !('email' in r.body.appointment.client));
r = await call('GET', `/api/appointments/${foreign.id}`, { token: OLGA });
check('чужая запись по номеру → 404', r.status === 404, r.status);

// =====================================================================
console.log('\n3. Свой график');
r = await call('GET', '/api/master/schedule', { token: OLGA });
check('график читается', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('это мой график', r.body.master_id === 1);
check('есть действующие интервалы', r.body.current.length > 0, r.body.current.length);
check('время суток местное, без перевода', /^\d\d:\d\d$/.test(r.body.current[0].work_start), r.body.current[0].work_start);
check('есть название дня недели', typeof r.body.current[0].weekday_name === 'string');

const mineWeekly = JSON.stringify(r.body.current);
r = await call('GET', '/api/master/schedule', { token: IRINA });
check('у второго мастера свой график', JSON.stringify(r.body.current) !== mineWeekly && r.body.master_id === 2);

r = await call('PUT', '/api/master/schedule', { token: OLGA, body: { valid_from: '2030-01-01', days: [] } });
check('менять график из кабинета нельзя', r.status === 404 || r.status === 405, r.status);

// =====================================================================
console.log('\n4. Мой день');
r = await call('GET', `/api/master/day?date=${mine.date}`, { token: OLGA });
check('день читается', r.status === 200, JSON.stringify(r.body).slice(0, 200));
check('дата и день недели на месте', r.body.date === mine.date && r.body.weekday >= 1 && r.body.weekday <= 7);
check('рабочие часы показаны', r.body.working_hours.length > 0, JSON.stringify(r.body.working_hours));
check('записи этого дня показаны', r.body.appointments.some((a) => a.id === mine.id));
check('чужих записей в дне нет', !r.body.appointments.some((a) => a.id === foreign.id));
check('телефон клиента виден и здесь', r.body.appointments.find((a) => a.id === mine.id).client.phone === '+79001239988');

r = await call('GET', '/api/master/day', { token: OLGA });
check('без даты — сегодня', r.status === 200 && r.body.date === new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10),
  r.body.date);

// Выходной попадает в день.
r = await call('POST', '/api/admin/masters/1/schedule-exceptions', {
  token: AT, body: { kind: 'day_off', date_from: mine.date, reason: 'Проверка' } });
const dayOff = r.body.exception.id;
r = await call('GET', `/api/master/day?date=${mine.date}`, { token: OLGA });
check('отклонение видно в дне', r.body.exceptions.some((e) => e.id === dayOff), JSON.stringify(r.body.exceptions));
check('в нём видна причина', r.body.exceptions.find((e) => e.id === dayOff).reason === 'Проверка');
await call('DELETE', `/api/admin/schedule-exceptions/${dayOff}`, { token: AT });

r = await call('GET', '/api/master/day?date=не-дата', { token: OLGA });
check('битая дата → 400', r.status === 400, r.status);

// =====================================================================
console.log('\n5. Границы кабинета');
for (const path of ['/api/master/appointments', '/api/master/schedule', '/api/master/day']) {
  const res = await call('GET', path, { token: client.token });
  check(`клиенту закрыт ${path}`, res.status === 403, res.status);
}
check('master_id не принимается ни одним эндпоинтом кабинета',
  !(await import('node:fs')).readFileSync('src/api/master.routes.js', 'utf8').includes("query.master_id"));

// --- уборка ---
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(orphan.id);
db.prepare('DELETE FROM users WHERE id = ?').run(orphan.id);
for (const id of created.reverse()) {
  db.prepare('DELETE FROM appointment_services WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM slot_holds WHERE appointment_id = ? OR reschedule_of_id = ?').run(id, id);
  db.prepare("DELETE FROM audit_log WHERE entity_type='appointment' AND entity_id=?").run(id);
  db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
}
db.prepare('DELETE FROM notifications WHERE user_id = ?').run(client.id);

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
