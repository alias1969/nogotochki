/**
 * Графики мастеров.
 *
 * Проверяет не только то, что строки легли в базу, но и главное: что
 * правка графика сразу меняет свободное время. Слоты нигде не хранятся,
 * поэтому единственный честный способ убедиться, что график применился,
 * — спросить календарь.
 *
 * Работает на отдельном мастере, которого создаёт сам, чтобы не портить
 * расписание Ольги и Ирины из тестовых данных.
 *
 * Запуск: npm start в соседнем окне, затем npm run test:schedules
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, ADMIN, OLGA, IRINA, ANNA, MASTER_PASSWORD } from './env.mjs';

const BASE = process.env.API_URL ?? 'http://localhost:3000';


let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  ok ? (pass++, console.log('  ok  ', name)) : (fail++, console.log('  FAIL', name, extra));
};

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');

const AT = (await call('POST', '/api/auth/login', {
  body: { email: ADMIN.email, password: ADMIN.password },
})).body.token;

/** Ближайшая дата с нужным днём недели (1 — понедельник). */
function nextWeekday(weekday, minOffsetDays = 3) {
  for (let i = minOffsetDays; i < minOffsetDays + 14; i += 1) {
    const date = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
    if (((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1 === weekday) return date;
  }
  throw new Error('не нашёл дату');
}
const today = new Date().toISOString().slice(0, 10);

// --- мастер для проверки ---
let r = await call('POST', '/api/admin/masters', {
  token: AT, body: { display_name: `График ${Date.now()}`, specialization: 'Проверка', service_ids: [1, 2] },
});
const masterId = r.body.master.id;
check('мастер для проверки создан', r.status === 201, JSON.stringify(r.body).slice(0, 150));

// =====================================================================
console.log('\n1. Пустой график');
r = await call('GET', `/api/admin/masters/${masterId}/schedule`, { token: AT });
check('график читается', r.status === 200, JSON.stringify(r.body).slice(0, 150));
check('он пуст', r.body.current.length === 0 && r.body.history.length === 0);

const monday = nextWeekday(1, 3);
r = await call('GET', `/api/availability?master_id=${masterId}&date=${monday}&service_ids=1`);
check('без графика свободного времени нет', r.status === 200 && r.body.slots.length === 0, JSON.stringify(r.body).slice(0, 150));

// =====================================================================
console.log('\n2. Задание графика');
r = await call('PUT', `/api/admin/masters/${masterId}/schedule`, {
  token: AT,
  body: {
    valid_from: today,
    days: [
      { weekday: 1, work_start: '10:00', work_end: '14:00' },
      { weekday: 1, work_start: '15:00', work_end: '19:00' },
      { weekday: 2, work_start: '12:00', work_end: '18:00' },
    ],
  },
});
check('график задан', r.status === 200, JSON.stringify(r.body).slice(0, 250));
check('три интервала', r.body.intervals === 3, r.body.intervals);
check('никого не подвесили', r.body.stranded_appointments.length === 0);
check('в ответе названия дней', r.body.current[0]?.weekday_name === 'понедельник', JSON.stringify(r.body.current[0]));

r = await call('GET', `/api/availability?master_id=${masterId}&date=${monday}&service_ids=1`);
check('в понедельник появились слоты', r.body.slots.length > 0, r.body.slots.length);
check('первый слот в 10:00 по студии', r.body.slots[0].local_time === '10:00', r.body.slots[0]?.local_time);
const lunchGap = r.body.slots.some((s) => s.local_time === '14:00') === false;
check('перерыв на обед не предлагается', lunchGap, r.body.slots.map((s) => s.local_time).join(' '));
check('после перерыва работа продолжается', r.body.slots.some((s) => s.local_time === '15:00'));

const wednesday = nextWeekday(3, 3);
r = await call('GET', `/api/availability?master_id=${masterId}&date=${wednesday}&service_ids=1`);
check('в среду мастер не работает', r.body.slots.length === 0);

// =====================================================================
console.log('\n3. Проверки при задании');
const bad = async (body, name, code) => {
  const res = await call('PUT', `/api/admin/masters/${masterId}/schedule`, { token: AT, body });
  check(name, res.status === 400 || res.status === 422, `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  if (code) check(`  код ${code}`, res.body.error?.code === code, res.body.error?.code);
};
await bad({ valid_from: today, days: [{ weekday: 1, work_start: '25:00', work_end: '26:00' }] }, 'время 25:00 отклонено');
await bad({ valid_from: today, days: [{ weekday: 1, work_start: '18:00', work_end: '10:00' }] }, 'конец раньше начала отклонён', 'invalid_interval');
await bad({ valid_from: today, days: [{ weekday: 9, work_start: '10:00', work_end: '18:00' }] }, 'день недели 9 отклонён');
await bad({
  valid_from: today,
  days: [{ weekday: 1, work_start: '10:00', work_end: '14:00' }, { weekday: 1, work_start: '13:00', work_end: '16:00' }],
}, 'пересекающиеся интервалы одного дня отклонены', 'overlapping_intervals');
await bad({ valid_from: '2020-01-01', days: [{ weekday: 1, work_start: '10:00', work_end: '18:00' }] }, 'дата в прошлом отклонена', 'valid_from_in_past');
await bad({ valid_from: today, days: [{ weekday: 7, work_start: '10:00', work_end: '18:00' }] }, 'график в закрытый день студии отклонён', 'studio_closed');

r = await call('PUT', `/api/admin/masters/${masterId}/schedule`, {
  token: AT, body: { valid_from: today, days: [] },
});
check('пустой график допустим', r.status === 200 && r.body.intervals === 0, JSON.stringify(r.body).slice(0, 150));

// вернуть график обратно
await call('PUT', `/api/admin/masters/${masterId}/schedule`, {
  token: AT,
  body: {
    valid_from: today,
    days: [
      { weekday: 1, work_start: '10:00', work_end: '14:00' },
      { weekday: 1, work_start: '15:00', work_end: '19:00' },
      { weekday: 2, work_start: '12:00', work_end: '18:00' },
    ],
  },
});

const client = (await call('POST', '/api/auth/register', {
  body: { email: `sch-${Date.now()}@example.com`, password: 'secret12345', full_name: 'Клиент Графиков', phone: '+79008889900' },
})).body;

// =====================================================================
console.log('\n4. История версий');
const nextMonday = nextWeekday(1, 10);
r = await call('PUT', `/api/admin/masters/${masterId}/schedule`, {
  token: AT, body: { valid_from: nextMonday, days: [{ weekday: 1, work_start: '16:00', work_end: '20:00' }] },
});
check('новая версия принята', r.status === 200, JSON.stringify(r.body).slice(0, 200));

r = await call('GET', `/api/admin/masters/${masterId}/schedule`, { token: AT });
const closed = r.body.history.filter((row) => row.valid_to !== null);
check('прежняя версия закрыта, а не стёрта', closed.length >= 3, JSON.stringify(r.body.history).slice(0, 250));
check('закрыта накануне новой даты',
  closed[0].valid_to === new Date(new Date(`${nextMonday}T00:00:00Z`) - 86400000).toISOString().slice(0, 10),
  closed[0].valid_to);

r = await call('GET', `/api/availability?master_id=${masterId}&date=${monday}&service_ids=1`);
check('ближайший понедельник считается по старой версии', r.body.slots[0]?.local_time === '10:00', r.body.slots[0]?.local_time);
r = await call('GET', `/api/availability?master_id=${masterId}&date=${nextMonday}&service_ids=1`);
check('следующий — уже по новой', r.body.slots[0]?.local_time === '16:00', r.body.slots[0]?.local_time);

// =====================================================================
console.log('\n5. Отклонения от графика');
r = await call('GET', `/api/availability?master_id=${masterId}&date=${monday}&service_ids=1`);
const before = r.body.slots.length;

r = await call('POST', `/api/admin/masters/${masterId}/schedule-exceptions`, {
  token: AT, body: { kind: 'day_off', date_from: monday, reason: 'Личные дела' },
});
check('выходной создан', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const dayOffId = r.body.exception.id;
check('интервал переведён в UTC', r.body.exception.starts_at.utc.endsWith('Z'), JSON.stringify(r.body.exception.starts_at));
check('местная дата совпадает с заданной', r.body.exception.starts_at.local_date === monday, r.body.exception.starts_at.local_date);

r = await call('GET', `/api/availability?master_id=${masterId}&date=${monday}&service_ids=1`);
check('в выходной слотов нет', r.body.slots.length === 0, r.body.slots.length);

r = await call('DELETE', `/api/admin/schedule-exceptions/${dayOffId}`, { token: AT });
check('выходной снят', r.status === 200);
r = await call('GET', `/api/availability?master_id=${masterId}&date=${monday}&service_ids=1`);
check('время вернулось само', r.body.slots.length === before, `${r.body.slots.length} против ${before}`);

// Закрытое время — часть дня.
r = await call('GET', `/api/availability?master_id=${masterId}&date=${monday}&service_ids=1`);
const blockFrom = r.body.slots[0].starts_at;
const blockTo = new Date(new Date(blockFrom).getTime() + 90 * 60000).toISOString().slice(0, 19) + 'Z';
r = await call('POST', `/api/admin/masters/${masterId}/schedule-exceptions`, {
  token: AT, body: { kind: 'time_block', starts_at: blockFrom, ends_at: blockTo, reason: 'Поставка материалов' },
});
check('закрытое время создано', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const blockId = r.body.exception.id;
r = await call('GET', `/api/availability?master_id=${masterId}&date=${monday}&service_ids=1`);
check('закрытые часы исчезли', !r.body.slots.some((s) => s.starts_at === blockFrom));
check('остальной день на месте', r.body.slots.length > 0 && r.body.slots.length < before, r.body.slots.length);
await call('DELETE', `/api/admin/schedule-exceptions/${blockId}`, { token: AT });

// Дополнительная смена — единственный вид, который время добавляет.
r = await call('GET', `/api/availability?master_id=${masterId}&date=${wednesday}&service_ids=1`);
check('в среду по-прежнему пусто', r.body.slots.length === 0);
const shiftStart = `${wednesday}T09:00:00Z`;
r = await call('POST', `/api/admin/masters/${masterId}/schedule-exceptions`, {
  token: AT, body: { kind: 'extra_shift', starts_at: shiftStart, ends_at: `${wednesday}T13:00:00Z` },
});
check('дополнительная смена создана', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const shiftId = r.body.exception.id;
r = await call('GET', `/api/availability?master_id=${masterId}&date=${wednesday}&service_ids=1`);
check('в среду появились слоты', r.body.slots.length > 0, r.body.slots.length);
await call('DELETE', `/api/admin/schedule-exceptions/${shiftId}`, { token: AT });

r = await call('POST', `/api/admin/masters/${masterId}/schedule-exceptions`, {
  token: AT, body: { kind: 'отпуск', date_from: monday },
});
check('незнакомый вид отклонения → 400', r.status === 400, r.status);
r = await call('POST', `/api/admin/masters/${masterId}/schedule-exceptions`, {
  token: AT, body: { kind: 'vacation', date_from: monday, date_to: '2020-01-01' },
});
check('конец отпуска раньше начала → 422', r.status === 422, r.status);

// =====================================================================
console.log('\n6. Правка графика и уже назначенные визиты');
r = await call('GET', `/api/availability?master_id=${masterId}&date=${monday}&service_ids=1`);
const evening = r.body.slots.find((s) => s.local_time === '15:00');
r = await call('POST', '/api/admin/appointments', {
  token: AT, body: { client_id: client.user.id, master_id: masterId, starts_at: evening.starts_at, service_ids: [1] },
});
check('визит на вечер назначен', r.status === 201, JSON.stringify(r.body).slice(0, 200));
const apptId = r.body.appointment.id;

r = await call('PUT', `/api/admin/masters/${masterId}/schedule`, {
  token: AT, body: { valid_from: today, days: [{ weekday: 1, work_start: '10:00', work_end: '14:00' }] },
});
check('сокращённый график принят', r.status === 200, JSON.stringify(r.body).slice(0, 200));
check('повисший визит показан администратору', r.body.stranded_appointments.length === 1, JSON.stringify(r.body.stranded_appointments));
check('в нём видно имя клиента', r.body.stranded_appointments[0]?.client_name === 'Клиент Графиков');
check('визит не отменён',
  db.prepare('SELECT status FROM appointments WHERE id = ?').get(apptId).status === 'booked');

// =====================================================================
console.log('\n7. Права');
r = await call('GET', `/api/admin/masters/${masterId}/schedule`, { token: client.token });
check('клиент не читает график → 403', r.status === 403, r.status);
r = await call('PUT', `/api/admin/masters/${masterId}/schedule`, {
  token: client.token, body: { valid_from: today, days: [] },
});
check('клиент не правит график → 403', r.status === 403, r.status);
r = await call('PUT', `/api/admin/masters/${masterId}/schedule`, { body: { valid_from: today, days: [] } });
check('без входа → 401', r.status === 401, r.status);
r = await call('GET', '/api/admin/masters/99999/schedule', { token: AT });
check('несуществующий мастер → 404', r.status === 404, r.status);

const audit = db.prepare(
  "SELECT COUNT(*) c FROM audit_log WHERE entity_type IN ('master_schedule','schedule_exception')").get().c;
check('правки графика попали в журнал', audit > 0, audit);

// --- уборка ---
db.prepare('DELETE FROM appointment_services WHERE appointment_id = ?').run(apptId);
db.prepare('DELETE FROM notifications WHERE appointment_id = ?').run(apptId);
db.prepare('DELETE FROM slot_holds WHERE appointment_id = ? OR master_id = ?').run(apptId, masterId);
db.prepare("DELETE FROM audit_log WHERE entity_type='appointment' AND entity_id=?").run(apptId);
db.prepare('DELETE FROM appointments WHERE id = ?').run(apptId);
db.prepare('DELETE FROM schedule_exceptions WHERE master_id = ?').run(masterId);
db.prepare('DELETE FROM master_schedules WHERE master_id = ?').run(masterId);
db.prepare('DELETE FROM master_services WHERE master_id = ?').run(masterId);
db.prepare("DELETE FROM audit_log WHERE entity_type='master' AND entity_id=?").run(masterId);
db.prepare("DELETE FROM audit_log WHERE entity_type='master_schedule' AND entity_id=?").run(masterId);
db.prepare('DELETE FROM masters WHERE id = ?').run(masterId);

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
