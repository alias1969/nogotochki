/**
 * Единственный путь записи в таблицу appointments.
 *
 * Проверяет два разных утверждения:
 *
 *   * структурное — в коде сервисов ровно один INSERT и по одному UPDATE
 *     на перенос и отмену, а обработчики маршрутов в таблицу записей
 *     не пишут вовсе. Это сверка исходников, а не поведения: поведение
 *     можно починить заплаткой во втором месте, и проверка этого не заметит;
 *
 *   * поведенческое — все три роли проходят через эти функции и получают
 *     ровно те права, которые им положены.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:one-write-path
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DB_FILE, ADMIN, OLGA, IRINA, ANNA, MASTER_PASSWORD } from './env.mjs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.API_URL ?? 'http://localhost:3000';


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

// =====================================================================
// Структура: сколько в коде мест, пишущих в appointments
// =====================================================================
console.log('\nСтруктура кода');

/** Все .js под src/, кроме миграций и тестовых данных. */
function sources(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { sources(full, found); continue; }
    if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

/** Строки с SQL, без комментариев: `//`, `*` в начале и `--` внутри SQL. */
function sqlLines(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*') && !line.startsWith('--'));
}

const files = sources('src').filter((f) => !f.includes('/migrations/'));
const counts = new Map();
for (const file of files) {
  const lines = sqlLines(file);
  const insert = lines.filter((l) => /INSERT\s+INTO\s+appointments\s*\(/i.test(l)).length;
  const update = lines.filter((l) => /UPDATE\s+appointments\b/i.test(l)).length;
  if (insert || update) counts.set(file, { insert, update });
}

const seed = 'src/db/seed.js';
const service = 'src/services/appointments.js';

check('вставка записи есть только в сервисе записей и в наполнении тестовыми данными',
  [...counts.keys()].filter((f) => counts.get(f).insert > 0).sort().join(', ') === `${seed}, ${service}`,
  [...counts.keys()].map((f) => `${f}:${counts.get(f).insert}`).join(', '));

check('в сервисе записей ровно один INSERT', counts.get(service)?.insert === 1, counts.get(service)?.insert);
// Три операции меняют строку записи: перенос, отмена и отметка исхода.
// По одному UPDATE на каждую — растёт число операций, а не число мест,
// где одну и ту же операцию делают по-разному.
check('в сервисе записей ровно три UPDATE — перенос, отмена, исход визита',
  counts.get(service)?.update === 3, counts.get(service)?.update);

const handlers = [...counts.keys()].filter((f) => f.startsWith('src/api/'));
check('обработчики маршрутов в таблицу записей не пишут', handlers.length === 0, handlers.join(', '));

const serviceText = readFileSync(service, 'utf8');
check('экспортируется одна функция создания',
  (serviceText.match(/^export function create\w+/gm) ?? []).join(',') === 'export function createAppointment',
  (serviceText.match(/^export function create\w+/gm) ?? []).join(','));

// Обе точки входа зовут одну и ту же функцию.
const clientRoute = readFileSync('src/api/appointments.routes.js', 'utf8');
const adminRoute = readFileSync('src/api/admin.routes.js', 'utf8');
check('клиентский маршрут зовёт createAppointment', clientRoute.includes('createAppointment({'));
check('админский маршрут зовёт ту же функцию', adminRoute.includes('createAppointment({'));

// =====================================================================
// Поведение: три роли через одни и те же функции
// =====================================================================
console.log('\nРоли');

const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).body.token;
const AT = await login(ADMIN.email, ADMIN.password);
const MT = await login(OLGA.email, MASTER_PASSWORD);      // мастер 1
const MT2 = await login(IRINA.email, MASTER_PASSWORD);    // мастер 2

async function newClient(tag) {
  const r = await call('POST', '/api/auth/register', {
    body: { email: `path-${tag}-${Date.now()}@example.com`, password: 'secret12345',
            full_name: `Клиент ${tag}`, phone: '+79005556677' },
  });
  return { token: r.body.token, id: r.body.user.id };
}
async function workingDay(masterId, offsetDays) {
  const from = new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  const r = await call('GET', `/api/availability/days?master_id=${masterId}&from=${from}&service_ids=1`);
  return r.body.days[0].date;
}

const created = [];
async function bookByAdmin(clientId, masterId, startsAt) {
  const r = await call('POST', '/api/admin/appointments', {
    token: AT, body: { client_id: clientId, master_id: masterId, starts_at: startsAt, service_ids: [1] },
  });
  if (r.status === 201) created.push(r.body.appointment.id);
  return r;
}

// --- создание ---
const day = await workingDay(1, 14);
let r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
const slots = r.body.slots;
const client = await newClient('main');

r = await call('POST', '/api/holds', { token: client.token, body: { master_id: 1, starts_at: slots[0].starts_at, service_ids: [1] } });
const hold = r.body.hold.id;
r = await call('POST', '/api/appointments', { token: client.token, body: { hold_id: hold } });
check('клиент создаёт запись', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const clientAppt = r.body.appointment.id;
created.push(clientAppt);
check('создана от лица клиента',
  db.prepare('SELECT created_by_role FROM appointments WHERE id = ?').get(clientAppt).created_by_role === 'client');

r = await bookByAdmin(client.id, 1, slots[4].starts_at);
check('администратор создаёт запись', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const adminAppt = r.body.appointment.id;
check('создана от лица администратора',
  db.prepare('SELECT created_by_role FROM appointments WHERE id = ?').get(adminAppt).created_by_role === 'admin');

// Мастер записей не создаёт — ни своим путём, ни админским.
r = await call('POST', '/api/holds', { token: MT, body: { master_id: 1, starts_at: slots[8].starts_at, service_ids: [1] } });
const masterHold = r.body.hold?.id;
r = await call('POST', '/api/appointments', { token: MT, body: { hold_id: masterHold } });
check('мастер получает 403 на создание', r.status === 403, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
check('в отказе сказано, кто записывает', /клиент|администратор/i.test(r.body.error.message), r.body.error.message);
r = await call('POST', '/api/admin/appointments', {
  token: MT, body: { client_id: client.id, master_id: 1, starts_at: slots[8].starts_at, service_ids: [1] },
});
check('мастер получает 403 и на админском пути', r.status === 403, r.status);
check('база тоже не знает роли master как создателя',
  db.prepare("SELECT sql FROM sqlite_master WHERE name='appointments'").get().sql
    .includes("created_by_role       TEXT    NOT NULL CHECK (created_by_role IN ('client', 'admin'))"));
if (masterHold) await call('DELETE', `/api/holds/${masterHold}`, { token: MT });

// --- отмена ---
console.log('\nОтмена');
r = await call('POST', `/api/appointments/${adminAppt}/cancel`, { token: MT, body: {} });
check('мастер без причины → 422', r.status === 422, r.status);
r = await call('POST', `/api/appointments/${adminAppt}/cancel`, { token: MT2, body: { reason: 'Чужая запись' } });
check('чужой мастер не видит запись → 404', r.status === 404, r.status);
r = await call('POST', `/api/appointments/${adminAppt}/cancel`, { token: MT, body: { reason: 'Заболела' } });
check('мастер отменяет свою запись с причиной', r.status === 200, JSON.stringify(r.body).slice(0, 200));

const cancelled = db.prepare('SELECT cancelled_by_role, cancel_reason, status FROM appointments WHERE id = ?').get(adminAppt);
check('отмена записана на роль master', cancelled.cancelled_by_role === 'master', JSON.stringify(cancelled));
check('причина сохранена', cancelled.cancel_reason === 'Заболела');
check('статус cancelled', cancelled.status === 'cancelled');
const auditRow = db.prepare(
  "SELECT actor_role FROM audit_log WHERE entity_type='appointment' AND entity_id=? AND action='cancel'").get(adminAppt);
check('действие мастера над чужой записью в журнале', auditRow?.actor_role === 'master', JSON.stringify(auditRow));
const noticeRow = db.prepare(
  "SELECT body FROM notifications WHERE appointment_id=? AND kind='booking_cancelled'").get(adminAppt);
check('клиенту ушло уведомление с причиной', noticeRow?.body.includes('Заболела'), noticeRow?.body);

r = await call('POST', `/api/appointments/${clientAppt}/cancel`, { token: client.token, body: {} });
check('клиент отменяет свою запись без причины', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('отмена записана на роль client',
  db.prepare('SELECT cancelled_by_role FROM appointments WHERE id = ?').get(clientAppt).cancelled_by_role === 'client');

// --- перенос ---
console.log('\nПеренос');
const day2 = await workingDay(1, 16);
r = await call('GET', `/api/availability?master_id=1&date=${day2}&service_ids=1`);
const free2 = r.body.slots;
r = await bookByAdmin(client.id, 1, free2[0].starts_at);
const moving = r.body.appointment.id;

async function takeHold(token, startsAt) {
  const res = await call('POST', '/api/holds', { token, body: { master_id: 1, starts_at: startsAt, reschedule_of: moving } });
  return res.body.hold?.id;
}

let h = await takeHold(MT, free2[10].starts_at);
r = await call('POST', `/api/appointments/${moving}/reschedule`, { token: MT, body: { hold_id: h } });
check('мастер без причины перенести не может → 422', r.status === 422, r.status);
r = await call('POST', `/api/appointments/${moving}/reschedule`, { token: MT, body: { hold_id: h, reason: 'Сдвиг смены' } });
check('мастер переносит свою запись с причиной', r.status === 200, JSON.stringify(r.body).slice(0, 200));
check('счётчик переносов клиента не потрачен',
  db.prepare('SELECT reschedule_count FROM appointments WHERE id = ?').get(moving).reschedule_count === 0);
check('перенос мастера в журнале',
  db.prepare("SELECT actor_role FROM audit_log WHERE entity_type='appointment' AND entity_id=? AND action='reschedule'")
    .get(moving)?.actor_role === 'master');

h = await takeHold(client.token, free2[16].starts_at);
r = await call('POST', `/api/appointments/${moving}/reschedule`, { token: client.token, body: { hold_id: h } });
check('клиент переносит свою запись', r.status === 200, JSON.stringify(r.body).slice(0, 200));
check('его перенос счётчик увеличил',
  db.prepare('SELECT reschedule_count FROM appointments WHERE id = ?').get(moving).reschedule_count === 1);
check('клиенту показаны оставшиеся переносы', r.body.appointment.reschedules_left === 2, r.body.appointment.reschedules_left);

r = await call('GET', `/api/appointments/${moving}`, { token: MT });
check('мастеру клиентские правила на кнопках не показывают', !('can_cancel' in r.body.appointment), JSON.stringify(r.body.appointment).slice(0, 200));

h = await takeHold(MT2, free2[20].starts_at);
check('чужой мастер не может взять резерв на чужую запись', h === undefined, h);

// --- уборка ---
for (const id of created.reverse()) {
  db.prepare('DELETE FROM appointment_services WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM slot_holds WHERE appointment_id = ? OR reschedule_of_id = ?').run(id, id);
  db.prepare("DELETE FROM audit_log WHERE entity_type='appointment' AND entity_id=?").run(id);
  db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
}

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
