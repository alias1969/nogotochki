/**
 * Дымовая проверка API.
 *
 * Проходит по сервису так, как по нему пойдёт живой клиент: регистрация,
 * выбор услуг, свободное время, резерв, запись, перенос, отмена — и отдельно
 * проверяет то, что должно быть запрещено: чужие записи, чужие резервы,
 * админ-панель без прав, поздняя отмена, повторное подтверждение.
 *
 * Это не модульные тесты: сервис проверяется целиком, через HTTP, на живой
 * базе. Для такого сервиса это честнее — почти все правила здесь живут
 * на стыке проверки прав, транзакции и расчёта свободного времени,
 * и по отдельности эти части ничего не доказывают.
 *
 * Запуск:
 *   npm run migrate && npm run seed
 *   npm start                       (в соседнем окне)
 *   npm test
 *
 * Проверка пишет в базу: гоняйте её на базе для разработки, не на рабочей.
 * Адрес сервиса берётся из API_URL, по умолчанию http://localhost:3000.
 */
import { DB_FILE, ADMIN } from './env.mjs';

const BASE = process.env.API_URL ?? 'http://localhost:3000';
let pass = 0, fail = 0;

async function call(method, path, { body, token, cookie } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json(), setCookie: res.headers.getSetCookie?.() ?? [] };
}
function check(name, cond, extra='') {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

/**
 * Рабочий день, общий для обоих мастеров.
 *
 * Раньше здесь стояло «сегодня плюс три дня». Это работало через раз:
 * у Ольги рабочие дни пн–пт, у Ирины вт–сб, и по средам и четвергам
 * такой расчёт попадал на субботу или воскресенье — свободных окон
 * не находилось, и набор падал не из-за кода, а из-за дня недели,
 * в который его запустили.
 *
 * Дату спрашиваем у сервера: он один знает графики мастеров, часы
 * студии, закрытия и горизонт записи.
 *
 * Поиск начинается с «плюс двое суток», а не с завтра: раздел 6 переносит
 * и раздел 7 отменяет запись на этот день от лица клиента, а клиенту это
 * разрешено не позднее чем за cancel_deadline_hours (по умолчанию 24 ч)
 * до визита. День, начатый с «завтра», мог оказаться ближе этого срока
 * в зависимости от времени суток запуска — набор падал не из-за кода,
 * а из-за часа, в который его запустили.
 */
const day = await (async () => {
  const from = new Date(Date.now() + 2*86400000).toISOString().slice(0,10);
  const ask = async (masterId, services) =>
    ((await call('GET', `/api/availability/days?master_id=${masterId}&from=${from}&service_ids=${services}`))
      .body.days ?? []).map((d) => d.date);
  const forOlga = await ask(1, '1,2');
  const forIrina = new Set(await ask(2, '2'));
  const both = forOlga.find((date) => forIrina.has(date));
  if (!both) throw new Error('Не нашлось дня, в который работают оба мастера — база засорена или графики пусты');
  return both;
})();

// --- 1. auth ---
console.log('\n1. Регистрация, вход, выход');
const email = `test${Date.now()}@example.com`;
let r = await call('POST', '/api/auth/register', { body: { email, password: 'secret12345', full_name: 'Тест Тестов', phone: '+79001112233' } });
check('регистрация 201', r.status === 201, JSON.stringify(r.body));
check('нет password_hash', !JSON.stringify(r.body).includes('password_hash'));
const token = r.body.token;
// Что завела проверка — чтобы убрать за собой в конце.
const made = { users: [r.body.user.id], appointments: [] };

r = await call('POST', '/api/auth/register', { body: { email, password: 'secret12345', full_name: 'Дубль', phone: '+79001112233' } });
check('повторный e-mail → 409', r.status === 409, r.status);
r = await call('POST', '/api/auth/register', { body: { email: 'нет-почты', password: '123', full_name: 'X', phone: 'abc' } });
check('битые данные → 400', r.status === 400, JSON.stringify(r.body));
r = await call('POST', '/api/auth/login', { body: { email, password: 'wrong-password' } });
check('неверный пароль → 401', r.status === 401);
r = await call('GET', '/api/auth/me', { token });
check('/me с токеном → 200', r.status === 200 && r.body.user.email === email);
r = await call('GET', '/api/auth/me');
check('/me без токена → 401', r.status === 401);

// --- 2. каталог ---
console.log('\n2. Услуги и мастера');
r = await call('GET', '/api/services');
check('услуги', r.status === 200 && r.body.services.length === 5);
check('цена целым числом копеек', Number.isInteger(r.body.services[0].price_kopecks));
r = await call('GET', '/api/masters?service_ids=4');
check('фильтр мастеров по услуге', r.status === 200 && r.body.masters.length === 1 && r.body.masters[0].id === 2);
r = await call('GET', '/api/masters/999');
check('нет мастера → 404', r.status === 404);

// --- 3. свободное время ---
console.log('\n3. Свободное время');
r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1,2`);
check('слоты на 90 минут', r.status === 200 && r.body.slots.length > 0, JSON.stringify(r.body).slice(0,200));
check('время в UTC + местное', r.body.slots[0].starts_at.endsWith('Z') && /^\d\d:\d\d$/.test(r.body.slots[0].local_time));
const slot90 = r.body.slots[0].starts_at;
const n90 = r.body.slots.length;
r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1,2,3,5`);
check('длинный набор даёт меньше слотов', r.body.slots.length < n90, `${r.body.slots.length} vs ${n90}`);
r = await call('GET', `/api/availability?master_id=1&date=${day}`);
check('без service_ids → 400', r.status === 400);
r = await call('GET', `/api/availability?master_id=1&date=2030-01-01&service_ids=1`);
check('за горизонтом → 422', r.status === 422, r.status);
r = await call('GET', `/api/availability/days?master_id=1&from=${day}&service_ids=1`);
check('календарь дней', r.status === 200 && r.body.days.length > 0);

// --- 4. резерв ---
console.log('\n4. Удержание слота');
r = await call('POST', '/api/holds', { token, body: { master_id: 1, starts_at: slot90, service_ids: [1,2] } });
check('резерв 201', r.status === 201, JSON.stringify(r.body).slice(0,200));
const hold = r.body.hold;
check('таймер идёт', hold.expires_in_seconds > 0 && hold.expires_in_seconds <= 600, hold.expires_in_seconds);
check('сумма в копейках', hold.total_price_kopecks === 400000, hold.total_price_kopecks);
check('длительность 90', hold.duration_min === 90);

r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1,2`);
check('удержанный слот исчез из свободных', !r.body.slots.some(s => s.starts_at === slot90));

const other = await call('POST', '/api/auth/register', { body: { email: `other${Date.now()}@example.com`, password: 'secret12345', full_name: 'Другой Клиент', phone: '+79004445566' } });
made.users.push(other.body.user.id);
r = await call('POST', '/api/holds', { token: other.body.token, body: { master_id: 1, starts_at: slot90, service_ids: [1,2] } });
check('второй клиент на тот же слот → 409', r.status === 409, r.status);
check('409 содержит свободные альтернативы', Array.isArray(r.body.error.details?.free_slots));
r = await call('GET', `/api/holds/${hold.id}`, { token: other.body.token });
check('чужой резерв → 403', r.status === 403, r.status);
r = await call('POST', '/api/holds', { token, body: { master_id: 1, starts_at: slot90, service_ids: [4] } });
check('мастер не делает услугу → 422', r.status === 422, r.status);

// --- 5. запись ---
console.log('\n5. Запись');
r = await call('POST', '/api/appointments', { body: { hold_id: hold.id } });
check('создание без входа → 401', r.status === 401, r.status);
r = await call('POST', '/api/appointments', { token, body: { hold_id: hold.id, client_note: 'Первый визит' } });
check('запись создана 201', r.status === 201, JSON.stringify(r.body).slice(0,300));
const appt = r.body.appointment;
made.appointments.push(appt.id);
check('статус booked', appt.status === 'booked');
check('время в UTC и местное', appt.starts_at.utc === slot90 && appt.starts_at.local.includes('+03:00'), JSON.stringify(appt.starts_at));
check('нет чужих персональных данных', !('client' in appt) && !('admin_note' in appt));
check('права посчитаны', typeof appt.can_cancel === 'boolean' && appt.reschedules_left === 3);

r = await call('POST', '/api/appointments', { token, body: { hold_id: hold.id } });
check('повторное подтверждение → 409', r.status === 409, r.status);
r = await call('GET', '/api/appointments?scope=upcoming', { token });
check('свои записи', r.status === 200 && r.body.appointments.some(a => a.id === appt.id));
r = await call('GET', `/api/appointments/${appt.id}`, { token: other.body.token });
check('чужая запись → 404', r.status === 404, r.status);
r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1,2`);
check('записанное время занято', !r.body.slots.some(s => s.starts_at === slot90));

// --- 6. перенос ---
console.log('\n6. Перенос');
r = await call('GET', `/api/availability?master_id=1&date=${day}&reschedule_of=${appt.id}`, { token });
check('свободное время под перенос', r.status === 200 && r.body.slots.length > 0, JSON.stringify(r.body).slice(0,200));
check('своё время видно себе', r.body.slots.some(s => s.starts_at === slot90));
// Не соседний слот: визит на 90 минут, начатый через 15 минут после старого
// времени, сам его и перекроет — проверять освобождение на нём бессмысленно.
const newSlot = r.body.slots.find(s => new Date(s.starts_at) - new Date(slot90) >= 90*60000).starts_at;
r = await call('POST', '/api/holds', { token, body: { master_id: 1, starts_at: newSlot, reschedule_of: appt.id } });
check('резерв для переноса', r.status === 201, JSON.stringify(r.body).slice(0,200));
const rhold = r.body.hold;
r = await call('POST', '/api/appointments', { token, body: { hold_id: rhold.id } });
check('резерв переноса нельзя провести как новую запись → 403', r.status === 403, r.status);
r = await call('POST', `/api/appointments/${appt.id}/reschedule`, { token, body: { hold_id: rhold.id } });
check('перенос 200', r.status === 200, JSON.stringify(r.body).slice(0,300));
check('время изменилось', r.body.appointment.starts_at.utc === newSlot);
check('счётчик переносов', r.body.appointment.reschedule_count === 1 && r.body.appointment.reschedules_left === 2);
r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1,2`);
check('старое время освободилось', r.body.slots.some(s => s.starts_at === slot90));

// --- 7. отмена ---
console.log('\n7. Отмена');
r = await call('POST', `/api/appointments/${appt.id}/cancel`, { token: other.body.token, body: {} });
check('чужую запись отменить нельзя → 404', r.status === 404, r.status);
r = await call('POST', `/api/appointments/${appt.id}/cancel`, { token, body: { reason: 'Планы изменились' } });
check('отмена 200', r.status === 200, JSON.stringify(r.body).slice(0,200));
check('статус cancelled и причина сохранена', r.body.appointment.status === 'cancelled' && r.body.appointment.cancelled.reason === 'Планы изменились');
r = await call('POST', `/api/appointments/${appt.id}/cancel`, { token, body: { reason: 'Ещё раз' } });
check('повторная отмена → 409', r.status === 409, r.status);
r = await call('GET', `/api/availability?master_id=1&date=${day}&service_ids=1,2`);
check('время вернулось в свободные', r.body.slots.some(s => s.starts_at === newSlot));
r = await call('GET', '/api/appointments?scope=past', { token });
check('отменённая осталась в истории', r.body.appointments.some(a => a.id === appt.id && a.status === 'cancelled'));

// --- 8. админ ---
console.log('\n8. Админ-панель');
r = await call('GET', '/api/admin/appointments', { token });
check('клиент в админку → 403', r.status === 403, r.status);
const admin = await call('POST', '/api/auth/login', { body: { email: ADMIN.email, password: ADMIN.password } });
check('вход администратора', admin.status === 200 && admin.body.user.roles.includes('admin'), JSON.stringify(admin.body).slice(0,200));
const at = admin.body.token;
r = await call('GET', `/api/admin/appointments?date=${day}`, { token: at });
check('все записи на день', r.status === 200 && Array.isArray(r.body.appointments));
check('администратору видны контакты клиента', r.body.appointments.length === 0 || 'client' in r.body.appointments[0]);
r = await call('GET', '/api/admin/appointments?status=выдумка', { token: at });
check('неверный статус → 400', r.status === 400, r.status);

r = await call('POST', '/api/admin/services', { token: at, body: { category_id: 1, name: `Тестовая услуга ${Date.now()}`, duration_min: 45, price_kopecks: 123456 } });
check('услуга создана 201', r.status === 201, JSON.stringify(r.body).slice(0,200));
const sid = r.body.service.id;
r = await call('PATCH', `/api/admin/services/${sid}`, { token: at, body: { price_kopecks: 200000 } });
check('цена изменена', r.status === 200 && r.body.service.price_kopecks === 200000);
r = await call('PATCH', `/api/admin/services/${sid}`, { token: at, body: { price_kopecks: -5 } });
check('отрицательная цена → 400', r.status === 400, r.status);
r = await call('DELETE', `/api/admin/services/${sid}`, { token: at });
check('услуга снята с витрины', r.status === 200 && r.body.deactivated);
r = await call('GET', '/api/services');
check('снятой услуги нет на витрине', !r.body.services.some(s => s.id === sid));
r = await call('GET', '/api/admin/services', { token: at });
check('администратор видит снятую', r.body.services.some(s => s.id === sid && s.is_active === false));

r = await call('POST', '/api/admin/masters', { token: at, body: { display_name: 'Новый мастер', specialization: 'Проба', service_ids: [1,2] } });
check('мастер создан 201', r.status === 201, JSON.stringify(r.body).slice(0,200));
const mid = r.body.master.id;
check('услуги привязаны', JSON.stringify(r.body.master.service_ids) === '[1,2]');
r = await call('PATCH', `/api/admin/masters/${mid}`, { token: at, body: { service_ids: [3] } });
check('набор услуг перезаписан', JSON.stringify(r.body.master.service_ids) === '[3]');
r = await call('POST', '/api/admin/masters', { token: at, body: { user_id: 4 } });
check('привязка аккаунта клиента → 422', r.status === 422, r.status);
r = await call('DELETE', `/api/admin/masters/${mid}`, { token: at });
check('мастер выключен', r.status === 200 && 'upcoming_appointments' in r.body);
r = await call('GET', '/api/masters');
check('выключенного нет на витрине', !r.body.masters.some(m => m.id === mid));

// --- 9. выход ---
console.log('\n9. Выход');
r = await call('POST', '/api/auth/logout', { token });
check('выход 200', r.status === 200);
r = await call('GET', '/api/auth/me', { token });
check('токен после выхода не работает → 401', r.status === 401, r.status);

// --- 10. прочее ---
console.log('\n10. Прочее');
r = await call('GET', '/api/нет-такого');
check('несуществующий адрес → 404', r.status === 404);
r = await call('DELETE', '/api/services');
check('неверный метод → 405', r.status === 405, r.status);


// Второй сценарий вынесен в отдельный блок: у него свои клиенты, свой день
// и свои переменные с теми же именами, что и выше.
{
console.log('\nГость: резерв без входа, затем регистрация');

let r=await call('GET',`/api/availability?master_id=2&date=${day}&service_ids=1`);
const slot=r.body.slots[0].starts_at;
r=await call('POST','/api/holds',{body:{master_id:2,starts_at:slot,service_ids:[1]}});
check('гость занял слот 201',r.status===201,JSON.stringify(r.body).slice(0,200));
const holdId=r.body.hold.id;
const guestCookie=r.setCookie.find(c=>c.startsWith('nog_guest='));
check('выдана гостевая cookie HttpOnly',!!guestCookie&&guestCookie.includes('HttpOnly'),String(guestCookie));
const cookie=guestCookie.split(';')[0];

r=await call('GET',`/api/holds/${holdId}`,{cookie});
check('гость видит свой резерв',r.status===200&&r.body.hold.id===holdId);
r=await call('GET',`/api/holds/${holdId}`);
check('без cookie чужой резерв недоступен',r.status===403,r.status);
r=await call('POST','/api/appointments',{cookie,body:{hold_id:holdId}});
check('гость не может подтвердить запись → 401',r.status===401,r.status);

const email=`guest${Date.now()}@example.com`;
r=await call('POST','/api/auth/register',{cookie,body:{email,password:'secret12345',full_name:'Гость Гостев',phone:'+79007778899'}});
check('регистрация из потока записи',r.status===201);
const token=r.body.token;
made.users.push(r.body.user.id);
r=await call('GET',`/api/holds/${holdId}`,{token});
check('резерв пережил регистрацию',r.status===200&&r.body.hold.id===holdId,JSON.stringify(r.body).slice(0,200));
r=await call('POST','/api/appointments',{token,body:{hold_id:holdId}});
check('запись создана после входа',r.status===201,JSON.stringify(r.body).slice(0,200));
const apptId=r.body.appointment.id;
made.appointments.push(apptId);

console.log('\nИстечение резерва');
const { DatabaseSync }=await import('node:sqlite');
// Путь — из env.mjs, как в уборке ниже. Вписанный сюда руками,
// он уводил проверку в основную базу, даже когда сервис работал
// с другой: DATABASE_FILE переставлял сервер, а эта строка — нет,
// и семь проверок истечения резерва отваливались без объяснения.
const db=new DatabaseSync(DB_FILE);
r=await call('GET',`/api/availability?master_id=2&date=${day}&service_ids=2`);
const free=r.body.slots.filter(s=>new Date(s.starts_at)-new Date(slot)>=120*60000);
const s2=free[0].starts_at;
r=await call('POST','/api/holds',{token,body:{master_id:2,starts_at:s2,service_ids:[2]}});
const h2=r.body.hold.id;
check('резерв поставлен',r.status===201);
r=await call('GET',`/api/availability?master_id=2&date=${day}&service_ids=2`);
check('слот занят резервом',!r.body.slots.some(s=>s.starts_at===s2));

db.prepare("UPDATE slot_holds SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 minute') WHERE id = ?").run(h2);
r=await call('GET',`/api/availability?master_id=2&date=${day}&service_ids=2`);
check('после истечения слот снова свободен',r.body.slots.some(s=>s.starts_at===s2));
const gone=db.prepare('SELECT COUNT(*) c FROM slot_holds WHERE id = ?').get(h2).c;
check('истёкший резерв удалён из базы',gone===0,gone);
r=await call('POST','/api/appointments',{token,body:{hold_id:h2}});
check('по истёкшему резерву записи нет → 409 либо 404',[404,409].includes(r.status),r.status);

console.log('\nСрок отмены');
const soon=db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now','+2 hours') t").get().t;
const soonEnd=db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now','+3 hours') t").get().t;
db.prepare('UPDATE appointments SET starts_at = ?, ends_at = ? WHERE id = ?').run(soon,soonEnd,apptId);
r=await call('GET',`/api/appointments/${apptId}`,{token});
check('отмена за 2 часа уже недоступна',r.body.appointment.can_cancel===false,JSON.stringify(r.body.appointment).slice(0,200));
r=await call('POST',`/api/appointments/${apptId}/cancel`,{token,body:{}});
check('позднюю отмену сервер не пропускает → 422',r.status===422,r.status);
const admin=await call('POST','/api/auth/login',{body:{email:ADMIN.email,password:ADMIN.password}});
r=await call('POST',`/api/appointments/${apptId}/cancel`,{token:admin.body.token,body:{}});
check('администратору без причины → 422',r.status===422,r.status);
r=await call('POST',`/api/appointments/${apptId}/cancel`,{token:admin.body.token,body:{reason:'Мастер заболел'}});
check('администратор отменяет с причиной',r.status===200,JSON.stringify(r.body).slice(0,200));
const log=db.prepare("SELECT * FROM audit_log WHERE entity_type='appointment' AND entity_id=? AND action='cancel'").get(apptId);
check('действие над чужой записью в журнале',!!log&&log.actor_role==='admin');
const note=db.prepare("SELECT * FROM notifications WHERE appointment_id=? AND kind='booking_cancelled'").get(apptId);
check('клиенту ушло уведомление в кабинет',!!note);
}

// --- уборка ---
// Услуга и карточка мастера, заведённые проверкой, остаются в прайсе
// навсегда: выключение — не удаление. Для справочников это правильно,
// для проверки — мусор, который копится с каждым запуском.
{
  const { DatabaseSync } = await import('node:sqlite');
  const cleanup = new DatabaseSync(DB_FILE);
  cleanup.exec('PRAGMA foreign_keys = ON');
  for (const [table, id] of [['services', sid], ['masters', mid]]) {
    // Удаляются только те строки, на которые никто не сослался: если
    // проверка успела создать по ним запись, внешний ключ не даст
    // стереть историю визита — и правильно сделает.
    try {
      cleanup.prepare(`DELETE FROM master_services WHERE ${table === 'masters' ? 'master_id' : 'service_id'} = ?`).run(id);
      cleanup.prepare(`DELETE FROM audit_log WHERE entity_type = ? AND entity_id = ?`)
        .run(table === 'masters' ? 'master' : 'service', id);
      cleanup.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    } catch {
      // Строка кому-то нужна — оставляем как есть.
    }
  }

  // Записи и аккаунты проверки. Раньше не убирались вовсе: за прогон
  // в базе оседали две отменённые записи и три клиента, и так каждый
  // раз. Отменённая запись слот не держит, но база от этого растёт
  // и перестаёт быть похожей на настоящую.
  for (const id of made.appointments) {
    try {
      cleanup.prepare('DELETE FROM appointment_services WHERE appointment_id = ?').run(id);
      cleanup.prepare('DELETE FROM notifications WHERE appointment_id = ?').run(id);
      cleanup.prepare('DELETE FROM slot_holds WHERE appointment_id = ? OR reschedule_of_id = ?').run(id, id);
      cleanup.prepare("DELETE FROM audit_log WHERE entity_type='appointment' AND entity_id=?").run(id);
      cleanup.prepare('DELETE FROM appointments WHERE id = ?').run(id);
    } catch { /* на запись сослались — пусть остаётся */ }
  }
  for (const id of made.users) {
    try {
      cleanup.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
      cleanup.prepare('DELETE FROM slot_holds WHERE client_id = ?').run(id);
      cleanup.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      cleanup.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
      cleanup.prepare('DELETE FROM users WHERE id = ?').run(id);
    } catch { /* на аккаунт сослались — пусть остаётся */ }
  }
  cleanup.close();
}

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail?1:0);
