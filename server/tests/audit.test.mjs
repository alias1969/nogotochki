/**
 * Журнал действий — экран A9.
 *
 * Проверяется не столько выдача, сколько два свойства, ради которых
 * журнал существует: в нём оказывается то, что произошло на самом деле,
 * и из него нельзя ничего убрать через API.
 *
 * Плюс отдельная проверка, которую стоит держать вечно: в журнале нет
 * ни паролей, ни токенов. Он читается людьми, и секретам там не место.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:audit
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

const AT = (await call('POST', '/api/auth/login', {
  body: { email: 'admin@nogotochki.local', password: 'admin12345' } })).body.token;
const MT = (await call('POST', '/api/auth/login', {
  body: { email: 'olga@nogotochki.local', password: 'master12345' } })).body.token;

const PASSWORD = 'secret12345';
const client = (await call('POST', '/api/auth/register', {
  body: { email: `aud-${Date.now()}@example.com`, password: PASSWORD,
          full_name: 'Клиент Журнала', phone: '+79001117788' } })).body;

const created = [];
const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);

// =====================================================================
console.log('\n1. В журнал попадает то, что произошло');
const day = (await call('GET', `/api/availability/days?master_id=1&from=${new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)}&service_ids=1`)).body.days[0].date;
const slot = (await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`)).body.slots[0].starts_at;

let r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: client.user.id, master_id: 1, starts_at: slot, service_ids: [1] } });
const appt = r.body.appointment.id;
created.push(appt);
check('запись создана администратором', r.status === 201, JSON.stringify(r.body).slice(0, 150));

r = await call('GET', `/api/admin/audit?entity_type=appointment&entity_id=${appt}`, { token: AT });
check('журнал читается', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('создание записано', r.body.entries.some((e) => e.action === 'create'), JSON.stringify(r.body.entries).slice(0, 200));

const entry = r.body.entries.find((e) => e.action === 'create');
check('видно, кто действовал', entry.actor.id === 1 && entry.actor.name.includes('Администратор'), JSON.stringify(entry.actor));
check('роль на момент действия', entry.actor.role === 'admin');
check('человеческое название действия', entry.action_title === 'Создание', entry.action_title);
check('человеческое название объекта', entry.entity.title === 'Запись', entry.entity.title);
check('время парой UTC и местное', entry.at.utc.endsWith('Z') && entry.at.local.includes('+03:00'));
check('details разобран в объект, а не строку',
  typeof entry.details === 'object' && entry.details.client_id === client.user.id, JSON.stringify(entry.details));

// Отмена мастером — другая роль в той же цепочке.
await call('POST', `/api/appointments/${appt}/cancel`, { token: MT, body: { reason: 'Заболела' } });
r = await call('GET', `/api/admin/audit?entity_type=appointment&entity_id=${appt}`, { token: AT });
check('отмена записана', r.body.entries.some((e) => e.action === 'cancel'));
const cancelEntry = r.body.entries.find((e) => e.action === 'cancel');
check('действовал мастер', cancelEntry.actor.role === 'master' && cancelEntry.actor.id === 2, JSON.stringify(cancelEntry.actor));
check('причина сохранена', cancelEntry.details.reason === 'Заболела', JSON.stringify(cancelEntry.details));
check('история объекта идёт новым сверху', r.body.entries[0].id > r.body.entries[1].id);

// Смена настроек и роли — другие сущности.
await call('PATCH', '/api/admin/settings', { token: AT, body: { settings: { hold_minutes: 12 } } });
r = await call('GET', '/api/admin/audit?entity_type=settings', { token: AT });
check('правка настроек записана', r.body.entries.length > 0, JSON.stringify(r.body).slice(0, 150));
check('видно, что на что менялось',
  r.body.entries[0].details.hold_minutes?.to === '12', JSON.stringify(r.body.entries[0].details));
check('у настроек entity_id равен нулю', r.body.entries[0].entity.id === 0, r.body.entries[0].entity.id);
await call('PATCH', '/api/admin/settings', { token: AT, body: { settings: { hold_minutes: 10 } } });

// =====================================================================
console.log('\n2. Фильтры');
r = await call('GET', '/api/admin/audit?action=cancel', { token: AT });
check('фильтр по действию', r.body.entries.every((e) => e.action === 'cancel') && r.body.entries.length > 0);
r = await call('GET', '/api/admin/audit?actor_role=master', { token: AT });
check('фильтр по роли', r.body.entries.every((e) => e.actor.role === 'master') && r.body.entries.length > 0);
r = await call('GET', '/api/admin/audit?actor_user_id=2', { token: AT });
check('фильтр по человеку', r.body.entries.every((e) => e.actor.id === 2) && r.body.entries.length > 0);
r = await call('GET', `/api/admin/audit?date=${today}`, { token: AT });
check('фильтр по дню', r.body.entries.every((e) => e.at.local_date === today) && r.body.entries.length > 0,
  r.body.entries.length);
r = await call('GET', '/api/admin/audit?date=2020-01-01', { token: AT });
check('в пустой день ничего нет', r.body.entries.length === 0);

r = await call('GET', '/api/admin/audit?action=выдумка', { token: AT });
check('незнакомое действие → 400', r.status === 400, r.status);
r = await call('GET', '/api/admin/audit?entity_type=выдумка', { token: AT });
check('незнакомая сущность → 400', r.status === 400, r.status);
r = await call('GET', '/api/admin/audit?from=2026-12-01&to=2026-01-01', { token: AT });
check('период задом наперёд → 422', r.status === 422, r.status);
r = await call('GET', '/api/admin/audit?limit=9999', { token: AT });
check('слишком большой limit → 400', r.status === 400, r.status);

r = await call('GET', '/api/admin/audit?limit=2', { token: AT });
check('страница на две записи', r.body.entries.length === 2, r.body.entries.length);
check('курсор выдан', typeof r.body.next_before_id === 'number');
const page2 = await call('GET', `/api/admin/audit?limit=2&before_id=${r.body.next_before_id}`, { token: AT });
check('вторая страница не повторяет первую',
  !page2.body.entries.some((e) => r.body.entries.some((x) => x.id === e.id)));

// =====================================================================
console.log('\n3. Сводка для фильтров');
r = await call('GET', '/api/admin/audit/meta', { token: AT });
check('сводка читается', r.status === 200 && r.body.total > 0, JSON.stringify(r.body).slice(0, 200));
check('видны границы журнала', r.body.oldest?.utc && r.body.newest?.utc);
check('разбивка по действиям', r.body.by_action.some((x) => x.action === 'cancel' && x.count > 0),
  JSON.stringify(r.body.by_action));
check('названия действий переведены', r.body.by_action.every((x) => typeof x.title === 'string'));
const login = r.body.actions.find((a) => a.action === 'login');
check('«Вход» помечен как незаписываемый', login.recorded === false, JSON.stringify(login));
check('«Отмена» помечена как записываемая',
  r.body.actions.find((a) => a.action === 'cancel').recorded === true);
check('список сущностей с названиями', r.body.entity_types.length === 9, r.body.entity_types?.length);

// =====================================================================
console.log('\n4. Из журнала нельзя ничего убрать');
for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
  const res = await call(method, '/api/admin/audit', { token: AT, body: {} });
  check(`${method} по журналу не проходит`, res.status === 404 || res.status === 405, res.status);
}
r = await call('DELETE', '/api/admin/audit/1', { token: AT });
check('удалить запись журнала нечем', r.status === 404 || r.status === 405, r.status);

// =====================================================================
console.log('\n5. Права и секреты');
r = await call('GET', '/api/admin/audit', { token: client.token });
check('клиенту закрыт → 403', r.status === 403, r.status);
r = await call('GET', '/api/admin/audit', { token: MT });
check('мастеру тоже → 403', r.status === 403, r.status);
r = await call('GET', '/api/admin/audit');
check('без входа → 401', r.status === 401, r.status);
r = await call('GET', '/api/admin/audit/meta', { token: MT });
check('сводка мастеру тоже закрыта → 403', r.status === 403, r.status);

// Смена пароля пишется в журнал — и не должна тащить туда сам пароль.
await call('POST', '/api/auth/change-password', {
  token: client.token, body: { current_password: PASSWORD, new_password: 'auditnew12345' } });
const pwdEntry = db.prepare(
  "SELECT details FROM audit_log WHERE action = 'password_change' ORDER BY id DESC").get();
check('смена пароля записана', !!pwdEntry, pwdEntry);
check('пароля в ней нет', !/secret12345|auditnew12345/.test(pwdEntry?.details ?? ''), pwdEntry?.details);

const all = db.prepare('SELECT details FROM audit_log WHERE details IS NOT NULL').all()
  .map((row) => row.details).join(' ');
check('во всём журнале нет паролей и токенов',
  !/secret12345|admin12345|master12345|client12345|scrypt\$|Bearer /.test(all),
  all.slice(0, 200));
check('и нет хешей токенов', !/[0-9a-f]{64}/.test(all), all.slice(0, 200));

// --- уборка ---
for (const id of created) {
  db.prepare('DELETE FROM appointment_services WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM slot_holds WHERE appointment_id = ? OR reschedule_of_id = ?').run(id, id);
  db.prepare("DELETE FROM audit_log WHERE entity_type='appointment' AND entity_id=?").run(id);
  db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
}
db.prepare("DELETE FROM audit_log WHERE entity_type='settings'").run();
db.prepare("DELETE FROM audit_log WHERE entity_type='user' AND entity_id=?").run(client.user.id);
db.prepare('DELETE FROM notifications WHERE user_id = ?').run(client.user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(client.user.id);
db.prepare('DELETE FROM users WHERE id = ?').run(client.user.id);

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
