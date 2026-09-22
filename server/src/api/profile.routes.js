/**
 * Свой профиль.
 *
 * Требует входа и работает только со своей строкой: номер пользователя
 * берётся из сессии, а не из адреса. Эндпоинта вида /api/users/:id здесь
 * нет и не должно быть — он немедленно поставил бы вопрос, кому можно
 * смотреть чужой профиль, ради задачи «поправить свой телефон».
 */
import * as v from '../lib/validate.js';
import * as views from './views.js';
import { loadProfile, updateProfile } from '../services/profile.js';

const THEMES = ['day', 'evening'];

export function registerProfileRoutes(router) {
  /**
   * GET /api/profile — свой профиль.
   *
   * Отличается от /api/auth/me назначением: тот отвечает на вопрос
   * «жива ли сессия» и отдаёт заодно правила студии, этот — данные
   * экрана профиля.
   */
  router.get('/api/profile', async (ctx) => {
    const user = ctx.requireUser();
    const row = loadProfile(user.id);
    return ctx.json(200, {
      profile: { ...views.user(row), created_at: views.moment(row.created_at, ctx.settings) },
    });
  });

  /**
   * PATCH /api/profile — поправить имя, телефон или тему.
   *
   * Частичное обновление: меняется только присланное. Телефон
   * нормализуется — из «+7 (900) 000-00-00» получается +79000000000,
   * чтобы одинаковые номера не лежали в базе в трёх начертаниях.
   *
   * Тема — `day` или `evening`, две темы дизайн-системы. Она живёт
   * в базе, а не в браузере, потому что должна переезжать между
   * устройствами: человек выбрал вечернюю на телефоне, открыл на ноутбуке
   * — и она вечерняя.
   *
   * Роль, признак активности, e-mail и пароль здесь не читаются вовсе.
   * У пароля своя операция (POST /api/auth/change-password), остальное
   * решает администратор.
   */
  router.patch('/api/profile', async (ctx) => {
    const user = ctx.requireUser();
    const body = v.object(await ctx.body());

    const patch = {};
    if (body.full_name !== undefined) patch.full_name = v.string(body.full_name, 'full_name', { min: 2, max: 120 });
    if (body.phone !== undefined) patch.phone = v.phone(body.phone);
    if (body.theme !== undefined) patch.theme = v.oneOf(body.theme, 'theme', THEMES);

    const row = updateProfile({ user, patch });
    return ctx.json(200, { profile: views.user(row) });
  });
}
