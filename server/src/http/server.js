/**
 * Сборка HTTP-сервера.
 *
 * Внешнего фреймворка нет — только node:http. Весь конвейер запроса виден
 * одной функцией: разобрать адрес, собрать контекст, найти обработчик,
 * выполнить, отправить JSON. Ошибки перехватываются в одном месте,
 * поэтому ни один обработчик не пишет try/catch вокруг своей работы.
 */
import { createServer as createHttpServer } from 'node:http';

import { createRouter } from './router.js';
import { createContext } from './context.js';
import { sendJson, sendError } from './json.js';
import { registerAuthRoutes } from '../api/auth.routes.js';
import { registerCatalogRoutes } from '../api/catalog.routes.js';
import { registerAvailabilityRoutes } from '../api/availability.routes.js';
import { registerHoldRoutes } from '../api/holds.routes.js';
import { registerAppointmentRoutes } from '../api/appointments.routes.js';
import { registerAdminRoutes } from '../api/admin.routes.js';
import { registerScheduleRoutes } from '../api/schedules.routes.js';
import { registerNotificationRoutes } from '../api/notifications.routes.js';
import { registerMasterRoutes } from '../api/master.routes.js';
import { registerStudioRoutes } from '../api/studio.routes.js';
import { registerProfileRoutes } from '../api/profile.routes.js';
import { registerUserRoutes } from '../api/users.routes.js';
import { registerAuditRoutes } from '../api/audit.routes.js';

export function buildRouter() {
  const router = createRouter();
  registerAuthRoutes(router);
  registerCatalogRoutes(router);
  registerAvailabilityRoutes(router);
  registerHoldRoutes(router);
  registerAppointmentRoutes(router);
  registerAdminRoutes(router);
  registerScheduleRoutes(router);
  registerNotificationRoutes(router);
  registerMasterRoutes(router);
  registerStudioRoutes(router);
  registerProfileRoutes(router);
  registerUserRoutes(router);
  registerAuditRoutes(router);

  /** Проверка живости для мониторинга и деплоя. Базу не трогает. */
  router.get('/api/health', async (ctx) => {
    ctx.allowPublic('проверка живости для мониторинга; данных не отдаёт');
    return ctx.json(200, { status: 'ok', time: ctx.now });
  });

  return router;
}

export function createServer() {
  const router = buildRouter();

  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      // Хвостовой слеш не должен плодить второй адрес для того же ресурса.
      const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

      const route = router.match(req.method, pathname);
      const ctx = createContext(req, res, url);
      ctx.params = route.params;
      await route.handler(ctx);

      // Обработчик обязан ответить сам; если он этого не сделал,
      // лучше явная 500, чем запрос, висящий до таймаута браузера.
      if (!res.writableEnded) {
        sendJson(res, 500, { error: { code: 'empty_response', message: 'Обработчик не дал ответа' } });
      }
    } catch (error) {
      if (res.writableEnded) return;
      sendError(res, error);
    }
  });
}
