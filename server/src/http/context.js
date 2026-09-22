/**
 * Контекст запроса — всё, что обработчик получает вместо голых req и res.
 *
 * Собирается один раз на запрос и отвечает на четыре вопроса:
 * кто спрашивает, что он прислал, какие сейчас правила студии
 * и чем подписан его резерв слота.
 */
import { parseCookies, serializeCookie, SESSION_COOKIE, GUEST_COOKIE } from './cookies.js';
import { readJsonBody, sendJson } from './json.js';
import { authenticate } from '../services/auth.js';
import { loadSettings } from '../services/settings.js';
import { hashToken, newToken } from '../lib/secrets.js';
import { env } from '../config/env.js';
import { now } from '../lib/time.js';
import { unauthorized, forbidden } from '../lib/http-error.js';

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

    /** Нужен вход — без уточнения роли. */
    requireUser() {
      if (!user) throw unauthorized();
      return user;
    },

    /**
     * Нужна конкретная роль.
     *
     * Администратор проходит везде, кроме случая, когда эндпоинт
     * по смыслу личный: свои записи у администратора — это его записи,
     * а не все подряд, поэтому 'user' не расширяется до admin.
     */
    requireRole(role) {
      if (!user) throw unauthorized();
      if (user.role !== role) throw forbidden(`Действие доступно роли ${role}`);
      return user;
    },

    json(status, payload, headers = {}) {
      sendJson(res, status, payload, headers);
    },
  };
}
