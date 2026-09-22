/**
 * Экран C2 «Регистрация».
 *
 * Отправляет POST /api/auth/register. Сервер сам ставит cookie сессии,
 * поэтому после регистрации человек уже вошёл и отдельный вход не нужен.
 * Токен из тела ответа не сохраняется.
 *
 * По карте связей ведёт на K1: у нового аккаунта записей нет, и кабинет
 * открывается пустым — это состояние того же экрана, а не отдельный.
 */
import { $, wireScreenLinks, setupTheme } from './shared.js';
import { wireForm, rules, backTarget, setupPasswordToggles, setupPasswordRules } from './auth.js';
import { AFTER_AUTH } from './routes.js';

wireScreenLinks();
setupTheme();
setupPasswordToggles();
setupPasswordRules($('[name="password"]'), $('#rules'));

wireForm(document.getElementById('form'), {
  endpoint: '/api/auth/register',
  busyLabel: 'Создаём аккаунт',

  check: (v) => {
    const problems = [];

    const name = rules.required(v.full_name, 'Имя');
    if (name) problems.push(['full_name', name]);
    else if (v.full_name.trim().length < 2) problems.push(['full_name', 'Имя короче двух символов']);

    const email = rules.required(v.email, 'E-mail') ?? rules.email(v.email);
    if (email) problems.push(['email', email]);

    const phone = rules.required(v.phone, 'Телефон') ?? rules.phone(v.phone);
    if (phone) problems.push(['phone', phone]);

    const password = rules.required(v.password, 'Пароль') ?? rules.password(v.password);
    if (password) problems.push(['password', password]);

    // Второе поле пароля — только на форме: серверу оно не отправляется
    // и проверять ему нечего.
    if (!password && v.password !== v.password2) problems.push(['password2', 'Пароли не совпадают']);

    // Согласия в API тоже нет. Это требование студии к форме, и живёт
    // оно здесь; полем запроса ему становиться незачем.
    if (!v.consent) problems.push(['consent', 'Отметьте согласие, чтобы продолжить']);

    return problems;
  },

  build: (v) => ({
    full_name: v.full_name.trim(),
    email: v.email.trim(),
    phone: v.phone.trim(),
    password: v.password,
  }),

  onSuccess: () => { location.href = backTarget(AFTER_AUTH); },
});
