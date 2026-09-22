/**
 * Проверка защиты от двойной записи — все три уровня.
 *
 * Уровень 1 (резерв) и уровень 2 (проверка в транзакции) проверяются
 * через HTTP, как их видит клиент. Уровень 3 (триггеры) — напрямую
 * в SQL: через API до него в обычной работе не добраться, он и задуман
 * как рубеж для путей, которые API не контролирует.
 *
 * Отдельно проверяется перевод ошибки базы в ответ 409: берётся настоящая
 * ошибка триггера и прогоняется через тот же код, что стоит в catch
 * при создании записи.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:overlap
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from './env.mjs';

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

/**
 * Ближайший день, в котором у мастера действительно есть свободное время.
 *
 * Прямая арифметика «сегодня плюс пять дней» тут не годится: мастера
 * работают не каждый день, студия по воскресеньям закрыта, и проверка
 * начинала бы падать в зависимости от дня недели, когда её запустили.
 */
async function findWorkingDay(masterId, serviceIds, offsetDays = 2) {
  const from = new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  const r = await call('GET', `/api/availability/days?master_id=${masterId}&from=${from}&service_ids=${serviceIds}`);
  if (r.status !== 200 || r.body.days.length === 0) {
    throw new Error(`У мастера ${masterId} нет свободного времени начиная с ${from}. Выполните npm run seed.`);
  }
  return r.body.days[0].date;
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');

// =====================================================================
// Уровень 3: триггеры в базе
// =====================================================================
console.log('\nУровень 3. Триггеры против пересечения');

const names = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((r) => r.name);
check('оба триггера на месте',
  names.includes('trg_appointments_no_overlap_insert') && names.includes('trg_appointments_no_overlap_update'),
  names.join(', '));

/** Вставка тестовой записи. Всё делается в транзакции и откатывается. */
function insert(startsAt, endsAt, { masterId = 1, status = 'booked' } = {}) {
  const cancelled = status === 'cancelled';
  return db.prepare(
    `INSERT INTO appointments(client_id, master_id, starts_at, ends_at, status,
                              created_by_role, created_by_user_id, cancelled_at, cancelled_by_role)
     VALUES (4, ?, ?, ?, ?, 'admin', 1, ?, ?)`,
  ).run(masterId, startsAt, endsAt, status,
        cancelled ? '2027-01-01T00:00:00Z' : null,
        cancelled ? 'admin' : null).lastInsertRowid;
}

/** true — база пропустила, false — отказала с меткой пересечения. */
function allowed(action) {
  try {
    action();
    return true;
  } catch (error) {
    if (error.message.includes('appointment_overlap')) return false;
    throw error;
  }
}

const D = '2027-03-01T';
db.exec('BEGIN IMMEDIATE');
try {
  const base = insert(`${D}10:00:00Z`, `${D}11:30:00Z`);

  check('накладка целиком внутри 10:30–11:00 отклонена', !allowed(() => insert(`${D}10:30:00Z`, `${D}11:00:00Z`)));
  check('накладка слева 09:00–10:30 отклонена', !allowed(() => insert(`${D}09:00:00Z`, `${D}10:30:00Z`)));
  check('накладка справа 11:00–12:00 отклонена', !allowed(() => insert(`${D}11:00:00Z`, `${D}12:00:00Z`)));
  check('накладка снаружи 09:00–13:00 отклонена', !allowed(() => insert(`${D}09:00:00Z`, `${D}13:00:00Z`)));
  check('точное совпадение отклонено', !allowed(() => insert(`${D}10:00:00Z`, `${D}11:30:00Z`)));

  check('вплотную до 09:00–10:00 разрешено', allowed(() => insert(`${D}09:00:00Z`, `${D}10:00:00Z`)));
  check('вплотную после 11:30–12:30 разрешено', allowed(() => insert(`${D}11:30:00Z`, `${D}12:30:00Z`)));
  check('то же время у другого мастера разрешено', allowed(() => insert(`${D}10:00:00Z`, `${D}11:30:00Z`, { masterId: 2 })));
  check('отменённая поверх занятого разрешена', allowed(() => insert(`${D}10:15:00Z`, `${D}11:00:00Z`, { status: 'cancelled' })));

  const moving = insert(`${D}16:00:00Z`, `${D}17:00:00Z`);
  const move = (starts, ends) => db.prepare('UPDATE appointments SET starts_at=?, ends_at=? WHERE id=?').run(starts, ends, moving);
  check('перенос на занятое 10:45 отклонён', !allowed(() => move(`${D}10:45:00Z`, `${D}11:45:00Z`)));
  check('перенос на свободное 18:00 разрешён', allowed(() => move(`${D}18:00:00Z`, `${D}19:00:00Z`)));

  const swap = () => db.prepare('UPDATE appointments SET master_id=2 WHERE id=?').run(moving);
  insert(`${D}18:30:00Z`, `${D}19:30:00Z`, { masterId: 2 });
  check('смена мастера на занятого отклонена', !allowed(swap));

  check('правка заметки у своей же записи разрешена',
    allowed(() => db.prepare("UPDATE appointments SET admin_note='x' WHERE id=?").run(base)));
  check('смена статуса на completed разрешена',
    allowed(() => db.prepare("UPDATE appointments SET status='completed' WHERE id=?").run(base)));

  // Отменённую запись возвращают в работу, а её время уже заняли.
  const revived = insert(`${D}20:00:00Z`, `${D}21:00:00Z`, { status: 'cancelled' });
  insert(`${D}20:00:00Z`, `${D}21:00:00Z`);
  check('возврат отменённой записи на занятое время отклонён',
    !allowed(() => db.prepare("UPDATE appointments SET status='booked', cancelled_at=NULL, cancelled_by_role=NULL WHERE id=?").run(revived)));
} finally {
  db.exec('ROLLBACK');
}

// =====================================================================
// Перевод ошибки базы в ответ API
// =====================================================================
console.log('\nПеревод ошибки триггера в ответ 409');

const { isSlotConflict } = await import('../src/db/constraints.js');
const { slotTakenError } = await import('../src/services/availability.js');
const { loadSettings } = await import('../src/services/settings.js');

let triggerError = null;
db.exec('BEGIN IMMEDIATE');
try {
  insert(`${D}10:00:00Z`, `${D}11:30:00Z`);
  try { insert(`${D}10:30:00Z`, `${D}11:00:00Z`); } catch (error) { triggerError = error; }
} finally {
  db.exec('ROLLBACK');
}

check('настоящая ошибка триггера опознана', isSlotConflict(triggerError), triggerError?.message);
check('посторонняя ошибка не опознана', !isSlotConflict(new Error('база не найдена')));

const settings = loadSettings();
const day = await findWorkingDay(1, '1', 5);
const slotsResponse = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
const someSlot = slotsResponse.body.slots[0].starts_at;
const translated = slotTakenError({ masterId: 1, startsAt: someSlot, totalMinutes: 60, settings });

check('код ответа 409', translated.status === 409, translated.status);
check('машинный код slot_taken', translated.code === 'slot_taken');
check('сообщение человеческое', translated.message === 'Это время уже занято — выберите другое');
check('приложены свободные слоты', Array.isArray(translated.details.free_slots) && translated.details.free_slots.length > 0);
check('у слота есть время в UTC и местное',
  translated.details.free_slots[0].starts_at?.endsWith('Z') && /^\d\d:\d\d$/.test(translated.details.free_slots[0].local_time));

const leaked = JSON.stringify({ message: translated.message, details: translated.details });
check('текста ошибки базы в ответе нет',
  !/appointment_overlap|SQLITE|constraint|trigger|UNIQUE/i.test(leaked), leaked.slice(0, 200));

// =====================================================================
// Уровень 1 и 2 через HTTP: гонка за один слот
// =====================================================================
console.log('\nУровни 1 и 2. Гонка через HTTP');

async function newClient(tag) {
  const r = await call('POST', '/api/auth/register', {
    body: { email: `race-${tag}-${Date.now()}@example.com`, password: 'secret12345',
            full_name: `Гонщик ${tag}`, phone: '+79001110000' },
  });
  return r.body.token;
}

const raceDay = await findWorkingDay(1, '1', 6);
let r = await call('GET', `/api/availability?master_id=1&date=${raceDay}&service_ids=1`);
const target = r.body.slots[0].starts_at;

const tokens = await Promise.all([...Array(8)].map((_, i) => newClient(i)));
const holds = await Promise.all(
  tokens.map((token) => call('POST', '/api/holds', { token, body: { master_id: 1, starts_at: target, service_ids: [1] } })),
);
const won = holds.filter((h) => h.status === 201);
const lost = holds.filter((h) => h.status === 409);

check('восемь одновременных попыток: слот достался ровно одному', won.length === 1, `201: ${won.length}`);
check('остальные получили 409', lost.length === 7, `409: ${lost.length}`);
check('проигравшим предложены свободные слоты',
  lost.every((h) => Array.isArray(h.body.error.details?.free_slots) && h.body.error.details.free_slots.length > 0));
check('в ответе проигравшим нет текста базы',
  lost.every((h) => !/appointment_overlap|SQLITE|constraint|trigger/i.test(JSON.stringify(h.body))));

const winner = tokens[holds.indexOf(won[0])];
const holdId = won[0].body.hold.id;

// Двойной клик по «Подтвердить»: пять одновременных подтверждений одного резерва.
const confirms = await Promise.all(
  [...Array(5)].map(() => call('POST', '/api/appointments', { token: winner, body: { hold_id: holdId } })),
);
check('двойной клик создаёт ровно одну запись',
  confirms.filter((c) => c.status === 201).length === 1,
  confirms.map((c) => c.status).join(','));
check('повторы получают 409', confirms.filter((c) => c.status === 409).length === 4);

const appointmentId = confirms.find((c) => c.status === 201).body.appointment.id;
const overlapping = db.prepare(
  `SELECT COUNT(*) AS count FROM appointments a
    WHERE a.master_id = 1 AND a.status = 'booked' AND a.id <> ?
      AND a.starts_at < (SELECT ends_at FROM appointments WHERE id = ?)
      AND a.ends_at   > (SELECT starts_at FROM appointments WHERE id = ?)`,
).get(appointmentId, appointmentId, appointmentId).count;
check('в базе нет ни одной пересекающейся записи', overlapping === 0, overlapping);

// Уровень 2: время закрыли в обход API, уже после того как клиент взял резерв.
console.log('\nУровень 2. Время заняли мимо API, пока клиент оформлял');
const sneakyDay = await findWorkingDay(2, '1', 6);
r = await call('GET', `/api/availability?master_id=2&date=${sneakyDay}&service_ids=1`);
const sneaky = r.body.slots[0].starts_at;
const lateToken = await newClient('late');
r = await call('POST', '/api/holds', { token: lateToken, body: { master_id: 2, starts_at: sneaky, service_ids: [1] } });
check('резерв взят', r.status === 201, JSON.stringify(r.body).slice(0, 150));
const lateHold = r.body.hold.id;

const sneakyEnd = new Date(new Date(sneaky).getTime() + 30 * 60000).toISOString().slice(0, 19) + 'Z';
const sneakyId = insert(sneaky, sneakyEnd, { masterId: 2 });

r = await call('POST', '/api/appointments', { token: lateToken, body: { hold_id: lateHold } });
check('подтверждение отклонено с 409', r.status === 409, `${r.status} ${JSON.stringify(r.body).slice(0, 150)}`);
check('код slot_taken', r.body.error.code === 'slot_taken');
check('предложены ближайшие свободные слоты',
  Array.isArray(r.body.error.details?.free_slots) && r.body.error.details.free_slots.length > 0);
check('текста ошибки базы нет', !/appointment_overlap|SQLITE|constraint|trigger/i.test(JSON.stringify(r.body)));

db.prepare('DELETE FROM appointments WHERE id = ?').run(sneakyId);

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
