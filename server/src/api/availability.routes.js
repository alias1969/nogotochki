/**
 * Свободное время мастера.
 *
 * Эндпоинт публичный: увидеть свободные окна можно до регистрации —
 * иначе клиент не поймёт, стоит ли вообще заводить аккаунт. Персональных
 * данных в ответе нет: занятое время просто отсутствует в списке,
 * а не показывается пометкой «занято».
 */
import * as v from '../lib/validate.js';
import * as views from '../api/views.js';
import { findActiveServices } from '../services/catalog.js';
import { findFreeSlots, findFreeDays } from '../services/availability.js';
import { findRescheduleTarget } from './appointments.routes.js';
import { unprocessable } from '../lib/http-error.js';
import { minutesBetween, addDays, utcDate, localDate } from '../lib/time.js';

/**
 * Длительность визита T.
 *
 * Берётся из трёх разных мест, и это не случайность:
 *   новая запись  — сумма из текущего прайса;
 *   перенос       — снимок из самой записи, прайс здесь ни при чём.
 * Если при переносе взять длительность из прайса, подорожавшая и удлинившаяся
 * услуга молча раздвинет визит и наедет на следующего клиента.
 */
function resolveDuration(ctx, serviceIds, rescheduleOf) {
  if (rescheduleOf) return minutesBetween(rescheduleOf.starts_at, rescheduleOf.ends_at);

  const services = findActiveServices(serviceIds);
  if (services.length !== serviceIds.length) {
    throw unprocessable('service_unavailable', 'Одна из выбранных услуг больше не доступна');
  }
  return services.reduce((sum, service) => sum + service.duration_min, 0);
}

export function registerAvailabilityRoutes(router) {
  /**
   * GET /api/availability — точки старта на конкретную дату.
   *
   * Параметры: master_id, date (местная дата студии) и либо service_ids,
   * либо reschedule_of — номер переносимой записи.
   *
   * Слот попадает в ответ, только если от его начала непрерывно помещается
   * сумма длительностей всех выбранных услуг: «свободно» — свойство пары
   * «время + длительность», а не времени самого по себе.
   */
  router.get('/api/availability', async (ctx) => {
    const masterId = v.id(ctx.query.master_id, 'master_id');
    const date = v.date(ctx.query.date, 'date');
    const rescheduleOf = ctx.query.reschedule_of
      ? findRescheduleTarget(v.id(ctx.query.reschedule_of, 'reschedule_of'), ctx)
      : null;
    const serviceIds = rescheduleOf ? [] : v.idList(ctx.query.service_ids, 'service_ids');
    const totalMinutes = resolveDuration(ctx, serviceIds, rescheduleOf);

    const slots = findFreeSlots({
      masterId,
      date,
      totalMinutes,
      settings: ctx.settings,
      excludeAppointmentId: rescheduleOf?.id ?? null,
    });

    return ctx.json(200, {
      master_id: masterId,
      date,
      timezone: ctx.settings.timezone,
      duration_min: totalMinutes,
      slots: slots.map((slot) => views.slot(slot, ctx.settings)),
    });
  });

  /**
   * GET /api/availability/days — в какие дни у мастера вообще есть окна.
   *
   * Нужен календарю на шаге B3: без него клиент листал бы месяц по одному
   * дню, чтобы выяснить, что мастер в отпуске. Окно ограничено 31 днём
   * за запрос — расчёт идёт по каждому дню отдельно.
   */
  router.get('/api/availability/days', async (ctx) => {
    const masterId = v.id(ctx.query.master_id, 'master_id');
    const from = v.date(ctx.query.from, 'from');
    const to = ctx.query.to ? v.date(ctx.query.to, 'to') : utcDate(addDays(`${from}T00:00:00Z`, 30));
    if (to < from) throw unprocessable('invalid_range', 'Конец периода раньше начала');
    if (minutesBetween(`${from}T00:00:00Z`, `${to}T00:00:00Z`) / (60 * 24) > 31) {
      throw unprocessable('range_too_long', 'За один запрос — не более 31 дня');
    }

    const rescheduleOf = ctx.query.reschedule_of
      ? findRescheduleTarget(v.id(ctx.query.reschedule_of, 'reschedule_of'), ctx)
      : null;
    const serviceIds = rescheduleOf ? [] : v.idList(ctx.query.service_ids, 'service_ids');
    const totalMinutes = resolveDuration(ctx, serviceIds, rescheduleOf);

    // Горизонт записи режет период здесь, а не внутри расчёта: запрос
    // на три месяца вперёд — обычное дело для календаря, это не ошибка клиента.
    const horizon = localDate(
      addDays(ctx.now, ctx.settings.booking_horizon_days),
      ctx.settings.utc_offset_minutes,
    );

    const days = findFreeDays({
      masterId,
      from,
      to: to > horizon ? horizon : to,
      totalMinutes,
      settings: ctx.settings,
    });

    return ctx.json(200, { master_id: masterId, from, to, duration_min: totalMinutes, days });
  });
}
