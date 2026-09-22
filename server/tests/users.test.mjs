/**
 * Управление пользователями и ролями — экран A10.
 *
 * Главное здесь — не список и не правка контактов, а четыре запрета,
 * каждый из которых закрывает способ сломать студию необратимо:
 * разжаловать себя, отключить себя, убрать последнего администратора
 * и увести в другую роль мастера с привязанной карточкой.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:users
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
const row = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const made = [];

// =====================================================================
console.log('\n1. Матрица прав');
let r = await call('GET', '/api/admin/permissions', { token: AT });
check('матрица читается', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('три роли', JSON.stringify(r.body.roles) === '["user","master","admin"]', JSON.stringify(r.body.roles));
check('разложена по группам', r.body.groups.length >= 6, r.body.groups.length);

const flat = r.body.groups.flatMap((g) => g.permissions);
const byKey = (key) => flat.find((p) => p.key === key);
check('у каждого права все три роли', flat.every((p) => Object.keys(p.roles).length === 3));
check('клиент исход визита не отмечает', byKey('appointment.set_status').roles.user.allowed === false);
check('мастер отмечает', byKey('appointment.set_status').roles.master.allowed === true);
check('наложение только администратору',
  byKey('appointment.overlap').roles.admin.allowed === true &&
  byKey('appointment.overlap').roles.master.allowed === false);
check('пояснение про e-mail клиента на месте',
  /e-mail/i.test(byKey('client.contacts').roles.master.note ?? ''), byKey('client.contacts').roles.master.note);

// Матрица должна совпадать с поведением кода — проверяем на двух правах.
const client = (await call('POST', '/api/auth/register', {
  body: { email: `um-${Date.now()}@example.com`, password: 'secret12345',
          full_name: 'Клиент Ролей', phone: '+79001110099' } })).body;
made.push(client.user.id);
r = await call('GET', '/api/admin/permissions', { token: client.token });
check('матрица закрыта клиенту → 403', r.status === 403, r.status);

// =====================================================================
console.log('\n2. Список и карточка');
r = await call('GET', '/api/admin/users?limit=5', { token: AT });
check('список читается', r.status === 200 && r.body.users.length === 5, r.body.users?.length);
check('хеша пароля нет', !JSON.stringify(r.body).includes('password_hash'));
check('но видно, активирован ли вход', typeof r.body.users[0].has_password === 'boolean');
check('курсор выдан', typeof r.body.next_after_id === 'number');

const page2 = await call('GET', `/api/admin/users?limit=5&after_id=${r.body.next_after_id}`, { token: AT });
check('вторая страница не повторяет первую',
  !page2.body.users.some((u) => r.body.users.some((x) => x.id === u.id)));

r = await call('GET', '/api/admin/users?role=master', { token: AT });
check('фильтр по роли', r.body.users.every((u) => u.role === 'master') && r.body.users.length >= 2);
check('у мастера видна карточка', r.body.users.find((u) => u.id === 2).master_id === 1);

r = await call('GET', `/api/admin/users?search=${encodeURIComponent('Клиент Ролей')}`, { token: AT });
check('поиск по имени', r.body.users.some((u) => u.id === client.user.id), JSON.stringify(r.body.users).slice(0, 150));
// Встроенный lower() в SQLite знает только латиницу — «ольга» по запросу
// в нижнем регистре не нашлась бы. Поиск идёт через свою функцию ulower.
r = await call('GET', `/api/admin/users?search=${encodeURIComponent('клиент ролей')}`, { token: AT });
check('поиск по имени не различает регистр в кириллице',
  r.body.users.some((u) => u.id === client.user.id), JSON.stringify(r.body.users).slice(0, 150));
r = await call('GET', `/api/admin/users?search=${encodeURIComponent('ОЛЬГА')}`, { token: AT });
check('и находит мастера в верхнем регистре', r.body.users.some((u) => u.id === 2), JSON.stringify(r.body.users).slice(0, 120));
r = await call('GET', '/api/admin/users?search=%2B79001110099', { token: AT });
check('поиск по телефону', r.body.users.some((u) => u.id === client.user.id));
r = await call('GET', '/api/admin/users?role=выдумка', { token: AT });
check('незнакомая роль → 400', r.status === 400, r.status);

r = await call('GET', `/api/admin/users/${client.user.id}`, { token: AT });
check('карточка читается', r.status === 200 && r.body.user.id === client.user.id);
check('есть сводка по визитам', typeof r.body.visits.total === 'number', JSON.stringify(r.body.visits));
r = await call('GET', '/api/admin/users/999999', { token: AT });
check('несуществующий → 404', r.status === 404, r.status);
r = await call('GET', '/api/admin/users', { token: client.token });
check('клиенту закрыто → 403', r.status === 403, r.status);

// =====================================================================
console.log('\n3. Создание аккаунта');
const walkEmail = `walk-${Date.now()}@example.com`;
r = await call('POST', '/api/admin/users', {
  token: AT, body: { email: walkEmail, full_name: 'Пришла Без Записи', phone: '+79002223300' } });
check('аккаунт создан', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const walkIn = r.body.user.id;
made.push(walkIn);
check('роль по умолчанию user', r.body.user.role === 'user');
check('пароль не задан', r.body.user.has_password === false && row(walkIn).password_hash === null);
check('в ответе сказано, как активировать вход', /восстановлен/i.test(r.body.activation), r.body.activation);

r = await call('POST', '/api/auth/login', { body: { email: walkEmail, password: 'secret12345' } });
check('войти в него нельзя', r.status === 401, r.status);
r = await call('POST', '/api/auth/forgot-password', { body: { email: walkEmail } });
const claim = r.body.token;
r = await call('POST', '/api/auth/reset-password', { body: { token: claim, password: 'ownpass12345' } });
check('владелец задаёт пароль сам', r.status === 200, JSON.stringify(r.body).slice(0, 120));
r = await call('POST', '/api/auth/login', { body: { email: walkEmail, password: 'ownpass12345' } });
check('и входит', r.status === 200, r.status);

r = await call('POST', '/api/admin/users', {
  token: AT, body: { email: walkEmail, full_name: 'Дубль', phone: '+79002223301' } });
check('повторный e-mail → 409', r.status === 409, r.status);
r = await call('POST', '/api/admin/users', { token: AT, body: { email: 'не-почта', full_name: 'X', phone: '1' } });
check('битые данные → 400', r.status === 400, r.status);

// =====================================================================
console.log('\n4. Правка и смена роли');
r = await call('PATCH', `/api/admin/users/${walkIn}`, {
  token: AT, body: { full_name: 'Мария Ковалёва', phone: '+7 (900) 222-33-44' } });
check('контакты изменены', r.status === 200 && r.body.user.full_name === 'Мария Ковалёва', JSON.stringify(r.body).slice(0, 150));
check('телефон нормализован', r.body.user.phone === '+79002223344', r.body.user.phone);

const newEmail = `moved-${Date.now()}@example.com`;
r = await call('PATCH', `/api/admin/users/${walkIn}`, { token: AT, body: { email: newEmail } });
check('администратор меняет e-mail', r.status === 200 && r.body.user.email === newEmail);
check('вход по новому адресу работает',
  (await call('POST', '/api/auth/login', { body: { email: newEmail, password: 'ownpass12345' } })).status === 200);
r = await call('PATCH', `/api/admin/users/${walkIn}`, { token: AT, body: { email: 'admin@nogotochki.local' } });
check('занятый e-mail → 409', r.status === 409, r.status);

// Смена роли выбрасывает из аккаунта.
const promoted = (await call('POST', '/api/auth/register', {
  body: { email: `prom-${Date.now()}@example.com`, password: 'secret12345',
          full_name: 'Будущий Мастер', phone: '+79005551100' } })).body;
made.push(promoted.user.id);
check('его сессия жива', (await call('GET', '/api/auth/me', { token: promoted.token })).status === 200);

r = await call('PATCH', `/api/admin/users/${promoted.user.id}`, { token: AT, body: { role: 'master' } });
check('роль изменена', r.status === 200 && r.body.user.role === 'master', JSON.stringify(r.body).slice(0, 150));
check('сессии закрыты', r.body.sessions_revoked >= 1, r.body.sessions_revoked);
check('старый токен больше не работает',
  (await call('GET', '/api/auth/me', { token: promoted.token })).status === 401);

const audit = db.prepare(
  "SELECT action, details FROM audit_log WHERE entity_type='user' AND entity_id=? ORDER BY id DESC").get(promoted.user.id);
check('смена роли записана отдельным действием', audit?.action === 'role_change', audit?.action);
check('видно, с какой роли на какую', /user.*master/.test(audit?.details ?? ''), audit?.details?.slice(0, 120));

// Отключение аккаунта.
r = await call('PATCH', `/api/admin/users/${promoted.user.id}`, { token: AT, body: { is_active: false } });
check('аккаунт отключён', r.status === 200 && r.body.user.is_active === false);
const reLogin = await call('POST', '/api/auth/login', {
  body: { email: row(promoted.user.id).email, password: 'secret12345' } });
check('отключённый не входит', reLogin.status === 401, reLogin.status);
await call('PATCH', `/api/admin/users/${promoted.user.id}`, { token: AT, body: { is_active: true } });

r = await call('PATCH', `/api/admin/users/${walkIn}`, { token: AT, body: {} });
check('пустая правка → 422', r.status === 422, r.status);
r = await call('PATCH', `/api/admin/users/${walkIn}`, { token: AT, body: { theme: 'evening' } });
check('тему администратор не трогает → 422', r.status === 422, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
check('тема осталась прежней', row(walkIn).theme === 'day');

// =====================================================================
console.log('\n5. Четыре запрета');
r = await call('PATCH', '/api/admin/users/1', { token: AT, body: { role: 'user' } });
check('себя разжаловать нельзя → 422', r.status === 422 && r.body.error.code === 'self_demotion',
  `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
r = await call('PATCH', '/api/admin/users/1', { token: AT, body: { is_active: false } });
check('себя отключить нельзя → 422', r.status === 422 && r.body.error.code === 'self_demotion', r.body.error?.code);
check('администратор цел', row(1).role === 'admin' && row(1).is_active === 1);

// Другого администратора — можно: студия не остаётся без доступа.
const second = (await call('POST', '/api/admin/users', {
  token: AT, body: { email: `adm2-${Date.now()}@example.com`, full_name: 'Второй Админ',
                     phone: '+79009998877', role: 'admin' } })).body.user;
made.push(second.id);
r = await call('PATCH', `/api/admin/users/${second.id}`, { token: AT, body: { is_active: false } });
check('другого администратора отключить можно', r.status === 200, r.status);
r = await call('PATCH', `/api/admin/users/${second.id}`, { token: AT, body: { role: 'user' } });
check('и разжаловать можно', r.status === 200, JSON.stringify(r.body).slice(0, 140));
check('действующий администратор в студии остался',
  db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND is_active=1").get().c >= 1);

// Проверка «последний администратор» через этот эндпоинт недостижима:
// вызывает его сам действующий администратор, а себя он трогать не может.
// Поэтому проверяется то, что достижимо, — порядок правил: на себе
// срабатывает запрет self_demotion, а не last_admin.
r = await call('PATCH', '/api/admin/users/1', { token: AT, body: { role: 'user', is_active: false } });
check('на себе срабатывает именно запрет на себя',
  r.status === 422 && r.body.error.code === 'self_demotion', r.body.error?.code);

// Мастер с привязанной карточкой.
r = await call('PATCH', '/api/admin/users/2', { token: AT, body: { role: 'user' } });
check('мастера с карточкой не разжаловать → 409', r.status === 409 && r.body.error.code === 'master_card_linked',
  `${r.status} ${JSON.stringify(r.body).slice(0, 150)}`);
check('в отказе указана карточка', r.body.error.details?.master_id === 1);
check('роль не изменилась', row(2).role === 'master');

// --- уборка ---
for (const id of made.reverse()) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(id);
  db.prepare("DELETE FROM audit_log WHERE entity_type='user' AND entity_id=?").run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
db.prepare("DELETE FROM audit_log WHERE entity_type='user' AND entity_id=1").run();

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
