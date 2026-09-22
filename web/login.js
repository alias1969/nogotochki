/**
 * Экран C1 «Вход».
 *
 * Отправляет POST /api/auth/login. Сессию ставит сервер: в ответе
 * приходит Set-Cookie с HttpOnly-токеном, и это всё, что нужно.
 * Поле `token` из тела ответа здесь не читается и никуда не кладётся.
 *
 * По карте связей успешный вход ведёт на K1 «Личный кабинет —
 * Предстоящие записи».
 */
import { wireScreenLinks, setupTheme } from './shared.js';
import { wireForm, rules, backTarget, setupPasswordToggles } from './auth.js';
import { AFTER_AUTH } from './routes.js';

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

  onSuccess: () => {
    // Ответ намеренно не разбирается: ничего из него странице не нужно.
    // `?back=` возвращает туда, откуда пришли, — например на шаг
    // подтверждения записи, где резерв уже идёт.
    location.href = backTarget(AFTER_AUTH);
  },
});
