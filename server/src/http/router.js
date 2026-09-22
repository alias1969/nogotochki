/**
 * Маршрутизатор.
 *
 * Своё вместо фреймворка: у проекта нет внешних зависимостей, а всё, что
 * здесь нужно, — сопоставить метод и путь с обработчиком и вытащить
 * :параметры. Это полсотни строк, которые целиком читаются за минуту.
 */
import { HttpError, notFound } from '../lib/http-error.js';

/** '/api/appointments/:id/cancel' → регулярное выражение с именованными группами. */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { regexp: new RegExp(`^${source}$`), names };
}

export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    routes.push({ method, pattern, ...compile(pattern), handler });
  };

  return {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    // PUT, а не PATCH, там где ресурс задаётся целиком: недельный график
    // присылается как состояние сетки «пн … вс», а не как список правок.
    put: (pattern, handler) => add('PUT', pattern, handler),
    patch: (pattern, handler) => add('PATCH', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),

    /**
     * Все зарегистрированные маршруты — метод и шаблон пути.
     *
     * Нужен проверке доступа (tests/roles.test.mjs): она обходит
     * эндпоинты по списку, а не по написанному руками перечню, —
     * иначе новый эндпоинт просто не попал бы в проверку.
     */
    list() {
      return routes.map(({ method, pattern }) => ({ method, pattern }));
    },

    /**
     * Ищет обработчик. Если путь есть, но метод другой, отвечаем 405
     * со списком допустимых методов, а не 404: это разные ситуации,
     * и на отладке разница экономит много времени.
     */
    match(method, pathname) {
      const allowed = new Set();
      for (const route of routes) {
        const found = route.regexp.exec(pathname);
        if (!found) continue;
        if (route.method !== method) {
          allowed.add(route.method);
          continue;
        }
        const params = Object.create(null);
        route.names.forEach((name, index) => {
          params[name] = decodeURIComponent(found[index + 1]);
        });
        return { handler: route.handler, params };
      }
      if (allowed.size > 0) {
        throw new HttpError(405, 'method_not_allowed', `Метод ${method} для этого адреса не поддерживается`, {
          allow: [...allowed].sort(),
        });
      }
      throw notFound('Такого адреса нет');
    },
  };
}
