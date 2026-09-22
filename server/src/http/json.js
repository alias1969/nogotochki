/**
 * Разбор тела запроса и отправка ответа. Формат один для всего API — JSON.
 */
import { HttpError, badRequest } from '../lib/http-error.js';

/** Тела запросов в этом сервисе — короткие формы; всё крупнее считаем ошибкой. */
const MAX_BODY_BYTES = 64 * 1024;

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Ответы API зависят от сессии и не должны попадать в общий кеш.
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendError(res, error) {
  const known = error instanceof HttpError;
  if (!known) {
    // Наружу уходит только код: текст внутренней ошибки может содержать
    // подробности схемы и путь к файлу базы.
    console.error('Необработанная ошибка:', error);
  }
  sendJson(
    res,
    known ? error.status : 500,
    {
      error: {
        code: known ? error.code : 'internal_error',
        message: known ? error.message : 'Внутренняя ошибка сервера',
        ...(known && error.details ? { details: error.details } : {}),
      },
    },
    // Заголовки несёт только своя ошибка: 429 обязана вернуть Retry-After.
    known && error.headers ? error.headers : {},
  );
}

/** Читает тело и разбирает его как JSON. Пустое тело — пустой объект. */
export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw badRequest('body_too_large', 'Тело запроса слишком велико');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const type = req.headers['content-type'] ?? '';
  if (!type.includes('application/json')) {
    throw badRequest('unsupported_media_type', 'Ожидается Content-Type: application/json');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('invalid_json', 'Тело запроса не является корректным JSON');
  }
}
