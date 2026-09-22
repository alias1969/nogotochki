/**
 * Формы входа, регистрации и восстановления пароля.
 *
 * Три правила, по которым здесь всё устроено.
 *
 * 1. Сессию страница не ведёт. Токен сервер кладёт в HttpOnly-cookie сам,
 *    и запросы идут с credentials:'include' — только чтобы браузер эту
 *    cookie принял и потом отправлял. Поле `token` в ответе на вход
 *    и регистрацию тоже приходит (оно для curl и мобильного клиента),
 *    но здесь не читается и никуда не сохраняется: ни в localStorage,
 *    ни в sessionStorage, ни в переменную. HttpOnly-cookie недоступна
 *    скриптам — это её смысл, и копия токена рядом с ней его отменяет.
 *
 * 2. Ошибку показывает сервер, а не форма. Его текст выводится как есть:
 *    он написан для человека, и придумывать свой поверх — значит однажды
 *    разойтись с тем, что на самом деле произошло. Если в ответе указано
 *    поле (`details.field`), оно подсвечивается и получает фокус.
 *
 * 3. Проверка на форме — удобство, а не защита. Она ловит опечатку до
 *    обращения к серверу и не повторяет его правил строже, чем они есть
 *    (пароль — только длина, как в validate.js). Настоящая проверка всё
 *    равно на сервере, и её ответ показывается всегда.
 */
import { API_BASE } from './config.js';
import { $, $$ } from './shared.js';

// --------------------------------------------------------------------------
// Запрос
// --------------------------------------------------------------------------

/**
 * POST на API.
 *
 * credentials:'include' обязателен: страница и API живут на разных
 * origin, и без него браузер не примет cookie сессии, которую ставит
 * сервер, и не пришлёт её в следующий запрос.
 */
export async function post(path, body, method = 'POST') {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await response.json(); } catch { /* пустое или не JSON */ }
  return { ok: response.ok, status: response.status, data };
}

// --------------------------------------------------------------------------
// Показ ошибок
// --------------------------------------------------------------------------

/**
 * Блок сообщения формы.
 *
 * По умолчанию #form-error — на странице с одной формой он один.
 * Там, где форм несколько (профиль), каждая называет свой: ошибка
 * смены пароля не должна всплывать над личными данными.
 */
const DEFAULT_NOTICE = 'form-error';

/** Снимает подсветку и прячет все подписи — перед каждой отправкой. */
export function clearErrors(form, noticeId = DEFAULT_NOTICE) {
  for (const input of $$('[name]', form)) input.removeAttribute('aria-invalid');
  for (const hint of $$('.field__hint', form)) { hint.hidden = true; hint.textContent = ''; }
  const notice = document.getElementById(noticeId);
  if (notice) notice.hidden = true;
}

const WARN_ICON = '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4.5M12 16h.01"></path></svg>';

/** Сообщение на всю форму: текст сервера или наше объяснение. */
export function showFormError(message, kind = 'error', noticeId = DEFAULT_NOTICE) {
  const notice = document.getElementById(noticeId);
  if (!notice) return;
  notice.className = `notice notice--${kind}`;
  notice.innerHTML = `<span>${WARN_ICON}</span><p></p>`;
  $('p', notice).textContent = message;
  notice.hidden = false;
}

/** Подпись под конкретным полем плюс подсветка самого поля. */
export function showFieldError(form, name, message) {
  const input = $(`[name="${name}"]`, form);
  if (!input) return false;
  input.setAttribute('aria-invalid', 'true');
  const hint = $(`#hint-${name}`, form);
  if (hint && message) {
    hint.innerHTML = `${WARN_ICON}<span></span>`;
    $('span', hint).textContent = message;
    hint.hidden = false;
  }
  return true;
}

/**
 * Ответ сервера с ошибкой — на форму.
 *
 * Текст показывается всегда: он единственный знает, что случилось.
 * Названное поле дополнительно подсвечивается и получает фокус, чтобы
 * не искать его глазами в длинной форме регистрации.
 */
export function showServerError(form, status, data, noticeId = DEFAULT_NOTICE) {
  const error = data?.error ?? {};
  let message = error.message ?? 'Не удалось связаться с сервером. Попробуйте ещё раз.';

  // 429 приходит со сроком в теле — заголовки со страницы читать неудобно.
  // Сервер говорит, что попыток было много; сколько именно ждать, знает
  // только он, и это единственное, что дописывается к его тексту.
  const retry = error.details?.retry_after_seconds;
  if (status === 429 && retry) {
    const left = retry >= 60
      ? `${Math.ceil(retry / 60)} мин`
      : `${retry} с`;
    const tail = `Повторить можно через ${left}.`;
    message = /[.!?…]$/.test(message) ? `${message} ${tail}` : `${message}. ${tail}`;
  }

  showFormError(message, status === 429 ? 'warning' : 'error', noticeId);

  const field = error.details?.field;
  if (field && showFieldError(form, field, null)) {
    $(`[name="${field}"]`, form).focus();
  }
}

// --------------------------------------------------------------------------
// Состояние отправки
// --------------------------------------------------------------------------

function setBusy(form, busy, labelBusy) {
  const button = $('[type="submit"]', form);
  if (!button) return;
  const spinner = $('.spinner', button);
  const label = $('.btn__label', button);
  button.disabled = busy;
  if (spinner) spinner.hidden = !busy;
  if (label && labelBusy) {
    if (busy) {
      label.dataset.idle = label.textContent;
      label.textContent = labelBusy;
    } else if (label.dataset.idle) {
      label.textContent = label.dataset.idle;
    }
  }
  for (const input of $$('input', form)) input.disabled = busy;
}

// --------------------------------------------------------------------------
// Проверка на форме
// --------------------------------------------------------------------------

/**
 * Те же границы, что в server/src/lib/validate.js.
 *
 * Строже сервера здесь быть нельзя: форма, которая не пускает пароль,
 * который сервер принял бы, просто врёт человеку.
 */
export const rules = {
  required: (value, label) => (value.trim() ? null : `Заполните поле «${label}»`),
  email: (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())
    ? null : 'Проверьте адрес почты: не хватает знака @'),
  password: (value) => (value.length >= 8 ? null : 'Пароль короче восьми символов'),
  phone: (value) => (/^\+?[0-9]{10,15}$/.test(value.replace(/[\s()-]/g, ''))
    ? null : 'Проверьте номер: не хватает цифр'),
};

// --------------------------------------------------------------------------
// Сборка формы
// --------------------------------------------------------------------------

/**
 * Связывает форму с эндпоинтом.
 *
 * @param formEl       сама форма
 * @param endpoint     путь API
 * @param method       HTTP-метод, по умолчанию POST
 * @param check        (values) => [[поле, сообщение], …] — проверка на форме
 * @param build        (values) => тело запроса
 * @param onSuccess    (data) => void
 * @param busyLabel    подпись кнопки на время запроса
 * @param errorNotice  id блока сообщения, если форм на странице несколько
 */
export function wireForm(formEl, {
  endpoint, check, build, onSuccess, busyLabel,
  method = 'POST', errorNotice = DEFAULT_NOTICE,
}) {
  formEl.setAttribute('novalidate', '');

  // Подсветка снимается, как только поле начали править: держать её
  // на поле, которое человек уже исправляет, незачем.
  formEl.addEventListener('input', (event) => {
    const input = event.target;
    if (!input.name) return;
    input.removeAttribute('aria-invalid');
    const hint = $(`#hint-${input.name}`, formEl);
    if (hint) hint.hidden = true;
  });

  formEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(formEl, errorNotice);

    const values = Object.fromEntries(new FormData(formEl));

    const problems = check ? check(values) : [];
    if (problems.length) {
      for (const [name, message] of problems) showFieldError(formEl, name, message);
      const first = $(`[name="${problems[0][0]}"]`, formEl);
      if (first) first.focus();
      return;   // к серверу не идём — но и ничего за него не решаем
    }

    setBusy(formEl, true, busyLabel);
    try {
      const { ok, status, data } = await post(endpoint, build(values), method);
      if (!ok) {
        showServerError(formEl, status, data, errorNotice);
        return;
      }
      onSuccess(data);
    } catch {
      // Сеть не дошла до сервера: ответа нет, и придумать его нельзя.
      showFormError(
        'Не удалось связаться с сервером. Проверьте соединение и попробуйте ещё раз.',
        'error', errorNotice,
      );
    } finally {
      setBusy(formEl, false, busyLabel);
    }
  });
}

// --------------------------------------------------------------------------
// Куда вернуться после входа
// --------------------------------------------------------------------------

/**
 * Адрес возврата из `?back=`.
 *
 * Принимается только путь внутри этого же сайта. Чужой адрес в таком
 * параметре — это открытый редирект: ссылку «войти в Ноготочки» можно
 * разослать так, чтобы после настоящего входа человека уносило на чужую
 * страницу, неотличимую от нашей. Поэтому проверяется не «похоже ли
 * на наш адрес», а разбирается сам URL: origin обязан совпасть.
 *
 * Протокол-относительный `//evil.example` отсекается тем же разбором —
 * у него origin чужой.
 */
export function backTarget(fallback) {
  const raw = new URLSearchParams(location.search).get('back');
  if (!raw) return fallback;
  try {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

// --------------------------------------------------------------------------
// Показать пароль
// --------------------------------------------------------------------------

const EYE = '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path><path d="M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z"></path></svg>';
const EYE_OFF = '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"></path><path d="M10.6 6.3A8.8 8.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.6 3.3M6.3 7.9A16.4 16.4 0 0 0 2.5 12S6 18 12 18c1.2 0 2.3-.2 3.3-.6"></path><path d="M9.6 9.9a2.8 2.8 0 0 0 3.9 3.9"></path></svg>';

export function setupPasswordToggles(root = document) {
  for (const button of $$('.pass__toggle', root)) {
    const input = $('input', button.parentElement);
    const apply = () => {
      const shown = input.type === 'text';
      button.innerHTML = shown ? EYE : EYE_OFF;
      button.setAttribute('aria-label', shown ? 'Скрыть пароль' : 'Показать пароль');
      button.setAttribute('aria-pressed', String(shown));
    };
    apply();
    button.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      apply();
    });
  }
}

// --------------------------------------------------------------------------
// Требования к паролю
// --------------------------------------------------------------------------

/**
 * Отметка «выполнено» у требований к паролю.
 *
 * Требование ровно одно — длина: сервер проверяет только её
 * (см. комментарий к password() в validate.js, там это решение объяснено).
 * Рисовать галочки про заглавные буквы и цифры, которых сервер не спросит,
 * значит показывать выдуманное правило.
 */
export function setupPasswordRules(input, box) {
  if (!input || !box) return;
  const update = () => {
    for (const rule of $$('.rule', box)) {
      const ok = input.value.length >= Number(rule.dataset.min ?? 8);
      rule.dataset.ok = String(ok);
      $('.rule__mark', rule).textContent = ok ? '✓' : '';
    }
  };
  update();
  input.addEventListener('input', update);
}
