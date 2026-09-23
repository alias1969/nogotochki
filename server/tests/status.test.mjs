/**
 * Отметка исхода визита: «Завершена» и «Не пришёл».
 *
 * Без неё любой отчёт по выручке считает и несостоявшиеся визиты,
 * поэтому проверяется не только то, что статус меняется, но и кто
 * имеет право его менять и на каких визитах.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:status
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

const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).body.token;
const AT = await login(ADMIN.email, ADMIN.password);
const MT = await login(OLGA.email, MASTER_PASSWORD);   // мастер 1
const MT2 = await login(IRINA.email, MASTER_PASSWORD); // мастер 2

const client = await (async () => {
  const r = await call('POST', '/api/auth/register', {
    body: { email: `st-${Date.now()}@example.com`, password: 'secret12345',
            full_name: 'Клиент Статусов', phone: '+79007778811' },
  });
  return { token: r.body.token, id: r.body.user.id };
})();

const created = [];

/**
 * Уборка — на выходе из процесса, а не последней строкой файла.
 *
 * Обработчик `exit` срабатывает и при обычном завершении, и после
 * необработанного исключения. Именно это здесь важно: прогон, упавший
 * на середине, раньше оставлял в прошлом сдвинутые визиты, и следующий
 * прогон ломался о них триггером. Записи SQLite синхронные, так что
 * в обработчике они успевают выполниться.
 */
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const id of created.reverse()) {
    try {
      db.prepare('DELETE FROM appointment_services WHERE appointment_id = ?').run(id);
      db.prepare('DELETE FROM notifications WHERE appointment_id = ?').run(id);
      db.prepare('DELETE FROM slot_holds WHERE appointment_id = ? OR reschedule_of_id = ?').run(id, id);
      db.prepare("DELETE FROM audit_log WHERE entity_type='appointment' AND entity_id=?").run(id);
      db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
    } catch { /* на выходе жаловаться некому и незачем */ }
  }
  try {
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(client.id);
    // Аккаунт проверки тоже убираем: иначе за прогон в базе оседает
    // ещё один клиент, и так до тех пор, пока база не станет неотличима
    // от свалки.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(client.id);
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(client.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(client.id);
  } catch { /* на кого-то сослались — пусть остаётся */ }
}
process.on('exit', cleanup);

/**
 * Визит в прошлом.
 *
 * Создаётся через API, а потом сдвигается в прошлое прямо в базе:
 * обычным путём записаться назад во времени нельзя — и правильно,
 * что нельзя. Проверять исход визита иначе не на чем.
 */
async function pastVisit(masterId = 1, hoursAgo = 3) {
  const from = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const days = (await call('GET', `/api/availability/days?master_id=${masterId}&from=${from}&service_ids=1`)).body.days;
  const slots = (await call('GET', `/api/availability?master_id=${masterId}&date=${days[0].date}&service_ids=1`)).body.slots;

  const r = await call('POST', '/api/admin/appointments', {
    token: AT, body: { client_id: client.id, master_id: masterId, starts_at: slots[0].starts_at, service_ids: [1] },
  });
  const id = r.body.appointment.id;
  created.push(id);

  const { starts, ends } = freePastHour(masterId, hoursAgo, id);
  db.prepare('UPDATE appointments SET starts_at = ?, ends_at = ? WHERE id = ?').run(starts, ends, id);
  return id;
}

/**
 * Свободный час в прошлом у этого мастера.
 *
 * Раньше час брался жёстко — «три часа назад», — и это работало ровно
 * до тех пор, пока прошлое оставалось пустым. Стоило одному прогону
 * упасть, не добравшись до уборки, как сдвинутый в прошлое визит
 * оставался в базе, и следующий прогон бил в него триггером
 * appointment_overlap: набор падал не из-за кода, а из-за собственного
 * мусора.
 *
 * Условие занятости — то же, что в триггере (миграция 002): пересечение
 * по строгим неравенствам и только со статусом 'booked'. Отменённые
 * время не держат.
 */
function freePastHour(masterId, hoursAgo, exceptId) {
  for (let back = hoursAgo; back < hoursAgo + 24 * 30; back += 1) {
    const starts = new Date(Date.now() - back * 3600000).toISOString().slice(0, 19) + 'Z';
    const ends = new Date(Date.now() - (back - 1) * 3600000).toISOString().slice(0, 19) + 'Z';
    const busy = db.prepare(
      `SELECT 1 FROM appointments
        WHERE master_id = ? AND status = 'booked' AND id <> ?
          AND starts_at < ? AND ends_at > ?`,
    ).get(masterId, exceptId, ends, starts);
    if (!busy) return { starts, ends };
  }
  throw new Error(`У мастера ${masterId} не нашлось свободного часа в прошлом за месяц — база засорена`);
}

const statusOf = (id) => db.prepare('SELECT status FROM appointments WHERE id = ?').get(id).status;

// =====================================================================
console.log('\n1. Мастер отмечает свой визит');
const visit = await pastVisit();
let r = await call('POST', `/api/appointments/${visit}/status`, { token: MT, body: { status: 'completed' } });
check('визит отмечен завершённым', r.status === 200, JSON.stringify(r.body).slice(0, 200));
check('статус в ответе', r.body.appointment.status === 'completed', r.body.appointment.status);
check('статус в базе', statusOf(visit) === 'completed');

const audit = db.prepare(
  "SELECT actor_role, details FROM audit_log WHERE entity_type='appointment' AND entity_id=? AND action='status_change'").get(visit);
check('записано в журнал', !!audit, audit);
check('в журнале роль мастера', audit?.actor_role === 'master', audit?.actor_role);
check('видно, из какого статуса в какой', /booked.*completed/.test(audit?.details ?? ''), audit?.details);

r = await call('POST', `/api/appointments/${visit}/status`, { token: MT, body: { status: 'completed' } });
check('повторное нажатие не ошибка', r.status === 200, r.status);

r = await call('POST', `/api/appointments/${visit}/status`, {
  token: MT, body: { status: 'no_show', note: 'Ошибся кнопкой' } });
check('ошибку кнопки можно исправить', r.status === 200 && statusOf(visit) === 'no_show', statusOf(visit));
check('заметка ушла в журнал',
  db.prepare("SELECT details FROM audit_log WHERE entity_id=? AND action='status_change' ORDER BY id DESC").get(visit)
    .details.includes('Ошибся кнопкой'));

// =====================================================================
console.log('\n2. Кто имеет право');
const second = await pastVisit();
r = await call('POST', `/api/appointments/${second}/status`, { token: client.token, body: { status: 'completed' } });
check('клиент не отмечает исход → 403', r.status === 403, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
check('в отказе сказано, кто отмечает', /мастер|администратор/i.test(r.body.error.message), r.body.error.message);
check('статус не изменился', statusOf(second) === 'booked');

r = await call('POST', `/api/appointments/${second}/status`, { token: MT2, body: { status: 'completed' } });
check('чужой мастер не видит запись → 404', r.status === 404, r.status);
r = await call('POST', `/api/appointments/${second}/status`, { body: { status: 'completed' } });
check('без входа → 401', r.status === 401, r.status);

r = await call('POST', `/api/appointments/${second}/status`, { token: AT, body: { status: 'no_show' } });
check('администратор отмечает любой визит', r.status === 200 && statusOf(second) === 'no_show', statusOf(second));
check('в журнале роль администратора',
  db.prepare("SELECT actor_role FROM audit_log WHERE entity_id=? AND action='status_change' ORDER BY id DESC").get(second)
    .actor_role === 'admin');

// =====================================================================
console.log('\n3. Что отметить нельзя');
const future = await (async () => {
  const from = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
  const days = (await call('GET', `/api/availability/days?master_id=1&from=${from}&service_ids=1`)).body.days;
  const slots = (await call('GET', `/api/availability?master_id=1&date=${days[0].date}&service_ids=1`)).body.slots;
  const res = await call('POST', '/api/admin/appointments', {
    token: AT, body: { client_id: client.id, master_id: 1, starts_at: slots[0].starts_at, service_ids: [1] } });
  created.push(res.body.appointment.id);
  return res.body.appointment.id;
})();

r = await call('POST', `/api/appointments/${future}/status`, { token: MT, body: { status: 'completed' } });
check('будущий визит отметить нельзя → 422', r.status === 422 && r.body.error.code === 'visit_not_started',
  `${r.status} ${JSON.stringify(r.body).slice(0, 150)}`);
check('и администратору тоже нельзя',
  (await call('POST', `/api/appointments/${future}/status`, { token: AT, body: { status: 'completed' } })).status === 422);
check('статус остался booked', statusOf(future) === 'booked');

const cancelled = await pastVisit();
db.prepare("UPDATE appointments SET status='cancelled', cancelled_at=?, cancelled_by_role='admin' WHERE id=?")
  .run(new Date().toISOString().slice(0, 19) + 'Z', cancelled);
r = await call('POST', `/api/appointments/${cancelled}/status`, { token: AT, body: { status: 'completed' } });
check('отменённую запись не воскресить → 409', r.status === 409 && r.body.error.code === 'appointment_cancelled',
  `${r.status} ${JSON.stringify(r.body).slice(0, 150)}`);
check('она осталась отменённой', statusOf(cancelled) === 'cancelled');

r = await call('POST', `/api/appointments/${second}/status`, { token: AT, body: { status: 'cancelled' } });
check('отмена через этот эндпоинт не проходит → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
r = await call('POST', `/api/appointments/${second}/status`, { token: AT, body: { status: 'booked' } });
check('вернуть в booked этим путём нельзя → 400', r.status === 400, r.status);
r = await call('POST', `/api/appointments/${second}/status`, { token: AT, body: { status: 'выдумка' } });
check('незнакомый статус → 400', r.status === 400, r.status);
r = await call('POST', `/api/appointments/${second}/status`, { token: AT, body: {} });
check('без статуса → 400', r.status === 400, r.status);

// =====================================================================
console.log('\n4. Что меняется вокруг');
const done = await pastVisit(2, 2);
const beforeRow = db.prepare('SELECT starts_at, ends_at, reschedule_count FROM appointments WHERE id = ?').get(done);
await call('POST', `/api/appointments/${done}/status`, { token: AT, body: { status: 'completed' } });
const afterRow = db.prepare('SELECT starts_at, ends_at, reschedule_count FROM appointments WHERE id = ?').get(done);
check('время визита не тронуто',
  afterRow.starts_at === beforeRow.starts_at && afterRow.ends_at === beforeRow.ends_at);
check('счётчик переносов не тронут', afterRow.reschedule_count === beforeRow.reschedule_count);
check('состав визита на месте',
  db.prepare('SELECT COUNT(*) c FROM appointment_services WHERE appointment_id = ?').get(done).c === 1);
check('запись видна клиенту в истории',
  (await call('GET', '/api/appointments?scope=past', { token: client.token }))
    .body.appointments.some((a) => a.id === done && a.status === 'completed'));
check('администратор фильтрует по статусу',
  (await call('GET', '/api/admin/appointments?status=completed&limit=500', { token: AT }))
    .body.appointments.some((a) => a.id === done));

// Завершённый визит перестаёт быть действующим — уникальный индекс его
// больше не держит, и на то же время можно записать снова.
const sameTime = db.prepare('SELECT starts_at, ends_at FROM appointments WHERE id = ?').get(done);
let again = null;
try {
  again = db.prepare(
    `INSERT INTO appointments(client_id, master_id, starts_at, ends_at, status, created_by_role, created_by_user_id)
     VALUES (?, 2, ?, ?, 'booked', 'admin', 1)`,
  ).run(client.id, sameTime.starts_at, sameTime.ends_at).lastInsertRowid;
} catch (error) {
  again = error.message;
}
check('на время завершённого визита можно записать снова', typeof again === 'number', again);
if (typeof again === 'number') db.prepare('DELETE FROM appointments WHERE id = ?').run(again);

// Уборка выполнится сама на выходе — см. cleanup() выше.
console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
