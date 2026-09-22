/**
 * Кабинет мастера — действия.
 *
 * Закрытие своего времени, заявки на изменение графика, загрузка
 * и выручка, уведомления о чужих действиях с его расписанием.
 *
 * Как и в проверке чтения, половина внимания — границам: мастер
 * закрывает своё время и только своё, отпуск себе не выписывает,
 * чужие закрытия не снимает.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:master-actions
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, ADMIN, OLGA as OLGA_ACCOUNT, IRINA as IRINA_ACCOUNT, ANNA, MASTER_PASSWORD } from './env.mjs';

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
const OLGA = await login(OLGA_ACCOUNT.email, MASTER_PASSWORD);   // мастер 1, аккаунт 2
const IRINA = await login(IRINA_ACCOUNT.email, MASTER_PASSWORD); // мастер 2, аккаунт 3

const client = await (async () => {
  const r = await call('POST', '/api/auth/register', {
    body: { email: `ma-${Date.now()}@example.com`, password: 'secret12345',
            full_name: 'Клиент Действий', phone: '+79004442211' },
  });
  return { token: r.body.token, id: r.body.user.id };
})();

const created = [];
const requests = [];
const exceptions = [];

// =====================================================================
console.log('\n1. Закрытие своего времени');
const from = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
const day = (await call('GET', `/api/availability/days?master_id=1&from=${from}&service_ids=1`)).body.days[0].date;
let r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
const slots = r.body.slots;
const before = slots.length;

const blockFrom = slots[0].starts_at;
const blockTo = new Date(new Date(blockFrom).getTime() + 90 * 60000).toISOString().slice(0, 19) + 'Z';

r = await call('POST', '/api/master/schedule-exceptions', {
  token: OLGA, body: { starts_at: blockFrom, ends_at: blockTo, reason: 'Поставка материалов' },
});
check('мастер закрыл своё время', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const block = r.body.exception.id;
exceptions.push(block);
check('вид time_block по умолчанию', r.body.exception.kind === 'time_block', r.body.exception.kind);
check('причина сохранена', r.body.exception.reason === 'Поставка материалов');
check('закрыто на своё имя',
  db.prepare('SELECT created_by, master_id FROM schedule_exceptions WHERE id = ?').get(block).created_by === 2);

r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
check('закрытое время исчезло из свободных', !r.body.slots.some((s) => s.starts_at === blockFrom));
check('остальной день на месте', r.body.slots.length > 0 && r.body.slots.length < before, r.body.slots.length);

r = await call('GET', `/api/master/day?date=${day}`, { token: OLGA });
check('закрытие видно в своём дне', r.body.exceptions.some((e) => e.id === block));

r = await call('DELETE', `/api/master/schedule-exceptions/${block}`, { token: OLGA });
check('своё закрытие снимается', r.status === 200, r.status);
r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
check('время вернулось само', r.body.slots.length === before, `${r.body.slots.length} против ${before}`);
exceptions.pop();

// --- границы ---
r = await call('POST', '/api/master/schedule-exceptions', {
  token: OLGA, body: { kind: 'vacation', starts_at: blockFrom, ends_at: blockTo } });
check('отпуск себе мастер не выписывает → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
r = await call('POST', '/api/master/schedule-exceptions', {
  token: OLGA, body: { kind: 'extra_shift', starts_at: blockFrom, ends_at: blockTo } });
check('и дополнительную смену тоже → 400', r.status === 400, r.status);
r = await call('POST', '/api/master/schedule-exceptions', {
  token: OLGA, body: { starts_at: blockTo, ends_at: blockFrom } });
check('интервал задом наперёд → 422', r.status === 422, r.status);
r = await call('POST', '/api/master/schedule-exceptions', {
  token: client.token, body: { starts_at: blockFrom, ends_at: blockTo } });
check('клиенту закрыто → 403', r.status === 403, r.status);

// Закрытие, поставленное администратором, мастер не снимает.
r = await call('POST', '/api/admin/masters/1/schedule-exceptions', {
  token: AT, body: { kind: 'time_block', starts_at: blockFrom, ends_at: blockTo, reason: 'Санитарный час' } });
const adminBlock = r.body.exception.id;
exceptions.push(adminBlock);
r = await call('DELETE', `/api/master/schedule-exceptions/${adminBlock}`, { token: OLGA });
check('чужое закрытие мастер не снимает → 403', r.status === 403, `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
check('оно осталось на месте',
  !!db.prepare('SELECT id FROM schedule_exceptions WHERE id = ?').get(adminBlock));

// Чужой мастер не лезет в чужое расписание.
r = await call('DELETE', `/api/master/schedule-exceptions/${adminBlock}`, { token: IRINA });
check('чужой мастер получает 404', r.status === 404, r.status);
await call('DELETE', `/api/admin/schedule-exceptions/${adminBlock}`, { token: AT });
exceptions.pop();

// Закрытие поверх назначенного визита предупреждает, но не отменяет.
const visitDay = (await call('GET', `/api/availability/days?master_id=1&from=${from}&service_ids=1`)).body.days[0].date;
const visitSlot = (await call('GET', `/api/availability?master_id=1&date=${visitDay}&service_ids=1`)).body.slots[0].starts_at;
r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: client.id, master_id: 1, starts_at: visitSlot, service_ids: [1] } });
const visit = r.body.appointment.id;
created.push(visit);
r = await call('POST', '/api/master/schedule-exceptions', {
  token: OLGA, body: { starts_at: visitSlot, ends_at: new Date(new Date(visitSlot).getTime() + 3600000).toISOString().slice(0, 19) + 'Z' } });
check('закрытие поверх визита проходит', r.status === 201, JSON.stringify(r.body).slice(0, 150));
exceptions.push(r.body.exception.id);
check('но визит показан мастеру', r.body.affected_appointments.some((a) => a.id === visit),
  JSON.stringify(r.body.affected_appointments));
check('и не отменён', db.prepare('SELECT status FROM appointments WHERE id = ?').get(visit).status === 'booked');
await call('DELETE', `/api/master/schedule-exceptions/${exceptions.pop()}`, { token: OLGA });

// =====================================================================
console.log('\n2. Заявки на изменение графика');
r = await call('POST', '/api/master/schedule-requests', {
  token: OLGA, body: { message: 'Прошу по средам начинать с 12:00', desired_from: day },
});
check('заявка создана', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const request = r.body.request.id;
requests.push(request);
check('статус pending', r.body.request.status === 'pending');
check('ответа пока нет', r.body.request.reviewed_at === null && r.body.request.admin_comment === null);

check('администратору пришло уведомление',
  !!db.prepare("SELECT id FROM notifications WHERE user_id = 1 AND kind = 'schedule_request_created' ORDER BY id DESC").get());

r = await call('POST', '/api/master/schedule-requests', { token: OLGA, body: { message: 'Ок' } });
check('слишком короткое сообщение → 400', r.status === 400, r.status);
r = await call('POST', '/api/master/schedule-requests', {
  token: OLGA, body: { message: 'Период задом наперёд', desired_from: '2026-12-01', desired_to: '2026-11-01' } });
check('период задом наперёд → 422', r.status === 422, r.status);
r = await call('POST', '/api/master/schedule-requests', { token: client.token, body: { message: 'Хочу график' } });
check('клиент заявок не подаёт → 403', r.status === 403, r.status);

r = await call('GET', '/api/master/schedule-requests', { token: OLGA });
check('свои заявки видны', r.body.requests.some((x) => x.id === request));
check('имени мастера в своём кабинете нет', !('master' in r.body.requests[0]), JSON.stringify(r.body.requests[0]).slice(0, 150));
r = await call('GET', '/api/master/schedule-requests', { token: IRINA });
check('чужих заявок мастер не видит', !r.body.requests.some((x) => x.id === request));

r = await call('GET', '/api/admin/schedule-requests?status=pending', { token: AT });
check('администратор видит заявку', r.body.requests.some((x) => x.id === request), JSON.stringify(r.body).slice(0, 200));
check('ему видно, чья она', r.body.requests.find((x) => x.id === request).master?.name === 'Ольга');
r = await call('GET', '/api/admin/schedule-requests', { token: OLGA });
check('мастер в общий список не ходит → 403', r.status === 403, r.status);

r = await call('POST', `/api/admin/schedule-requests/${request}/review`, {
  token: AT, body: { decision: 'approved', comment: 'Согласовано с понедельника' } });
check('заявка утверждена', r.status === 200 && r.body.request.status === 'approved', JSON.stringify(r.body).slice(0, 200));
check('проставлен момент ответа', r.body.request.reviewed_at?.utc?.endsWith('Z'));
check('комментарий сохранён', r.body.request.admin_comment === 'Согласовано с понедельника');
check('мастеру пришло уведомление',
  !!db.prepare("SELECT id FROM notifications WHERE user_id = 2 AND kind = 'schedule_request_reviewed' ORDER BY id DESC").get());

r = await call('POST', `/api/admin/schedule-requests/${request}/review`, { token: AT, body: { decision: 'rejected' } });
check('повторно рассмотреть нельзя → 409', r.status === 409 && r.body.error.code === 'request_already_reviewed',
  `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
r = await call('POST', `/api/admin/schedule-requests/${request}/review`, { token: AT, body: { decision: 'maybe' } });
check('незнакомое решение → 400', r.status === 400, r.status);
check('график сам не изменился — это переписка, а не команда',
  db.prepare('SELECT COUNT(*) c FROM master_schedules WHERE master_id = 1').get().c === 10,
  db.prepare('SELECT COUNT(*) c FROM master_schedules WHERE master_id = 1').get().c);

// =====================================================================
console.log('\n3. Загрузка и выручка');
// Завершённый визит в прошлом — единственный, что попадёт в выручку.
const done = await (async () => {
  const d = (await call('GET', `/api/availability/days?master_id=1&from=${from}&service_ids=1`)).body.days[0].date;
  const s = (await call('GET', `/api/availability?master_id=1&date=${d}&service_ids=1`)).body.slots.at(-1).starts_at;
  const res = await call('POST', '/api/admin/appointments', {
    token: AT, body: { client_id: client.id, master_id: 1, starts_at: s, service_ids: [1, 2] } });
  const id = res.body.appointment.id;
  created.push(id);
  const start = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 19) + 'Z';
  const end = new Date(Date.now() - 1.5 * 3600000).toISOString().slice(0, 19) + 'Z';
  db.prepare('UPDATE appointments SET starts_at = ?, ends_at = ? WHERE id = ?').run(start, end, id);
  await call('POST', `/api/appointments/${id}/status`, { token: OLGA, body: { status: 'completed' } });
  return id;
})();

const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
r = await call('GET', `/api/master/workload?from=${today}&to=${today}`, { token: OLGA });
check('сводка читается', r.status === 200, JSON.stringify(r.body).slice(0, 250));
check('завершённый визит посчитан', r.body.completed.visits === 1, JSON.stringify(r.body.completed));
check('выручка по снимкам цен', r.body.completed.revenue_kopecks === 400000, r.body.completed.revenue_kopecks);
check('отработанные минуты', r.body.completed.minutes === 90, r.body.completed.minutes);
check('разбивка по услугам', r.body.by_service.length === 2, JSON.stringify(r.body.by_service));
check('в разбивке названия и суммы',
  r.body.by_service.reduce((s, x) => s + x.revenue_kopecks, 0) === 400000, JSON.stringify(r.body.by_service));
check('запланированные часы посчитаны', r.body.scheduled_minutes > 0, r.body.scheduled_minutes);
check('доля загрузки выведена', typeof r.body.utilization_percent === 'number', r.body.utilization_percent);

// Правка прайса не меняет прошлый отчёт.
await call('PATCH', '/api/admin/services/1', { token: AT, body: { price_kopecks: 999000 } });
r = await call('GET', `/api/master/workload?from=${today}&to=${today}`, { token: OLGA });
check('подорожание услуги не переписало выручку', r.body.completed.revenue_kopecks === 400000,
  r.body.completed.revenue_kopecks);
await call('PATCH', '/api/admin/services/1', { token: AT, body: { price_kopecks: 250000 } });

r = await call('GET', '/api/master/workload', { token: OLGA });
check('без периода — текущий месяц', r.body.range.from.endsWith('-01') && r.body.range.to >= r.body.range.from,
  JSON.stringify(r.body.range));
r = await call('GET', `/api/master/workload?from=${today}&to=2020-01-01`, { token: OLGA });
check('период задом наперёд → 422', r.status === 422, r.status);
r = await call('GET', '/api/master/workload?from=2020-01-01&to=2030-01-01', { token: OLGA });
check('слишком длинный период → 422', r.status === 422 && r.body.error.code === 'range_too_long', r.status);
r = await call('GET', '/api/master/workload', { token: client.token });
check('клиенту закрыто → 403', r.status === 403, r.status);

// =====================================================================
console.log('\n4. Уведомления мастеру о его расписании');
const beforeCount = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = 2").get().c;

const fresh = await (async () => {
  const d = (await call('GET', `/api/availability/days?master_id=1&from=${from}&service_ids=1`)).body.days[0].date;
  const s = (await call('GET', `/api/availability?master_id=1&date=${d}&service_ids=1`)).body.slots[0].starts_at;
  const hold = (await call('POST', '/api/holds', { token: client.token, body: { master_id: 1, starts_at: s, service_ids: [1] } })).body.hold.id;
  const res = await call('POST', '/api/appointments', { token: client.token, body: { hold_id: hold } });
  created.push(res.body.appointment.id);
  return res.body.appointment.id;
})();
check('о новой записи мастеру сообщили',
  !!db.prepare("SELECT id FROM notifications WHERE user_id = 2 AND kind = 'booking_created' AND appointment_id = ?").get(fresh));

await call('POST', `/api/appointments/${fresh}/cancel`, { token: client.token, body: { reason: 'Передумал' } });
check('об отмене клиентом мастеру тоже сообщили',
  !!db.prepare("SELECT id FROM notifications WHERE user_id = 2 AND kind = 'booking_cancelled' AND appointment_id = ?").get(fresh));
check('клиент своё уведомление тоже получил',
  !!db.prepare("SELECT id FROM notifications WHERE user_id = ? AND kind = 'booking_cancelled' AND appointment_id = ?").get(client.id, fresh));

// Своё же действие мастеру не дублируется.
const ownCancel = await (async () => {
  const d = (await call('GET', `/api/availability/days?master_id=1&from=${from}&service_ids=1`)).body.days[0].date;
  const s = (await call('GET', `/api/availability?master_id=1&date=${d}&service_ids=1`)).body.slots[0].starts_at;
  const res = await call('POST', '/api/admin/appointments', {
    token: AT, body: { client_id: client.id, master_id: 1, starts_at: s, service_ids: [1] } });
  created.push(res.body.appointment.id);
  return res.body.appointment.id;
})();
await call('POST', `/api/appointments/${ownCancel}/cancel`, { token: OLGA, body: { reason: 'Заболела' } });
check('свою же отмену мастеру не дублируют',
  !db.prepare("SELECT id FROM notifications WHERE user_id = 2 AND kind = 'booking_cancelled' AND appointment_id = ?").get(ownCancel));
check('а клиент о ней узнал',
  !!db.prepare("SELECT id FROM notifications WHERE user_id = ? AND kind = 'booking_cancelled' AND appointment_id = ?").get(client.id, ownCancel));
check('уведомлений у мастера прибавилось',
  db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = 2").get().c > beforeCount);

r = await call('GET', '/api/notifications', { token: OLGA });
check('мастер читает их своим кабинетом', r.status === 200 && r.body.notifications.length > 0, r.body.notifications?.length);

// --- уборка ---
for (const id of exceptions) db.prepare('DELETE FROM schedule_exceptions WHERE id = ?').run(id);
for (const id of requests) {
  db.prepare("DELETE FROM audit_log WHERE entity_type='schedule_change_request' AND entity_id=?").run(id);
  db.prepare('DELETE FROM schedule_change_requests WHERE id = ?').run(id);
}
for (const id of created.reverse()) {
  db.prepare('DELETE FROM appointment_services WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM slot_holds WHERE appointment_id = ? OR reschedule_of_id = ?').run(id, id);
  db.prepare("DELETE FROM audit_log WHERE entity_type='appointment' AND entity_id=?").run(id);
  db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
}
db.prepare("DELETE FROM notifications WHERE user_id IN (1, 2) AND kind LIKE 'schedule_request%'").run();
db.prepare('DELETE FROM notifications WHERE user_id = ?').run(client.id);

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
