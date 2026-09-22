/**
 * Категории услуг — разделы прайса.
 *
 * Справочник тонкий, и интересного в нём ровно три вещи: категорий-
 * близнецов не заводится, выключение прячет с витрины и саму категорию,
 * и все её услуги, а удалить её нельзя, потому что вместе с ней исчез бы
 * состав прошлых визитов.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:categories
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
const client = (await call('POST', '/api/auth/register', {
  body: { email: `cat-${Date.now()}@example.com`, password: 'secret12345',
          full_name: 'Клиент Категорий', phone: '+79001114455' } })).body;

const made = { categories: [], services: [] };

// =====================================================================
console.log('\n1. Чтение');
let r = await call('GET', '/api/admin/service-categories', { token: AT });
check('категории читаются', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('две из тестовых данных', r.body.categories.length === 2, r.body.categories.length);
const nails = r.body.categories.find((c) => c.name === 'Ногтевой сервис');
check('видно, сколько в ней услуг',
  nails.services_active >= 4 && nails.services_total >= nails.services_active, JSON.stringify(nails));
check('порядок вывода отдаётся', typeof nails.sort_order === 'number');

r = await call('GET', '/api/admin/service-categories', { token: client.token });
check('клиенту закрыто → 403', r.status === 403, r.status);
r = await call('GET', '/api/admin/service-categories');
check('без входа → 401', r.status === 401, r.status);

r = await call('GET', '/api/services');
check('клиент видит категории вместе с услугами',
  r.body.services.every((s) => typeof s.category?.name === 'string'), JSON.stringify(r.body.services[0]?.category));

// =====================================================================
console.log('\n2. Создание');
const NAME = `Проба ${Date.now()}`;
r = await call('POST', '/api/admin/service-categories', {
  token: AT, body: { name: NAME, sort_order: 50 } });
check('категория создана', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const cat = r.body.category.id;
made.categories.push(cat);
check('на витрине по умолчанию', r.body.category.is_active === true);
check('услуг пока нет', r.body.category.services_total === 0);

r = await call('POST', '/api/admin/service-categories', { token: AT, body: { name: NAME } });
check('точный близнец → 409', r.status === 409 && r.body.error.code === 'category_exists',
  `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
r = await call('POST', '/api/admin/service-categories', { token: AT, body: { name: NAME.toUpperCase() } });
check('близнец в другом регистре тоже → 409', r.status === 409, `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
check('в отказе указан занявший раздел', r.body.error.details?.category_id === cat);
r = await call('POST', '/api/admin/service-categories', { token: AT, body: { name: 'уход' } });
check('кириллица в другом регистре ловится', r.status === 409, `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);

r = await call('POST', '/api/admin/service-categories', { token: AT, body: { name: 'У' } });
check('слишком короткое имя → 400', r.status === 400, r.status);
r = await call('POST', '/api/admin/service-categories', { token: AT, body: { sort_order: 1 } });
check('без имени → 400', r.status === 400, r.status);
r = await call('POST', '/api/admin/service-categories', { token: client.token, body: { name: 'Клиентская' } });
check('клиенту закрыто → 403', r.status === 403, r.status);

// =====================================================================
console.log('\n3. Правка');
r = await call('PATCH', `/api/admin/service-categories/${cat}`, {
  token: AT, body: { name: `${NAME} обновлённая`, sort_order: 5 } });
check('имя и порядок изменены', r.status === 200 && r.body.category.sort_order === 5,
  JSON.stringify(r.body).slice(0, 150));
r = await call('PATCH', `/api/admin/service-categories/${cat}`, { token: AT, body: { name: 'Уход' } });
check('переименовать в занятое имя → 409', r.status === 409, r.status);
r = await call('PATCH', `/api/admin/service-categories/${cat}`, {
  token: AT, body: { name: `${NAME} обновлённая` } });
check('своё же имя менять можно', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
r = await call('PATCH', `/api/admin/service-categories/${cat}`, { token: AT, body: {} });
check('пустая правка → 422', r.status === 422, r.status);
r = await call('PATCH', '/api/admin/service-categories/99999', { token: AT, body: { name: 'Нет такой' } });
check('несуществующая → 404', r.status === 404, r.status);

// =====================================================================
console.log('\n4. Услуги внутри категории');
r = await call('POST', '/api/admin/services', {
  token: AT, body: { category_id: cat, name: 'Пробная услуга', duration_min: 30, price_kopecks: 100000 } });
check('услуга в новой категории создана', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const svc = r.body.service.id;
made.services.push(svc);
check('категория указана верно', r.body.service.category.id === cat);

r = await call('GET', '/api/services');
check('услуга видна на витрине', r.body.services.some((s) => s.id === svc));
r = await call('GET', '/api/admin/service-categories', { token: AT });
check('счётчик услуг вырос', r.body.categories.find((c) => c.id === cat).services_active === 1);

r = await call('POST', '/api/admin/services', {
  token: AT, body: { category_id: 99999, name: 'В никуда', duration_min: 30, price_kopecks: 1 } });
check('услуга в несуществующую категорию → 422', r.status === 422, r.status);

// =====================================================================
console.log('\n5. Выключение прячет и категорию, и её услуги');
r = await call('DELETE', `/api/admin/service-categories/${cat}`, { token: AT });
check('категория снята с витрины', r.status === 200 && r.body.deactivated === true, JSON.stringify(r.body).slice(0, 150));
check('сказано, сколько услуг уходит со сцены', r.body.hidden_services === 1, r.body.hidden_services);

r = await call('GET', '/api/services');
check('услуга исчезла с витрины вместе с категорией', !r.body.services.some((s) => s.id === svc),
  JSON.stringify(r.body.services.map((s) => s.id)));
check('сама услуга осталась активной', db.prepare('SELECT is_active FROM services WHERE id = ?').get(svc).is_active === 1);

r = await call('GET', '/api/admin/services', { token: AT });
check('администратор услугу по-прежнему видит', r.body.services.some((s) => s.id === svc));
r = await call('GET', '/api/admin/service-categories', { token: AT });
check('и категорию тоже', r.body.categories.find((c) => c.id === cat)?.is_active === false);

r = await call('PATCH', `/api/admin/service-categories/${cat}`, { token: AT, body: { is_active: true } });
check('можно вернуть обратно', r.status === 200 && r.body.category.is_active === true);
r = await call('GET', '/api/services');
check('услуга вернулась на витрину', r.body.services.some((s) => s.id === svc));

// =====================================================================
console.log('\n6. Удалить нельзя — на категорию ссылаются услуги');
let refusal = null;
try {
  db.prepare('DELETE FROM service_categories WHERE id = ?').run(cat);
} catch (error) {
  refusal = error.message;
}
check('база не даёт удалить категорию с услугами', /FOREIGN KEY|constraint/i.test(refusal ?? ''), refusal);
check('категория на месте', !!db.prepare('SELECT id FROM service_categories WHERE id = ?').get(cat));

const audit = db.prepare(
  "SELECT COUNT(*) c FROM audit_log WHERE entity_type = 'service' AND entity_id = ?").get(cat).c;
check('правки категории в журнале', audit >= 3, audit);

// --- уборка ---
for (const id of made.services) {
  db.prepare("DELETE FROM audit_log WHERE entity_type='service' AND entity_id=?").run(id);
  db.prepare('DELETE FROM services WHERE id = ?').run(id);
}
for (const id of made.categories) {
  db.prepare("DELETE FROM audit_log WHERE entity_type='service' AND entity_id=?").run(id);
  db.prepare('DELETE FROM service_categories WHERE id = ?').run(id);
}
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(client.user.id);
db.prepare('DELETE FROM users WHERE id = ?').run(client.user.id);

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
