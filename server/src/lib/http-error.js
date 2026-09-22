/**
 * Ошибка с кодом ответа HTTP.
 *
 * Весь код ниже бросает именно её, а единственный обработчик в server.js
 * превращает её в JSON. Благодаря этому ни один обработчик маршрута
 * не занимается форматированием ошибок и не знает про res.
 *
 * Коды, которыми пользуется сервис:
 *   400 — данные не прошли проверку
 *   401 — нет действующей сессии
 *   403 — сессия есть, но прав не хватает
 *   404 — объекта нет или он не принадлежит запрашивающему
 *   409 — конфликт: время занято, резерв истёк, e-mail уже занят
 *   422 — данные корректны по форме, но правило студии не выполняется
 */
export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new HttpError(400, code, message, details);
export const unauthorized = (message = 'Требуется вход в аккаунт') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Недостаточно прав') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Объект не найден') => new HttpError(404, 'not_found', message);
export const conflict = (code, message, details) => new HttpError(409, code, message, details);
export const unprocessable = (code, message, details) => new HttpError(422, code, message, details);
