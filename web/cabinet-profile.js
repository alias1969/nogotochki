/**
 * Экран K5 «Личный кабинет — Профиль».
 *
 * Три независимые операции на одной странице, и это не случайность:
 *   PATCH /api/profile              — имя, телефон, тема;
 *   POST  /api/auth/change-password — пароль, с текущим паролем;
 *   POST  /api/auth/logout          — выход.
 *
 * Разделены они на сервере, поэтому разделены и здесь: у каждой формы
 * своя кнопка, свой ответ и своё сообщение об ошибке. Одна общая кнопка
 * «Сохранить всё» пришлось бы разбирать на те же три запроса, и при
 * отказе одного из них было бы непонятно, что сохранилось.
 *
 * E-mail на этом экране не меняется: PATCH /api/profile его не читает
 * (см. комментарий в profile.routes.js — адрес входа меняет администратор).
 * Поле показано заблокированным с объяснением, а не убрано: человек
 * должен видеть, какой адрес у него записан.
 */
import {
  $, api, setupCabinet, applyTheme, rememberTheme,
  THEME_FROM_API, THEME_TO_API, SCREENS,
} from './cabinet.js';
import { wireForm, rules, setupPasswordToggles, setupPasswordRules } from './auth.js';

let profile = null;

// --------------------------------------------------------------------------
// Личные данные
// --------------------------------------------------------------------------

const profileForm = $('#form-profile');

wireForm(profileForm, {
  endpoint: '/api/profile',
  busyLabel: 'Сохраняем',
  method: 'PATCH',

  check: (v) => {
    const problems = [];
    const name = rules.required(v.full_name, 'Имя');
    if (name) problems.push(['full_name', name]);
    else if (v.full_name.trim().length < 2) problems.push(['full_name', 'Имя короче двух символов']);

    const phone = rules.required(v.phone, 'Телефон') ?? rules.phone(v.phone);
    if (phone) problems.push(['phone', phone]);
    return problems;
  },

  build: (v) => ({ full_name: v.full_name.trim(), phone: v.phone.trim() }),

  onSuccess: (data) => {
    profile = data.profile;
    fill();
    $('#saved').hidden = false;
    // Имя в шапке меняется сразу: иначе на экране два разных имени.
    $('#user-name').textContent = (profile.full_name ?? '').split(/\s+/)[0] ?? '';
  },
});

// Начали править — сообщение об успехе больше не про то, что на экране.
profileForm.addEventListener('input', () => { $('#saved').hidden = true; });

// --------------------------------------------------------------------------
// Смена пароля
// --------------------------------------------------------------------------

const passForm = $('#form-password');
setupPasswordToggles(passForm);
setupPasswordRules($('[name="new_password"]', passForm), $('#rules'));

wireForm(passForm, {
  endpoint: '/api/auth/change-password',
  busyLabel: 'Обновляем',
  errorNotice: 'pass-error',

  check: (v) => {
    const problems = [];
    const current = rules.required(v.current_password, 'Текущий пароль');
    if (current) problems.push(['current_password', current]);

    // Длину нового проверяем той же границей, что и сервер, — не строже.
    const next = rules.required(v.new_password, 'Новый пароль') ?? rules.password(v.new_password);
    if (next) problems.push(['new_password', next]);

    // Совпадение со старым здесь не ловим: сервер отвечает на это
    // отдельным 422, и его формулировка точнее нашей догадки.
    return problems;
  },

  build: (v) => ({ current_password: v.current_password, new_password: v.new_password }),

  onSuccess: (data) => {
    passForm.reset();
    setupPasswordRules($('[name="new_password"]', passForm), $('#rules'));
    const revoked = data.sessions_revoked ?? 0;
    $('#pass-saved-text').textContent = revoked
      ? `Пароль изменён. Закрыто других входов: ${revoked}`
      : 'Пароль изменён';
    $('#pass-saved').hidden = false;
  },
});

passForm.addEventListener('input', () => { $('#pass-saved').hidden = true; });

// --------------------------------------------------------------------------
// Оформление
// --------------------------------------------------------------------------

function setupThemes() {
  for (const input of document.querySelectorAll('[name="theme"]')) {
    input.addEventListener('change', async () => {
      const theme = input.value;
      // Показываем сразу: тема — это то, что человек видит, а не ждёт.
      applyTheme(theme);
      rememberTheme(theme);
      $('#theme-error').hidden = true;
      try {
        await api('/api/profile', { method: 'PATCH', body: { theme: THEME_TO_API[theme] } });
        profile.theme = THEME_TO_API[theme];
      } catch (error) {
        // Здесь молчать нельзя: человек ждёт, что выбор переедет
        // на другое устройство, а он не уехал.
        $('#theme-error').innerHTML = '<p></p>';
        $('#theme-error p').textContent = `${error.message} В этом браузере тема осталась выбранной.`;
        $('#theme-error').hidden = false;
      }
    });
  }
}

// --------------------------------------------------------------------------
// Выход
// --------------------------------------------------------------------------

$('#logout').addEventListener('click', async () => {
  const button = $('#logout');
  button.disabled = true;
  try {
    // Сессию гасит сервер: стереть cookie на странице мало, токен
    // продолжил бы работать. По карте связей выход ведёт на лендинг.
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } catch { /* даже если не дошло — уводим со страницы кабинета */ }
  location.href = SCREENS.L1;
});

// --------------------------------------------------------------------------
// Загрузка
// --------------------------------------------------------------------------

function fill() {
  $('[name="full_name"]', profileForm).value = profile.full_name ?? '';
  $('[name="phone"]', profileForm).value = profile.phone ?? '';
  $('#email').value = profile.email ?? '';

  const theme = THEME_FROM_API[profile.theme] ?? 'light';
  const picked = document.querySelector(`[name="theme"][value="${theme}"]`);
  if (picked) picked.checked = true;

  if (profile.created_at) {
    $('#since').textContent = `Аккаунт создан ${profile.created_at.local_date.split('-').reverse().join('.')}`;
  }
}

async function load() {
  $('#load-error').hidden = true;
  try {
    profile = (await api('/api/profile')).profile;
    fill();
    $('#body').hidden = false;
  } catch (error) {
    $('#load-error-text').textContent = error.message;
    $('#load-error').hidden = false;
  }
}

$('#retry').addEventListener('click', load);

(async () => {
  if (await setupCabinet('K5')) {
    setupThemes();
    load();
  }
})();
