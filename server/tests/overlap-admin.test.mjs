/**
 * Осознанное наложение администратора.
 *
 * Три требования, которые здесь проверяются:
 *   1. запись с признаком наложения проходит мимо триггера;
 *   2. признак может выставить только администратор — от клиента
 *      и мастера он игнорируется и наложения не создаёт;
 *   3. созданная запись дальше участвует в проверке пересечений
 *      как обычная: занимает время и не пускает на него других.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:overlap-admin
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, ADMIN, OLGA, IRINA, ANNA, MASTER_PASSWORD } from './env.mjs';

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

const admin = await call('POST', '/api/auth/login', {
  body: { email: ADMIN.email, password: ADMIN.password },
});
const AT = admin.body.token;

async function newClient(tag) {
  const r = await call('POST', '/api/auth/register', {
    body: { email: `ovl-${tag}-${Date.now()}@example.com`, password: 'secret12345',
            full_name: `Клиент ${tag}`, phone: '+79002223344' },
  });
  return { token: r.body.token, id: r.body.user.id };
}

async function workingDay(masterId, offsetDays = 8) {
  const from = new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  const r = await call('GET', `/api/availability/days?master_id=${masterId}&from=${from}&service_ids=1`);
  if (r.body.days?.length) return r.body.days[0].date;
  throw new Error('нет свободных дней — выполните npm run seed');
}

const created = [];
const remember = (id) => { created.push(id); return id; };

// =====================================================================
// 1. Признак пропускает запись мимо триггера
// =====================================================================
console.log('\n1. Наложение администратором');

const day = await workingDay(1);
let r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
const slot = r.body.slots[0].starts_at;

const anna = await newClient('anna');
const boris = await newClient('boris');

r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: anna.id, master_id: 1, starts_at: slot, service_ids: [1] },
});
check('обычная ручная запись создана', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const first = remember(r.body.appointment.id);
check('признак наложения выключен', r.body.appointment.allow_overlap === false);

r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: boris.id, master_id: 1, starts_at: slot, service_ids: [1] },
});
check('вторая запись на то же время без признака → 409', r.status === 409, r.status);
check('код slot_taken', r.body.error?.code === 'slot_taken');

r = await call('POST', '/api/admin/appointments', {
  token: AT,
  body: { client_id: boris.id, master_id: 1, starts_at: slot, service_ids: [1],
          allow_overlap: true, admin_note: 'Ольга согласилась принять двоих' },
});
check('та же запись с признаком создана', r.status === 201, JSON.stringify(r.body).slice(0, 250));
const overlapped = remember(r.body.appointment.id);
check('признак виден администратору', r.body.appointment.allow_overlap === true);

const stored = db.prepare('SELECT allow_overlap, created_by_role FROM appointments WHERE id = ?').get(overlapped);
check('в базе allow_overlap = 1', stored.allow_overlap === 1, JSON.stringify(stored));
check('создана администратором', stored.created_by_role === 'admin');

// Наложение частичное, а не только «минута в минуту».
const shifted = new Date(new Date(slot).getTime() + 15 * 60000).toISOString().slice(0, 19) + 'Z';
r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: anna.id, master_id: 1, starts_at: shifted, service_ids: [2], allow_overlap: true },
});
check('частичное наложение со сдвигом тоже проходит', r.status === 201, JSON.stringify(r.body).slice(0, 200));
remember(r.body.appointment.id);

// =====================================================================
// 2. Признак может выставить только администратор
// =====================================================================
console.log('\n2. Признак от клиента игнорируется');

r = await call('POST', '/api/admin/appointments', {
  token: anna.token, body: { client_id: anna.id, master_id: 1, starts_at: slot, service_ids: [1], allow_overlap: true },
});
check('клиент в админский эндпоинт → 403', r.status === 403, r.status);
r = await call('POST', '/api/admin/appointments', {
  body: { client_id: anna.id, master_id: 1, starts_at: slot, service_ids: [1], allow_overlap: true },
});
check('без входа → 401', r.status === 401, r.status);

// Клиент идёт своим путём и подкладывает признак в тело запроса.
const day2 = await workingDay(2, 9);
r = await call('GET', `/api/availability?master_id=2&date=${day2}&service_ids=1`);
const slot2 = r.body.slots[0].starts_at;

const viktor = await newClient('viktor');
r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: viktor.id, master_id: 2, starts_at: slot2, service_ids: [1] },
});
check('время занято первой записью', r.status === 201, JSON.stringify(r.body).slice(0, 200));
remember(r.body.appointment.id);

const galina = await newClient('galina');
r = await call('POST', '/api/holds', {
  token: galina.token,
  body: { master_id: 2, starts_at: slot2, service_ids: [1], allow_overlap: true },
});
check('клиент не может даже зарезервировать занятое, передав признак', r.status === 409, r.status);

// Клиент берёт свободный слот, а признак подкладывает на шаге подтверждения.
r = await call('GET', `/api/availability?master_id=2&date=${day2}&service_ids=1`);
const freeSlot = r.body.slots[0].starts_at;
r = await call('POST', '/api/holds', { token: galina.token, body: { master_id: 2, starts_at: freeSlot, service_ids: [1] } });
const galinaHold = r.body.hold.id;
r = await call('POST', '/api/appointments', {
  token: galina.token, body: { hold_id: galinaHold, allow_overlap: true, master_chosen_by_client: 0 },
});
check('запись клиента создана', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const galinaAppt = remember(r.body.appointment.id);
check('клиенту признак в ответе не показывают', !('allow_overlap' in r.body.appointment));

const galinaRow = db.prepare('SELECT allow_overlap, created_by_role FROM appointments WHERE id = ?').get(galinaAppt);
check('признак из тела запроса в базу не попал', galinaRow.allow_overlap === 0, JSON.stringify(galinaRow));
check('роль создателя осталась client', galinaRow.created_by_role === 'client');

// Второй контур: база не даёт выписать признак записи, созданной клиентом.
let dbRefusal = null;
try {
  db.prepare('UPDATE appointments SET allow_overlap = 1 WHERE id = ?').run(galinaAppt);
} catch (error) {
  dbRefusal = error.message;
}
check('база отказывает в признаке для записи клиента', dbRefusal?.includes('overlap_flag_requires_admin'), dbRefusal);
check('в базе признак по-прежнему 0',
  db.prepare('SELECT allow_overlap FROM appointments WHERE id = ?').get(galinaAppt).allow_overlap === 0);

let insertRefusal = null;
try {
  db.prepare(
    `INSERT INTO appointments(client_id, master_id, starts_at, ends_at, status, allow_overlap,
                              created_by_role, created_by_user_id)
     VALUES (?, 1, ?, ?, 'booked', 1, 'client', ?)`,
  ).run(anna.id, slot, new Date(new Date(slot).getTime() + 36e5).toISOString().slice(0, 19) + 'Z', anna.id);
} catch (error) {
  insertRefusal = error.message;
}
check('база отказывает во вставке с признаком от клиента',
  insertRefusal?.includes('overlap_flag_requires_admin'), insertRefusal);

// =====================================================================
// 3. Наложенная запись участвует в проверках как обычная
// =====================================================================
console.log('\n3. Наложенная запись ведёт себя как обычная');

r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
check('её время не предлагается как свободное', !r.body.slots.some((s) => s.starts_at === slot));

const dmitry = await newClient('dmitry');
r = await call('POST', '/api/holds', { token: dmitry.token, body: { master_id: 1, starts_at: slot, service_ids: [1] } });
check('клиент не может зарезервировать её время → 409', r.status === 409, r.status);

r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: dmitry.id, master_id: 1, starts_at: slot, service_ids: [1] },
});
check('администратор без признака тоже получает 409', r.status === 409, r.status);

// Главное: она не «прозрачная» — проверяем на уровне самого триггера.
const slotEnd = new Date(new Date(slot).getTime() + 30 * 60000).toISOString().slice(0, 19) + 'Z';
let triggerRefusal = null;
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare('DELETE FROM appointments WHERE master_id = 1 AND status = \'booked\' AND id <> ?').run(overlapped);
  try {
    db.prepare(
      `INSERT INTO appointments(client_id, master_id, starts_at, ends_at, status,
                                created_by_role, created_by_user_id)
       VALUES (?, 1, ?, ?, 'booked', 'admin', 1)`,
    ).run(dmitry.id, slot, slotEnd);
  } catch (error) {
    triggerRefusal = error.message;
  }
} finally {
  db.exec('ROLLBACK');
}
check('наложенная запись в одиночку блокирует чужую вставку',
  triggerRefusal?.includes('appointment_overlap'), triggerRefusal);

// Перенос сбрасывает разрешение.
const target = await workingDay(1, 12);
r = await call('GET', `/api/availability?master_id=1&date=${target}&service_ids=1`);
const busy = r.body.slots[0].starts_at;
r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: anna.id, master_id: 1, starts_at: busy, service_ids: [1] },
});
remember(r.body.appointment.id);

const mover = db.prepare('SELECT starts_at, ends_at FROM appointments WHERE id = ?').get(overlapped);
const duration = (new Date(mover.ends_at) - new Date(mover.starts_at)) / 60000;
let moveRefusal = null;
try {
  db.prepare('UPDATE appointments SET starts_at = ?, ends_at = ?, allow_overlap = 0 WHERE id = ?')
    .run(busy, new Date(new Date(busy).getTime() + duration * 60000).toISOString().slice(0, 19) + 'Z', overlapped);
} catch (error) {
  moveRefusal = error.message;
}
check('перенос со сброшенным признаком снова проверяется',
  moveRefusal?.includes('appointment_overlap'), moveRefusal);

// --- уборка ---
for (const id of created.reverse()) {
  db.prepare('DELETE FROM appointment_services WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM slot_holds WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM audit_log WHERE entity_type = \'appointment\' AND entity_id = ?').run(id);
  db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
}

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
