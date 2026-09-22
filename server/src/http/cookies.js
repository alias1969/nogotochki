/**
 * Чтение и установка cookie без внешних библиотек.
 *
 * Сервис держит две cookie:
 *   nog_session — токен сессии после входа;
 *   nog_guest   — анонимный токен браузера, на котором висит резерв слота
 *                 у гостя, ещё не вошедшего в аккаунт (шаг B3 → B4).
 *
 * Обе HttpOnly: токен не нужен JavaScript на странице, а недоступная скриптам
 * cookie не утекает через чужой встроенный скрипт.
 */
export const SESSION_COOKIE = 'nog_session';
export const GUEST_COOKIE = 'nog_guest';

export function parseCookies(header) {
  const result = Object.create(null);
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (name in result) continue;
    try {
      result[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Значение с битым процентным кодированием считаем отсутствующим.
    }
  }
  return result;
}

/**
 * SameSite=Lax, а не None: сервис и фронтенд живут на одном домене,
 * а Lax отсекает отправку cookie при запросах с чужих сайтов — базовая
 * защита от действий от имени вошедшего пользователя.
 * Secure ставится только в проде: на http://localhost такая cookie не сохранится.
 */
export function serializeCookie(name, value, { maxAge, secure = false } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name, { secure = false } = {}) {
  return serializeCookie(name, '', { maxAge: 0, secure });
}
