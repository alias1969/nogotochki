/**
 * Экран K2 «Личный кабинет — История».
 *
 * Тот же эндпоинт, что и на K1, но scope=past: сервер сам решает,
 * что считать прошлым — запись либо не 'booked', либо уже закончилась.
 * Считать это на странице значило бы завести второе определение
 * «прошедшего» рядом с серверным.
 *
 * Отменённая запись из истории не исчезает: она меняет статус и остаётся
 * видимой — вместе с тем, кто именно её отменил.
 */
import {
  $, el, api, setupCabinet, setupToast,
  statusOf, humanDate, initials, money, duration,
} from './cabinet.js';

setupToast();

const list = $('#list');
let items = [];
let filter = 'all';

/** Фильтры — по тому, что реально пришло, а не по всем мыслимым статусам. */
const FILTERS = [
  { id: 'all', label: 'Все', match: () => true },
  { id: 'completed', label: 'Завершённые', match: (a) => a.status === 'completed' },
  { id: 'cancelled', label: 'Отменённые', match: (a) => a.status === 'cancelled' },
  { id: 'no_show', label: 'Не пришли', match: (a) => a.status === 'no_show' },
];

function card(ap) {
  const box = el('div', 'ap ap--past');
  const status = statusOf(ap);

  const pill = el('span', 'status');
  pill.dataset.tone = status.tone;
  pill.innerHTML = status.icon;
  pill.append(el('span', null, status.label));

  const head = el('div', 'ap__head');
  const badges = el('div', 'ap__badges');
  badges.append(pill);
  head.append(
    badges,
    el('b', 'ap__when', humanDate(ap.starts_at)),
    el('span', 'ap__range', `${ap.starts_at.local_time} – ${ap.ends_at.local_time} · ${duration(ap.duration_min)}`),
  );

  const top = el('div', 'ap__top');
  top.append(head);

  const face = el('span', 'ap__face', initials(ap.master.name));
  const who = el('div', 'ap__master');
  const whoText = el('div');
  whoText.append(el('span', 'overline', 'мастер'), el('b', null, ap.master.name));
  who.append(face, whoText);

  const services = el('div');
  services.append(el('span', 'overline', 'услуги'));
  const names = el('div', 'ap__services');
  for (const s of ap.services) names.append(el('span', null, s.name));
  services.append(names, el('span', 'ap__totals', `${duration(ap.duration_min)} · ${money(ap.total_price_kopecks)}`));

  const body = el('div', 'ap__body');
  body.append(who, services);
  box.append(top, body);

  // Причина отмены — текст, который написал тот, кто отменил.
  if (ap.cancelled?.reason) {
    box.append(el('div', 'ap__reason', `Причина: ${ap.cancelled.reason}`));
  }

  const foot = el('div', 'ap__foot');
  const buttons = el('div', 'ap__buttons');
  // «Записаться ещё раз» несёт тот же набор услуг на первый шаг.
  const again = el('a', 'btn btn--outline btn--sm', 'Записаться ещё раз');
  again.href = `booking-services.html?services=${ap.services.map((s) => s.service_id).join(',')}`;
  buttons.append(again);
  foot.append(buttons);
  box.append(foot);

  return box;
}

function drawFilters() {
  $('#filters').replaceChildren(...FILTERS
    .filter((f) => f.id === 'all' || items.some(f.match))
    .map((f) => {
      const chip = el('button', 'chip', f.label);
      chip.type = 'button';
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', String(filter === f.id));
      chip.addEventListener('click', () => { filter = f.id; drawFilters(); draw(); });
      return chip;
    }));
}

function draw() {
  const rule = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
  const shown = items.filter(rule.match);
  list.replaceChildren(...shown.map(card));
  list.hidden = shown.length === 0;
  $('#nothing').hidden = shown.length > 0;
}

function show(which) {
  for (const id of ['loading', 'empty', 'list', 'load-error']) $(`#${id}`).hidden = id !== which;
  $('#filters').hidden = which !== 'list';
  if (which !== 'list') $('#nothing').hidden = true;
}

async function load() {
  show('loading');
  try {
    const data = await api('/api/appointments?scope=past');
    items = data.appointments ?? [];

    // Пусто — это состояние списка, не отдельная страница: фильтры
    // и сам список прячутся, на их месте объяснение и кнопка записи.
    if (!items.length) { show('empty'); return; }

    show('list');
    drawFilters();
    draw();
  } catch (error) {
    $('#error-text').textContent = error.message;
    show('load-error');
  }
}

$('#retry').addEventListener('click', load);

(async () => {
  if (await setupCabinet('K2')) load();
})();
