/**
 * Лендинг «Ноготочки» — поведение страницы.
 *
 * Что тут есть: подстановка адресов по карте экранов, тема, мобильное меню,
 * аккордеон вопросов, часы работы и загрузка двух списков с сервера —
 * услуг и мастеров. Ничего больше на этой странице не происходит:
 * сама запись живёт на шагах B1–B6.
 *
 * Списки услуг и мастеров в разметке не лежат: витрина меняется
 * в админ-панели, и вписанная руками цена расходится с прайсом в первый
 * же день. До ответа сервера на их месте стоят карточки-заглушки той же
 * формы — иначе страница прыгает, когда данные приезжают.
 */
import { API_BASE, SKELETON_COUNT } from './config.js';
import { bookingHref } from './routes.js';
import { $, $$, el, wireScreenLinks, setupTheme, money, duration, plural, initials } from './shared.js';
import { SCREENS } from './routes.js';

// --------------------------------------------------------------------------
// Мелочи
// --------------------------------------------------------------------------

/**
 * Иконка часов в карточке услуги.
 *
 * Размер задаётся классом из styles.css, а не атрибутами width/height:
 * у SVG есть viewBox, и размер, вписанный в разметку, обошёл бы шкалу
 * иконок — единственное место, где он должен меняться.
 */
function clockIcon(className = 'icon--s') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ${className}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5l3 2"></path>';
  return svg;
}

// --------------------------------------------------------------------------
// Вошедший в шапке
// --------------------------------------------------------------------------

/**
 * Шапка лендинга у вошедшего.
 *
 * «Войти» уступает место имени — оно же ссылка в профиль, как в кабинете.
 * Кнопка записи становится «Выйти»: человек уже внутри, и предлагать ему
 * войти второй раз незачем.
 *
 * Спрашиваем сессию отдельным запросом с credentials: остальные вызовы
 * на этой странице публичные и куку не шлют.
 */
async function setupSession() {
  let me = null;
  try {
    const response = await fetch(`${API_BASE}/api/auth/me`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;          // 401 — оставляем шапку как есть
    me = (await response.json()).user;
  } catch {
    // Сервер не ответил: считаем, что не вошли, и ничего не меняем.
    return;
  }

  $('#header-login').hidden = true;
  // То же самое в мобильном меню: там шапка коротка, и без этих строк
  // вошедший не нашёл бы ни кабинета, ни выхода.
  $('#menu-login').hidden = true;
  $('#menu-profile').hidden = false;
  $('#menu-logout').hidden = false;
  $('#user-face').textContent = initials(me.full_name);
  $('#user-name').textContent = (me.full_name ?? '').split(/\s+/)[0] ?? '';
  $('#user-chip').hidden = false;

  const cta = $('#header-cta');
  cta.removeAttribute('data-screen');
  cta.href = '#';
  $('.cta-short', cta).textContent = 'Выйти';
  $('.cta-long', cta).textContent = 'Выйти';

  const logout = async (event) => {
    event.preventDefault();
    try {
      // Сессию гасит сервер: стёртой куки мало, токен продолжил бы работать.
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch { /* не дошло — страницу всё равно перезагружаем */ }
    location.href = SCREENS.L1;
  };

  cta.addEventListener('click', logout);
  $('#menu-logout').addEventListener('click', logout);
}

// --------------------------------------------------------------------------
// Меню, плавающая кнопка, вопросы
// --------------------------------------------------------------------------

function setupMenu() {
  const burger = $('#burger');
  const menu = $('#menu');

  const close = () => {
    menu.hidden = true;
    burger.setAttribute('aria-expanded', 'false');
  };

  burger.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
  });

  // Пункт меню ведёт к блоку на этой же странице: прокрутка делается
  // штатным якорем (scroll-behavior в styles.css), меню просто закрывается.
  for (const link of $$('a', menu)) link.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

function setupFloatingCta() {
  const float = $('#float');
  const onScroll = () => { float.hidden = (window.scrollY || 0) <= 420; };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

function setupFaq() {
  for (const button of $$('.faq__q')) {
    button.addEventListener('click', () => {
      const answer = document.getElementById(button.getAttribute('aria-controls'));
      const open = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!open));
      answer.hidden = open;
    });
  }
}

// --------------------------------------------------------------------------
// Часы работы
// --------------------------------------------------------------------------

/**
 * Расписание студии лежит в разметке, а не приходит с сервера: публичного
 * адреса у него нет — studio_hours отдаётся только по /api/admin/studio-hours,
 * то есть администратору. Открыто/закрыто считается здесь же по часам браузера.
 */
const WEEK = [
  { day: 'Понедельник', hours: '10:00–21:00', idx: 1, open: 600, close: 1260 },
  { day: 'Вторник', hours: '10:00–21:00', idx: 2, open: 600, close: 1260 },
  { day: 'Среда', hours: '10:00–21:00', idx: 3, open: 600, close: 1260 },
  { day: 'Четверг', hours: '10:00–21:00', idx: 4, open: 600, close: 1260 },
  { day: 'Пятница', hours: '10:00–21:00', idx: 5, open: 600, close: 1260 },
  { day: 'Суббота', hours: '10:00–20:00', idx: 6, open: 600, close: 1200 },
  { day: 'Воскресенье', hours: '11:00–18:00', idx: 0, open: 660, close: 1080 },
];

function renderHours() {
  const box = $('#hours-rows');
  const badge = $('#open-badge');
  const now = new Date();
  const dow = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();

  for (const row of WEEK) {
    const line = el('div', 'hours__row');
    if (row.idx === dow) line.dataset.today = 'true';
    line.append(el('span', null, row.day), el('span', null, row.hours));
    box.append(line);
  }

  const today = WEEK.find((r) => r.idx === dow);
  const isOpen = !!today && minutes >= today.open && minutes < today.close;
  badge.dataset.open = String(isOpen);
  badge.textContent = isOpen ? 'Сейчас открыто' : 'Закрыто';
}

// --------------------------------------------------------------------------
// Загрузка данных
// --------------------------------------------------------------------------

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return response.json();
}

/** Заглушка карточки услуги — той же высоты и формы, что настоящая. */
function serviceSkeleton() {
  const card = el('div', 'card skeleton');
  card.setAttribute('aria-hidden', 'true');
  card.append(
    el('span', 'skeleton__line skeleton__line--title'),
    el('span', 'skeleton__line skeleton__line--short'),
    el('span', 'skeleton__line'),
    el('span', 'skeleton__line skeleton__line--short'),
    el('span', 'skeleton__line skeleton__line--btn'),
  );
  return card;
}

/** Заглушка карточки мастера — с кружком на месте фотографии. */
function masterSkeleton() {
  const card = el('div', 'card skeleton');
  card.setAttribute('aria-hidden', 'true');
  card.append(
    el('span', 'skeleton__circle'),
    el('span', 'skeleton__line skeleton__line--title'),
    el('span', 'skeleton__line skeleton__line--short'),
    el('span', 'skeleton__line'),
    el('span', 'skeleton__line skeleton__line--btn'),
  );
  return card;
}

/**
 * Заглушка кнопки-категории: без неё строка фильтров пустует и прыгает.
 *
 * Ширина — шагами сетки отступов, чтобы и здесь не было числа в пикселях:
 * названия категорий приходят с сервера, и точная ширина всё равно неизвестна.
 */
function chipSkeleton(steps) {
  const chip = el('span', 'chip chip--skeleton');
  chip.setAttribute('aria-hidden', 'true');
  chip.style.width = `calc(var(--s-16) + var(--s-${steps}))`;
  return chip;
}

function showSkeletons(box, make, count) {
  box.replaceChildren(...Array.from({ length: count }, make));
  box.setAttribute('aria-busy', 'true');
}

/** Сорвалась загрузка — на месте списка остаётся объяснение и кнопка «Ещё раз». */
function showError(box, text, retry) {
  const note = el('div', 'load-error');
  note.append(el('span', null, text));
  const again = el('button', 'btn btn--outline btn--sm', 'Попробовать ещё раз');
  again.type = 'button';
  again.addEventListener('click', retry);
  note.append(again);
  box.replaceChildren(note);
  box.setAttribute('aria-busy', 'false');
}

// --- услуги ---------------------------------------------------------------

function serviceCard(service) {
  const card = el('div', 'card service');

  const head = el('div', 'service__head');
  head.append(el('b', 'service__name', service.name), el('span', 'service__price', money(service.price_kopecks)));

  const dur = el('span', 'service__dur');
  dur.append(clockIcon(), el('span', null, duration(service.duration_min)));

  card.append(head, dur);
  if (service.description) card.append(el('p', 'prose body-s muted', service.description));

  const book = el('a', 'btn btn--outline btn--block', 'Записаться');
  book.href = bookingHref({ serviceId: service.id });
  card.append(book);

  return card;
}

/**
 * Категории — не отдельный запрос: они приходят внутри каждой услуги
 * (`category: {id, name}`), и второй адрес ради тех же двух строк
 * не нужен. Порядок — тот, в котором услуги пришли с сервера:
 * его задаёт sort_order в админ-панели.
 */
function renderServices(services) {
  const chips = $('#service-cats');
  const box = $('#services');

  const categories = [];
  for (const service of services) {
    if (!categories.some((c) => c.id === service.category.id)) categories.push(service.category);
  }

  let active = categories[0]?.id ?? null;

  const draw = () => {
    chips.replaceChildren(...categories.map((category) => {
      const chip = el('button', 'chip', category.name);
      chip.type = 'button';
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', String(category.id === active));
      chip.addEventListener('click', () => { active = category.id; draw(); });
      return chip;
    }));

    const shown = services.filter((s) => s.category.id === active);
    box.replaceChildren(...shown.map(serviceCard));
    box.setAttribute('aria-busy', 'false');
  };

  if (!services.length) {
    chips.replaceChildren();
    box.replaceChildren(el('p', 'prose body-m muted', 'Услуги пока не добавлены.'));
    box.setAttribute('aria-busy', 'false');
    return;
  }

  draw();

  // Цифра в блоке «О салоне» — это счёт услуг на витрине, а не круглое
  // число в разметке: разойтись с прайсом ей теперь не на чем.
  $('#stat-services').textContent = String(services.length);
}

async function loadServices() {
  const box = $('#services');
  $('#service-cats').replaceChildren(chipSkeleton(16), chipSkeleton(6));
  showSkeletons(box, serviceSkeleton, SKELETON_COUNT.services);
  try {
    const data = await apiGet('/api/services');
    renderServices(data.services ?? []);
  } catch {
    $('#service-cats').replaceChildren();
    showError(box, 'Не удалось загрузить услуги.', loadServices);
  }
}

// --- мастера --------------------------------------------------------------

function masterCard(master) {
  const card = el('div', 'card master');

  const avatar = el('span', 'avatar');
  if (master.photo_url) {
    const img = el('img');
    img.src = master.photo_url;
    img.alt = '';
    // Битая ссылка на фото не должна оставлять в карточке пустой кружок.
    img.addEventListener('error', () => { avatar.textContent = initials(master.name); });
    avatar.append(img);
  } else {
    avatar.textContent = initials(master.name);
  }

  const id = el('div', 'master__id');
  id.append(el('b', 'h3', master.name));
  if (master.specialization) id.append(el('span', 'body-s muted', master.specialization));

  card.append(avatar, id);
  if (master.bio) card.append(el('p', 'prose body-s muted', master.bio));

  const book = el('a', 'btn btn--outline btn--block', 'Записаться к мастеру');
  book.href = bookingHref({ masterId: master.id });
  card.append(book);

  return card;
}

function renderMasters(masters) {
  const box = $('#masters');

  if (!masters.length) {
    box.replaceChildren(el('p', 'prose body-m muted', 'Список мастеров пока пуст.'));
    box.setAttribute('aria-busy', 'false');
    return;
  }

  box.replaceChildren(...masters.map(masterCard));
  box.setAttribute('aria-busy', 'false');
  $('#trust-masters').textContent = plural(masters.length, 'мастер', 'мастера', 'мастеров');
}

async function loadMasters() {
  const box = $('#masters');
  showSkeletons(box, masterSkeleton, SKELETON_COUNT.masters);
  try {
    const data = await apiGet('/api/masters');
    renderMasters(data.masters ?? []);
  } catch {
    showError(box, 'Не удалось загрузить мастеров.', loadMasters);
  }
}

// --------------------------------------------------------------------------
// Старт
// --------------------------------------------------------------------------

wireScreenLinks();
setupTheme();
setupMenu();
setupFloatingCta();
setupFaq();
renderHours();
setupSession();
loadServices();
loadMasters();
