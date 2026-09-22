/**
 * Админ-панель: графики мастеров.
 *
 * Четыре эндпоинта закрывают функцию паспорта «управление графиками
 * мастеров» — ту, без которой сервис нельзя было запустить в живой студии:
 * расчёт свободного времени целиком опирается на master_schedules,
 * а заводились они только командой наполнения тестовыми данными.
 *
 * Пересобирать слоты после правки графика не нужно и нечего: свободное
 * время не хранится, а вычисляется при каждом запросе. Изменили график —
 * следующий же расчёт увидит новые данные.
 */
import * as v from '../lib/validate.js';
import * as views from './views.js';
import {
  loadSchedule,
  replaceWeeklySchedule,
  createException,
  deleteException,
} from '../services/schedules.js';
import { localDayBounds, addDays, utcDate } from '../lib/time.js';
import { listAll as listRequests, findRequest, reviewRequest } from '../services/schedule-requests.js';
import { unprocessable } from '../lib/http-error.js';

const KINDS = ['vacation', 'day_off', 'time_block', 'extra_shift'];

/** Кому интервал задают целыми днями, а кому — с точностью до минуты. */
const WHOLE_DAY_KINDS = new Set(['vacation', 'day_off']);

/**
 * Недельный набор из тела запроса.
 *
 * Формат — список интервалов, а не семь полей «начало/конец»: у мастера
 * бывает перерыв на обед, и тогда день описывается двумя интервалами
 * (10:00–14:00 и 15:00–20:00). Одним полем такое не выразить.
 */
function parseDays(body) {
  const raw = body.days;
  if (!Array.isArray(raw)) throw v.object(undefined, 'days');
  if (raw.length > 7 * 6) throw unprocessable('too_many_intervals', 'Слишком много интервалов');

  return raw.map((item, index) => {
    const day = v.object(item, `days[${index}]`);
    const start = v.timeOfDay(day.work_start, `days[${index}].work_start`);
    const end = v.timeOfDay(day.work_end, `days[${index}].work_end`);
    if (end <= start) {
      throw unprocessable('invalid_interval', 'Конец рабочего интервала должен быть позже начала', {
        index,
        work_start: start,
        work_end: end,
      });
    }
    return { weekday: v.weekday(day.weekday, `days[${index}].weekday`), work_start: start, work_end: end };
  });
}

/**
 * Интервал отклонения → моменты UTC.
 *
 * Отпуск и выходной задаются местными датами студии: «с 1 по 10 июля» —
 * это календарь, а не минуты, и требовать от администратора вводить
 * 2026-06-30T21:00:00Z было бы издевательством. Закрытое время
 * и дополнительная смена, наоборот, задаются моментами: там важны
 * именно часы и минуты.
 *
 * В базу в обоих случаях ложится UTC — правило сервиса не нарушается,
 * перевод происходит здесь, на границе.
 */
function parseInterval(body, kind, settings) {
  if (WHOLE_DAY_KINDS.has(kind)) {
    const from = v.date(body.date_from, 'date_from');
    const to = body.date_to === undefined ? from : v.date(body.date_to, 'date_to');
    if (to < from) throw unprocessable('invalid_range', 'Конец периода раньше начала');
    return {
      startsAt: localDayBounds(from, settings.utc_offset_minutes).from,
      // Правая граница — начало следующих суток: интервал полуоткрытый,
      // иначе последний день отпуска оказался бы рабочим.
      endsAt: localDayBounds(utcDate(addDays(`${to}T00:00:00Z`, 1)), settings.utc_offset_minutes).from,
    };
  }
  return {
    startsAt: v.instant(body.starts_at, 'starts_at'),
    endsAt: v.instant(body.ends_at, 'ends_at'),
  };
}

export function registerScheduleRoutes(router) {
  /**
   * GET /api/admin/masters/:id/schedule — график мастера.
   *
   * Отдаёт три вещи: всю историю недельных версий, действующую на сегодня
   * версию отдельным полем и отклонения в выбранном периоде. История нужна,
   * чтобы понять задним числом, почему визит на прошлой неделе был возможен.
   */
  router.get('/api/admin/masters/:id/schedule', async (ctx) => {
    ctx.requireRole('admin');
    const masterId = v.id(ctx.params.id, 'id');
    const from = ctx.query.from ? v.date(ctx.query.from, 'from') : null;
    const to = ctx.query.to ? v.date(ctx.query.to, 'to') : null;
    if (from && to && to < from) throw unprocessable('invalid_range', 'Конец периода раньше начала');

    const schedule = loadSchedule(masterId, { from, to, settings: ctx.settings });
    return ctx.json(200, {
      master_id: masterId,
      timezone: ctx.settings.timezone,
      range: schedule.range,
      current: schedule.current.map(views.scheduleRow),
      history: schedule.weekly.map(views.scheduleRow),
      exceptions: schedule.exceptions.map((row) => views.scheduleException(row, ctx.settings)),
    });
  });

  /**
   * PUT /api/admin/masters/:id/schedule — задать недельный график.
   *
   * Тело: `valid_from` (местная дата, с которой действует) и `days` —
   * список интервалов вида `{weekday, work_start, work_end}`. Время суток
   * местное: график — это «работаю с 10:00 до 20:00» в человеческом
   * смысле, он не должен уезжать при переводе часов.
   *
   * Набор задаётся целиком: экран графика — сетка «пн … вс», он присылает
   * состояние, а не разницу. Пустой `days` означает «мастер пока не
   * работает» и это допустимое состояние.
   *
   * Прошлое не переписывается: действующие строки закрываются накануне
   * новой даты, новый график приходит следующей версией.
   *
   * Если сузить график так, что уже назначенные визиты окажутся вне
   * рабочих часов, сервис их не отменит — это решение администратора.
   * Но вернёт их списком в поле `stranded_appointments`.
   */
  router.put('/api/admin/masters/:id/schedule', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const masterId = v.id(ctx.params.id, 'id');
    const body = v.object(await ctx.body());
    const validFrom = v.date(body.valid_from, 'valid_from');
    const days = parseDays(body);

    const result = replaceWeeklySchedule({ admin, masterId, validFrom, days, settings: ctx.settings });
    const schedule = loadSchedule(masterId, { settings: ctx.settings });

    return ctx.json(200, {
      master_id: masterId,
      valid_from: validFrom,
      intervals: result.inserted,
      current: schedule.current.map(views.scheduleRow),
      stranded_appointments: result.stranded.map((row) => views.strandedAppointment(row, ctx.settings)),
    });
  });

  /**
   * POST /api/admin/masters/:id/schedule-exceptions — отклонение от графика.
   *
   * Тело: `kind` — vacation, day_off, time_block или extra_shift,
   * `reason` и интервал. Отпуск и выходной задаются местными датами
   * (`date_from`, `date_to`), закрытое время и дополнительная смена —
   * моментами UTC (`starts_at`, `ends_at`).
   *
   * Дополнительная смена — единственный вид, который время **добавляет**:
   * ею мастера выводят на работу в день, которого нет в недельном графике.
   * Остальные три время вычитают.
   *
   * Визиты, попавшие под отпуск или закрытое время, возвращаются
   * в `affected_appointments` — сервис их не отменяет.
   */
  router.post('/api/admin/masters/:id/schedule-exceptions', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const masterId = v.id(ctx.params.id, 'id');
    const body = v.object(await ctx.body());
    const kind = v.oneOf(body.kind, 'kind', KINDS);
    const { startsAt, endsAt } = parseInterval(body, kind, ctx.settings);
    const reason = v.optionalString(body.reason, 'reason', { max: 300 });

    const result = createException({ actor: admin, masterId, kind, startsAt, endsAt, reason });

    return ctx.json(201, {
      exception: views.scheduleException(
        { id: result.id, kind, starts_at: startsAt, ends_at: endsAt, reason },
        ctx.settings,
      ),
      affected_appointments: result.affected.map((row) => views.strandedAppointment(row, ctx.settings)),
    });
  });

  /**
   * DELETE /api/admin/schedule-exceptions/:id — снять отклонение.
   *
   * Отпуск отменили — время возвращается в свободные само, при следующем
   * расчёте его просто не окажется среди вычитаемых.
   */
  router.delete('/api/admin/schedule-exceptions/:id', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const exceptionId = v.id(ctx.params.id, 'id');
    const row = deleteException({ actor: admin, exceptionId });
    return ctx.json(200, { ok: true, removed: exceptionId, master_id: row.master_id });
  });

  /**
   * GET /api/admin/schedule-requests — заявки мастеров на изменение графика.
   *
   * Сверху те, что ждут ответа: экран A7 открывают ради них.
   * Фильтры: `status` и `master_id`.
   */
  router.get('/api/admin/schedule-requests', async (ctx) => {
    ctx.requireRole('admin');
    const status = ctx.query.status
      ? v.oneOf(ctx.query.status, 'status', ['pending', 'approved', 'rejected'])
      : null;
    const masterId = ctx.query.master_id ? v.id(ctx.query.master_id, 'master_id') : null;

    return ctx.json(200, {
      requests: listRequests({ status, masterId })
        .map((row) => views.scheduleRequest(row, ctx.settings, { audience: 'admin' })),
    });
  });

  /**
   * POST /api/admin/schedule-requests/:id/review — ответить на заявку.
   *
   * Тело: `decision` — `approved` или `rejected`, и `comment`.
   *
   * Утверждение означает «согласен», а не «применено»: график после этого
   * нужно поправить отдельно, через PUT .../schedule. Так и задумано схемой
   * (раздел 4.8) — из текста заявки не следует автоматически ни одна
   * конкретная строка расписания.
   *
   * Рассмотреть повторно нельзя: передумали — это новая заявка. Иначе
   * в кабинете мастера «утверждено» однажды превратилось бы в «отклонено»
   * без следа о том, что там было раньше.
   */
  router.post('/api/admin/schedule-requests/:id/review', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const body = v.object(await ctx.body());
    const decision = v.oneOf(body.decision, 'decision', ['approved', 'rejected']);
    const comment = v.optionalString(body.comment, 'comment', { max: 1000 });

    const request = findRequest(v.id(ctx.params.id, 'id'));
    reviewRequest({ request, admin, decision, comment });

    return ctx.json(200, {
      request: views.scheduleRequest(findRequest(request.id), ctx.settings, { audience: 'admin' }),
    });
  });
}
