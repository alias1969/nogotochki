/**
 * Уведомления личного кабинета — экран K4.
 *
 * Проверяет обе половины: что события студии действительно создают
 * уведомления и что человек видит только свои. Уведомления — единственный
 * канал, который паспорт разрешает («приходят только внутри личного
 * кабинета»), поэтому важно не столько API само по себе, сколько то,
 * что запись, отмена и перенос до него доходят.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:notifications
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

async function newClient(tag) {
  const r = await call('POST', '/api/auth/register', {
    body: { email: `note-${tag}-${Date.now()}@example.com`, password: 'secret12345',
            full_name: `Клиент ${tag}`, phone: '+79003334455' },
  });
  return { token: r.body.token, id: r.body.user.id };
}
async function workingDay(masterId, offsetDays) {
  const from = new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  const r = await call('GET', `/api/availability/days?master_id=${masterId}&from=${from}&service_ids=1`);
  return r.body.days[0].date;
}

const created = [];

// =====================================================================
console.log('\n1. Пустой кабинет');
const anna = await newClient('anna');
let r = await call('GET', '/api/notifications', { token: anna.token });
check('список читается', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('у нового клиента пусто', r.body.notifications.length === 0 && r.body.unread === 0, JSON.stringify(r.body).slice(0, 120));
check('листать нечего', r.body.next_before_id === null);

r = await call('GET', '/api/notifications');
check('без входа → 401', r.status === 401, r.status);

// =====================================================================
console.log('\n2. События студии доходят до кабинета');
const day = await workingDay(1, 5);
r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
const slots = r.body.slots;

r = await call('POST', '/api/holds', { token: anna.token, body: { master_id: 1, starts_at: slots[0].starts_at, service_ids: [1] } });
r = await call('POST', '/api/appointments', { token: anna.token, body: { hold_id: r.body.hold.id } });
const apptId = r.body.appointment.id;
created.push(apptId);
check('запись создана', r.status === 201, JSON.stringify(r.body).slice(0, 150));

r = await call('GET', '/api/notifications', { token: anna.token });
check('о записи пришло уведомление', r.body.notifications.length === 1, JSON.stringify(r.body).slice(0, 200));
check('счётчик непрочитанных — 1', r.body.unread === 1, r.body.unread);
const first = r.body.notifications[0];
check('вид booking_created', first.kind === 'booking_created', first.kind);
check('непрочитанное', first.is_read === false && first.read_at === null);
check('время создания парой UTC и местное',
  first.created_at.utc.endsWith('Z') && first.created_at.local.includes('+03:00'), JSON.stringify(first.created_at));
check('есть переход к записи', first.appointment?.id === apptId, JSON.stringify(first.appointment));
check('видно время визита', first.appointment.starts_at.utc === slots[0].starts_at);
check('видно статус визита', first.appointment.status === 'booked');
check('чужих данных в уведомлении нет',
  !/client_name|phone|email/.test(JSON.stringify(first)), JSON.stringify(first).slice(0, 200));

// перенос
r = await call('GET', `/api/availability?master_id=1&date=${day}&reschedule_of=${apptId}`, { token: anna.token });
// Любой слот, заметно отстоящий от текущего времени визита; если день
// короткий — последний свободный.
const target = r.body.slots.find((s) => new Date(s.starts_at) - new Date(slots[0].starts_at) >= 60 * 60000)
  ?? r.body.slots.at(-1);
r = await call('POST', '/api/holds', { token: anna.token, body: { master_id: 1, starts_at: target.starts_at, reschedule_of: apptId } });
r = await call('POST', `/api/appointments/${apptId}/reschedule`, { token: anna.token, body: { hold_id: r.body.hold.id } });
check('запись перенесена', r.status === 200, JSON.stringify(r.body).slice(0, 150));

r = await call('GET', '/api/notifications', { token: anna.token });
check('о переносе пришло уведомление', r.body.notifications[0].kind === 'booking_rescheduled', r.body.notifications[0].kind);
check('новое сверху', r.body.notifications.length === 2 && r.body.notifications[0].id > r.body.notifications[1].id);
check('счётчик — 2', r.body.unread === 2, r.body.unread);

// отмена администратором
r = await call('POST', `/api/appointments/${apptId}/cancel`, { token: AT, body: { reason: 'Мастер заболел' } });
check('администратор отменил', r.status === 200, JSON.stringify(r.body).slice(0, 150));
r = await call('GET', '/api/notifications', { token: anna.token });
check('об отмене пришло уведомление', r.body.notifications[0].kind === 'booking_cancelled', r.body.notifications[0].kind);
check('в тексте видна причина', r.body.notifications[0].body.includes('Мастер заболел'), r.body.notifications[0].body);
check('статус записи в уведомлении обновился', r.body.notifications[0].appointment.status === 'cancelled');
check('счётчик — 3', r.body.unread === 3, r.body.unread);

// смена пароля
await call('POST', '/api/auth/change-password', {
  token: anna.token, body: { current_password: 'secret12345', new_password: 'notenew12345' } });
r = await call('GET', '/api/notifications', { token: anna.token });
check('о смене пароля тоже уведомляют', r.body.notifications[0].kind === 'system', r.body.notifications[0].kind);
check('к записи такое уведомление не привязано', r.body.notifications[0].appointment === null);

// =====================================================================
console.log('\n3. Отметка о прочтении');
const unreadIds = (await call('GET', '/api/notifications', { token: anna.token })).body.notifications.map((n) => n.id);
r = await call('POST', `/api/notifications/${unreadIds[0]}/read`, { token: anna.token });
check('отметка принята', r.status === 200, JSON.stringify(r.body).slice(0, 120));
check('счётчик уменьшился', r.body.unread === 3, r.body.unread);

r = await call('GET', '/api/notifications', { token: anna.token });
const marked = r.body.notifications.find((n) => n.id === unreadIds[0]);
check('уведомление стало прочитанным', marked.is_read === true && marked.read_at !== null, JSON.stringify(marked).slice(0, 150));
const readAt = marked.read_at.utc;

r = await call('POST', `/api/notifications/${unreadIds[0]}/read`, { token: anna.token });
check('повторная отметка не ошибка', r.status === 200, r.status);
r = await call('GET', '/api/notifications', { token: anna.token });
check('момент первого прочтения не переписан',
  r.body.notifications.find((n) => n.id === unreadIds[0]).read_at.utc === readAt);

r = await call('GET', '/api/notifications?unread=true', { token: anna.token });
check('фильтр непрочитанных работает', r.body.notifications.length === 3 && r.body.notifications.every((n) => !n.is_read),
  r.body.notifications.length);

r = await call('GET', '/api/notifications/unread-count', { token: anna.token });
check('отдельный счётчик совпадает', r.body.unread === 3, JSON.stringify(r.body));

r = await call('POST', '/api/notifications/read-all', { token: anna.token });
check('прочитаны все', r.status === 200 && r.body.marked === 3 && r.body.unread === 0, JSON.stringify(r.body));
r = await call('GET', '/api/notifications?unread=true', { token: anna.token });
check('непрочитанных не осталось', r.body.notifications.length === 0);

// =====================================================================
console.log('\n4. Чужие уведомления');
const boris = await newClient('boris');
r = await call('GET', '/api/notifications', { token: boris.token });
check('чужих уведомлений не видно', r.body.notifications.length === 0, JSON.stringify(r.body).slice(0, 120));
r = await call('POST', `/api/notifications/${unreadIds[1]}/read`, { token: boris.token });
check('чужое уведомление → 404, а не 403', r.status === 404, r.status);
r = await call('POST', '/api/notifications/999999/read', { token: anna.token });
check('несуществующее → 404', r.status === 404, r.status);
r = await call('GET', '/api/notifications', { token: AT });
check('у администратора свой список', r.status === 200 && !r.body.notifications.some((n) => unreadIds.includes(n.id)));

// =====================================================================
console.log('\n5. Листание');
const many = await newClient('many');
const insert = db.prepare(
  "INSERT INTO notifications(user_id, kind, title, body) VALUES (?, 'system', ?, 'Текст')");
for (let i = 1; i <= 7; i += 1) insert.run(many.id, `Сообщение ${i}`);

r = await call('GET', '/api/notifications?limit=3', { token: many.token });
check('первая страница — три', r.body.notifications.length === 3, r.body.notifications.length);
check('курсор на следующую выдан', typeof r.body.next_before_id === 'number', r.body.next_before_id);
check('сверху самое свежее', r.body.notifications[0].title === 'Сообщение 7', r.body.notifications[0].title);

const page2 = await call('GET', `/api/notifications?limit=3&before_id=${r.body.next_before_id}`, { token: many.token });
check('вторая страница не повторяет первую',
  !page2.body.notifications.some((n) => r.body.notifications.some((m) => m.id === n.id)));
check('на ней следующие три', page2.body.notifications[0].title === 'Сообщение 4', page2.body.notifications[0].title);

const page3 = await call('GET', `/api/notifications?limit=3&before_id=${page2.body.next_before_id}`, { token: many.token });
check('на последней — остаток', page3.body.notifications.length === 1, page3.body.notifications.length);
check('курсор кончился', page3.body.next_before_id === null);

r = await call('GET', '/api/notifications?limit=500', { token: many.token });
check('слишком большой limit → 400', r.status === 400, r.status);
r = await call('GET', '/api/notifications?before_id=ноль', { token: many.token });
check('битый курсор → 400', r.status === 400, r.status);

// --- уборка ---
for (const id of created) {
  db.prepare('DELETE FROM appointment_services WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM slot_holds WHERE appointment_id = ? OR reschedule_of_id = ?').run(id, id);
  db.prepare("DELETE FROM audit_log WHERE entity_type='appointment' AND entity_id=?").run(id);
  db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
}
for (const u of [anna.id, boris.id, many.id]) db.prepare('DELETE FROM notifications WHERE user_id = ?').run(u);

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
