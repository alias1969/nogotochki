/**
 * Заголовки CORS.
 *
 * Лендинг и остальные экраны раздаются отдельно от API — статикой на своём
 * порту (web/serve.mjs) или веб-сервером на своём домене. Для браузера это
 * другой origin, и без явного разрешения он не отдаёт странице даже успешный
 * ответ: запрос уходит, ответ приходит, а fetch падает.
 *
 * Два правила, от которых здесь ничего не отступает:
 *
 *   1. Origin из запроса не отражается обратно как есть. Отражение
 *      превращает список разрешённых в «разрешены все», в том числе
 *      сайт, открытый в соседней вкладке.
 *   2. Звёздочки нет вовсе. С `Allow-Credentials: true` она запрещена
 *      спецификацией, а без неё не работает вход.
 *
 * Список адресов задаётся переменной WEB_ORIGINS и в продакшене пуст
 * по умолчанию: разрешение пускать к API чужую страницу — решение
 * того, кто разворачивает сервис, а не значение из кода.
 */
import { env } from '../config/env.js';

/** Методы, которые вообще есть в маршрутизаторе. */
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

/**
 * Заголовки, которые странице разрешено присылать.
 *
 * Authorization здесь потому, что сессия умеет приходить не только cookie,
 * но и `Bearer` (см. readToken в context.js), — а межсайтовый запрос
 * с cookie SameSite=Lax браузер отправит без неё.
 */
const ALLOWED_HEADERS = 'Content-Type, Authorization';

/** Сколько браузеру разрешено не переспрашивать предварительный запрос. */
const PREFLIGHT_MAX_AGE = 600;

/** Хвостовой слеш в Origin не приходит, но в настройке его пишут легко. */
function normalize(origin) {
  return origin.replace(/\/+$/, '');
}

/** Разрешён ли адрес. Сравнение точное: ни подстрок, ни масок. */
export function isAllowedOrigin(origin) {
  if (!origin) return false;
  return env.webOrigins.includes(normalize(origin));
}

/**
 * Навешивает заголовки на ответ.
 *
 * Через setHeader, а не через writeHead: обработчики отвечают сами
 * и о CORS не знают. Node сливает заголовки, выставленные заранее,
 * с теми, что уходят в writeHead, поэтому разрешение получают все
 * ответы разом — и удачные, и 404, и 500.
 *
 * Vary ставится всегда, даже для постороннего адреса: ответ зависит
 * от Origin, и кеш, не знающий об этом, отдаст второму сайту
 * разрешение, выписанное первому.
 */
export function applyCors(req, res) {
  res.setHeader('Vary', 'Origin');

  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin)) return false;

  res.setHeader('Access-Control-Allow-Origin', normalize(origin));
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  return true;
}

/**
 * Предварительный запрос (preflight).
 *
 * Браузер шлёт OPTIONS перед всем, что сложнее простой формы, — а у этого
 * API сложное всё: он принимает и отдаёт JSON. В маршрутизаторе таких
 * маршрутов нет и быть не должно, поэтому OPTIONS разбирается до поиска
 * обработчика и до создания контекста.
 *
 * Возвращает true, если ответ уже отправлен.
 */
export function handlePreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  if (!req.headers['access-control-request-method']) return false;

  // Разрешения нет — отвечаем пустым 204 без заголовков CORS.
  // Запрос всё равно не состоится: решение принимает браузер,
  // и объяснять постороннему сайту, что тут есть, незачем.
  if (!isAllowedOrigin(req.headers.origin)) {
    res.writeHead(204).end();
    return true;
  }

  res.writeHead(204, {
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE),
  }).end();
  return true;
}
