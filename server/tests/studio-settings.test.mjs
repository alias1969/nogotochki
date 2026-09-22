/**
 * Настройки студии — экран A11.
 *
 * Главное здесь не «значение сохранилось», а что правила действительно
 * управляют сервисом: изменил длительность резерва — таймер на экране
 * подтверждения стал другим; закрыл студию на день — слоты исчезли.
 * Настройка, которую можно поменять, но которая ни на что не влияет,
 * хуже отсутствующей.
 *
 * Проверка возвращает все значения обратно — она гоняется на той же базе,
 * что и остальные.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:studio
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
const client = await (async () => {
  const r = await call('POST', '/api/auth/register', {
    body: { email: `set-${Date.now()}@example.com`, password: 'secret12345',
            full_name: 'Клиент Настроек', phone: '+79006665544' } });
  return { token: r.body.token, id: r.body.user.id };
})();

/** Исходные значения — чтобы вернуть всё как было. */
const ORIGINAL = Object.fromEntries(
  db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
const ORIGINAL_HOURS = db.prepare('SELECT weekday, is_closed, open_time, close_time FROM studio_hours').all();

// =====================================================================
console.log('\n1. Чтение правил');
let r = await call('GET', '/api/admin/settings', { token: AT });
check('настройки читаются', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('все тринадцать ключей', r.body.settings.length === 13, r.body.settings.length);

const hold = r.body.settings.find((x) => x.key === 'hold_minutes');
check('у числовой настройки есть границы', hold.type === 'int' && hold.min === 1 && hold.max === 120,
  JSON.stringify(hold));
check('есть человеческое название', typeof hold.title === 'string' && hold.title.length > 5, hold.title);
check('есть группа для раскладки', hold.group === 'booking', hold.group);
check('текстовая настройка описана длиной',
  r.body.settings.find((x) => x.key === 'studio_name').max_length === 100);

r = await call('GET', '/api/admin/settings', { token: client.token });
check('клиенту закрыто → 403', r.status === 403, r.status);
r = await call('GET', '/api/admin/settings');
check('без входа → 401', r.status === 401, r.status);

// =====================================================================
console.log('\n2. Правила действительно управляют сервисом');
r = await call('PATCH', '/api/admin/settings', { token: AT, body: { settings: { hold_minutes: 25 } } });
check('значение изменено', r.status === 200 && r.body.updated.includes('hold_minutes'), JSON.stringify(r.body).slice(0, 150));

const day = (await call('GET', `/api/availability/days?master_id=1&from=${new Date(Date.now() + 11 * 86400000).toISOString().slice(0, 10)}&service_ids=1`)).body.days[0].date;
const slots = (await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`)).body.slots;
r = await call('POST', '/api/holds', { token: client.token, body: { master_id: 1, starts_at: slots[0].starts_at, service_ids: [1] } });
check('резерв стал жить 25 минут', r.body.hold.expires_in_seconds > 1400 && r.body.hold.expires_in_seconds <= 1500,
  r.body.hold.expires_in_seconds);
await call('DELETE', `/api/holds/${r.body.hold.id}`, { token: client.token });

r = await call('GET', '/api/studio');
check('новое правило видно и на витрине', r.body.studio.booking_rules.hold_minutes === 25,
  r.body.studio.booking_rules.hold_minutes);

// Горизонт календаря.
await call('PATCH', '/api/admin/settings', { token: AT, body: { settings: { booking_horizon_days: 2 } } });
r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
check('сокращённый горизонт отсекает дальние даты', r.status === 422 && r.body.error.code === 'outside_booking_horizon',
  `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

// Минимальный срок до визита.
await call('PATCH', '/api/admin/settings', { token: AT, body: { settings: { booking_horizon_days: 90, min_lead_time_minutes: 0 } } });
const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
const nowSlots = (await call('GET', `/api/availability?master_id=1&date=${today}&service_ids=1`)).body.slots?.length ?? 0;
await call('PATCH', '/api/admin/settings', { token: AT, body: { settings: { min_lead_time_minutes: 10080 } } });
const laterSlots = (await call('GET', `/api/availability?master_id=1&date=${today}&service_ids=1`)).body.slots?.length ?? 0;
check('минимальный срок до визита работает', laterSlots <= nowSlots, `${laterSlots} против ${nowSlots}`);

// Шаг сетки.
await call('PATCH', '/api/admin/settings', { token: AT, body: { settings: { min_lead_time_minutes: 120, slot_step_minutes: 60 } } });
r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
check('шаг сетки стал часовым', r.body.slots.every((s) => s.local_time.endsWith(':00')),
  r.body.slots.map((s) => s.local_time).join(' '));
await call('PATCH', '/api/admin/settings', { token: AT, body: { settings: { slot_step_minutes: 15 } } });

// =====================================================================
console.log('\n3. Чего не дают сделать');
const bad = async (settings, name, code) => {
  const res = await call('PATCH', '/api/admin/settings', { token: AT, body: { settings } });
  check(name, res.status === 400 || res.status === 422, `${res.status} ${JSON.stringify(res.body).slice(0, 130)}`);
  if (code) check(`  код ${code}`, res.body.error?.code === code, res.body.error?.code);
};
await bad({ hold_minutes: 'полчаса' }, 'текст вместо числа отклонён');
await bad({ hold_minutes: 0 }, 'резерв в ноль минут отклонён', 'out_of_range');
await bad({ slot_step_minutes: 1 }, 'шаг в одну минуту отклонён', 'out_of_range');
await bad({ max_client_reschedules: 5 }, 'лимит переносов выше схемы отклонён', 'out_of_range');
await bad({ выдумка: 1 }, 'незнакомый ключ отклонён', 'unknown_setting');
await bad({ timezone: 'Asia/Omsk' }, 'пояс без смещения отклонён', 'paired_setting');
await bad({ utc_offset_minutes: 360 }, 'смещение без пояса отклонено', 'paired_setting');
r = await call('PATCH', '/api/admin/settings', { token: AT, body: { settings: {} } });
check('пустой набор отклонён', r.status === 400, r.status);

check('после отказов значения не поехали',
  db.prepare("SELECT value FROM settings WHERE key = 'slot_step_minutes'").get().value === '15');

r = await call('PATCH', '/api/admin/settings', {
  token: AT, body: { settings: { timezone: 'Asia/Omsk', utc_offset_minutes: 360 } } });
check('пояс и смещение вместе — принято', r.status === 200, JSON.stringify(r.body).slice(0, 150));
r = await call('GET', '/api/studio');
check('часовой пояс применился', r.body.studio.timezone === 'Asia/Omsk' && r.body.studio.utc_offset_minutes === 360);
await call('PATCH', '/api/admin/settings', {
  token: AT, body: { settings: { timezone: 'Europe/Moscow', utc_offset_minutes: 180 } } });

const audit = db.prepare(
  "SELECT details FROM audit_log WHERE entity_type = 'settings' ORDER BY id DESC").get();
check('правка настроек в журнале', !!audit, audit);
check('в журнале видно, что на что менялось', /from.*to/.test(audit?.details ?? ''), audit?.details?.slice(0, 120));
check('проставлен автор правки',
  db.prepare("SELECT updated_by FROM settings WHERE key = 'hold_minutes'").get().updated_by === 1);

// =====================================================================
console.log('\n4. Часы работы студии');
r = await call('GET', '/api/admin/studio-hours', { token: AT });
check('часы читаются', r.status === 200 && r.body.studio_hours.length === 7, r.body.studio_hours?.length);
check('воскресенье закрыто', r.body.studio_hours.find((d) => d.weekday === 7).is_closed === true);
check('у дня есть название', r.body.studio_hours[0].weekday_name === 'понедельник');

r = await call('PUT', '/api/admin/studio-hours', {
  token: AT, body: { days: [{ weekday: 1, open_time: '09:00', close_time: '21:00' }] } });
check('неполная неделя отклонена → 422', r.status === 422 && r.body.error.code === 'incomplete_week',
  `${r.status} ${JSON.stringify(r.body).slice(0, 130)}`);

const week = (open, close) => [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
  weekday === 7 ? { weekday, is_closed: true } : { weekday, open_time: open, close_time: close });

r = await call('PUT', '/api/admin/studio-hours', { token: AT, body: { days: week('12:00', '13:00') } });
check('часы заданы', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('визиты вне новых часов показаны', Array.isArray(r.body.stranded_appointments));

r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
check('календарь обрезан часами студии', r.body.slots.every((s) => s.local_time >= '12:00' && s.local_time < '13:00'),
  r.body.slots.map((s) => s.local_time).join(' '));

r = await call('PUT', '/api/admin/studio-hours', {
  token: AT, body: { days: week('21:00', '09:00') } });
check('закрытие раньше открытия отклонено → 422', r.status === 422, r.status);
r = await call('PUT', '/api/admin/studio-hours', {
  token: AT, body: { days: week('9:00', '21:00') } });
check('время без ведущего нуля отклонено → 400', r.status === 400, r.status);
r = await call('PUT', '/api/admin/studio-hours', { token: client.token, body: { days: week('09:00', '21:00') } });
check('клиенту закрыто → 403', r.status === 403, r.status);

// вернуть часы
await call('PUT', '/api/admin/studio-hours', {
  token: AT,
  body: { days: ORIGINAL_HOURS.map((d) => d.is_closed === 1
    ? { weekday: d.weekday, is_closed: true }
    : { weekday: d.weekday, open_time: d.open_time, close_time: d.close_time }) } });
r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
check('после возврата часов день снова полный', r.body.slots.length > 10, r.body.slots.length);

// =====================================================================
console.log('\n5. Нерабочие дни');
const beforeClosure = (await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`)).body.slots.length;

r = await call('POST', '/api/admin/studio-closures', {
  token: AT, body: { date_from: day, reason: 'Санитарный день' } });
check('закрытие создано', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const closure = r.body.closure.id;
check('конец по умолчанию равен началу', r.body.closure.date_to === day, r.body.closure.date_to);
check('назначенные визиты показаны', Array.isArray(r.body.affected_appointments));

r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
check('в закрытый день слотов нет', r.body.slots.length === 0, r.body.slots.length);

r = await call('GET', '/api/admin/studio-closures', { token: AT });
check('закрытие в списке', r.body.closures.some((c) => c.id === closure));
check('видно, кто закрыл', r.body.closures.find((c) => c.id === closure).created_by_name?.includes('Администратор'));

r = await call('POST', '/api/admin/studio-closures', {
  token: AT, body: { date_from: day, date_to: '2020-01-01', reason: 'Задом наперёд' } });
check('период задом наперёд → 422', r.status === 422, r.status);
r = await call('POST', '/api/admin/studio-closures', { token: AT, body: { date_from: day } });
check('без причины → 400', r.status === 400, r.status);
r = await call('POST', '/api/admin/studio-closures', { token: client.token, body: { date_from: day, reason: 'Нет' } });
check('клиенту закрыто → 403', r.status === 403, r.status);

r = await call('DELETE', `/api/admin/studio-closures/${closure}`, { token: AT });
check('закрытие снято', r.status === 200, r.status);
r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1`);
check('время вернулось само', r.body.slots.length === beforeClosure, `${r.body.slots.length} против ${beforeClosure}`);
r = await call('DELETE', `/api/admin/studio-closures/${closure}`, { token: AT });
check('повторное снятие → 404', r.status === 404, r.status);

// --- вернуть настройки как было ---
const restore = Object.fromEntries(Object.entries(ORIGINAL).map(([k, val]) => [k, /^-?\d+$/.test(val) ? Number(val) : val]));
await call('PATCH', '/api/admin/settings', { token: AT, body: { settings: restore } });
const after = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r2) => [r2.key, r2.value]));
check('все настройки вернулись к исходным',
  JSON.stringify(after) === JSON.stringify(ORIGINAL), JSON.stringify(after).slice(0, 200));

db.prepare('DELETE FROM notifications WHERE user_id = ?').run(client.id);
db.prepare("DELETE FROM audit_log WHERE entity_type = 'settings'").run();

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
