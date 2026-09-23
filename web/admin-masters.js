/**
 * Экран A6 «Админ — Мастера».
 *
 * Карточки мастеров студии: кто есть, чем занимается, сколько услуг
 * закреплено, привязан ли аккаунт для входа в кабинет мастера.
 * Данные настоящие: GET /api/admin/masters — список карточек,
 * GET /api/admin/services — прайс для сетки чекбоксов в форме,
 * GET /api/admin/users?role=master&search= — поиск аккаунта для привязки.
 */
import {
  $, $$, el, api, initAdminShell, showForbidden, tag, initials, SCREENS,
} from './admin-shell.js';

let services = [];
let editingMaster = null;

/**
 * Выбор аккаунта в форме.
 * undefined — поле не трогали (в PATCH не отправляется вовсе);
 * null — явно «без аккаунта»; число — id выбранного пользователя.
 */
let accountChoice;
let accountLabel = '';
let searchTimer = null;

// --------------------------------------------------------------------------
// Таблица мастеров
// --------------------------------------------------------------------------

function skeletonRow() {
  const tr = el('tr', 'adm-table-skel');
  for (let i = 0; i < 5; i += 1) {
    const td = el('td');
    td.append(el('span', 'skeleton__line'));
    tr.append(td);
  }
  return tr;
}

function iconBtn(iconSvg, { label, danger = false }) {
  const btn = el('button', `adm-iconbtn${danger ? ' adm-iconbtn--danger' : ''}`);
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.innerHTML = iconSvg;
  return btn;
}

const EDIT_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16v4Z"></path></svg>';
const SCHEDULE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="17" rx="3"></rect><path d="M3 9.5h18M8 2.5v4M16 2.5v4"></path></svg>';
const POWER_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5v8"></path><path d="M7 6.2a7.2 7.2 0 1 0 10 0"></path></svg>';

function masterRow(m) {
  const tr = el('tr');

  const nameTd = el('td');
  const wrap = el('div', 'mst-name');
  wrap.append(el('span', 'avatar avatar--sm', initials(m.name)));
  const textWrap = el('div', 'mst-name__text');
  textWrap.append(el('span', 'adm-table__name', m.name || '—'));
  wrap.append(textWrap);
  nameTd.append(wrap);

  const specTd = el('td', null, m.specialization || '—');
  const svcTd = el('td', 'num', String(m.service_ids?.length ?? 0));

  const statusTd = el('td');
  statusTd.append(tag(m.is_active ? 'Активен' : 'Выключен', m.is_active ? 'success' : 'neutral'));

  const actionsTd = el('td');
  const actions = el('div', 'adm-table__actions');

  const editButton = iconBtn(EDIT_ICON, { label: 'Править' });
  editButton.addEventListener('click', () => openModal(m));

  const scheduleLink = el('a', 'adm-iconbtn');
  scheduleLink.setAttribute('aria-label', 'График');
  scheduleLink.title = 'График';
  scheduleLink.innerHTML = SCHEDULE_ICON;
  scheduleLink.href = `${SCREENS.A7}?master_id=${m.id}`;

  const toggleButton = iconBtn(POWER_ICON, {
    label: m.is_active ? 'Выключить' : 'Включить',
    danger: m.is_active,
  });
  toggleButton.addEventListener('click', () => {
    if (m.is_active) deactivateMaster(m); else activateMaster(m);
  });

  actions.append(editButton, scheduleLink, toggleButton);
  actionsTd.append(actions);

  tr.append(nameTd, specTd, svcTd, statusTd, actionsTd);
  return tr;
}

async function deactivateMaster(m) {
  const ok = confirm(
    `Выключить мастера «${m.name}»?\n\n`
    + 'Карточка исчезнет с сайта и из выбора при записи. Уже подтверждённые '
    + 'записи при этом не отменяются — их нужно перенести вручную.',
  );
  if (!ok) return;
  try {
    const result = await api(`/api/admin/masters/${m.id}`, { method: 'DELETE' });
    const upcoming = result.upcoming_appointments ?? 0;
    alert(upcoming > 0
      ? `Мастер выключен. Будущих записей у него: ${upcoming} — перенесите их вручную в разделе «Записи».`
      : 'Мастер выключен.');
    await loadMasters();
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    alert(error.message);
  }
}

async function activateMaster(m) {
  try {
    await api(`/api/admin/masters/${m.id}`, { method: 'PATCH', body: { is_active: true } });
    await loadMasters();
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    alert(error.message);
  }
}

async function loadMasters() {
  $('#masters-error').hidden = true;
  $('#masters-empty').hidden = true;
  const tbody = $('#masters-tbody');
  tbody.replaceChildren(skeletonRow(), skeletonRow(), skeletonRow());

  try {
    const [{ masters }, { services: svcRows }] = await Promise.all([
      api('/api/admin/masters'),
      api('/api/admin/services'),
    ]);
    services = svcRows;

    tbody.replaceChildren();
    for (const m of masters) tbody.append(masterRow(m));
    $('#masters-empty').hidden = masters.length > 0;
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    tbody.replaceChildren();
    $('#masters-error').hidden = false;
  }
}

// --------------------------------------------------------------------------
// Модалка создания / редактирования
// --------------------------------------------------------------------------

function renderAccountChip() {
  const chip = $('#master-account-chip');
  if (accountChoice === undefined) {
    chip.hidden = true;
    chip.textContent = '';
    return;
  }
  chip.hidden = false;
  chip.textContent = accountChoice === null ? 'Без аккаунта' : accountLabel;
}

function renderServiceGrid(selectedIds) {
  const grid = $('#master-services-grid');
  grid.replaceChildren();
  const selected = new Set(selectedIds);
  for (const s of services) {
    const label = el('label', 'adm-check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(s.id);
    input.checked = selected.has(s.id);
    label.append(input, document.createTextNode(s.is_active ? s.name : `${s.name} (неактивна)`));
    grid.append(label);
  }
}

function openModal(m) {
  editingMaster = m;
  accountChoice = undefined;
  accountLabel = '';

  $('#master-modal-title').textContent = m ? 'Карточка мастера' : 'Новый мастер';
  $('#master-name').value = m ? (m.name ?? '') : '';
  $('#master-spec').value = m ? (m.specialization ?? '') : '';
  $('#master-bio').value = m ? (m.bio ?? '') : '';
  $('#master-photo').value = m ? (m.photo_url ?? '') : '';
  $('#master-active').checked = m ? Boolean(m.is_active) : true;

  $('#master-account-search').value = '';
  $('#master-account-results').replaceChildren();
  $('#master-account-results').hidden = true;
  renderAccountChip();

  renderServiceGrid(m ? (m.service_ids ?? []) : []);

  $('#master-error').hidden = true;
  $('#master-modal-backdrop').hidden = false;
  $('#master-name').focus();
}

function closeModal() {
  $('#master-modal-backdrop').hidden = true;
  editingMaster = null;
}

async function runAccountSearch(query) {
  const box = $('#master-account-results');
  try {
    const { users } = await api(`/api/admin/users?role=master&search=${encodeURIComponent(query)}`);
    box.replaceChildren();
    if (!users.length) {
      const empty = el('button', 'mst-acct__opt', 'Ничего не найдено');
      empty.type = 'button';
      empty.disabled = true;
      box.append(empty);
    } else {
      for (const u of users) {
        const optText = `${u.full_name} · ${u.email}`;
        const opt = el('button', 'mst-acct__opt', optText);
        opt.type = 'button';
        opt.addEventListener('click', () => {
          accountChoice = u.id;
          accountLabel = optText;
          $('#master-account-search').value = u.full_name ?? '';
          box.hidden = true;
          renderAccountChip();
        });
        box.append(opt);
      }
    }
    box.hidden = false;
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    box.hidden = true;
  }
}

function wireModal() {
  $('#master-modal-close').addEventListener('click', closeModal);
  $('#master-cancel').addEventListener('click', closeModal);
  $('#master-modal-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal();
  });

  const searchInput = $('#master-account-search');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = searchInput.value.trim();
    if (!query) {
      $('#master-account-results').hidden = true;
      $('#master-account-results').replaceChildren();
      return;
    }
    searchTimer = setTimeout(() => runAccountSearch(query), 300);
  });
  document.addEventListener('click', (event) => {
    const box = $('#master-account-results');
    if (!box || box.hidden) return;
    if (event.target === searchInput || box.contains(event.target)) return;
    box.hidden = true;
  });

  $('#master-account-clear').addEventListener('click', (event) => {
    event.preventDefault();
    accountChoice = null;
    accountLabel = '';
    searchInput.value = '';
    $('#master-account-results').hidden = true;
    renderAccountChip();
  });

  $('#master-save').addEventListener('click', submitMaster);
}

async function submitMaster() {
  const body = {
    display_name: $('#master-name').value.trim() || null,
    specialization: $('#master-spec').value.trim() || null,
    bio: $('#master-bio').value.trim() || null,
    photo_url: $('#master-photo').value.trim() || null,
    is_active: $('#master-active').checked,
    service_ids: $$('#master-services-grid input[type="checkbox"]:checked').map((input) => Number(input.value)),
  };
  if (accountChoice !== undefined) body.user_id = accountChoice;

  const saveButton = $('#master-save');
  saveButton.disabled = true;
  $('#master-error').hidden = true;

  try {
    if (editingMaster) {
      await api(`/api/admin/masters/${editingMaster.id}`, { method: 'PATCH', body });
    } else {
      await api('/api/admin/masters', { method: 'POST', body });
    }
    closeModal();
    await loadMasters();
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    const notice = $('#master-error');
    notice.hidden = false;
    notice.querySelector('p').textContent = error.message;
  } finally {
    saveButton.disabled = false;
  }
}

// --------------------------------------------------------------------------

async function main() {
  const me = await initAdminShell({ active: 'A6' });
  if (!me) return;
  wireModal();
  $('#masters-retry').addEventListener('click', loadMasters);
  $('#master-add-btn').addEventListener('click', () => openModal(null));
  await loadMasters();
}

main();
