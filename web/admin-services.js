/**
 * Экран A5 «Админ — Услуги».
 *
 * Две панели: категории прайса и сами услуги. Данные — настоящие,
 * через /api/admin/service-categories и /api/admin/services; поиск
 * и фильтр по категории — на уже загруженном в браузере списке услуг,
 * сервер поиска не делает.
 */
import {
  $, el, api, initAdminShell, showForbidden, tag, money, duration,
} from './admin-shell.js';

const ICON_EDIT = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16v4Z"></path></svg>';
const ICON_TRASH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"></path></svg>';

let categories = [];
let services = [];
let editingCategory = null;
let editingService = null;

// --------------------------------------------------------------------------
// Мелочи разметки
// --------------------------------------------------------------------------

function skeletonRows(count, cols) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const row = el('tr', 'adm-table-skel');
    const td = document.createElement('td');
    td.colSpan = cols;
    td.append(el('span', 'skeleton__line'));
    row.append(td);
    rows.push(row);
  }
  return rows;
}

function iconButton(iconSvg, label, onClick, { danger = false } = {}) {
  const btn = el('button', `adm-iconbtn${danger ? ' adm-iconbtn--danger' : ''}`);
  btn.type = 'button';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = iconSvg;
  btn.addEventListener('click', onClick);
  return btn;
}

/** Переключатель «Активна/Скрыта» — сохраняет сразу через onChange(next). */
function activeSwitch(isActive, onChange) {
  const wrap = el('label', 'adm-switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(isActive);
  const track = el('span', 'adm-switch__track');
  const text = el('span', 'adm-switch__label', isActive ? 'Активна' : 'Скрыта');
  wrap.append(input, track, text);

  input.addEventListener('change', async () => {
    const next = input.checked;
    input.disabled = true;
    try {
      await onChange(next);
      text.textContent = next ? 'Активна' : 'Скрыта';
    } catch (error) {
      input.checked = !next;
      if (error.status === 403) { showForbidden(); return; }
      alert(error.message);
    } finally {
      input.disabled = false;
    }
  });

  return wrap;
}

// --------------------------------------------------------------------------
// Категории
// --------------------------------------------------------------------------

function categoryRow(cat) {
  const tr = document.createElement('tr');

  const tdName = document.createElement('td');
  tdName.append(el('span', 'adm-table__name', cat.name));
  tr.append(tdName);

  const tdCount = document.createElement('td');
  tdCount.className = 'num';
  tdCount.textContent = `${cat.services_active} на витрине из ${cat.services_total}`;
  tr.append(tdCount);

  const tdActive = document.createElement('td');
  tdActive.append(activeSwitch(cat.is_active, (next) => api(`/api/admin/service-categories/${cat.id}`, {
    method: 'PATCH', body: { is_active: next },
  })));
  tr.append(tdActive);

  const tdActions = document.createElement('td');
  const actions = el('div', 'adm-table__actions');
  actions.append(
    iconButton(ICON_EDIT, 'Редактировать категорию', () => openCategoryModal(cat)),
    iconButton(ICON_TRASH, 'Снять категорию с витрины', () => deleteCategory(cat), { danger: true }),
  );
  tdActions.append(actions);
  tr.append(tdActions);

  return tr;
}

function renderCategories() {
  const tbody = $('#cat-tbody');
  tbody.replaceChildren();
  for (const cat of categories) tbody.append(categoryRow(cat));
  $('#cat-empty').hidden = categories.length > 0;
}

function openCategoryModal(cat) {
  editingCategory = cat;
  $('#category-modal-title').textContent = cat ? 'Редактировать категорию' : 'Новая категория';
  $('#category-name').value = cat ? cat.name : '';
  $('#category-modal-error').hidden = true;
  $('#category-modal-backdrop').hidden = false;
  $('#category-name').focus();
}

function closeCategoryModal() {
  $('#category-modal-backdrop').hidden = true;
  editingCategory = null;
}

function showCategoryModalError(message) {
  const notice = $('#category-modal-error');
  notice.hidden = false;
  notice.querySelector('p').textContent = message;
}

function wireCategoryModal() {
  $('#category-modal-close').addEventListener('click', closeCategoryModal);
  $('#category-modal-cancel').addEventListener('click', closeCategoryModal);
  $('#category-modal-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeCategoryModal();
  });
  $('#category-modal-save').addEventListener('click', async () => {
    const name = $('#category-name').value.trim();
    if (!name) { showCategoryModalError('Введите название категории'); return; }

    const button = $('#category-modal-save');
    button.disabled = true;
    try {
      if (editingCategory) {
        await api(`/api/admin/service-categories/${editingCategory.id}`, { method: 'PATCH', body: { name } });
      } else {
        await api('/api/admin/service-categories', { method: 'POST', body: { name } });
      }
      closeCategoryModal();
      await loadAll();
    } catch (error) {
      if (error.status === 403) { showForbidden(); return; }
      showCategoryModalError(error.message);
    } finally {
      button.disabled = false;
    }
  });
}

async function deleteCategory(cat) {
  const ok = confirm(
    `Категория «${cat.name}» и все её услуги (сейчас ${cat.services_total}) будут сняты с витрины. `
    + 'Это не удаление — данные останутся в истории записей. Продолжить?',
  );
  if (!ok) return;

  try {
    const { hidden_services: hiddenServices } = await api(`/api/admin/service-categories/${cat.id}`, { method: 'DELETE' });
    await loadAll();
    alert(`Категория снята с витрины. Вместе с ней скрыто услуг: ${hiddenServices}.`);
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    alert(error.message);
  }
}

// --------------------------------------------------------------------------
// Услуги
// --------------------------------------------------------------------------

function fillCategorySelects() {
  const filterSelect = $('#svc-filter-category');
  const modalSelect = $('#service-category');
  const prevFilter = filterSelect.value;

  const allOption = el('option', null, 'Все категории');
  allOption.value = 'all';
  filterSelect.replaceChildren(allOption);
  modalSelect.replaceChildren();

  for (const cat of categories) {
    const filterOption = el('option', null, cat.name);
    filterOption.value = String(cat.id);
    filterSelect.append(filterOption);

    const modalOption = el('option', null, cat.is_active ? cat.name : `${cat.name} (скрыта)`);
    modalOption.value = String(cat.id);
    modalSelect.append(modalOption);
  }

  if ([...filterSelect.options].some((opt) => opt.value === prevFilter)) filterSelect.value = prevFilter;
}

function serviceRow(svc) {
  const tr = document.createElement('tr');

  const tdName = document.createElement('td');
  tdName.append(el('span', 'adm-table__name', svc.name));
  if (svc.description) tdName.append(el('span', 'adm-table__sub', svc.description));
  tr.append(tdName);

  const tdCat = document.createElement('td');
  tdCat.append(tag(svc.category?.name ?? '—', 'neutral'));
  tr.append(tdCat);

  const tdDur = document.createElement('td');
  tdDur.className = 'num';
  tdDur.textContent = duration(svc.duration_min);
  tr.append(tdDur);

  const tdPrice = document.createElement('td');
  tdPrice.className = 'num';
  tdPrice.textContent = money(svc.price_kopecks);
  tr.append(tdPrice);

  const tdActive = document.createElement('td');
  tdActive.append(activeSwitch(svc.is_active, (next) => api(`/api/admin/services/${svc.id}`, {
    method: 'PATCH', body: { is_active: next },
  })));
  tr.append(tdActive);

  const tdActions = document.createElement('td');
  const actions = el('div', 'adm-table__actions');
  actions.append(
    iconButton(ICON_EDIT, 'Редактировать услугу', () => openServiceModal(svc)),
    iconButton(ICON_TRASH, 'Снять услугу с витрины', () => deleteService(svc), { danger: true }),
  );
  tdActions.append(actions);
  tr.append(tdActions);

  return tr;
}

function renderServices(list) {
  const tbody = $('#svc-tbody');
  tbody.replaceChildren();
  for (const svc of list) tbody.append(serviceRow(svc));
  $('#svc-empty').hidden = list.length > 0;
}

function applyServiceFilters() {
  const categoryFilter = $('#svc-filter-category').value;
  const query = $('#svc-search').value.trim().toLowerCase();
  const filtered = services.filter((svc) => {
    if (categoryFilter !== 'all' && String(svc.category?.id) !== categoryFilter) return false;
    if (query && !svc.name.toLowerCase().includes(query)) return false;
    return true;
  });
  renderServices(filtered);
}

function wireFilters() {
  $('#svc-filter-category').addEventListener('change', applyServiceFilters);
  $('#svc-search').addEventListener('input', applyServiceFilters);
}

function openServiceModal(svc) {
  editingService = svc;
  $('#service-modal-title').textContent = svc ? 'Редактировать услугу' : 'Новая услуга';
  $('#service-name').value = svc ? svc.name : '';
  const categorySelect = $('#service-category');
  categorySelect.value = svc ? String(svc.category?.id ?? '') : (categorySelect.options[0]?.value ?? '');
  $('#service-description').value = svc?.description ?? '';
  $('#service-duration').value = svc ? String(svc.duration_min) : '';
  $('#service-price').value = svc ? (svc.price_kopecks / 100).toFixed(2) : '';
  $('#service-modal-error').hidden = true;
  $('#service-modal-backdrop').hidden = false;
  $('#service-name').focus();
}

function closeServiceModal() {
  $('#service-modal-backdrop').hidden = true;
  editingService = null;
}

function showServiceModalError(message) {
  const notice = $('#service-modal-error');
  notice.hidden = false;
  notice.querySelector('p').textContent = message;
}

function wireServiceModal() {
  $('#service-modal-close').addEventListener('click', closeServiceModal);
  $('#service-modal-cancel').addEventListener('click', closeServiceModal);
  $('#service-modal-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeServiceModal();
  });
  $('#service-modal-save').addEventListener('click', async () => {
    const name = $('#service-name').value.trim();
    const categoryId = Number($('#service-category').value);
    const description = $('#service-description').value.trim();
    const durationMin = Number($('#service-duration').value);
    const priceRub = $('#service-price').value;

    if (!name) { showServiceModalError('Введите название услуги'); return; }
    if (!categoryId) { showServiceModalError('Выберите категорию'); return; }
    if (!Number.isFinite(durationMin) || durationMin < 5 || durationMin > 600) {
      showServiceModalError('Длительность — от 5 до 600 минут');
      return;
    }
    if (priceRub === '' || Number.isNaN(Number(priceRub)) || Number(priceRub) < 0) {
      showServiceModalError('Укажите цену — число не может быть отрицательным');
      return;
    }

    const body = {
      category_id: categoryId,
      name,
      description: description || null,
      duration_min: durationMin,
      price_kopecks: Math.round(Number(priceRub) * 100),
    };

    const button = $('#service-modal-save');
    button.disabled = true;
    try {
      if (editingService) {
        await api(`/api/admin/services/${editingService.id}`, { method: 'PATCH', body });
      } else {
        await api('/api/admin/services', { method: 'POST', body });
      }
      closeServiceModal();
      await loadAll();
    } catch (error) {
      if (error.status === 403) { showForbidden(); return; }
      showServiceModalError(error.message);
    } finally {
      button.disabled = false;
    }
  });
}

async function deleteService(svc) {
  const ok = confirm(`Услуга «${svc.name}» будет снята с витрины. Она останется в истории записей. Продолжить?`);
  if (!ok) return;

  try {
    await api(`/api/admin/services/${svc.id}`, { method: 'DELETE' });
    await loadAll();
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    alert(error.message);
  }
}

// --------------------------------------------------------------------------
// Загрузка экрана
// --------------------------------------------------------------------------

async function loadAll() {
  $('#cat-error').hidden = true;
  $('#svc-error').hidden = true;
  $('#cat-table').hidden = false;
  $('#svc-table').hidden = false;
  $('#cat-empty').hidden = true;
  $('#svc-empty').hidden = true;
  $('#cat-tbody').replaceChildren(...skeletonRows(3, 4));
  $('#svc-tbody').replaceChildren(...skeletonRows(4, 6));

  try {
    const [{ categories: cats }, { services: svcs }] = await Promise.all([
      api('/api/admin/service-categories'),
      api('/api/admin/services'),
    ]);
    categories = cats;
    services = svcs;

    fillCategorySelects();
    renderCategories();
    applyServiceFilters();
  } catch (error) {
    if (error.status === 403) { showForbidden(); return; }
    $('#cat-table').hidden = true;
    $('#svc-table').hidden = true;
    $('#cat-error').hidden = false;
    $('#svc-error').hidden = false;
  }
}

async function main() {
  const me = await initAdminShell({ active: 'A5' });
  if (!me) return;

  wireCategoryModal();
  wireServiceModal();
  wireFilters();

  $('#cat-add').addEventListener('click', () => openCategoryModal(null));
  $('#svc-add').addEventListener('click', () => openServiceModal(null));
  $('#cat-retry').addEventListener('click', loadAll);
  $('#svc-retry').addEventListener('click', loadAll);

  await loadAll();
}

main();
