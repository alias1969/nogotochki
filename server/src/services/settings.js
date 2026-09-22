/**
 * Настройки студии и правила записи — экран A11.
 *
 * Таблица «ключ — значение»: правила меняются нечасто, но должны
 * редактироваться администратором без участия разработчика. Отсюда же
 * берутся все числа, на которых держится расчёт свободного времени,
 * — в коде их нет ни одного.
 *
 * Значения в базе лежат строками (это всё, что умеет таблица), а смысл
 * у них разный: число минут, название пояса, текст на лендинге. Поэтому
 * рядом с таблицей живёт описание — что за ключ, какого он типа
 * и в каких границах имеет смысл. Без него админ-панель — это поле ввода,
 * в которое можно написать «полчаса» вместо 30 и обвалить календарь.
 */
import { getDb, transaction } from '../db/connection.js';
import { unprocessable, badRequest } from '../lib/http-error.js';
import { now } from '../lib/time.js';
import { writeAudit } from './journal.js';

/**
 * Описание настроек: тип, границы, значение по умолчанию.
 *
 * Границы подобраны не «на глаз», там где их диктует что-то ещё:
 *
 *   max_client_reschedules ≤ 3 — потому что в appointments стоит
 *     CHECK (reschedule_count BETWEEN 0 AND 3). Поставь администратор
 *     четыре, и четвёртый перенос упёрся бы в базу с невнятной ошибкой
 *     вместо понятного отказа. Схему правит миграция, а не экран настроек.
 *
 *   slot_step_minutes ≥ 5 — шаг ноль или минута превращает список
 *     свободного времени в бесконечную ленту.
 *
 *   utc_offset_minutes в пределах −12…+14 часов — реальный диапазон
 *     земных поясов.
 */
const SETTINGS = {
  studio_name: { type: 'text', max: 100, group: 'studio', title: 'Название студии' },
  studio_address: { type: 'text', max: 300, group: 'studio', title: 'Адрес' },
  studio_phone: { type: 'text', max: 40, group: 'studio', title: 'Телефон' },
  studio_about: { type: 'text', max: 2000, group: 'studio', title: 'Текст «О студии»' },

  timezone: { type: 'text', max: 64, group: 'time', title: 'Часовой пояс студии' },
  utc_offset_minutes: {
    type: 'int', min: -720, max: 840, group: 'time',
    title: 'Смещение пояса в минутах',
  },

  hold_minutes: { type: 'int', min: 1, max: 120, group: 'booking', title: 'Сколько живёт резерв слота' },
  booking_horizon_days: { type: 'int', min: 1, max: 365, group: 'booking', title: 'На сколько дней открыт календарь' },
  cancel_deadline_hours: { type: 'int', min: 0, max: 168, group: 'booking', title: 'За сколько часов можно отменить' },
  max_client_reschedules: { type: 'int', min: 0, max: 3, group: 'booking', title: 'Лимит переносов клиентом' },
  slot_step_minutes: { type: 'int', min: 5, max: 120, group: 'booking', title: 'Шаг сетки свободного времени' },
  min_lead_time_minutes: { type: 'int', min: 0, max: 10080, group: 'booking', title: 'Минимальный срок до визита' },
  buffer_after_minutes: { type: 'int', min: 0, max: 120, group: 'booking', title: 'Технический перерыв после визита' },
};

const DEFAULTS = {
  studio_name: 'Ноготочки',
  studio_address: '',
  studio_phone: '',
  studio_about: '',
  timezone: 'Europe/Moscow',
  utc_offset_minutes: 180,
  hold_minutes: 10,
  booking_horizon_days: 90,
  cancel_deadline_hours: 24,
  max_client_reschedules: 3,
  slot_step_minutes: 15,
  min_lead_time_minutes: 120,
  buffer_after_minutes: 0,
};

/**
 * Пары, которые нельзя двигать поодиночке.
 *
 * Название пояса и смещение — два описания одного и того же. В расчётах
 * используется число (SQLite не знает названий поясов), а человеку на
 * экране показывается название. Поменять одно и забыть другое — получить
 * студию, которая на экране в Москве, а считает по Калининграду.
 */
const PAIRED_KEYS = [['timezone', 'utc_offset_minutes']];

export function settingsSchema() {
  return Object.entries(SETTINGS).map(([key, spec]) => ({
    key,
    ...spec,
    default: DEFAULTS[key],
  }));
}

/**
 * Настройки читаются на каждый запрос, без кеша в памяти процесса.
 *
 * Это один запрос к таблице из десятка строк — дешевле, чем объяснять
 * администратору, почему изменённое время резерва применится
 * «когда-нибудь», и почему два процесса отвечают по-разному. Правка
 * на экране A11 действует со следующего же запроса.
 *
 * Значения по умолчанию нужны на случай, если строки в базе нет: сервис
 * должен отвечать разумно, а не падать на пустой таблице настроек.
 */
export function loadSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const raw = stored[key];
    if (raw === undefined) {
      result[key] = fallback;
    } else if (typeof fallback === 'number') {
      const parsed = Number(raw);
      result[key] = Number.isFinite(parsed) ? parsed : fallback;
    } else {
      result[key] = raw;
    }
  }
  return result;
}

/** Настройки с пояснениями — то, что видит администратор на экране. */
export function loadForAdmin() {
  const rows = getDb()
    .prepare('SELECT key, value, description, updated_at, updated_by FROM settings')
    .all();
  const stored = new Map(rows.map((row) => [row.key, row]));

  return settingsSchema().map((spec) => {
    const row = stored.get(spec.key);
    const raw = row?.value;
    return {
      key: spec.key,
      value: spec.type === 'int' ? Number(raw ?? spec.default) : (raw ?? spec.default),
      type: spec.type,
      group: spec.group,
      title: spec.title,
      description: row?.description ?? null,
      ...(spec.type === 'int' ? { min: spec.min, max: spec.max } : { max_length: spec.max }),
      default: spec.default,
      // В базе строки может не быть вовсе — тогда работает значение
      // по умолчанию, и это стоит показать явно.
      is_default: raw === undefined,
      updated_at: row?.updated_at ?? null,
    };
  });
}

/** Проверка одного значения по описанию ключа. */
function validate(key, value) {
  const spec = SETTINGS[key];
  if (!spec) {
    // Белый список, а не свободная таблица: иначе settings превращается
    // в чулан, куда однажды положат ключ, который никто не читает.
    throw badRequest('unknown_setting', `Настройка ${key} не существует`, { field: key });
  }

  if (spec.type === 'int') {
    const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (!Number.isInteger(parsed)) {
      throw badRequest('validation_failed', 'Ожидается целое число', { field: key });
    }
    if (parsed < spec.min || parsed > spec.max) {
      throw unprocessable(
        'out_of_range',
        `${spec.title}: допустимо от ${spec.min} до ${spec.max}`,
        { field: key, min: spec.min, max: spec.max },
      );
    }
    return String(parsed);
  }

  if (typeof value !== 'string') {
    throw badRequest('validation_failed', 'Ожидается строка', { field: key });
  }
  const text = value.trim();
  if (text.length > spec.max) {
    throw badRequest('validation_failed', `Не длиннее ${spec.max} знаков`, { field: key });
  }
  return text;
}

/**
 * Изменить настройки.
 *
 * Принимается сразу набор, а не по одной: экран настроек — это форма,
 * он присылает то, что администратор поправил. Всё уходит одной
 * транзакцией: половина применённых правил хуже, чем ни одного,
 * — особенно когда половинки связаны между собой.
 */
export function updateSettings({ admin, patch }) {
  const keys = Object.keys(patch);
  if (keys.length === 0) throw badRequest('nothing_to_update', 'Не передано ни одной настройки');

  for (const [first, second] of PAIRED_KEYS) {
    const has = keys.includes(first);
    const hasOther = keys.includes(second);
    if (has !== hasOther) {
      throw unprocessable(
        'paired_setting',
        `«${SETTINGS[first].title}» и «${SETTINGS[second].title}» меняются только вместе`,
        { keys: [first, second] },
      );
    }
  }

  // Сначала проверяется всё, и только потом пишется хоть что-то.
  const prepared = keys.map((key) => [key, validate(key, patch[key])]);
  const previous = loadSettings();

  return transaction((db) => {
    const write = db.prepare(
      `INSERT INTO settings(key, value, updated_at, updated_by)
       VALUES (:key, :value, :now, :admin)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    );
    for (const [key, value] of prepared) {
      write.run({ key, value, now: now(), admin: admin.id });
    }

    writeAudit(db, {
      actorUserId: admin.id,
      actorRole: 'admin',
      action: 'update',
      entityType: 'settings',
      // У таблицы «ключ — значение» нет числового идентификатора,
      // а entity_id в журнале обязателен. 0 здесь значит «настройки студии
      // целиком»: что именно поменялось, видно в details.
      entityId: 0,
      details: Object.fromEntries(
        prepared.map(([key, value]) => [key, { from: String(previous[key]), to: value }]),
      ),
    });

    return prepared.map(([key]) => key);
  });
}
