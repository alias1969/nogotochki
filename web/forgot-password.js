/**
 * Экран C3 «Восстановление пароля — запрос».
 *
 * Отправляет POST /api/auth/forgot-password. Ответ сервера всегда 200
 * и всегда один и тот же, есть такой e-mail в студии или нет: иначе
 * форма восстановления превращается в способ проверить, записан ли
 * человек к нам. Поэтому и экран после отправки не утверждает, что
 * письмо ушло, а повторяет формулировку сервера.
 *
 * В прототипе шаги 1 и 2 нарисованы двумя карточками рядом — это способ
 * показать оба состояния сразу. Здесь это одна карточка, которая после
 * отправки меняет содержимое.
 */
import { $, wireScreenLinks, setupTheme } from './shared.js';
import { wireForm, rules, post, showFormError } from './auth.js';
import { SCREENS } from './routes.js';

wireScreenLinks();
setupTheme();

const form = $('#form');
const head = $('#head');
const sent = $('#sent');
const resend = $('#resend');
const resendHint = $('#resend-hint');

let lastEmail = '';

/** Повтор не чаще раза в минуту — тот же предел, что у сервера. */
const RESEND_SECONDS = 60;
let timer = null;

function startCountdown() {
  let left = RESEND_SECONDS;
  resend.disabled = true;
  const tick = () => {
    resendHint.textContent = left > 0
      ? `Отправить ещё раз можно через ${left} с`
      : 'Письма нет? Проверьте папку «Спам» или отправьте ещё раз';
    if (left > 0) { left -= 1; return; }
    resend.disabled = false;
    clearInterval(timer);
  };
  tick();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
}

/**
 * Ссылка из ответа — только для разработки.
 *
 * Отправки писем в сервисе пока нет, и вне прода сервер возвращает
 * одноразовый токен прямо в ответе (mayExposeLink в services/delivery.js).
 * Адрес собирается здесь из токена, а не берётся из reset_link: тот
 * построен от APP_URL и указывает на API, а экран лежит в статике.
 */
function showDevLink(data) {
  if (!data.token) return;
  const box = $('#dev-link');
  $('#dev-link-a').href = `${SCREENS.C4}?token=${encodeURIComponent(data.token)}`;
  box.hidden = false;
}

function showSent(data) {
  head.hidden = true;
  form.hidden = true;
  sent.hidden = false;
  $('#sent-text').textContent = data.message
    ?? 'Если такой e-mail зарегистрирован, ссылка для восстановления отправлена';
  $('#sent-email').textContent = lastEmail;
  showDevLink(data);
  startCountdown();
}

wireForm(form, {
  endpoint: '/api/auth/forgot-password',
  busyLabel: 'Отправляем',
  check: (v) => {
    const email = rules.required(v.email, 'E-mail') ?? rules.email(v.email);
    return email ? [['email', email]] : [];
  },
  build: (v) => ({ email: v.email.trim() }),
  onSuccess: (data) => {
    lastEmail = $('[name="email"]', form).value.trim();
    showSent(data);
  },
});

resend.addEventListener('click', async () => {
  resend.disabled = true;
  try {
    const { ok, status, data } = await post('/api/auth/forgot-password', { email: lastEmail });
    if (ok) { showDevLink(data); startCountdown(); return; }
    // Сюда попадает и 429: сервер отвечает одинаково и на слишком частый
    // повтор, поэтому просто показываем, что он сказал.
    showFormError(data?.error?.message ?? 'Не удалось отправить ещё раз', status === 429 ? 'warning' : 'error');
    resend.disabled = false;
  } catch {
    showFormError('Не удалось связаться с сервером. Проверьте соединение и попробуйте ещё раз.');
    resend.disabled = false;
  }
});
