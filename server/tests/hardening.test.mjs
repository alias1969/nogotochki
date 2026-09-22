/**
 * Три правила, которые проверяются снаружи, через HTTP.
 *
 *   6. Все запросы к базе параметризованы. Проверяется поведением:
 *      строка с кавычками, точкой с запятой и DROP TABLE попадает в базу
 *      как обычный текст и ничего не ломает.
 *   7. Входные данные проверяются — типы, форматы, длина, существование
 *      даты, — а поля, которые пользователь не вправе задавать, до базы
 *      не доходят вовсе.
 *   9. В ответах на ошибки нет внутренних подробностей: ни текста ошибок
 *      SQLite, ни имён таблиц, ни путей к файлам, ни следа стека.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:hardening
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, ADMIN } from './env.mjs';

const BASE = process.env.API_URL ?? 'http://localhost:3000';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  ok ? (pass++, console.log('  ok  ', name)) : (fail++, console.log('  FAIL', name, extra));
};

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed, text };
}

const db = new DatabaseSync(DB_FILE);
const made = [];
const PASSWORD = 'secret12345';

const AT = (await call('POST', '/api/auth/login', {
  body: { email: ADMIN.email, password: ADMIN.password } })).body.token;

async function newClient(tag) {
  const email = `hard-${tag}-${Date.now()}@example.com`;
  const r = await call('POST', '/api/auth/register', {
    body: { email, password: PASSWORD, full_name: `Проба ${tag}`, phone: '+79001110066' } });
  made.push(r.body.user.id);
  return { email, id: r.body.user.id, token: r.body.token };
}

// =====================================================================
console.log('\n1. Параметризованные запросы: текст остаётся текстом');

const client = await newClient('sql');

// Классические попытки инъекции в тех полях, которые доходят до SQL:
// имя идёт в UPDATE, поисковая строка — в LIKE, e-mail — в WHERE.
const INJECTIONS = [
  "Ольга'; DROP TABLE users; --",
  "' OR '1'='1",
  'Мария" OR 1=1 --',
  "Аня'); DELETE FROM appointments; --",
  "%'; UPDATE users SET is_active = 0; --",
];

for (const attempt of INJECTIONS) {
  const r = await call('PATCH', '/api/profile', { token: client.token, body: { full_name: attempt } });
  check(`имя со вставкой сохраняется как текст: ${attempt.slice(0, 22)}…`,
    r.status === 200 && r.body.profile.full_name === attempt,
    `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
}

const stored = db.prepare('SELECT full_name FROM users WHERE id = ?').get(client.id);
check('в базе лежит ровно присланная строка', stored.full_name === INJECTIONS[INJECTIONS.length - 1], stored.full_name);
check('таблица users на месте',
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='users'").get().c === 1);
check('таблица appointments на месте',
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='appointments'").get().c === 1);
check('никого не отключили',
  db.prepare('SELECT COUNT(*) c FROM users WHERE is_active = 0').get().c === 0);

// Поиск по списку пользователей — строка уходит в LIKE.
for (const attempt of ["' OR 1=1 --", "%' UNION SELECT password_hash FROM users --"]) {
  const r = await call('GET', `/api/admin/users?search=${encodeURIComponent(attempt)}`, { token: AT });
  check(`поиск со вставкой не расширяет выборку: ${attempt.slice(0, 20)}…`,
    r.status === 200 && r.body.users.length === 0, `${r.status} нашлось ${r.body.users?.length}`);
}

const r0 = await call('POST', '/api/auth/login', {
  body: { email: "admin@nogotochki.local' --", password: 'что угодно' } });
check('подставленный e-mail не пускает', r0.status === 401 || r0.status === 400, r0.status);

// =====================================================================
console.log('\n2. Проверка входных данных');

let r;
const bad = async (name, path, body, token = AT, method = 'POST') => {
  r = await call(method, path, { token, body });
  check(name, r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 110)}`);
};

// Типы
await bad('число вместо строки → 400', '/api/admin/service-categories', { name: 12345 });
await bad('объект вместо строки → 400', '/api/admin/service-categories', { name: { ru: 'Уход' } });
await bad('строка вместо числа → 400', '/api/admin/services',
  { category_id: 'первая', name: 'Услуга', duration_min: 30, price_kopecks: 1000 });
await bad('дробное вместо целого → 400', '/api/admin/services',
  { category_id: 1, name: 'Услуга', duration_min: 30.5, price_kopecks: 1000 });
await bad('строка вместо списка ролей → 400', '/api/admin/users',
  { email: `t-${Date.now()}@example.com`, full_name: 'Тест Тестов', phone: '+79001112233', roles: 'admin' });
r = await call('GET', '/api/appointments/не-число', { token: client.token });
check('нечисловой идентификатор в адресе → 400', r.status === 400, r.status);

// Форматы
await bad('e-mail без собаки → 400', '/api/admin/users',
  { email: 'не-почта', full_name: 'Тест Тестов', phone: '+79001112233' });
await bad('телефон из букв → 400', '/api/admin/users',
  { email: `t2-${Date.now()}@example.com`, full_name: 'Тест Тестов', phone: 'позвоните мне' });
r = await call('GET', '/api/availability?master_id=1&date=18.09.2026&service_ids=1');
check('дата в другом формате → 400', r.status === 400, r.status);
r = await call('POST', '/api/holds', { body: { master_id: 1, starts_at: '2026-09-18 10:00', service_ids: [1] } });
check('момент времени без T и Z → 400', r.status === 400, r.status);

// Длина
await bad('слишком короткое имя → 400', '/api/admin/service-categories', { name: 'У' });
await bad('слишком длинное имя → 400', '/api/admin/service-categories', { name: 'У'.repeat(500) });
r = await call('POST', '/api/auth/register', {
  body: { email: `t3-${Date.now()}@example.com`, password: 'коротк', full_name: 'Тест Тестов', phone: '+79001112233' } });
check('пароль короче восьми знаков → 400', r.status === 400, r.status);
r = await call('PATCH', '/api/profile', { token: client.token, body: { full_name: 'И'.repeat(5000) } });
check('имя длиннее предела → 400', r.status === 400, r.status);

// Допустимость даты
for (const date of ['2026-02-30', '2026-13-01', '2026-00-10', '2025-02-29']) {
  r = await call('GET', `/api/availability?master_id=1&date=${date}&service_ids=1`);
  check(`несуществующая дата ${date} → 400`, r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
}
r = await call('GET', '/api/availability?master_id=1&date=2028-02-29&service_ids=1');
check('високосное 29 февраля принимается', r.status !== 400, r.status);
r = await call('POST', '/api/holds', { body: { master_id: 1, starts_at: '2026-02-30T10:00:00Z', service_ids: [1] } });
check('несуществующий момент времени → 400', r.status === 400, r.status);

// Тело запроса
r = await call('POST', '/api/admin/service-categories', { token: AT, body: [1, 2, 3] });
check('массив вместо объекта → 400', r.status === 400, r.status);
r = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{битый json',
}).then(async (res) => ({ status: res.status, body: await res.json() }));
check('битый JSON → 400 с понятным кодом', r.status === 400 && r.body.error.code === 'invalid_json',
  JSON.stringify(r.body).slice(0, 120));

// =====================================================================
console.log('\n3. Поля, которые пользователь не вправе задавать');

const before = db.prepare('SELECT * FROM users WHERE id = ?').get(client.id);
r = await call('PATCH', '/api/profile', {
  token: client.token,
  body: {
    full_name: 'Честное Имя',
    // всё дальнейшее пользователь задавать не вправе
    id: 1, email: 'hacker@example.com', password_hash: 'подделка', is_active: 0,
    roles: ['admin'], role: 'admin', created_at: '2000-01-01T00:00:00Z',
  },
});
check('запрос с лишними полями принят, а не отвергнут', r.status === 200, JSON.stringify(r.body).slice(0, 120));
const after = db.prepare('SELECT * FROM users WHERE id = ?').get(client.id);
check('имя изменено', after.full_name === 'Честное Имя', after.full_name);
check('идентификатор не тронут', after.id === before.id);
check('e-mail не тронут', after.email === before.email, after.email);
check('хеш пароля не тронут', after.password_hash === before.password_hash);
check('признак активности не тронут', after.is_active === before.is_active);
check('дата создания не тронута', after.created_at === before.created_at);
check('роли не тронуты',
  db.prepare('SELECT COUNT(*) c FROM user_roles WHERE user_id = ? AND role = ?').get(client.id, 'admin').c === 0);

// Администратор тоже не задаёт что попало: тема — выбор владельца.
r = await call('PATCH', `/api/admin/users/${client.id}`, { token: AT, body: { theme: 'evening' } });
check('администратору тема недоступна → 422', r.status === 422, `${r.status} ${JSON.stringify(r.body).slice(0, 110)}`);
check('тема в базе прежняя', db.prepare('SELECT theme FROM users WHERE id = ?').get(client.id).theme === before.theme);

// Запись создаётся из резерва: мастер, время и услуги из тела не читаются.
r = await call('POST', '/api/appointments', {
  token: client.token,
  body: { hold_id: 999999, master_id: 1, starts_at: '2030-01-01T10:00:00Z', service_ids: [1], allow_overlap: true },
});
check('подложенные мастер и время не создают запись', r.status >= 400, r.status);
check('и наложение из тела не сработало',
  db.prepare("SELECT COUNT(*) c FROM appointments WHERE allow_overlap = 1 AND created_by_role <> 'admin'").get().c === 0);

// =====================================================================
console.log('\n4. Ответы на ошибки без внутренних подробностей');

const SECRETS = [
  /SQLITE/i, /sqlite3?/i, /no such (table|column)/i, /constraint failed/i,
  /\/Users\//, /\/home\//, /\.js:\d+/, /at \w+ \(/, /node:internal/,
  /nogotochki\.db/, /SELECT .* FROM/i, /INSERT INTO/i, /UPDATE .* SET/i,
];
const clean = (text, where) => {
  const hit = SECRETS.find((rx) => rx.test(text));
  check(`без внутренних подробностей: ${where}`, hit === undefined, `${hit} → ${text.slice(0, 200)}`);
};

// Запросы, которые упираются в ограничения базы или в её отсутствие.
const probes = [
  ['POST', '/api/auth/register',
    { email: ADMIN.email, password: PASSWORD, full_name: 'Дубль Дублёв', phone: '+79001112233' }, null],
  ['POST', '/api/admin/services',
    { category_id: 999999, name: 'Висячая ссылка', duration_min: 30, price_kopecks: 1000 }, AT],
  ['POST', '/api/admin/masters', { user_id: 999999, display_name: 'Нет такого' }, AT],
  ['GET', '/api/appointments/999999', undefined, client.token],
  ['GET', '/api/admin/users/999999', undefined, AT],
  ['DELETE', '/api/admin/service-categories/999999', undefined, AT],
  ['GET', '/api/такого-адреса-нет', undefined, null],
  ['PUT', '/api/services', undefined, null],
  ['POST', '/api/admin/users', { email: 'x', full_name: 'y', phone: 'z' }, AT],
];
for (const [method, path, body, token] of probes) {
  const res = await call(method, path, { body, token });
  clean(res.text, `${method} ${path} → ${res.status}`);
}

r = await call('POST', '/api/admin/service-categories', { token: AT, body: { name: 'Ногтевой сервис' } });
check('дубль категории — понятный ответ, а не текст ошибки базы',
  r.status === 409 && /категор/i.test(r.body.error.message), JSON.stringify(r.body).slice(0, 160));
clean(r.text, 'дубль категории');

r = await call('GET', '/api/admin/users?limit=999999', { token: AT });
check('предел листания объяснён без внутренностей', r.status === 400 && /значение/i.test(r.body.error.message),
  JSON.stringify(r.body).slice(0, 140));

// В 500 не должно быть ничего, кроме кода: проверяем на ответе,
// который сервис отдаёт при забытой проверке доступа (см. context.js).
check('в теле ошибки нет поля со стеком',
  !('stack' in (r.body.error ?? {})) && !('cause' in (r.body.error ?? {})), JSON.stringify(r.body.error));

// --- уборка ---
for (const id of made.reverse()) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
