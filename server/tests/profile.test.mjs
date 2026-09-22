/**
 * Свой профиль — экраны K5 и M4.
 *
 * Меняются три поля: имя, телефон и тема. Половина проверок — про то,
 * что остальное из той же строки users через этот эндпоинт не проходит:
 * роль, признак активности, e-mail и пароль.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:profile
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

const EMAIL = `prof-${Date.now()}@example.com`;
const me = (await call('POST', '/api/auth/register', {
  body: { email: EMAIL, password: 'secret12345', full_name: 'Иван Первый', phone: '+79001112233' },
})).body;
const TOKEN = me.token;
const ID = me.user.id;
const row = () => db.prepare('SELECT * FROM users WHERE id = ?').get(ID);

// =====================================================================
console.log('\n1. Чтение');
let r = await call('GET', '/api/profile', { token: TOKEN });
check('профиль читается', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('имя, телефон, e-mail на месте',
  r.body.profile.full_name === 'Иван Первый' && r.body.profile.phone === '+79001112233' && r.body.profile.email === EMAIL,
  JSON.stringify(r.body.profile));
check('тема по умолчанию дневная', r.body.profile.theme === 'day', r.body.profile.theme);
check('хеша пароля в ответе нет', !JSON.stringify(r.body).includes('password'));
check('момент регистрации парой UTC и местное',
  r.body.profile.created_at.utc.endsWith('Z') && r.body.profile.created_at.local.includes('+03:00'));

r = await call('GET', '/api/profile');
check('без входа → 401', r.status === 401, r.status);

// =====================================================================
console.log('\n2. Правка');
r = await call('PATCH', '/api/profile', { token: TOKEN, body: { full_name: 'Иван Петрович Первый' } });
check('имя изменено', r.status === 200 && r.body.profile.full_name === 'Иван Петрович Первый',
  JSON.stringify(r.body).slice(0, 150));
check('телефон не тронут', r.body.profile.phone === '+79001112233');

r = await call('PATCH', '/api/profile', { token: TOKEN, body: { phone: '+7 (900) 444-55-66' } });
check('телефон нормализован', r.body.profile.phone === '+79004445566', r.body.profile.phone);
check('в базе тоже нормализованный', row().phone === '+79004445566');

r = await call('PATCH', '/api/profile', { token: TOKEN, body: { theme: 'evening' } });
check('тема вечерняя', r.status === 200 && r.body.profile.theme === 'evening', r.body.profile.theme);
check('тема легла в базу, а не в браузер', row().theme === 'evening');
r = await call('GET', '/api/auth/me', { token: TOKEN });
check('тема видна и в /auth/me — переедет на другое устройство', r.body.user.theme === 'evening');

r = await call('PATCH', '/api/profile', {
  token: TOKEN, body: { full_name: 'Иван Первый', phone: '+79001112233', theme: 'day' } });
check('три поля разом', r.status === 200 && r.body.profile.theme === 'day' && r.body.profile.phone === '+79001112233');
check('updated_at сдвинулся', row().updated_at >= row().created_at);

// =====================================================================
console.log('\n3. Что не проходит');
const bad = async (body, name) => {
  const res = await call('PATCH', '/api/profile', { token: TOKEN, body });
  check(name, res.status === 400, `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
};
await bad({ full_name: 'И' }, 'слишком короткое имя');
await bad({ phone: 'позвоните мне' }, 'телефон не из цифр');
await bad({ phone: '+7900' }, 'слишком короткий телефон');
await bad({ theme: 'ночная' }, 'несуществующая тема');
await bad({}, 'пустое тело');

r = await call('PATCH', '/api/profile', { token: TOKEN, body: { role: 'admin' } });
check('одна роль в теле — нечего менять → 400', r.status === 400, r.status);
check('роль не изменилась', row().role === 'user', row().role);

r = await call('PATCH', '/api/profile', {
  token: TOKEN,
  body: { full_name: 'Иван Первый', role: 'admin', is_active: 0, email: 'hacker@example.com',
          password_hash: 'x', id: 1 },
});
check('запрос с лишними полями принят', r.status === 200, JSON.stringify(r.body).slice(0, 150));
const after = row();
check('роль осталась user', after.role === 'user', after.role);
check('аккаунт остался активным', after.is_active === 1);
check('e-mail не изменился', after.email === EMAIL, after.email);
check('хеш пароля не тронут', after.password_hash?.startsWith('scrypt$'));
check('номер строки не тронут', after.id === ID);
check('вход прежним паролем работает',
  (await call('POST', '/api/auth/login', { body: { email: EMAIL, password: 'secret12345' } })).status === 200);

// =====================================================================
console.log('\n4. Только свой профиль');
const other = (await call('POST', '/api/auth/register', {
  body: { email: `other-${Date.now()}@example.com`, password: 'secret12345',
          full_name: 'Чужой Человек', phone: '+79007778899' } })).body;

r = await call('GET', '/api/profile', { token: other.token });
check('второй видит свой профиль', r.body.profile.id === other.user.id && r.body.profile.full_name === 'Чужой Человек');
await call('PATCH', '/api/profile', { token: other.token, body: { full_name: 'Переименованный' } });
check('правка не задела первого', row().full_name === 'Иван Первый', row().full_name);

r = await call('GET', '/api/users/1');
check('эндпоинта чужого профиля нет вовсе → 404', r.status === 404, r.status);

// Мастер и администратор правят свой профиль тем же путём.
const MT = (await call('POST', '/api/auth/login', {
  body: { email: 'olga@nogotochki.local', password: 'master12345' } })).body.token;
r = await call('PATCH', '/api/profile', { token: MT, body: { theme: 'day' } });
check('мастер правит свой профиль', r.status === 200 && r.body.profile.role === 'master', JSON.stringify(r.body).slice(0, 120));
check('его карточка мастера при этом не тронута',
  db.prepare('SELECT display_name FROM masters WHERE user_id = 2').get().display_name === 'Ольга');
await call('PATCH', '/api/profile', { token: MT, body: { theme: 'evening' } });

// --- уборка ---
for (const id of [ID, other.user.id]) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
