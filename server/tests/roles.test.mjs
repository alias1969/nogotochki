/**
 * Роли и три проверки доступа.
 *
 * Проверяется четыре вещи.
 *
 *   1. Роли берутся из базы. Ни регистрация, ни правка профиля, ни любое
 *      другое поле запроса на список ролей не влияют.
 *   2. Ролей может быть несколько, и право ищется в списке, а не
 *      сравнивается с единственным значением.
 *   3. Видимость записей складывается: мастер, записавшийся к коллеге,
 *      видит и свой визит как клиент, и записи своего дня как мастер.
 *   4. На каждом эндпоинте стоят все три проверки: вход, роль,
 *      принадлежность объекта. Список эндпоинтов берётся у самого
 *      роутера — чтобы новый эндпоинт не мог тихо мимо неё проехать.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:roles
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, ADMIN, OLGA, IRINA, ANNA, MASTER_PASSWORD } from './env.mjs';
import { buildRouter } from '../src/http/server.js';

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
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 120) }; }
  return { status: res.status, body: parsed };
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');
const rolesOf = (id) => db.prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role')
  .all(id).map((r) => r.role);

const login = async (email, password) =>
  (await call('POST', '/api/auth/login', { body: { email, password } })).body;

const PASSWORD = 'secret12345';
const made = [];
async function newClient(tag) {
  const email = `role-${tag}-${Date.now()}@example.com`;
  const r = await call('POST', '/api/auth/register', {
    body: { email, password: PASSWORD, full_name: `Проба ${tag}`, phone: '+79001110022' },
  });
  made.push(r.body.user.id);
  return { email, id: r.body.user.id, token: r.body.token };
}

const AT = (await login(ADMIN.email, ADMIN.password)).token;

// =====================================================================
console.log('\n1. Роли берутся из базы, а не из запроса');

const sneaky = await call('POST', '/api/auth/register', {
  body: {
    email: `sneaky-${Date.now()}@example.com`, password: PASSWORD,
    full_name: 'Хитрый Гость', phone: '+79001110033',
    role: 'admin', roles: ['admin', 'master'], is_active: 1,
  },
});
made.push(sneaky.body.user.id);
check('регистрация прошла', sneaky.status === 201, JSON.stringify(sneaky.body).slice(0, 150));
check('роли в теле запроса проигнорированы', sneaky.body.user.roles.join(',') === 'user', sneaky.body.user.roles);
check('и в базе тоже только user', rolesOf(sneaky.body.user.id).join(',') === 'user', rolesOf(sneaky.body.user.id));
check('в админ-панель он не попадает',
  (await call('GET', '/api/admin/users', { token: sneaky.body.token })).status === 403);

let r = await call('PATCH', '/api/profile', { token: sneaky.body.token, body: { roles: ['admin'] } });
check('через профиль роли не выписать', r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
check('роли по-прежнему только user', rolesOf(sneaky.body.user.id).join(',') === 'user');

check('в ответе отдаётся список, а не одно значение',
  Array.isArray(sneaky.body.user.roles) && !('role' in sneaky.body.user), JSON.stringify(sneaky.body.user));

// =====================================================================
console.log('\n2. Ролей может быть несколько');

// Ольга — мастер с карточкой. Выдаём ей ещё и права администратора:
// владелица студии и принимает клиентов, и ведёт прайс.
r = await call('PATCH', '/api/admin/users/2', { token: AT, body: { roles: ['master', 'admin'] } });
check('мастеру выдана вторая роль', r.status === 200 && r.body.user.roles.join(',') === 'admin,master',
  JSON.stringify(r.body).slice(0, 150));
check('карточка мастера не помешала', rolesOf(2).join(',') === 'admin,master', rolesOf(2));

const owner = await login(OLGA.email, MASTER_PASSWORD);
check('в ответе на вход обе роли', owner.user.roles.join(',') === 'admin,master', owner.user.roles);

r = await call('GET', '/api/master/me', { token: owner.token });
check('она попадает в кабинет мастера', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
r = await call('GET', '/api/admin/users', { token: owner.token });
check('и в админ-панель тоже', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
check('это и есть проверка вхождения, а не равенства: одно значение закрыло бы одну из двух дверей', true);

r = await call('GET', '/api/admin/users?role=master', { token: AT });
check('фильтр по роли ищет вхождение', r.body.users.some((u) => u.id === 2), 'Ольги нет в списке мастеров');
r = await call('GET', '/api/admin/users?role=admin', { token: AT });
check('и находит её же среди администраторов', r.body.users.some((u) => u.id === 2));

// Снятие роли закрывает сессии: снимок ролей в сессии перестаёт совпадать.
r = await call('PATCH', '/api/admin/users/2', { token: AT, body: { roles: ['master'] } });
check('вторая роль снята', r.status === 200 && r.body.user.roles.join(',') === 'master', JSON.stringify(r.body).slice(0, 120));
check('сессии закрыты', r.body.sessions_revoked >= 1, r.body.sessions_revoked);
check('прежний токен больше не работает',
  (await call('GET', '/api/auth/me', { token: owner.token })).status === 401);

const backToMaster = await login(OLGA.email, MASTER_PASSWORD);
r = await call('GET', '/api/admin/users', { token: backToMaster.token });
check('после снятия роли админ-панель закрыта', r.status === 403, r.status);
check('а кабинет мастера остался',
  (await call('GET', '/api/master/me', { token: backToMaster.token })).status === 200);

// =====================================================================
console.log('\n3. Видимость записей складывается, а не выбирает одну роль');

// Ольге (мастер, карточка 1) выдаём роль клиента и записываем её к Ирине.
await call('PATCH', '/api/admin/users/2', { token: AT, body: { roles: ['master', 'user'] } });
check('у мастера появилась роль клиента', rolesOf(2).join(',') === 'master,user', rolesOf(2));

const hybrid = await login(OLGA.email, MASTER_PASSWORD);
check('обе роли видны в кабинете', hybrid.user.roles.join(',') === 'master,user', hybrid.user.roles);

/**
 * Первое свободное время у мастера в ближайшие две недели.
 *
 * Перебором по дням, а не «сегодня плюс пять»: у мастера пять смен
 * в неделю, и фиксированный день рано или поздно попадает на выходной —
 * тест начинал бы падать в зависимости от дня запуска.
 */
async function firstSlot(masterId, serviceId = 1) {
  for (let shift = 1; shift <= 14; shift += 1) {
    const date = new Date(Date.now() + shift * 86400_000).toISOString().slice(0, 10);
    const res = await call('GET', `/api/availability?master_id=${masterId}&date=${date}&service_ids=${serviceId}`, {});
    const slot = res.body?.slots?.[0]?.starts_at;
    if (slot) return slot;
  }
  return null;
}

// Запись мастеру-клиенту создаёт администратор — к другому мастеру (карточка 2).
const at = await firstSlot(2);
check('нашлось свободное время у второго мастера', typeof at === 'string', at);

r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: 2, master_id: 2, starts_at: at, service_ids: [1] },
});
check('администратор записал мастера как клиента', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const ownVisit = r.body.appointment?.id;

r = await call('GET', `/api/appointments/${ownVisit}`, { token: hybrid.token });
check('свой визит у чужого мастера он видит — по роли клиента', r.status === 200,
  `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

r = await call('GET', '/api/appointments', { token: hybrid.token });
check('и в списке своих записей визит есть',
  r.status === 200 && r.body.appointments.some((a) => a.id === ownVisit),
  `${r.status} ${JSON.stringify(r.body).slice(0, 150)}`);

r = await call('GET', '/api/master/appointments', { token: hybrid.token });
check('а кабинет мастера показывает его собственное расписание', r.status === 200,
  `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
check('свой визит у коллеги в расписание мастера не попал',
  !r.body.appointments.some((a) => a.id === ownVisit));

// Чужая запись не видна ни по одной из ролей.
const stranger = await newClient('stranger');
r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: stranger.id, master_id: 2, starts_at: await firstSlot(2), service_ids: [1] },
});
const strangerVisit = r.body.appointment?.id;
check('чужая запись создана', typeof strangerVisit === 'number', JSON.stringify(r.body).slice(0, 150));

r = await call('GET', `/api/appointments/${strangerVisit}`, { token: hybrid.token });
check('чужая запись у чужого мастера → 404, а не 403', r.status === 404, r.status);
r = await call('POST', `/api/appointments/${strangerVisit}/cancel`, { token: hybrid.token, body: { reason: 'а можно?' } });
check('и отменить её нельзя → 404', r.status === 404, r.status);

// Возвращаем Ольгу в исходное состояние.
db.prepare('DELETE FROM appointment_services WHERE appointment_id IN (?, ?)').run(ownVisit, strangerVisit);
db.prepare('DELETE FROM appointments WHERE id IN (?, ?)').run(ownVisit, strangerVisit);
await call('PATCH', '/api/admin/users/2', { token: AT, body: { roles: ['master'] } });
check('мастер возвращён к одной роли', rolesOf(2).join(',') === 'master', rolesOf(2));

// =====================================================================
console.log('\n3a. Роль действия должна быть связана с самой записью');

// Доступ к записи складывается по ролям, а действует человек в одной роли.
// На пересечении этих правил и была дыра: мастер, записавшийся к коллеге,
// получал доступ к записи как клиент, а действовал над ней как мастер.
await call('PATCH', '/api/admin/users/2', { token: AT, body: { roles: ['master', 'user'] } });
const dual = await login(OLGA.email, MASTER_PASSWORD);

// Записываем его клиентом к ДРУГОМУ мастеру (карточка 2, его собственная — 1).
r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: 2, master_id: 2, starts_at: await firstSlot(2), service_ids: [1] },
});
const visitAtColleague = r.body.appointment?.id;
check('визит у коллеги создан', typeof visitAtColleague === 'number', JSON.stringify(r.body).slice(0, 150));

// Исход отмечают только по прошедшему визиту — сдвигаем его в прошлое.
const intoPast = (id) => db.prepare(
  `UPDATE appointments SET starts_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 hours'),
                           ends_at   = strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 hours')
    WHERE id = ?`).run(id);
intoPast(visitAtColleague);

r = await call('POST', `/api/appointments/${visitAtColleague}/status`, {
  token: dual.token, body: { status: 'completed' } });
check('исход чужой работы мастер не отмечает → 404', r.status === 404,
  `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
check('и статус в базе не изменился',
  db.prepare('SELECT status FROM appointments WHERE id = ?').get(visitAtColleague).status === 'booked');

// А мастер этого расписания — отмечает.
const colleague = await login(IRINA.email, MASTER_PASSWORD);
r = await call('POST', `/api/appointments/${visitAtColleague}/status`, {
  token: colleague.token, body: { status: 'completed' } });
check('мастер своего расписания отмечает исход', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
check('в журнале действие записано за мастером',
  db.prepare(`SELECT actor_user_id FROM audit_log WHERE entity_id = ? AND action = 'status_change'
               ORDER BY id DESC`).get(visitAtColleague)?.actor_user_id === 3);

// Администратор проходит по своей роли, а не по мастерской.
r = await call('POST', `/api/appointments/${visitAtColleague}/status`, {
  token: AT, body: { status: 'no_show' } });
check('администратору доступны все записи студии', r.status === 200, r.status);

// --- правила клиента над собственной записью ---
// Срок отмены действует и на мастера, когда он сам клиент: студия теряет
// слот одинаково, кем бы ни работал тот, кто отменил за час до визита.
r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: 2, master_id: 2, starts_at: await firstSlot(2), service_ids: [1] },
});
const ownSoon = r.body.appointment?.id;
check('вторая запись у коллеги создана', typeof ownSoon === 'number', JSON.stringify(r.body).slice(0, 150));

// Срок отмены расширяем до недели (168 ч — предел настройки) вместо того,
// чтобы двигать визит в ближайший час: сдвиг времени упёрся бы в триггер
// против пересечения записей, а правило отмены проверяется одинаково
// при любом сроке. Визит назначен на завтра, поэтому в неделю он попадает.
const deadlineBefore = (await call('GET', '/api/admin/settings', { token: AT }))
  .body.settings.find((item) => item.key === 'cancel_deadline_hours').value;
await call('PATCH', '/api/admin/settings', {
  token: AT, body: { settings: { cancel_deadline_hours: 168 } } });

r = await call('POST', `/api/appointments/${ownSoon}/cancel`, {
  token: dual.token, body: { reason: 'передумал' } });
check('свою запись мастер отменяет по правилам клиента → 422 срок',
  r.status === 422 && r.body.error?.code === 'deadline_passed',
  `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);

// Тот же человек в чужой записи своего расписания остаётся мастером:
// срок на него не действует, но нужна причина.
r = await call('GET', `/api/appointments/${ownSoon}`, { token: dual.token });
check('в своей записи видны правила клиента', r.body.appointment?.can_cancel !== undefined,
  JSON.stringify(r.body.appointment).slice(0, 160));

// Мастер этого расписания отменяет ту же запись без оглядки на срок.
r = await call('POST', `/api/appointments/${ownSoon}/cancel`, {
  token: colleague.token, body: { reason: 'мастер заболел' } });
check('мастер расписания отменяет без срока', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

await call('PATCH', '/api/admin/settings', {
  token: AT, body: { settings: { cancel_deadline_hours: Number(deadlineBefore) } } });
check('срок отмены возвращён', (await call('GET', '/api/admin/settings', { token: AT }))
  .body.settings.find((item) => item.key === 'cancel_deadline_hours').value === deadlineBefore);

// уборка
db.prepare('DELETE FROM appointment_services WHERE appointment_id IN (?, ?)').run(visitAtColleague, ownSoon);
db.prepare('DELETE FROM audit_log WHERE entity_type = ? AND entity_id IN (?, ?)')
  .run('appointment', visitAtColleague, ownSoon);
db.prepare('DELETE FROM notifications WHERE appointment_id IN (?, ?)').run(visitAtColleague, ownSoon);
db.prepare('DELETE FROM appointments WHERE id IN (?, ?)').run(visitAtColleague, ownSoon);
await call('PATCH', '/api/admin/users/2', { token: AT, body: { roles: ['master'] } });

// =====================================================================
console.log('\n3b. Аккаунт без единой роли');

// Через API такое состояние не создаётся: регистрация выдаёт `user`,
// правка ролей отклоняет пустой список. Но схема пустоту допускает,
// поэтому рубеж должен стоять в коде — иначе сессия выглядит живой,
// и человек попадает туда, где нужен только вход.
const roleless = await newClient('roleless');
check('живая сессия до снятия ролей',
  (await call('GET', '/api/auth/me', { token: roleless.token })).status === 200);

db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(roleless.id);
check('ролей в базе не осталось',
  db.prepare('SELECT COUNT(*) c FROM user_roles WHERE user_id = ?').get(roleless.id).c === 0);

r = await call('GET', '/api/auth/me', { token: roleless.token });
check('прежний токен перестаёт работать → 401', r.status === 401, r.status);
r = await call('GET', '/api/notifications', { token: roleless.token });
check('и на эндпоинт, где нужен только вход, тоже → 401', r.status === 401, r.status);

// Повторный вход не выдаёт рабочий токен: отказ тот же, что при неверном
// пароле, — причина отказа наружу не уточняется.
const again = await call('POST', '/api/auth/login', {
  body: { email: roleless.email, password: PASSWORD } });
check('войти в такой аккаунт нельзя → 401', again.status === 401, again.status);
check('и ответ не выдаёт причину',
  again.body.error?.message === 'Неверный e-mail или пароль', again.body.error?.message);

// Роль вернули — аккаунт снова рабочий.
db.prepare("INSERT INTO user_roles(user_id, role) VALUES (?, 'user')").run(roleless.id);
r = await call('POST', '/api/auth/login', { body: { email: roleless.email, password: PASSWORD } });
check('с возвращённой ролью вход работает', r.status === 200, r.status);

// =====================================================================
console.log('\n4. Три проверки на каждом эндпоинте');

const routes = buildRouter().list();
console.log(`  всего эндпоинтов: ${routes.length}`);

// Проверка 0: ни один эндпоинт не отвечает, забыв решить вопрос о доступе.
// Предохранитель в context.js превращает такую забывчивость в 500
// с кодом access_check_missing — и данные наружу не уходят.
const sample = (pattern) => pattern.replace(/:[a-z_]+/gi, '999999');
const undecided = [];
for (const route of routes) {
  const res = await call(route.method, sample(route.pattern), { body: route.method === 'GET' ? undefined : {} });
  if (res.body?.error?.code === 'access_check_missing') undecided.push(`${route.method} ${route.pattern}`);
}
check('ни один эндпоинт не отвечает без решения о доступе',
  undecided.length === 0, undecided.join(', '));

// Проверка 1: вход. Всё, что не объявлено публичным, без токена даёт 401.
const PUBLIC = new Set([
  'POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout',
  'POST /api/auth/forgot-password', 'POST /api/auth/reset-password',
  'POST /api/auth/reset-password/check',
  'GET /api/services', 'GET /api/masters', 'GET /api/masters/:id', 'GET /api/studio',
  'GET /api/availability', 'GET /api/availability/days',
  'POST /api/holds', 'GET /api/holds/:id', 'DELETE /api/holds/:id',
  'GET /api/health',
]);
const leaky = [];
for (const route of routes) {
  const name = `${route.method} ${route.pattern}`;
  if (PUBLIC.has(name)) continue;
  const res = await call(route.method, sample(route.pattern), { body: route.method === 'GET' ? undefined : {} });
  if (res.status !== 401) leaky.push(`${name} → ${res.status}`);
}
check('каждый непубличный эндпоинт без входа отвечает 401', leaky.length === 0, leaky.join(', '));

// Проверка 2: роль. Клиент не проходит ни в админ-панель, ни в кабинет мастера.
const client = await newClient('checks');
const wrongRole = [];
for (const route of routes) {
  if (!route.pattern.startsWith('/api/admin/') && !route.pattern.startsWith('/api/master/')) continue;
  const res = await call(route.method, sample(route.pattern), {
    token: client.token, body: route.method === 'GET' ? undefined : {},
  });
  if (res.status !== 403) wrongRole.push(`${route.method} ${route.pattern} → ${res.status}`);
}
check('клиент не проходит ни в один эндпоинт админа и мастера', wrongRole.length === 0, wrongRole.join(', '));

// Проверка 3: принадлежность объекта. Своя запись видна, чужая — нет,
// и отличается это 404, а не 403: по разнице ответов чужие записи
// можно было бы пересчитать перебором.
const mine = await newClient('mine');
r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: mine.id, master_id: 1, starts_at: await firstSlot(1), service_ids: [1] },
});
const myVisit = r.body.appointment?.id;
check('запись клиента создана', typeof myVisit === 'number', JSON.stringify(r.body).slice(0, 150));

check('свою запись клиент видит',
  (await call('GET', `/api/appointments/${myVisit}`, { token: mine.token })).status === 200);
check('чужой клиент её не видит → 404',
  (await call('GET', `/api/appointments/${myVisit}`, { token: client.token })).status === 404);
check('и не отменяет → 404',
  (await call('POST', `/api/appointments/${myVisit}/cancel`, { token: client.token, body: {} })).status === 404);

// Выборка идёт по номеру из сессии: подсказать чужой номер в запросе нельзя.
r = await call('GET', `/api/appointments?client_id=${mine.id}`, { token: client.token });
check('client_id в запросе не подменяет своего',
  r.status === 200 && !r.body.appointments.some((a) => a.id === myVisit),
  JSON.stringify(r.body).slice(0, 150));

// Мастер видит запись своего расписания и не видит чужую.
const masterToken = (await login(IRINA.email, MASTER_PASSWORD)).token;
check('чужого мастера эта запись не касается → 404',
  (await call('GET', `/api/appointments/${myVisit}`, { token: masterToken })).status === 404);
const ownMasterToken = (await login(OLGA.email, MASTER_PASSWORD)).token;
check('мастер своего расписания её видит',
  (await call('GET', `/api/appointments/${myVisit}`, { token: ownMasterToken })).status === 200);
check('администратор видит все записи',
  (await call('GET', `/api/appointments/${myVisit}`, { token: AT })).status === 200);

// --- уборка ---
db.prepare('DELETE FROM appointment_services WHERE appointment_id = ?').run(myVisit);
db.prepare('DELETE FROM appointments WHERE id = ?').run(myVisit);
for (const id of made.reverse()) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
