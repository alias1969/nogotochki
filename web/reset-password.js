/**
 * Экран C4 «Восстановление пароля — новый пароль».
 *
 * Токен приходит в адресе ссылки из письма (?token=…). Сначала он
 * проверяется отдельным запросом POST /api/auth/reset-password/check,
 * и только если ссылка жива, показывается форма: иначе человек введёт
 * пароль дважды и лишь потом узнает, что ссылка протухла.
 *
 * Сам токен уходит в теле запроса, а не в строке адреса к API: это
 * секрет на предъявителя, и в query он осел бы в журналах сервера.
 *
 * Автоматического входа после смены пароля нет. Так решено на сервере:
 * смена гасит все сессии аккаунта, включая ту, из которой пришёл запрос,
 * потому что пароль восстанавливают чаще всего именно тогда, когда
 * в аккаунт зашёл кто-то чужой. Поэтому экран ведёт на C1 «Вход»,
 * а не в кабинет.
 */
import { $, wireScreenLinks, setupTheme } from './shared.js';
import { wireForm, rules, post, setupPasswordToggles, setupPasswordRules } from './auth.js';

wireScreenLinks();
setupTheme();
setupPasswordToggles();
setupPasswordRules($('[name="password"]'), $('#rules'));

const checking = $('#checking');
const head = $('#head');
const form = $('#form');
const done = $('#done');
const dead = $('#dead');

const token = new URLSearchParams(location.search).get('token');

/** Почему ссылка не работает — словами, по коду от сервера. */
const DEAD_REASON = {
  unknown: 'Такой ссылки не существует. Возможно, адрес скопирован не целиком.',
  used: 'По этой ссылке пароль уже меняли. Каждая работает один раз.',
  expired: 'Срок действия ссылки истёк. Запросите новую — придёт свежее письмо.',
  missing: 'В адресе нет ссылки для смены пароля. Откройте её из письма целиком.',
};

function showDead(reason) {
  checking.hidden = true;
  $('#dead-text').textContent = DEAD_REASON[reason] ?? DEAD_REASON.unknown;
  dead.hidden = false;
}

function showForm() {
  checking.hidden = true;
  head.hidden = false;
  form.hidden = false;
}

async function check() {
  if (!token) { showDead('missing'); return; }
  try {
    const { ok, data } = await post('/api/auth/reset-password/check', { token });
    if (ok && data.valid) { showForm(); return; }
    showDead(data?.reason ?? data?.error?.code ?? 'unknown');
  } catch {
    // Сервер недоступен — это не «ссылка мертва». Даём попробовать.
    checking.hidden = true;
    head.hidden = false;
    form.hidden = false;
    $('#form-error').className = 'notice notice--warning';
    $('#form-error').innerHTML = '<p>Не удалось проверить ссылку: сервер не отвечает. Можно попробовать сохранить пароль — ответ придёт от сервера.</p>';
    $('#form-error').hidden = false;
  }
}

wireForm(form, {
  endpoint: '/api/auth/reset-password',
  busyLabel: 'Сохраняем',

  check: (v) => {
    const problems = [];
    const password = rules.required(v.password, 'Новый пароль') ?? rules.password(v.password);
    if (password) problems.push(['password', password]);
    if (!password && v.password !== v.password2) problems.push(['password2', 'Пароли не совпадают']);
    return problems;
  },

  build: (v) => ({ token, password: v.password }),

  onSuccess: (data) => {
    head.hidden = true;
    form.hidden = true;
    $('#form-error').hidden = true;
    // Текст берём у сервера: это он решает, вошли мы или нет.
    $('#done-text').textContent = data.message ?? 'Пароль изменён. Войдите с новым паролем.';
    done.hidden = false;
  },
});

check();
