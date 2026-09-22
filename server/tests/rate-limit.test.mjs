/**
 * Ограничение частоты входа и регистрации.
 *
 * Проверка поднимает **свой** сервер на свободном порту с нарочно
 * маленькими лимитами. Так проверяется настоящий путь запроса — HTTP,
 * обработчик, ограничитель, — и при этом не расходуются счётчики того
 * сервера, на котором идут остальные проверки: иначе этот набор
 * блокировал бы вход всем следующим.
 *
 * Переменные окружения выставляются до импорта конфигурации: значения
 * из .env их не перебивают (process.loadEnvFile не трогает уже заданные).
 *
 * Запуск: npm run test:rate-limit
 */
process.env.LOGIN_MAX_ATTEMPTS = '3';
process.env.LOGIN_WINDOW_MINUTES = '5';
process.env.REGISTER_MAX_ATTEMPTS = '2';
process.env.REGISTER_WINDOW_MINUTES = '60';

const { createServer } = await import('../src/http/server.js');
const { createLimiter, clientAddress } = await import('../src/lib/rate-limit.js');
const { DB_FILE } = await import('./env.mjs');
const { DatabaseSync } = await import('node:sqlite');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  ok ? (pass++, console.log('  ok  ', name)) : (fail++, console.log('  FAIL', name, extra));
};

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() };
}

const db = new DatabaseSync(DB_FILE);
const made = [];

// =====================================================================
console.log('\n1. Вход: перебор пароля по одному аккаунту');

const email = `rl-${Date.now()}@example.com`;
const PASSWORD = 'secret12345';
let r = await call('POST', '/api/auth/register', {
  email, password: PASSWORD, full_name: 'Проба Лимита', phone: '+79001110044',
});
check('аккаунт заведён', r.status === 201, JSON.stringify(r.body).slice(0, 150));
made.push(r.body.user.id);

const wrong = () => call('POST', '/api/auth/login', { email, password: 'неверный-пароль' });

r = await wrong();
check('первая неудача — обычный 401', r.status === 401, r.status);
r = await wrong();
check('вторая — тоже 401', r.status === 401, r.status);
r = await wrong();
check('третья — тоже 401 (лимит 3 исчерпан ровно ею)', r.status === 401, r.status);

r = await wrong();
check('четвёртая → 429', r.status === 429, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
check('код ошибки говорит о частоте', r.body.error?.code === 'too_many_requests', r.body.error?.code);
check('есть заголовок Retry-After', Number(r.retryAfter) > 0, r.retryAfter);
check('и то же число в теле', r.body.error?.details?.retry_after_seconds > 0,
  JSON.stringify(r.body.error?.details));
check('в отказе не сказано, сколько попыток осталось и по какому признаку',
  !/попыт(ок|ки) осталось|e-mail|адрес/i.test(r.body.error?.message ?? ''), r.body.error?.message);

r = await call('POST', '/api/auth/login', { email, password: PASSWORD });
check('верный пароль тоже отбивается — лимит не обходится угадыванием', r.status === 429, r.status);

// =====================================================================
console.log('\n2. Успешный вход обнуляет счётчик по e-mail');

// Отдельный ограничитель с теми же правилами — проверяем саму логику
// «считаем только неудачи», не дожидаясь пятиминутного окна.
const limiter = createLimiter({ name: 'проба', max: 3, windowMs: 60_000 });
limiter.hit('email:a');
limiter.hit('email:a');
check('две неудачи — место ещё есть', limiter.check('email:a') === 1);
limiter.forget('email:a');
check('после успеха счётчик чист', limiter.check('email:a') === 3);

limiter.hit('email:b'); limiter.hit('email:b'); limiter.hit('email:b');
let refused = null;
try { limiter.check('email:b'); } catch (error) { refused = error; }
check('исчерпанный ключ отбивается', refused?.status === 429, refused?.status);
check('другой ключ при этом свободен', limiter.check('email:c') === 3);

// Окно скользящее: попытка, вышедшая за его край, перестаёт считаться.
const short = createLimiter({ name: 'окно', max: 2, windowMs: 120 });
short.hit('k'); short.hit('k');
let blocked = false;
try { short.check('k'); } catch { blocked = true; }
check('лимит сработал', blocked);
await new Promise((resolve) => setTimeout(resolve, 200));
check('через окно попытки снова разрешены', short.check('k') === 2);

// =====================================================================
console.log('\n3. Регистрация: массовое заведение аккаунтов');

// Лимит регистрации — 2 за окно, и одну попытку уже израсходовала
// регистрация из пункта 1.
const reg = (tag) => call('POST', '/api/auth/register', {
  email: `rl-mass-${tag}-${Date.now()}@example.com`,
  password: PASSWORD, full_name: `Массовый ${tag}`, phone: '+79001110055',
});

r = await reg('a');
check('вторая регистрация проходит', r.status === 201, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
if (r.body.user) made.push(r.body.user.id);

r = await reg('b');
check('третья → 429', r.status === 429, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
check('в базе она не появилась',
  db.prepare("SELECT COUNT(*) c FROM users WHERE email LIKE 'rl-mass-b-%'").get().c === 0);

// Неверные данные тоже расходуют лимит: иначе перебор прикрывался бы
// заведомо битыми запросами.
r = await call('POST', '/api/auth/register', { email: 'не-почта' });
check('битая регистрация тоже отбивается по частоте, а не по форме', r.status === 429, r.status);

// =====================================================================
console.log('\n4. Адрес клиента');

const fake = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: { remoteAddress: '127.0.0.1' } };
check('без доверия прокси берётся адрес сокета',
  clientAddress(fake, { trustProxy: false }) === '127.0.0.1');
check('с доверием — первый адрес из заголовка',
  clientAddress(fake, { trustProxy: true }) === '1.2.3.4');
check('без заголовка и без сокета — не падает, а отвечает unknown',
  clientAddress({ headers: {} }, { trustProxy: true }) === 'unknown');

// --- уборка ---
for (const id of made.reverse()) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
server.close();

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
