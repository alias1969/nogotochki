/**
 * Контекст запроса — всё, что обработчик получает вместо голых req и res.
 *
 * Собирается один раз на запрос и отвечает на четыре вопроса:
 * кто спрашивает, что он прислал, какие сейчас правила студии
 * и чем подписан его резерв слота.
 *
 * Здесь же живут проверки доступа. Их три, и они разные:
 *
 *   1. requireUser  — вошёл ли вообще;
 *   2. requireRole  — есть ли нужная роль в его списке ролей из базы;
 *   3. проверка принадлежности объекта — своя у каждого раздела
 *      (findAccessible у записей, ownOnly у графиков), потому что
 *      «свой» у клиента, мастера и администратора значит разное.
 *
 * Первые две проверки видны здесь, третья — в сервисах. Общее у них то,
 * что ни одна не верит запросу на слово: ни роль, ни идентификатор
 * владельца из тела или строки запроса не участвуют в решении.
 *
 * Каждый обработчик обязан принять решение о доступе — хотя бы объявить
 * эндпоинт публичным через allowPublic(). Забытую проверку ловит сервер
 * (см. http/server.js): ответ без решения о доступе наружу не уходит.
 */
import { parseCookies, serializeCookie, SESSION_COOKIE, GUEST_COOKIE } from './cookies.js';
import { readJsonBody, sendJson } from './json.js';
import { authenticate } from '../services/auth.js';
import { loadSettings } from '../services/settings.js';
import { hashToken, newToken } from '../lib/secrets.js';
import { has, hasAny, strongest } from '../lib/roles.js';
import { env } from '../config/env.js';
import { now } from '../lib/time.js';
import { HttpError, unauthorized, forbidden } from '../lib/http-error.js';

/**
 * Предохранитель против забытой проверки доступа.
 *
 * Обработчик, не принявший решения о доступе, не отдаёт данные вообще —
 * ни правильному человеку, ни постороннему. Это единственный способ
 * сделать правило «на каждом эндпоинте стоит проверка» проверяемым:
 * иначе новый эндпоинт без requireUser выглядит ровно так же, как
 * эндпоинт, которому проверка не нужна, и разница всплывает не на тесте,
 * а в чужом кабинете.
 *
 * Публичный эндпоинт объявляет себя публичным — и тоже проходит.
 */
function assertAccessDecided(ctx, req, url) {
  if (ctx.accessDecision !== null) return;
  console.error(`Доступ не проверен: ${req.method} ${url.pathname}`);
  throw new HttpError(500, 'access_check_missing', 'Обработчик не проверил доступ');
}

/** Токен берётся из cookie или из заголовка Authorization: Bearer. */
function readToken(req, cookies) {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return cookies[SESSION_COOKIE] ?? null;
}

export function createContext(req, res, url) {
  const cookies = parseCookies(req.headers.cookie);
  const token = readToken(req, cookies);
  const auth = authenticate(token);

  // Гостевой токен нужен только для резерва слота. Он не даёт никаких прав
  // и выдаётся при первом резерве, а не всем подряд: cookie без нужды
  // не ставим.
  let guestToken = cookies[GUEST_COOKIE] ?? null;
  let guestIssued = false;
  const ensureGuestToken = () => {
    if (!guestToken) {
      guestToken = newToken();
      guestIssued = true;
    }
    return guestToken;
  };

  const settings = loadSettings();
  const user = auth?.user ?? null;

  return {
    req,
    res,
    url,
    token,
    user,
    // Номер текущей сессии нужен смене пароля: она закрывает все входы
    // этого человека, кроме того, из которого пришёл запрос.
    sessionId: auth?.sessionId ?? null,
    settings,
    now: now(),
    query: Object.fromEntries(url.searchParams),
    params: Object.create(null),
    guestTokenHash: guestToken ? hashToken(guestToken) : null,

    /**
     * Владелец резерва.
     *
     * У вошедшего резерв привязан к аккаунту, у гостя — к токену браузера.
     * Поле tokenHash заполняется всегда: резерв, взятый до входа, ищется
     * по нему и после входа привязывается к аккаунту.
     */
    get owner() {
      return {
        userId: user?.id ?? null,
        tokenHash: auth ? auth.tokenHash : hashToken(ensureGuestToken()),
      };
    },

    /** Заголовок с гостевой cookie — только если её действительно выдали. */
    guestCookieHeader() {
      if (!guestIssued) return {};
      return {
        'Set-Cookie': serializeCookie(GUEST_COOKIE, guestToken, {
          maxAge: 24 * 3600,
          secure: env.isProduction,
        }),
      };
    },

    body: () => readJsonBody(req),

    /** Проверка доступа выполнена — заполняется требованиями ниже. */
    accessDecision: null,

    /**
     * Эндпоинт открыт всем: витрина услуг, список мастеров, свободное время.
     *
     * Объявляется явно и вслух. Разница между «здесь проверка не нужна»
     * и «здесь проверку забыли» на глаз не видна, а цена у неё разная,
     * поэтому публичность — такое же решение о доступе, как и остальные.
     */
    allowPublic(why = 'витрина студии') {
      this.accessDecision = { kind: 'public', why };
      return user;
    },

    /** Проверка 1: нужен вход — без уточнения роли. */
    requireUser() {
      this.accessDecision = { kind: 'user' };
      if (!user) throw unauthorized();
      return user;
    },

    /**
     * Проверка 2: нужна роль — именно наличие её в списке.
     *
     * Список ролей взят из базы при опознании сессии. Проверяется
     * вхождение, а не равенство: у человека ролей может быть несколько,
     * и мастер, который заодно администратор, обязан попадать и в свой
     * кабинет, и в админ-панель.
     *
     * Администратор не проходит «везде по должности»: на личных эндпоинтах
     * свои записи у администратора — это его записи, а не все подряд.
     * Где ему нужен доступ ко всему, это сказано отдельно — в проверке
     * принадлежности объекта, а не здесь.
     */
    requireRole(role) {
      this.accessDecision = { kind: 'role', role };
      if (!user) throw unauthorized();
      if (!has(user, role)) throw forbidden(`Действие доступно роли ${role}`);
      return user;
    },

    /** Проверка 2 для эндпоинтов, открытых нескольким ролям сразу. */
    requireAnyRole(roles) {
      this.accessDecision = { kind: 'role', role: roles.join('/') };
      if (!user) throw unauthorized();
      if (!hasAny(user, roles)) {
        throw forbidden(`Действие доступно ролям: ${roles.join(', ')}`);
      }
      return user;
    },

    /** Есть ли роль у того, кто пришёл. Без отказа — для развилок внутри обработчика. */
    hasRole(role) {
      return has(user, role);
    },

    /** Самая сильная роль пришедшего — для журнала и сообщений. */
    get role() {
      return strongest(user);
    },

    json(status, payload, headers = {}) {
      assertAccessDecided(this, req, url);
      sendJson(res, status, payload, headers);
    },
  };
}
