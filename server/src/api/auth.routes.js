/**
 * Регистрация, вход, выход и «кто я».
 *
 * Токен сессии уходит и в HttpOnly-cookie, и в теле ответа: cookie нужна
 * браузеру, поле token — мобильному клиенту и curl на отладке. В базе
 * ни того, ни другого нет — только хеш.
 *
 * Токен живёт ограниченное время. Срок возвращается вместе с ним —
 * expires_in в секундах и expires_at временем студии, — чтобы клиент
 * не выяснял его первым отказом на середине записи.
 */
import * as v from '../lib/validate.js';
import * as views from '../api/views.js';
import { register, login, logout } from '../services/auth.js';
import { requestReset, checkResetToken, resetPassword, changePassword } from '../services/passwords.js';
import { buildResetLink, deliverResetLink, mayExposeLink } from '../services/delivery.js';
import { attachHoldsToUser } from '../services/holds.js';
import { SESSION_COOKIE, GUEST_COOKIE, serializeCookie, clearCookie } from '../http/cookies.js';
import { env } from '../config/env.js';
import { createLimiter, clientAddress } from '../lib/rate-limit.js';

/**
 * Ограничение частоты входа.
 *
 * Два ключа на одну попытку, и они ловят разные атаки:
 *   адрес  — перебор паролей к разным аккаунтам с одной машины;
 *   e-mail — перебор одного аккаунта с разных машин.
 *
 * Считаются только **неудачные** попытки: успешный вход обнуляет счётчик
 * по e-mail. Иначе администратор, который за утро заходит с трёх
 * устройств, блокировал бы сам себя, и защиту первым делом отключили бы.
 */
const loginLimit = createLimiter({
  name: 'login',
  max: env.loginMaxAttempts,
  windowMs: env.loginWindowMinutes * 60_000,
});

/**
 * Ограничение частоты регистрации — по адресу.
 *
 * Здесь считаются все попытки, а не только неудачные: массовое заведение
 * аккаунтов и есть то, что нужно остановить, и каждая такая попытка
 * «успешна».
 */
const registerLimit = createLimiter({
  name: 'register',
  max: env.registerMaxAttempts,
  windowMs: env.registerWindowMinutes * 60_000,
});

const addressOf = (ctx) => clientAddress(ctx.req, { trustProxy: env.trustProxy });

function sessionCookie(session) {
  return serializeCookie(SESSION_COOKIE, session.token, {
    maxAge: session.expiresInSeconds,
    secure: env.isProduction,
  });
}

/** Выданный токен и его срок — одинаково после регистрации и после входа. */
function sessionView(session, settings) {
  return {
    token: session.token,
    expires_in: session.expiresInSeconds,
    expires_at: views.moment(session.expiresAt, settings),
  };
}

export function registerAuthRoutes(router) {
  /**
   * POST /api/auth/register — регистрация клиента.
   *
   * Роль не принимается из тела: она всегда 'user'. Резерв, взятый
   * гостем до регистрации, переносится на новый аккаунт — выбор времени
   * на шаге B3 не должен теряться из-за шага B4.
   */
  router.post('/api/auth/register', async (ctx) => {
    ctx.allowPublic('регистрация — до неё человек по определению не вошёл');

    // Проверка до разбора тела: исчерпавшему лимит незачем добираться
    // ни до базы, ни до хеширования пароля — scrypt намеренно медленный,
    // и считать его для перебора значит помогать перебору.
    //
    // Счётчик у регистрации свой. Со счётчиком входа он намеренно
    // не связан: человек, трижды забывший пароль, не должен лишаться
    // возможности завести аккаунт заново.
    const address = addressOf(ctx);
    registerLimit.check(address);
    registerLimit.hit(address);

    const body = v.object(await ctx.body());
    const data = {
      email: v.email(body.email),
      password: v.password(body.password),
      fullName: v.string(body.full_name, 'full_name', { min: 2, max: 120 }),
      phone: v.phone(body.phone),
      userAgent: ctx.req.headers['user-agent'],
    };

    const { user, session } = register(data);
    attachHoldsToUser(ctx.guestTokenHash, user.id);

    return ctx.json(201, { user: views.user(user), ...sessionView(session, ctx.settings) }, {
      'Set-Cookie': sessionCookie(session),
    });
  });

  /** POST /api/auth/login — вход. Ответ не различает неверный e-mail и неверный пароль. */
  router.post('/api/auth/login', async (ctx) => {
    ctx.allowPublic('вход');

    const address = addressOf(ctx);
    loginLimit.check(address);

    const body = v.object(await ctx.body());
    const email = v.email(body.email);
    const password = v.password(body.password);

    // Ключ по e-mail — после проверки формы: считать попытки по строке,
    // которая даже не похожа на адрес, незачем.
    const emailKey = `email:${email}`;
    loginLimit.check(emailKey);

    let result;
    try {
      result = login({ email, password, userAgent: ctx.req.headers['user-agent'] });
    } catch (error) {
      // Неудача — и только она — идёт в счётчик.
      loginLimit.hit(address);
      loginLimit.hit(emailKey);
      throw error;
    }

    // Успех снимает подозрение с этого аккаунта; счётчик по адресу
    // остаётся — с одной машины могли перебирать чужие аккаунты, а потом
    // честно зайти в свой.
    loginLimit.forget(emailKey);

    const { user, session } = result;
    attachHoldsToUser(ctx.guestTokenHash, user.id);

    return ctx.json(200, { user: views.user(user), ...sessionView(session, ctx.settings) }, {
      'Set-Cookie': sessionCookie(session),
    });
  });

  /**
   * POST /api/auth/logout — выход.
   *
   * Сессия в базе помечается revoked_at, cookie стирается. Одной только
   * стёртой cookie мало: украденный токен продолжал бы работать.
   */
  router.post('/api/auth/logout', async (ctx) => {
    // Без входа не ошибка: выход из несуществующей сессии — не беда,
    // а нормальный ответ на повторное нажатие кнопки.
    ctx.allowPublic('выход; гасит ровно ту сессию, токен которой предъявлен');
    logout(ctx.token);
    return ctx.json(200, { ok: true }, {
      'Set-Cookie': clearCookie(SESSION_COOKIE, { secure: env.isProduction }),
    });
  });

  /**
   * POST /api/auth/forgot-password — запросить ссылку восстановления.
   *
   * Ответ всегда один и тот же, 200, независимо от того, есть такой
   * e-mail в студии или нет. Иначе форма восстановления превращается
   * в способ проверить, записан ли человек к нам, — та же причина,
   * по которой при входе не различаются «нет такого e-mail»
   * и «неверный пароль».
   *
   * По той же причине одинаково отвечает и слишком частый повтор:
   * не чаще одной ссылки в минуту на аккаунт, чтобы форма не стала
   * кнопкой «завалить человека письмами».
   *
   * Отправки писем в MVP нет (см. services/delivery.js). Пока её нет,
   * вне прода ссылка возвращается в поле reset_link, чтобы поток можно
   * было пройти целиком. В проде она не возвращается никогда.
   */
  router.post('/api/auth/forgot-password', async (ctx) => {
    ctx.allowPublic('восстановление пароля — человек как раз не может войти');
    const body = v.object(await ctx.body());
    const email = v.email(body.email);

    const token = requestReset(email);
    const link = token === null ? null : buildResetLink(token);
    if (link) deliverResetLink({ email, link });

    return ctx.json(200, {
      ok: true,
      message: 'Если такой e-mail зарегистрирован, ссылка для восстановления отправлена',
      ...(link && mayExposeLink() ? { reset_link: link, token } : {}),
    });
  });

  /**
   * POST /api/auth/reset-password/check — жива ли ссылка.
   *
   * Нужен экрану, на который человек попадает из письма: сначала
   * выяснить, работает ли ссылка, и только потом предлагать придумать
   * пароль. Иначе человек введёт новый пароль дважды и лишь после
   * этого узнает, что ссылка протухла.
   *
   * Токен приходит в теле, а не в адресе: это секрет на предъявителя,
   * и в строке запроса он осел бы в журналах сервера и в истории браузера.
   */
  router.post('/api/auth/reset-password/check', async (ctx) => {
    ctx.allowPublic('проверка ссылки из письма; доступ даёт сам одноразовый токен');
    const body = v.object(await ctx.body());
    const token = v.string(body.token, 'token', { max: 200 });
    const state = checkResetToken(token);

    return ctx.json(200, {
      valid: state.valid,
      ...(state.valid ? { expires_at: views.moment(state.expiresAt, ctx.settings) } : { reason: state.reason }),
    });
  });

  /**
   * POST /api/auth/reset-password — задать новый пароль по ссылке.
   *
   * Ссылка одноразовая, и все сессии аккаунта после смены закрываются
   * без исключений: пароль восстанавливают чаще всего именно потому,
   * что в аккаунт зашёл кто-то чужой, и оставить ему живую сессию —
   * значит не сделать ничего.
   *
   * Автоматического входа после смены нет намеренно: человек должен
   * подтвердить, что помнит новый пароль, пока он ещё под рукой.
   */
  router.post('/api/auth/reset-password', async (ctx) => {
    ctx.allowPublic('смена пароля по ссылке; доступ даёт сам одноразовый токен');
    const body = v.object(await ctx.body());
    const token = v.string(body.token, 'token', { max: 200 });
    const password = v.password(body.password);

    const result = resetPassword({ token, password });
    return ctx.json(200, {
      ok: true,
      sessions_revoked: result.sessionsRevoked,
      message: 'Пароль изменён. Войдите с новым паролем.',
    });
  });

  /**
   * POST /api/auth/change-password — смена пароля изнутри кабинета.
   *
   * Экраны K5, M4 и A-панели. Текущий пароль обязателен: без него любой,
   * кто подсел за незакрытый ноутбук, забрал бы аккаунт себе.
   *
   * Текущая сессия остаётся живой, остальные закрываются — смысл
   * в том, чтобы выгнать остальных, а не себя.
   */
  router.post('/api/auth/change-password', async (ctx) => {
    const user = ctx.requireUser();
    const body = v.object(await ctx.body());
    const currentPassword = v.password(body.current_password, 'current_password');
    const newPassword = v.password(body.new_password, 'new_password');

    const result = changePassword({
      user,
      sessionId: ctx.sessionId,
      currentPassword,
      newPassword,
    });

    return ctx.json(200, { ok: true, sessions_revoked: result.sessionsRevoked });
  });

  /** GET /api/auth/me — профиль текущей сессии; заодно способ проверить, жива ли она. */
  router.get('/api/auth/me', async (ctx) => {
    const user = ctx.requireUser();
    return ctx.json(200, { user: views.user(user), studio: views.studio(ctx.settings) });
  });
}

export { GUEST_COOKIE };
