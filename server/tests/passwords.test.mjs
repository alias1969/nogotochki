/**
 * Восстановление и смена пароля.
 *
 * Главное, что здесь проверяется, — не «пароль поменялся», а то, что
 * смена пароля действительно выгоняет тех, кто уже сидит в аккаунте.
 * Ради этого сессии и лежат в базе: без сброса восстановление пароля
 * не решало бы ту задачу, ради которой его обычно и делают.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:passwords
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

const PASSWORD = 'secret12345';
async function newUser(tag) {
  const email = `pwd-${tag}-${Date.now()}@example.com`;
  const r = await call('POST', '/api/auth/register', {
    body: { email, password: PASSWORD, full_name: `Проба ${tag}`, phone: '+79001110022' },
  });
  return { email, id: r.body.user.id, token: r.body.token };
}
const forgot = async (email) => call('POST', '/api/auth/forgot-password', { body: { email } });

// =====================================================================
console.log('\n1. Запрос ссылки');
const user = await newUser('main');

let r = await forgot(user.email);
check('запрос принят', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('ссылка выдана вне прода', typeof r.body.reset_link === 'string' && r.body.reset_link.includes('token='));
const token = r.body.token;

const unknown = await forgot(`нет-такого-${Date.now()}@example.com`);
check('незнакомый e-mail отвечает так же', unknown.status === 200 && unknown.body.message === r.body.message,
  JSON.stringify(unknown.body).slice(0, 150));
check('и ссылки при этом не даёт', !('reset_link' in unknown.body));

r = await call('POST', '/api/auth/forgot-password', { body: { email: 'не-почта' } });
check('битый e-mail → 400', r.status === 400, r.status);

const again = await forgot(user.email);
check('повтор в ту же минуту отвечает так же', again.status === 200 && !('reset_link' in again.body),
  JSON.stringify(again.body).slice(0, 120));
check('и второй ссылки не создаёт',
  db.prepare('SELECT COUNT(*) c FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL').get(user.id).c === 1);

const stored = db.prepare('SELECT token_hash FROM password_reset_tokens WHERE user_id = ?').get(user.id);
check('в базе лежит хеш, а не токен', stored.token_hash !== token && stored.token_hash.length === 64, stored.token_hash?.slice(0, 20));

// =====================================================================
console.log('\n2. Проверка ссылки до ввода пароля');
r = await call('POST', '/api/auth/reset-password/check', { body: { token } });
check('живая ссылка опознана', r.status === 200 && r.body.valid === true, JSON.stringify(r.body).slice(0, 150));
check('виден срок действия', r.body.expires_at?.utc?.endsWith('Z'));

r = await call('POST', '/api/auth/reset-password/check', { body: { token: 'выдумка' } });
check('выдуманная ссылка не живая', r.status === 200 && r.body.valid === false && r.body.reason === 'unknown',
  JSON.stringify(r.body));

// =====================================================================
console.log('\n3. Смена пароля по ссылке');
const NEW_PASSWORD = 'brandnew98765';

// Заранее открываем два входа: их обязано выбросить.
const s1 = (await call('POST', '/api/auth/login', { body: { email: user.email, password: PASSWORD } })).body.token;
const s2 = (await call('POST', '/api/auth/login', { body: { email: user.email, password: PASSWORD } })).body.token;
check('два входа открыты',
  (await call('GET', '/api/auth/me', { token: s1 })).status === 200 &&
  (await call('GET', '/api/auth/me', { token: s2 })).status === 200);

r = await call('POST', '/api/auth/reset-password', { body: { token, password: 'коротк' } });
check('короткий пароль → 400', r.status === 400, r.status);

r = await call('POST', '/api/auth/reset-password', { body: { token, password: NEW_PASSWORD } });
check('пароль изменён', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('сообщено, сколько входов закрыто', r.body.sessions_revoked >= 2, r.body.sessions_revoked);

check('старый вход перестал работать', (await call('GET', '/api/auth/me', { token: s1 })).status === 401);
check('и второй тоже', (await call('GET', '/api/auth/me', { token: s2 })).status === 401);
check('и тот, с которого регистрировались', (await call('GET', '/api/auth/me', { token: user.token })).status === 401);

r = await call('POST', '/api/auth/login', { body: { email: user.email, password: PASSWORD } });
check('старый пароль больше не пускает', r.status === 401, r.status);
r = await call('POST', '/api/auth/login', { body: { email: user.email, password: NEW_PASSWORD } });
check('новый пускает', r.status === 200, r.status);
const live = r.body.token;

r = await call('POST', '/api/auth/reset-password', { body: { token, password: 'onemore12345' } });
check('повтор по той же ссылке → 409', r.status === 409 && r.body.error.code === 'reset_token_used', JSON.stringify(r.body).slice(0, 150));
r = await call('POST', '/api/auth/reset-password/check', { body: { token } });
check('проверка тоже говорит «использована»', r.body.reason === 'used', JSON.stringify(r.body));

const audit = db.prepare(
  "SELECT details FROM audit_log WHERE entity_id = ? AND action = 'password_change' ORDER BY id DESC").get(user.id);
check('смена записана в журнал', !!audit, audit);
check('в журнале нет ни пароля, ни токена',
  !/password|token|secret|brandnew/i.test(audit?.details ?? ''), audit?.details);
const notice = db.prepare(
  "SELECT title FROM notifications WHERE user_id = ? AND kind = 'system' ORDER BY id DESC").get(user.id);
check('в кабинет пришло уведомление', notice?.title === 'Пароль изменён', JSON.stringify(notice));

// =====================================================================
console.log('\n4. Истёкшая ссылка');
const late = await newUser('late');
const lateToken = (await forgot(late.email)).body.token;
db.prepare(
  "UPDATE password_reset_tokens SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 minute') WHERE user_id = ?")
  .run(late.id);

r = await call('POST', '/api/auth/reset-password/check', { body: { token: lateToken } });
check('протухшая ссылка опознана', r.body.valid === false && r.body.reason === 'expired', JSON.stringify(r.body));
r = await call('POST', '/api/auth/reset-password', { body: { token: lateToken, password: 'whatever12345' } });
check('по ней пароль не меняется → 409', r.status === 409 && r.body.error.code === 'reset_token_expired', JSON.stringify(r.body).slice(0, 150));
check('пароль остался прежним',
  (await call('POST', '/api/auth/login', { body: { email: late.email, password: PASSWORD } })).status === 200);

// Новая ссылка гасит прежнюю неиспользованную.
const twice = await newUser('twice');
const first = (await forgot(twice.email)).body.token;
db.prepare("UPDATE password_reset_tokens SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-5 minutes') WHERE user_id = ?").run(twice.id);
const second = (await forgot(twice.email)).body.token;
check('вторая ссылка выдана', typeof second === 'string' && second !== first);
r = await call('POST', '/api/auth/reset-password/check', { body: { token: first } });
check('первая ссылка погашена', r.body.valid === false, JSON.stringify(r.body));
r = await call('POST', '/api/auth/reset-password', { body: { token: second, password: 'secondone12345' } });
check('вторая работает', r.status === 200, JSON.stringify(r.body).slice(0, 120));

// =====================================================================
console.log('\n5. Аккаунт, заведённый администратором вручную');
const AT = (await call('POST', '/api/auth/login', {
  body: { email: 'admin@nogotochki.local', password: 'admin12345' } })).body.token;
const walkin = db.prepare("SELECT id, email, password_hash FROM users WHERE email = 'walkin@example.com'").get();
check('у такого аккаунта пароля нет', walkin.password_hash === null, walkin.password_hash);
r = await call('POST', '/api/auth/login', { body: { email: walkin.email, password: PASSWORD } });
check('войти в него нельзя', r.status === 401, r.status);

const claimToken = (await forgot(walkin.email)).body.token;
check('ссылка восстановления выдаётся', typeof claimToken === 'string');
r = await call('POST', '/api/auth/reset-password', { body: { token: claimToken, password: 'claimed12345' } });
check('через неё задаётся первый пароль', r.status === 200, JSON.stringify(r.body).slice(0, 120));
r = await call('POST', '/api/auth/login', { body: { email: walkin.email, password: 'claimed12345' } });
check('и аккаунт открывается', r.status === 200, r.status);

// вернуть тестовые данные в исходное состояние
db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(walkin.id);
db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(walkin.id);
db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ?').run(new Date().toISOString().slice(0, 19) + 'Z', walkin.id);

// =====================================================================
console.log('\n6. Смена пароля в кабинете');
const cabinet = await newUser('cabinet');
const other = (await call('POST', '/api/auth/login', { body: { email: cabinet.email, password: PASSWORD } })).body.token;

r = await call('POST', '/api/auth/change-password', { body: { current_password: PASSWORD, new_password: 'nopass12345' } });
check('без входа → 401', r.status === 401, r.status);
r = await call('POST', '/api/auth/change-password', {
  token: cabinet.token, body: { current_password: 'неверный-пароль', new_password: 'nopass12345' } });
check('неверный текущий пароль → 401', r.status === 401, r.status);
r = await call('POST', '/api/auth/change-password', {
  token: cabinet.token, body: { current_password: PASSWORD, new_password: PASSWORD } });
check('новый совпадает с текущим → 422', r.status === 422 && r.body.error.code === 'password_unchanged', JSON.stringify(r.body).slice(0, 120));
r = await call('POST', '/api/auth/change-password', {
  token: cabinet.token, body: { current_password: PASSWORD, new_password: 'ok' } });
check('слишком короткий новый → 400', r.status === 400, r.status);

r = await call('POST', '/api/auth/change-password', {
  token: cabinet.token, body: { current_password: PASSWORD, new_password: 'cabinetnew12345' } });
check('пароль изменён', r.status === 200, JSON.stringify(r.body).slice(0, 120));
check('другие входы закрыты', r.body.sessions_revoked === 1, r.body.sessions_revoked);
check('текущий вход остался живым', (await call('GET', '/api/auth/me', { token: cabinet.token })).status === 200);
check('чужой вход выброшен', (await call('GET', '/api/auth/me', { token: other })).status === 401);
check('вход новым паролем работает',
  (await call('POST', '/api/auth/login', { body: { email: cabinet.email, password: 'cabinetnew12345' } })).status === 200);

// Смена пароля гасит и выданную, но не использованную ссылку.
const mixed = await newUser('mixed');
db.prepare("UPDATE password_reset_tokens SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-5 minutes') WHERE user_id = ?").run(mixed.id);
const pending = (await forgot(mixed.email)).body.token;
await call('POST', '/api/auth/change-password', {
  token: mixed.token, body: { current_password: PASSWORD, new_password: 'mixednew12345' } });
r = await call('POST', '/api/auth/reset-password/check', { body: { token: pending } });
check('ссылка, выданная до смены пароля, погашена', r.body.valid === false, JSON.stringify(r.body));

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
