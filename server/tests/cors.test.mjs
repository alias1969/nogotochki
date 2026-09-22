/**
 * CORS: кого пускают к API с чужого origin.
 *
 * Лендинг и остальные экраны раздаются отдельно от API, поэтому разрешение
 * нужно. Проверяется не «заголовок есть», а то, что он выдаётся выборочно:
 *
 *   * разрешённому адресу — выдаётся;
 *   * постороннему — не выдаётся, и его Origin не отражается обратно;
 *   * звёздочки нет вовсе: с Allow-Credentials она запрещена, а подменять
 *     ею список — то же самое, что не иметь списка;
 *   * Vary: Origin стоит всегда, иначе кеш отдаст второму сайту
 *     разрешение, выписанное первому;
 *   * предварительный запрос (OPTIONS) получает 204, а не 405 от роутера;
 *   * ответ об ошибке тоже несёт заголовки — иначе страница увидит
 *     «сетевую ошибку» вместо кода 401 или 404.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:cors
 *
 * Тест исходит из умолчания разработки (WEB_ORIGINS не задана):
 * разрешён http://localhost:5173. Если переменная выставлена
 * в .env, подставьте свой адрес через ALLOWED_ORIGIN.
 */
const BASE = process.env.API_URL ?? 'http://localhost:3000';
const ALLOWED = process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173';
const OUTSIDER = 'http://evil.example';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  ok ? (pass++, console.log('  ok  ', name)) : (fail++, console.log('  FAIL', name, extra));
};

/** Заголовки ответа интересуют больше тела, поэтому возвращаем их целиком. */
async function call(path, { method = 'GET', origin, preflight } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (preflight) {
    headers['Access-Control-Request-Method'] = preflight;
    headers['Access-Control-Request-Headers'] = 'content-type';
  }
  const res = await fetch(BASE + path, { method, headers });
  await res.text();
  return {
    status: res.status,
    allowOrigin: res.headers.get('access-control-allow-origin'),
    allowCredentials: res.headers.get('access-control-allow-credentials'),
    allowMethods: res.headers.get('access-control-allow-methods'),
    allowHeaders: res.headers.get('access-control-allow-headers'),
    maxAge: res.headers.get('access-control-max-age'),
    vary: res.headers.get('vary'),
  };
}

// =====================================================================
console.log('\n1. Разрешённый адрес');

const ok = await call('/api/services', { origin: ALLOWED });
check('запрос проходит', ok.status === 200, ok.status);
check('разрешение выписано именно на него', ok.allowOrigin === ALLOWED, ok.allowOrigin);
check('и это не звёздочка', ok.allowOrigin !== '*', ok.allowOrigin);
check('вход с этого адреса возможен', ok.allowCredentials === 'true', ok.allowCredentials);
check('Vary: Origin на месте', (ok.vary ?? '').includes('Origin'), ok.vary);

// =====================================================================
console.log('\n2. Посторонний адрес');

const bad = await call('/api/services', { origin: OUTSIDER });
check('разрешения нет', bad.allowOrigin === null, bad.allowOrigin);
check('его Origin не отражён обратно', bad.allowOrigin !== OUTSIDER, bad.allowOrigin);
check('и звёздочка не подставлена', bad.allowOrigin !== '*', bad.allowOrigin);
check('Vary: Origin всё равно стоит', (bad.vary ?? '').includes('Origin'), bad.vary);

// Похожий, но не тот же адрес: сравнение должно быть точным,
// а не «начинается с» или «содержит».
for (const near of [`${ALLOWED}.evil.example`, `${ALLOWED.replace('http:', 'https:')}`, 'http://localhost:5174']) {
  const r = await call('/api/services', { origin: near });
  check(`похожий адрес не проходит: ${near}`, r.allowOrigin === null, r.allowOrigin);
}

// =====================================================================
console.log('\n3. Запрос без Origin — curl, мониторинг, сервер к серверу');

const plain = await call('/api/health');
check('работает как раньше', plain.status === 200, plain.status);
check('разрешение не выписывается впустую', plain.allowOrigin === null, plain.allowOrigin);

// =====================================================================
console.log('\n4. Предварительный запрос');

const pre = await call('/api/holds', { method: 'OPTIONS', origin: ALLOWED, preflight: 'POST' });
check('отвечает 204, а не 405 от роутера', pre.status === 204, pre.status);
check('разрешение на адрес', pre.allowOrigin === ALLOWED, pre.allowOrigin);
check('перечислены методы', (pre.allowMethods ?? '').includes('POST'), pre.allowMethods);
check('разрешён Content-Type', (pre.allowHeaders ?? '').includes('Content-Type'), pre.allowHeaders);
check('разрешён Authorization', (pre.allowHeaders ?? '').includes('Authorization'), pre.allowHeaders);
check('браузеру сказано, сколько это помнить', Number(pre.maxAge) > 0, pre.maxAge);

const preBad = await call('/api/holds', { method: 'OPTIONS', origin: OUTSIDER, preflight: 'POST' });
check('постороннему предварительный запрос ничего не разрешает', preBad.allowOrigin === null, preBad.allowOrigin);

// =====================================================================
console.log('\n5. Ответы об ошибках тоже несут заголовки');

for (const [name, path, method, expected] of [
  ['404', '/api/nope', 'GET', 404],
  ['401', '/api/appointments', 'GET', 401],
  ['405', '/api/services', 'DELETE', 405],
]) {
  const r = await call(path, { method, origin: ALLOWED });
  check(`${name}: код тот самый`, r.status === expected, r.status);
  check(`${name}: страница увидит ответ, а не «сетевую ошибку»`, r.allowOrigin === ALLOWED, r.allowOrigin);
}

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
