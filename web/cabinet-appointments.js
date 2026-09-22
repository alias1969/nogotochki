/**
 * Экран K1 «Личный кабинет — Предстоящие записи».
 *
 * Список приходит из GET /api/appointments?scope=upcoming. Своими эти
 * записи делает сервер: выборка идёт по идентификатору из сессии,
 * и подставить чужой номер в запросе нельзя — параметра такого нет.
 *
 * Можно ли отменить и перенести, решает тоже сервер: в ответе есть
 * can_cancel, can_reschedule и reschedules_left, посчитанные по правилам
 * студии. Кнопки рисуются по ним, а не по нашему представлению о сроках.
 */
import {
  $, el, api, setupCabinet, setupToast, toast,
  statusOf, humanDate, initials, money, duration, SCREENS,
} from './cabinet.js';

setupToast();

const list = $('#list');

function card(ap) {
  const box = el('div', 'ap');
  const status = statusOf(ap);

  // --- шапка карточки
  const badges = el('div', 'ap__badges');
  const pill = el('span', 'status');
  pill.dataset.tone = status.tone;
  pill.innerHTML = status.icon;
  pill.append(el('span', null, status.label));
  badges.append(pill);

  const head = el('div', 'ap__head');
  head.append(
    badges,
    el('b', 'ap__when', humanDate(ap.starts_at)),
    el('span', 'ap__range', `${ap.starts_at.local_time} – ${ap.ends_at.local_time} · ${duration(ap.duration_min)}`),
  );

  const top = el('div', 'ap__top');
  top.append(head);
  // Счётчик переносов показывается, только когда он что-то значит.
  if (ap.reschedules_left != null && ap.reschedule_count > 0) {
    top.append(el('span', 'ap__moves', `Переносов осталось: ${ap.reschedules_left}`));
  }

  // --- мастер и услуги
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

  if (ap.client_note) {
    const note = el('div', 'ap__reason');
    note.textContent = `Ваш комментарий: ${ap.client_note}`;
    box.append(note);
  }

  // --- действия
  const foot = el('div', 'ap__foot');
  const buttons = el('div', 'ap__buttons');

  const move = el('button', 'btn btn--outline btn--sm', 'Перенести');
  move.type = 'button';
  move.disabled = !ap.can_reschedule;
  move.addEventListener('click', () => {
    // Перенос — экран K3, его пока нет; до него ведёт тот же путь выбора
    // времени, но с номером записи.
    location.href = `booking-reschedule.html?appointment=${ap.id}`;
  });

  const cancel = el('button', 'btn btn--outline btn--sm', 'Отменить');
  cancel.type = 'button';
  cancel.disabled = !ap.can_cancel;
  cancel.addEventListener('click', () => askCancel(ap, box));

  buttons.append(move, cancel);
  foot.append(buttons);

  // Почему кнопка выключена — объясняем, а не оставляем гадать.
  if (!ap.can_reschedule && ap.reschedules_left === 0) {
    foot.append(el('span', 'ap__note', 'Лимит переносов исчерпан'));
  } else if (!ap.can_cancel) {
    foot.append(el('span', 'ap__note',
      'Отменить и перенести онлайн уже нельзя — срок прошёл. Позвоните в студию: +7 495 123-45-67'));
  }

  box.append(foot);
  return box;
}

/**
 * Отмена.
 *
 * Спрашиваем подтверждение: отменённое время сразу уходит другим клиентам,
 * и вернуть его нажатием «назад» не получится.
 */
async function askCancel(ap, box) {
  const when = `${humanDate(ap.starts_at)}, ${ap.starts_at.local_time}`;
  if (!confirm(`Отменить запись ${when}?\n\nВремя сразу станет доступно другим клиентам.`)) return;

  const buttons = [...box.querySelectorAll('button')];
  for (const b of buttons) b.disabled = true;

  try {
    await api(`/api/appointments/${ap.id}/cancel`, { method: 'POST', body: {} });
    toast('Запись отменена', 'Время снова доступно другим клиентам');
    load();
  } catch (error) {
    // Текст — серверный: он знает, почему отмена не прошла.
    alert(error.message);
    for (const b of buttons) b.disabled = false;
  }
}

function show(which) {
  for (const id of ['loading', 'empty', 'list', 'load-error']) $(`#${id}`).hidden = id !== which;
}

async function load() {
  show('loading');
  try {
    const data = await api('/api/appointments?scope=upcoming');
    const items = data.appointments ?? [];

    if (!items.length) { show('empty'); return; }

    list.replaceChildren(...items.map(card));
    show('list');
  } catch (error) {
    $('#error-text').textContent = error.message;
    show('load-error');
  }
}

$('#retry').addEventListener('click', load);

(async () => {
  if (await setupCabinet('K1')) load();
})();
