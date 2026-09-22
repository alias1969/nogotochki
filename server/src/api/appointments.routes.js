/**
 * Записи клиента: создание, список, детали, перенос, отмена.
 *
 * Все эти эндпоинты требуют входа, и все отбирают записи по идентификатору
 * пользователя из сессии. Параметр вида ?client_id= здесь не принимается
 * намеренно: если выборка идёт по параметру запроса, рано или поздно кто-то
 * подставит чужой номер.
 */
import * as v from '../lib/validate.js';
import * as views from '../api/views.js';
import {
  createAppointment,
  listForClient,
  findAccessible,
  loadAppointmentServices,
  clientAbilities,
  reschedule,
  cancel,
  setStatus,
  OUTCOME_STATUSES,
} from '../services/appointments.js';
import { findOwnedHold } from '../services/holds.js';
import { strongest } from '../lib/roles.js';
import { forbidden } from '../lib/http-error.js';

/**
 * Запись, которую этот пользователь имеет право переносить.
 *
 * Вынесена сюда, потому что нужна трём эндпоинтам: расчёту свободного
 * времени под перенос, постановке резерва для переноса и самому переносу.
 */
export function findRescheduleTarget(appointmentId, ctx) {
  if (!ctx.user) throw forbidden('Перенос доступен только после входа');
  // Кто и на каких условиях вправе переносить, решает таблица прав внутри
  // сервиса. Здесь проверяется только доступ к самой записи: клиент видит
  // свои, мастер — записи своего дня, администратор — все.
  return findAccessible(appointmentId, ctx.user);
}

/**
 * Ответ с записью.
 *
 * Поля can_cancel и can_reschedule — это правила клиента: срок отмены
 * и лимит переносов. Мастеру и администратору они не годятся, у них
 * другие основания и другие ограничения, поэтому им эти поля не уходят
 * вовсе. Показать чужие правила хуже, чем не показать никаких:
 * по ним нарисовали бы кнопки, которые сервер потом не пропустит.
 *
 * Ролей у человека может быть несколько, поэтому оба вопроса решаются
 * по сильнейшей из них — той самой, в которой он и будет действовать
 * (см. pickPolicy в lib/roles.js). Мастер, записавшийся к коллеге,
 * видит свой визит глазами мастера и правил клиента не получает:
 * переносить его он будет по правилам мастера, без срока и без лимита.
 */
function present(row, ctx) {
  const role = strongest(ctx.user);
  const actsAsClient = role === 'user' && row.client_id === ctx.user.id;
  return views.appointment(row, loadAppointmentServices(row.id), ctx.settings, {
    // Роль смотрящего и решает, что он увидит: клиент — свой визит,
    // мастер — плюс контакты клиента, администратор — плюс служебное.
    audience: role === 'user' ? 'client' : role,
    abilities: actsAsClient ? clientAbilities(row, ctx.settings, ctx.now) : null,
  });
}

export function registerAppointmentRoutes(router) {
  /**
   * POST /api/appointments — подтвердить запись по резерву.
   *
   * Тело: hold_id и необязательный комментарий. Ни мастера, ни времени,
   * ни услуг в теле нет — всё это уже лежит в резерве, и брать их из запроса
   * значило бы разрешить подтвердить одно, а записаться на другое.
   *
   * Признак наложения allow_overlap здесь не читается. Не «читается
   * и отбрасывается при неподходящей роли», а не читается вообще: из тела
   * берутся ровно два поля, остальное на вставку не влияет.
   *
   * Роль проверяет не этот обработчик, а сама createAppointment — та же
   * функция, что обслуживает администратора. Здесь требуется только вход:
   * кому что положено, решает таблица прав внутри функции, в одном месте
   * для всех трёх ролей. Мастер, постучавшийся сюда, получит 403 оттуда же,
   * откуда его получил бы на любом другом пути создания записи.
   */
  router.post('/api/appointments', async (ctx) => {
    const actor = ctx.requireUser();
    const body = v.object(await ctx.body());

    return ctx.json(201, {
      appointment: present(
        findAccessible(
          createAppointment({
            actor,
            input: {
              holdId: v.id(body.hold_id, 'hold_id'),
              clientNote: v.optionalString(body.client_note, 'client_note', { max: 500 }),
              owner: ctx.owner,
            },
            settings: ctx.settings,
          }),
          actor,
        ),
        ctx,
      ),
    });
  });

  /**
   * GET /api/appointments — свои записи.
   *
   * scope: upcoming — предстоящие, past — история, all — всё.
   * Отменённые записи остаются в истории: они меняют статус, а не исчезают.
   */
  router.get('/api/appointments', async (ctx) => {
    const client = ctx.requireRole('user');
    const scope = ctx.query.scope
      ? v.oneOf(ctx.query.scope, 'scope', ['upcoming', 'past', 'all'])
      : 'all';
    const rows = listForClient(client.id, { scope });
    return ctx.json(200, { appointments: rows.map((row) => present(row, ctx)) });
  });

  /** GET /api/appointments/:id — детали записи. Чужая запись отвечает 404, а не 403. */
  router.get('/api/appointments/:id', async (ctx) => {
    const user = ctx.requireUser();
    const row = findAccessible(v.id(ctx.params.id, 'id'), user);
    return ctx.json(200, { appointment: present(row, ctx) });
  });

  /**
   * POST /api/appointments/:id/reschedule — перенос на время из резерва.
   *
   * Меняется время той же записи, новая не создаётся: иначе история клиента
   * распалась бы на цепочку записей-призраков. Старое время остаётся
   * за клиентом, пока перенос не подтверждён.
   *
   * Один эндпоинт и одна функция на все три роли. Клиент укладывается
   * в срок и расходует один перенос из трёх; мастер и администратор
   * в срок не обязаны, счётчик не тратят, но должны указать причину —
   * клиент увидит её в кабинете.
   */
  router.post('/api/appointments/:id/reschedule', async (ctx) => {
    const user = ctx.requireUser();
    const body = v.object(await ctx.body());
    const appointment = findRescheduleTarget(v.id(ctx.params.id, 'id'), ctx);
    const hold = findOwnedHold(v.id(body.hold_id, 'hold_id'), ctx.owner);
    const reason = v.optionalString(body.reason, 'reason', { max: 300 });

    reschedule({ appointment, hold, actor: user, reason, settings: ctx.settings });
    const row = findAccessible(appointment.id, user);
    return ctx.json(200, { appointment: present(row, ctx) });
  });

  /**
   * POST /api/appointments/:id/status — отметить исход визита.
   *
   * Тело: `status` — `completed` или `no_show`, необязательная `note`
   * для журнала. Доступно мастеру (по своим записям) и администратору;
   * клиенту — нет: исход визита это свидетельство студии, а не мнение
   * клиента о собственном визите.
   *
   * Отметить можно не раньше начала визита — будущий визит не может
   * ни состояться, ни не состояться. Правило действует и на
   * администратора: «изменить статус задним числом» из паспорта — это
   * про прошедшие визиты.
   *
   * Ошибку кнопки исправить можно: «Не пришёл» меняется на «Завершена»
   * и обратно. Отменённую запись этим путём не воскресить — 409.
   */
  router.post('/api/appointments/:id/status', async (ctx) => {
    const user = ctx.requireUser();
    const body = v.object(await ctx.body());
    const status = v.oneOf(body.status, 'status', OUTCOME_STATUSES);
    const note = v.optionalString(body.note, 'note', { max: 300 });

    const appointment = findAccessible(v.id(ctx.params.id, 'id'), user);
    setStatus({ appointment, actor: user, status, note });

    const row = findAccessible(appointment.id, user);
    return ctx.json(200, { appointment: present(row, ctx) });
  });

  /**
   * POST /api/appointments/:id/cancel — отмена.
   *
   * Клиент отменяет не позднее чем за cancel_deadline_hours; мастер
   * и администратор — в любой момент, но обязаны указать причину: её увидит
   * клиент в кабинете. Время освобождается само: отменённой записи
   * в следующем расчёте свободного времени просто не окажется.
   */
  router.post('/api/appointments/:id/cancel', async (ctx) => {
    const user = ctx.requireUser();
    const body = v.object(await ctx.body());
    const reason = v.optionalString(body.reason, 'reason', { max: 300 });
    const appointment = findAccessible(v.id(ctx.params.id, 'id'), user);

    cancel({ appointment, actor: user, reason, settings: ctx.settings });
    const row = findAccessible(appointment.id, user);
    return ctx.json(200, { appointment: present(row, ctx) });
  });
}
