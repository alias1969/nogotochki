/**
 * Шаг B2 «Мастер».
 *
 * Список запрашивается уже с учётом выбранных услуг:
 * GET /api/masters?service_ids=… возвращает только тех, кто делает
 * весь набор, — это и есть ответ на вопрос «кто подходит».
 *
 * Но тех, кто не подходит, экран тоже показывает — неактивными
 * и с пояснением, чего именно мастер не делает. Поэтому берётся и полный
 * список GET /api/masters: в нём у каждого есть service_ids, и по нему
 * видно, каких услуг не хватает. Решает, кто активен, всё равно первый
 * запрос — второй нужен только чтобы недоступных было видно, а не чтобы
 * они молча исчезли.
 */
import { wireScreenLinks, setupTheme, initials } from './shared.js';
import {
  $, el, selection, renderSteps, summaryLine, setNext,
  get, fetchTotals, skeletonCards, line, duration, money, SCREENS,
} from './booking.js';

wireScreenLinks();
setupTheme();

const box = $('#masters');
const chosenServices = selection.read().services;
let master = selection.read().master;      // число, 'any' или null
let serviceNames = new Map();

function picked() {
  return { services: chosenServices, master };
}

renderSteps(2, picked());

const backHref = selection.href('B1', { services: chosenServices, master: null });
$('#back').href = backHref;
$('#edit-services').href = backHref;
$('#fix-services').href = backHref;
$('#go-services').href = SCREENS.B1;

function syncUrl() {
  history.replaceState(null, '', selection.href('B2', picked()));
}

function refreshNext() {
  setNext(master !== null, 'Выберите мастера или «Любой мастер»');
}

// --------------------------------------------------------------------------
// Карточки
// --------------------------------------------------------------------------

function pickRow({ id, avatar, name, lines, bio, why }) {
  const label = el('label', 'pick');

  const input = el('input');
  input.type = 'radio';
  input.name = 'master';
  input.checked = master === id;
  input.disabled = Boolean(why);
  input.addEventListener('change', () => {
    master = id;
    syncUrl();
    refreshNext();
  });

  const body = el('div', 'pick__body');
  body.append(el('b', 'm-name', name));
  for (const text of lines) body.append(el('span', 'm-line', text));
  if (bio) body.append(el('p', 'm-bio', bio));

  if (why) {
    const note = el('span', 'm-why');
    note.innerHTML = '<svg class="icon icon--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4.5M12 16h.01"></path></svg>';
    note.append(el('span', null, why));
    body.append(note);
  }

  const row = el('div', 'pick__row');
  row.append(input, avatar, body);
  label.append(row);
  return label;
}

function avatarFor(m) {
  const box = el('span', 'm-avatar');
  if (m.photo_url) {
    const img = el('img');
    img.src = m.photo_url;
    img.alt = '';
    img.addEventListener('error', () => { box.textContent = initials(m.name); });
    box.append(img);
  } else {
    box.textContent = initials(m.name);
  }
  return box;
}

function anyCard() {
  const avatar = el('span', 'm-avatar m-avatar--any');
  avatar.innerHTML = '<svg class="icon icon--l" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.4"></circle><path d="M3 20a6 6 0 0 1 12 0M16.5 5.4a3.4 3.4 0 0 1 0 6.4M19 19.6a5.8 5.8 0 0 0-2.2-4.2"></path></svg>';
  return pickRow({
    id: 'any',
    avatar,
    name: 'Любой мастер',
    lines: ['Кто освободится раньше'],
    bio: null,
    why: null,
  });
}

/** Каких из выбранных услуг мастер не делает — по его же service_ids. */
function missingFor(m) {
  const can = new Set(m.service_ids ?? []);
  return chosenServices.filter((id) => !can.has(id)).map((id) => serviceNames.get(id) ?? `услуга №${id}`);
}

// --------------------------------------------------------------------------
// Загрузка
// --------------------------------------------------------------------------

async function load() {
  $('#load-error').hidden = true;
  $('#none-fit').hidden = true;

  // Без услуг шаг 2 не имеет смысла: подбирать не под что.
  if (!chosenServices.length) {
    box.replaceChildren();
    box.setAttribute('aria-busy', 'false');
    $('#no-services').hidden = false;
    $('#chosen-names').textContent = 'Ничего не выбрано';
    setNext(false, 'Сначала выберите услуги');
    return;
  }

  skeletonCards(box, 3, () => [line('skeleton__line--title'), line('skeleton__line--short'), line()]);

  try {
    // Итог и оба списка — одним заходом.
    const [totals, fitting, all] = await Promise.all([
      fetchTotals(chosenServices),
      get(`/api/masters?service_ids=${chosenServices.join(',')}`),
      get('/api/masters'),
    ]);

    serviceNames = new Map(totals.services.map((s) => [s.id, s.name]));
    $('#chosen-names').textContent = totals.services.map((s) => s.name).join(' · ');
    $('#chosen-totals').textContent = `${duration(totals.duration_min)} · ${money(totals.total_price_kopecks)}`;
    $('#bar-sum').textContent = summaryLine(totals);

    const fits = new Set((fitting.masters ?? []).map((m) => m.id));
    const everyone = all.masters ?? [];

    if (!fits.size) {
      box.replaceChildren();
      box.setAttribute('aria-busy', 'false');
      $('#none-fit').hidden = false;
      setNext(false, 'Подходящих мастеров нет');
      return;
    }

    // Выбранный раньше мастер мог перестать подходить: услуги с тех пор
    // поменяли. Молча оставлять его выбранным нельзя.
    if (typeof master === 'number' && !fits.has(master)) {
      master = null;
      syncUrl();
    }

    const cards = [anyCard()];
    for (const m of everyone) {
      const missing = fits.has(m.id) ? [] : missingFor(m);
      cards.push(pickRow({
        id: m.id,
        avatar: avatarFor(m),
        name: m.name,
        lines: m.specialization ? [m.specialization] : [],
        bio: m.bio,
        why: missing.length ? `Не делает: ${missing.join(', ')}` : null,
      }));
    }

    box.replaceChildren(...cards);
    box.setAttribute('aria-busy', 'false');
    refreshNext();
  } catch {
    box.replaceChildren();
    box.setAttribute('aria-busy', 'false');
    $('#load-error').hidden = false;
    setNext(false, 'Список мастеров не загрузился');
  }
}

$('#retry').addEventListener('click', load);

$('#next').addEventListener('click', () => {
  if (master === null) return;
  location.href = selection.href('B3', picked());
});

$('#bar-note').textContent = 'Оплата на месте';

load();
