/**
 * Удержание слота на время оформления.
 *
 * Резерв — единственная причина, по которой два клиента, открывшие одно
 * и то же окно, не оформят его оба: первый, кто нажал «Выбрать время»,
 * забирает слот на hold_minutes, и у второго он из списка исчезает.
 *
 * Резерв работает и без входа: он висит на токене браузера. Поэтому эти
 * эндпоинты не требуют авторизации — требование появляется на шаге
 * создания записи.
 */
import * as v from '../lib/validate.js';
import * as views from '../api/views.js';
import { createHold, findOwnedHold, releaseHold, loadHoldServices, secondsLeft } from '../services/holds.js';
import { findRescheduleTarget } from './appointments.routes.js';
import { loadAppointmentServices } from '../services/appointments.js';

export function registerHoldRoutes(router) {
  /**
   * POST /api/holds — занять слот на время оформления.
   *
   * Тело: master_id, starts_at (UTC), service_ids либо reschedule_of.
   * Ответ содержит expires_in_seconds — по нему рисуется таймер на экране
   * подтверждения. Если время уже заняли, приходит 409 со списком
   * оставшихся свободных точек: клиенту есть что выбрать, не перезагружая экран.
   */
  router.post('/api/holds', async (ctx) => {
    const body = v.object(await ctx.body());
    const masterId = v.id(body.master_id, 'master_id');
    const startsAt = v.instant(body.starts_at, 'starts_at');
    const rescheduleOf = body.reschedule_of
      ? findRescheduleTarget(v.id(body.reschedule_of, 'reschedule_of'), ctx)
      : null;
    // При переносе состав визита не меняется — услуги берутся из самой записи.
    const serviceIds = rescheduleOf
      ? loadAppointmentServiceIds(rescheduleOf.id)
      : v.idList(body.service_ids, 'service_ids');

    const hold = createHold({
      masterId,
      startsAt,
      serviceIds,
      owner: ctx.owner,
      settings: ctx.settings,
      rescheduleOf,
    });

    return ctx.json(
      201,
      { hold: views.hold(hold, loadHoldServices(hold.id), ctx.settings, secondsLeft(hold, ctx.now)) },
      ctx.guestCookieHeader(),
    );
  });

  /**
   * GET /api/holds/:id — состояние резерва и остаток таймера.
   *
   * Экран подтверждения спрашивает его после входа или восстановления
   * пароля: выбор услуг хранится в базе, а не в браузере, и переживает
   * уход на почту по ссылке.
   */
  router.get('/api/holds/:id', async (ctx) => {
    const hold = findOwnedHold(v.id(ctx.params.id, 'id'), ctx.owner);
    return ctx.json(200, {
      hold: views.hold(hold, loadHoldServices(hold.id), ctx.settings, secondsLeft(hold, ctx.now)),
    });
  });

  /**
   * DELETE /api/holds/:id — отказаться от резерва.
   *
   * Клиент ушёл с экрана подтверждения — время возвращается в свободные
   * сразу, не дожидаясь истечения десяти минут.
   */
  router.delete('/api/holds/:id', async (ctx) => {
    releaseHold(v.id(ctx.params.id, 'id'), ctx.owner);
    return ctx.json(200, { ok: true });
  });
}

/** Состав переносимой записи: при переносе набор услуг не меняется. */
function loadAppointmentServiceIds(appointmentId) {
  return loadAppointmentServices(appointmentId).map((service) => service.id);
}
