/**
 * Кабинет мастера — чтение.
 *
 * До этого модуля у мастера был вход и три права: отменять, переносить
 * и отмечать исход своих записей. Посмотреть, что у него за день,
 * он не мог — список записей отдавался только роли `user`, а собственный
 * график видел один администратор.
 *
 * Границы кабинета заданы паспортом дословно: «Записи и контакты клиентов
 * других мастеров ему недоступны». Поэтому ни один эндпоинт здесь
 * не принимает master_id: мастер, из-под которого пришёл запрос,
 * определяется по сессии. Подставить чужой номер физически нечем.
 */
import * as v from '../lib/validate.js';
import * as views from './views.js';
import { findMasterByUser, listServices } from '../services/catalog.js';
import { listAll, loadAppointmentServices } from '../services/appointments.js';
import { loadSchedule, createException, deleteException, allowedExceptionKinds } from '../services/schedules.js';
import { createRequest, listForMaster } from '../services/schedule-requests.js';
import { masterWorkload, currentMonth } from '../services/workload.js';
import { localDayBounds, addDays, utcDate, weekdayOf, localDate } from '../lib/time.js';
import { forbidden, unprocessable } from '../lib/http-error.js';

const STATUSES = ['booked', 'completed', 'no_show', 'cancelled'];

/**
 * Мастер, от лица которого идёт запрос.
 *
 * Роли `master` мало: нужна ещё привязанная карточка. Аккаунт без карточки
 * — не поломка, а нормальное промежуточное состояние, и объяснить его
 * человеку лучше внятным текстом, чем пустым кабинетом.
 */
function currentMaster(ctx) {
  const user = ctx.requireRole('master');
  const master = findMasterByUser(user.id);
  if (!master) {
    throw forbidden('К вашему аккаунту не привязана карточка мастера — обратитесь к администратору');
  }
  return master;
}

export function registerMasterRoutes(router) {
  /**
   * GET /api/master/me — кто я как мастер.
   *
   * Карточка и услуги, которые за мастером закреплены. Нужен кабинету
   * на старте: из `/api/auth/me` видно только аккаунт, а номер карточки
   * и набор услуг — уже здесь.
   */
  router.get('/api/master/me', async (ctx) => {
    const master = currentMaster(ctx);
    return ctx.json(200, {
      master: views.master({ ...master, service_ids: [] }),
      services: listServices({ masterId: master.id }).map((row) => views.service(row)),
      studio: views.studio(ctx.settings),
    });
  });

  /**
   * GET /api/master/appointments — свои записи.
   *
   * Фильтры: `date` (один день по календарю студии) либо `from`/`to`,
   * а также `status`, `scope=upcoming|past|all` и `limit`.
   *
   * В каждой записи видно имя и телефон клиента — по паспорту это ровно
   * то, что мастеру положено: понять, кто придёт, и позвонить, если
   * человек опаздывает. E-mail не отдаётся: он остаётся администратору,
   * который ведёт клиентскую базу.
   */
  router.get('/api/master/appointments', async (ctx) => {
    const master = currentMaster(ctx);
    const query = ctx.query;
    const offset = ctx.settings.utc_offset_minutes;

    let dateFrom = null;
    let dateTo = null;
    if (query.date) {
      const bounds = localDayBounds(v.date(query.date, 'date'), offset);
      dateFrom = bounds.from;
      dateTo = bounds.to;
    } else if (query.from || query.to) {
      const from = query.from ? v.date(query.from, 'from') : null;
      const to = query.to ? v.date(query.to, 'to') : null;
      if (from && to && to < from) throw unprocessable('invalid_range', 'Конец периода раньше начала');
      if (from) dateFrom = localDayBounds(from, offset).from;
      // Правая граница — начало следующих суток: иначе визит,
      // начавшийся в 19:50 последнего дня, выпал бы из выборки.
      if (to) dateTo = localDayBounds(utcDate(addDays(`${to}T00:00:00Z`, 1)), offset).from;
    }

    const scope = query.scope ? v.oneOf(query.scope, 'scope', ['upcoming', 'past', 'all']) : 'all';
    if (scope === 'upcoming' && !dateFrom) dateFrom = ctx.now;
    if (scope === 'past' && !dateTo) dateTo = ctx.now;

    const rows = listAll({
      dateFrom,
      dateTo,
      status: query.status ? v.oneOf(query.status, 'status', STATUSES) : null,
      masterId: master.id,
      limit: query.limit ? v.integer(query.limit, 'limit', { min: 1, max: 500 }) : 200,
    });

    return ctx.json(200, {
      master_id: master.id,
      appointments: rows.map((row) =>
        views.appointment(row, loadAppointmentServices(row.id), ctx.settings, { audience: 'master' }),
      ),
    });
  });

  /**
   * GET /api/master/schedule — свой график.
   *
   * Тот же график, что администратор задаёт на экране A7, только глазами
   * мастера: недельные версии и отклонения в периоде. Менять его отсюда
   * нельзя — по паспорту мастер изменение графика предлагает,
   * а утверждает администратор.
   */
  router.get('/api/master/schedule', async (ctx) => {
    const master = currentMaster(ctx);
    const from = ctx.query.from ? v.date(ctx.query.from, 'from') : null;
    const to = ctx.query.to ? v.date(ctx.query.to, 'to') : null;
    if (from && to && to < from) throw unprocessable('invalid_range', 'Конец периода раньше начала');

    const schedule = loadSchedule(master.id, { from, to, settings: ctx.settings });
    return ctx.json(200, {
      master_id: master.id,
      timezone: ctx.settings.timezone,
      range: schedule.range,
      current: schedule.current.map(views.scheduleRow),
      history: schedule.weekly.map(views.scheduleRow),
      exceptions: schedule.exceptions.map((row) => views.scheduleException(row, ctx.settings)),
    });
  });

  /**
   * GET /api/master/day — мой день, экран M2.
   *
   * Три вещи разом: рабочие интервалы этого дня недели, отклонения,
   * попавшие на дату, и записи. Одним запросом, потому что экран дня
   * без любой из трёх частей неполон: записи без графика не показывают,
   * когда мастер свободен, а график без отклонений соврёт в день отпуска.
   *
   * Рабочие интервалы отдаются как есть, местным временем суток — ровно
   * так, как их задавал администратор. Пересечение с часами студии
   * и нарезку на слоты здесь не делают: это нужно расчёту свободного
   * времени, а не экрану «что у меня сегодня».
   */
  router.get('/api/master/day', async (ctx) => {
    const master = currentMaster(ctx);
    const offset = ctx.settings.utc_offset_minutes;
    const date = ctx.query.date ? v.date(ctx.query.date, 'date') : localDate(ctx.now, offset);
    const bounds = localDayBounds(date, offset);

    const schedule = loadSchedule(master.id, { from: date, to: date, settings: ctx.settings });
    const weekday = weekdayOf(date);
    const working = schedule.weekly.filter(
      (row) =>
        row.weekday === weekday &&
        row.valid_from <= date &&
        (row.valid_to === null || row.valid_to >= date),
    );

    const rows = listAll({
      dateFrom: bounds.from,
      dateTo: bounds.to,
      masterId: master.id,
      limit: 200,
    });

    return ctx.json(200, {
      master_id: master.id,
      date,
      weekday,
      timezone: ctx.settings.timezone,
      working_hours: working.map(views.scheduleRow),
      exceptions: schedule.exceptions
        .filter((row) => row.starts_at < bounds.to && row.ends_at > bounds.from)
        .map((row) => views.scheduleException(row, ctx.settings)),
      appointments: rows.map((row) =>
        views.appointment(row, loadAppointmentServices(row.id), ctx.settings, { audience: 'master' }),
      ),
    });
  });

  /**
   * POST /api/master/schedule-exceptions — закрыть своё время.
   *
   * Тело: `starts_at`, `ends_at` (моменты UTC) и необязательная `reason`.
   * Вид всегда `time_block` — «занят, не записывайте»: отпуск и выходной
   * мастер не назначает сам, он их предлагает заявкой, а утверждает
   * администратор. Разница не формальная — отпуск сдвигает работу студии,
   * а закрытый час нет.
   *
   * Уже назначенные визиты, попавшие в закрытый интервал, возвращаются
   * в `affected_appointments`. Сервис их не отменяет: решает мастер.
   */
  router.post('/api/master/schedule-exceptions', async (ctx) => {
    const master = currentMaster(ctx);
    const body = v.object(await ctx.body());
    const kind = body.kind === undefined
      ? 'time_block'
      : v.oneOf(body.kind, 'kind', allowedExceptionKinds('master'));

    const result = createException({
      actor: ctx.user,
      masterId: master.id,
      kind,
      startsAt: v.instant(body.starts_at, 'starts_at'),
      endsAt: v.instant(body.ends_at, 'ends_at'),
      reason: v.optionalString(body.reason, 'reason', { max: 300 }),
    });

    return ctx.json(201, {
      exception: views.scheduleException(
        { id: result.id, kind, starts_at: body.starts_at, ends_at: body.ends_at, reason: body.reason ?? null },
        ctx.settings,
      ),
      affected_appointments: result.affected.map((row) => views.strandedAppointment(row, ctx.settings)),
    });
  });

  /**
   * DELETE /api/master/schedule-exceptions/:id — снова открыть своё время.
   *
   * Только то, что мастер закрыл сам. Время, закрытое администратором,
   * он не трогает: раз студия закрыла этот час, отменять решение должна студия.
   */
  router.delete('/api/master/schedule-exceptions/:id', async (ctx) => {
    currentMaster(ctx);
    const row = deleteException({ actor: ctx.user, exceptionId: v.id(ctx.params.id, 'id') });
    return ctx.json(200, { ok: true, removed: row.id });
  });

  /**
   * POST /api/master/schedule-requests — предложить изменение графика.
   *
   * Тело: `message` и необязательные `desired_from` / `desired_to`.
   * Дат может не быть вовсе: «прошу поставить меня на субботы» — тоже заявка.
   *
   * Заявка сам график **не меняет**. Утверждение означает «согласен»,
   * а не «применено»: дальше администратор правит график обычным путём.
   * Из фразы «хочу по средам начинать позже» не следует автоматически
   * ни одна конкретная строка расписания, а угадывать её за человека
   * опасно — ошибка стоит потерянных визитов.
   */
  router.post('/api/master/schedule-requests', async (ctx) => {
    const master = currentMaster(ctx);
    const body = v.object(await ctx.body());
    const desiredFrom = body.desired_from === undefined ? null : v.date(body.desired_from, 'desired_from');
    const desiredTo = body.desired_to === undefined ? null : v.date(body.desired_to, 'desired_to');
    if (desiredFrom && desiredTo && desiredTo < desiredFrom) {
      throw unprocessable('invalid_range', 'Конец периода раньше начала');
    }

    const id = createRequest({
      master,
      actor: ctx.user,
      message: v.string(body.message, 'message', { min: 5, max: 1000 }),
      desiredFrom,
      desiredTo,
    });

    const row = listForMaster(master.id).find((item) => item.id === id);
    return ctx.json(201, { request: views.scheduleRequest(row, ctx.settings) });
  });

  /** GET /api/master/schedule-requests — свои заявки и ответы на них. */
  router.get('/api/master/schedule-requests', async (ctx) => {
    const master = currentMaster(ctx);
    const status = ctx.query.status
      ? v.oneOf(ctx.query.status, 'status', ['pending', 'approved', 'rejected'])
      : null;
    return ctx.json(200, {
      requests: listForMaster(master.id, { status }).map((row) => views.scheduleRequest(row, ctx.settings)),
    });
  });

  /**
   * GET /api/master/workload — своя загрузка и выручка.
   *
   * Период `from`/`to` местными датами студии; по умолчанию — текущий месяц.
   *
   * Выручкой считаются только завершённые визиты: `no_show` и `cancelled`
   * денег не принесли, а `booked` ещё не принёс — он идёт отдельной строкой
   * «ожидается». Цены берутся из снимков состава визита, а не из прайса,
   * иначе отчёт за прошлый месяц менялся бы при каждой правке цен.
   *
   * Загрузка считается от рабочих часов по графику, а не от суток:
   * «занято 6 часов» само по себе не говорит, полный это день или треть смены.
   */
  router.get('/api/master/workload', async (ctx) => {
    const master = currentMaster(ctx);
    const month = currentMonth(ctx.settings, ctx.now);
    const from = ctx.query.from ? v.date(ctx.query.from, 'from') : month.from;
    const to = ctx.query.to ? v.date(ctx.query.to, 'to') : month.to;

    return ctx.json(200, {
      master_id: master.id,
      timezone: ctx.settings.timezone,
      ...masterWorkload({ masterId: master.id, from, to, settings: ctx.settings }),
    });
  });
}
