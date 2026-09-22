/**
 * Админ-панель: настройки студии — экран A11.
 *
 * Три вещи, которые вместе отвечают на вопрос «как работает студия»:
 * правила записи (таблица settings), постоянные часы работы
 * (studio_hours) и разовые нерабочие дни (studio_closures).
 *
 * Все три участвуют в расчёте свободного времени с первого дня, но
 * задать их до сих пор было нечем: правила и часы приезжали из наполнения
 * тестовыми данными, а нерабочих дней не было вовсе. Чтобы поменять
 * длительность резерва, приходилось лезть в базу руками.
 */
import * as v from '../lib/validate.js';
import * as views from './views.js';
import { loadForAdmin, updateSettings } from '../services/settings.js';
import {
  loadStudioHours,
  replaceStudioHours,
  listClosures,
  createClosure,
  deleteClosure,
} from '../services/studio.js';
import { unprocessable } from '../lib/http-error.js';

/**
 * День недели из тела запроса.
 *
 * Закрытый день не требует времени и не хранит его: ограничение схемы
 * разрешает пустые open_time/close_time только при is_closed = 1.
 */
function parseDay(item, index) {
  const day = v.object(item, `days[${index}]`);
  const weekday = v.weekday(day.weekday, `days[${index}].weekday`);
  const isClosed = day.is_closed === undefined ? false : v.boolean(day.is_closed, `days[${index}].is_closed`);
  if (isClosed) return { weekday, is_closed: true, open_time: null, close_time: null };

  const open = v.timeOfDay(day.open_time, `days[${index}].open_time`);
  const close = v.timeOfDay(day.close_time, `days[${index}].close_time`);
  if (close <= open) {
    throw unprocessable('invalid_interval', 'Закрытие должно быть позже открытия', {
      weekday, open_time: open, close_time: close,
    });
  }
  return { weekday, is_closed: false, open_time: open, close_time: close };
}

export function registerStudioRoutes(router) {
  /**
   * GET /api/admin/settings — правила студии с пояснениями.
   *
   * Отдаёт не голые строки из базы, а описание каждой настройки: тип,
   * границы, значение по умолчанию и группу для раскладки на экране.
   * Иначе админ-панель — это поле ввода, в которое можно написать
   * «полчаса» вместо 30 и обвалить календарь.
   */
  router.get('/api/admin/settings', async (ctx) => {
    ctx.requireRole('admin');
    return ctx.json(200, { settings: loadForAdmin() });
  });

  /**
   * PATCH /api/admin/settings — изменить правила.
   *
   * Тело: `{ "settings": { "hold_minutes": 15, ... } }`. Принимается сразу
   * набор — экран настроек это форма, он присылает то, что поправили.
   * Всё уходит одной транзакцией: половина применённых правил хуже,
   * чем ни одного.
   *
   * Правка действует со следующего же запроса: настройки читаются на
   * каждый запрос, без кеша в памяти процесса.
   *
   * Часовой пояс и смещение меняются только вместе — это два описания
   * одного и того же, и поменять одно значит получить студию, которая
   * на экране в Москве, а считает по Калининграду.
   */
  router.patch('/api/admin/settings', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const body = v.object(await ctx.body());
    const patch = v.object(body.settings, 'settings');

    const changed = updateSettings({ admin, patch });
    return ctx.json(200, { updated: changed, settings: loadForAdmin() });
  });

  /** GET /api/admin/studio-hours — часы работы студии по дням недели. */
  router.get('/api/admin/studio-hours', async (ctx) => {
    ctx.requireRole('admin');
    return ctx.json(200, { studio_hours: loadStudioHours().map(views.studioDay) });
  });

  /**
   * PUT /api/admin/studio-hours — задать часы работы.
   *
   * Все семь дней сразу, по одному разу каждый. Отсутствующая строка
   * означает не «круглосуточно», а «расчёт не найдёт рабочих интервалов»:
   * день молча выпадет из календаря, и никто не поймёт, почему у мастера
   * по средам нет записей.
   *
   * Закрытый день задаётся как `{ "weekday": 7, "is_closed": true }` —
   * время для него не нужно и не хранится.
   *
   * Визиты, оказавшиеся вне новых часов, возвращаются
   * в `stranded_appointments`; сервис их не отменяет.
   */
  router.put('/api/admin/studio-hours', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const body = v.object(await ctx.body());
    if (!Array.isArray(body.days)) throw v.object(undefined, 'days');
    const days = body.days.map(parseDay);

    const result = replaceStudioHours({ admin, days, settings: ctx.settings });
    return ctx.json(200, {
      studio_hours: loadStudioHours().map(views.studioDay),
      stranded_appointments: result.stranded.map((row) => views.strandedAppointment(row, ctx.settings)),
    });
  });

  /**
   * GET /api/admin/studio-closures — разовые нерабочие дни.
   *
   * По умолчанию только те, что ещё не прошли: прошлогодние праздники
   * на экране настроек не нужны. `?from=` показывает и прошлые.
   */
  router.get('/api/admin/studio-closures', async (ctx) => {
    ctx.requireRole('admin');
    const from = ctx.query.from
      ? v.date(ctx.query.from, 'from')
      : new Date(Date.now() + ctx.settings.utc_offset_minutes * 60_000).toISOString().slice(0, 10);
    return ctx.json(200, { closures: listClosures({ from }).map(views.studioClosure) });
  });

  /**
   * POST /api/admin/studio-closures — закрыть студию на день или период.
   *
   * Тело: `date_from`, необязательный `date_to` (по умолчанию тот же день)
   * и `reason`. Даты местные — праздник это календарь, а не минуты.
   *
   * Отдельной таблицей, а не отпуском каждому мастеру (решение 7.18):
   * иначе при найме нового мастера пришлось бы вручную повторять ему
   * все прошлые праздники.
   *
   * Уже назначенные на эти дни визиты возвращаются
   * в `affected_appointments` — их администратор разносит сам.
   */
  router.post('/api/admin/studio-closures', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const body = v.object(await ctx.body());
    const dateFrom = v.date(body.date_from, 'date_from');
    const dateTo = body.date_to === undefined ? dateFrom : v.date(body.date_to, 'date_to');
    const reason = v.string(body.reason, 'reason', { min: 2, max: 200 });

    const result = createClosure({ admin, dateFrom, dateTo, reason, settings: ctx.settings });
    return ctx.json(201, {
      closure: views.studioClosure({ id: result.id, date_from: dateFrom, date_to: dateTo, reason }),
      affected_appointments: result.affected.map((row) => views.strandedAppointment(row, ctx.settings)),
    });
  });

  /**
   * DELETE /api/admin/studio-closures/:id — снять закрытие.
   *
   * Время возвращается в свободные само: при следующем расчёте
   * этой даты просто не окажется среди закрытых.
   */
  router.delete('/api/admin/studio-closures/:id', async (ctx) => {
    const admin = ctx.requireRole('admin');
    const row = deleteClosure({ admin, closureId: v.id(ctx.params.id, 'id') });
    return ctx.json(200, { ok: true, removed: row.id });
  });
}
