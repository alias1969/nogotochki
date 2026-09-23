/**
 * Экран C1 «Вход».
 *
 * Отправляет POST /api/auth/login. Сессию ставит сервер: в ответе
 * приходит Set-Cookie с HttpOnly-токеном, и это всё, что нужно.
 * Поле `token` из тела ответа здесь не читается и никуда не кладётся.
 *
 * По карте связей успешный вход клиента ведёт на K1 «Личный кабинет —
 * Предстоящие записи». Форма при этом одна на всех: администратор входит
 * тем же полем и той же кнопкой, а куда его вести — решает роль из ответа
 * сервера (`user.roles`), а не отдельный адрес для входа в админ-панель.
 */
import { wireScreenLinks, setupTheme } from './shared.js';
import { wireForm, rules, backTarget, setupPasswordToggles } from './auth.js';
import { afterAuthHref } from './routes.js';

wireScreenLinks();
setupTheme();
setupPasswordToggles();

wireForm(document.getElementById('form'), {
  endpoint: '/api/auth/login',
  busyLabel: 'Входим',

  // Проверка на форме ловит пустое поле и опечатку в адресе. Пароль
  // здесь по длине не проверяется намеренно: на входе короткий пароль —
  // это не опечатка в форме, а неверный пароль, и отвечать об этом
  // должен сервер, одинаково для всех случаев.
  check: (v) => {
    const problems = [];
    const email = rules.required(v.email, 'E-mail') ?? rules.email(v.email);
    if (email) problems.push(['email', email]);
    const password = rules.required(v.password, 'Пароль');
    if (password) problems.push(['password', password]);
    return problems;
  },

  build: (v) => ({ email: v.email.trim(), password: v.password }),

  onSuccess: (data) => {
    // `?back=` возвращает туда, откуда пришли, — например на шаг
    // подтверждения записи, где резерв уже идёт. Без него запасной адрес
    // зависит от роли: администратора он ведёт в /admin, остальных — в K1.
    // Роль проверяется поиском в списке (data.user.roles.includes('admin')),
    // а не сравнением — как и на сервере.
    location.href = backTarget(afterAuthHref(data.user?.roles));
  },
});
