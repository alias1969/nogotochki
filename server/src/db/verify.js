/**
 * Сверка фактической базы с документом Docs/db-schema.md.
 *
 * Проверяет, что в базе есть все таблицы, поля, типы, обязательность полей,
 * первичные и внешние ключи, индексы и уникальные ограничения из документа,
 * и что поддержка внешних ключей действительно включена.
 *
 * Выход с кодом 1, если найдены расхождения — команду можно ставить в CI.
 *
 * Запуск: npm run db:verify
 */
import { getDb, closeDb, checkForeignKeys } from './connection.js';
import { readSchemaDoc, parseFields, parseIndexes, countReferences } from './schema-doc.js';

/** Служебная таблица самих миграций — в документе её нет и не должно быть. */
const INTERNAL_TABLES = new Set(['schema_migrations']);

/**
 * table_xinfo, а не table_info: обычный table_info скрывает вычисляемые
 * колонки (users.email_normalized, appointments.active_slot), и сверка
 * ложно ругалась бы на их отсутствие.
 */
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_xinfo(${table})`).all();
}

export function verify({ silent = false } = {}) {
  const db = getDb();
  const md = readSchemaDoc();
  const problems = [];
  const say = (...args) => { if (!silent) console.log(...args); };

  // --- таблицы ---
  const docFields = parseFields(md);
  const realTables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((name) => !INTERNAL_TABLES.has(name));

  for (const table of docFields.keys()) {
    if (!realTables.includes(table)) problems.push(`таблица ${table} описана в документе, но её нет в базе`);
  }
  for (const table of realTables) {
    if (!docFields.has(table)) problems.push(`таблица ${table} есть в базе, но не описана в документе`);
  }
  say(`Таблицы:   документ ${docFields.size}, база ${realTables.length}`);

  // --- поля, типы, обязательность, первичные ключи ---
  let checkedColumns = 0;
  for (const [table, fields] of docFields) {
    if (!realTables.includes(table)) continue;
    const columns = new Map(columnsOf(db, table).map((c) => [c.name, c]));
    const documented = new Set(fields.map((f) => f.name));

    for (const field of fields) {
      const column = columns.get(field.name);
      if (!column) { problems.push(`${table}.${field.name}: описано в документе, нет в базе`); continue; }
      checkedColumns += 1;

      const realType = (column.type || '').toUpperCase();
      if (field.type && realType && realType !== field.type) {
        problems.push(`${table}.${field.name}: тип ${realType}, в документе ${field.type}`);
      }
      const isPk = column.pk > 0;
      const isGenerated = column.hidden === 2 || column.hidden === 3;
      if (field.obligation === 'да' && !column.notnull && !isPk && !isGenerated) {
        problems.push(`${table}.${field.name}: документ требует обязательности, база допускает NULL`);
      }
      if (field.obligation === 'нет' && column.notnull) {
        problems.push(`${table}.${field.name}: документ допускает NULL, база требует значение`);
      }
      if (field.obligation.startsWith('PK') && !isPk) {
        problems.push(`${table}.${field.name}: должно быть первичным ключом`);
      }
    }
    for (const name of columns.keys()) {
      if (!documented.has(name)) problems.push(`${table}.${name}: есть в базе, не описано в документе`);
    }
  }
  say(`Поля:      сверено ${checkedColumns}`);

  // --- первичные ключи: у каждой таблицы должен быть ---
  for (const table of realTables) {
    if (!columnsOf(db, table).some((c) => c.pk > 0)) problems.push(`таблица ${table} без первичного ключа`);
  }

  // --- внешние ключи ---
  const realFk = realTables.reduce(
    (sum, table) => sum + db.prepare(`PRAGMA foreign_key_list(${table})`).all().length, 0,
  );
  const docFk = countReferences(md);
  if (realFk !== docFk) problems.push(`внешних ключей в базе ${realFk}, в документе ${docFk}`);

  const fkEnabled = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  if (fkEnabled !== 1) problems.push('поддержка внешних ключей выключена (PRAGMA foreign_keys = 0)');

  const broken = checkForeignKeys();
  if (broken.length) problems.push(`битых ссылок: ${broken.length}`);
  say(`Ключи:     внешних ${realFk}, поддержка ${fkEnabled === 1 ? 'включена' : 'ВЫКЛЮЧЕНА'}, битых ссылок ${broken.length}`);

  // --- индексы и уникальные ограничения ---
  const docIndexes = parseIndexes(md);
  const realIndexes = new Map(
    db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .all().map((r) => [r.name, r.sql || '']),
  );
  for (const [name, unique] of docIndexes) {
    if (!realIndexes.has(name)) { problems.push(`индекс ${name} описан в документе, нет в базе`); continue; }
    if (unique !== /UNIQUE/i.test(realIndexes.get(name))) {
      problems.push(`индекс ${name}: уникальность не совпадает с документом`);
    }
  }
  for (const name of realIndexes.keys()) {
    if (!docIndexes.has(name)) problems.push(`индекс ${name} есть в базе, не описан в документе`);
  }
  const uniqueCount = [...docIndexes.values()].filter(Boolean).length;
  say(`Индексы:   ${realIndexes.size} из них уникальных ${uniqueCount}`);

  if (!silent) {
    console.log('');
    if (problems.length === 0) {
      console.log('Расхождений с документом нет.');
    } else {
      console.log(`Расхождений: ${problems.length}`);
      for (const p of problems) console.log(`  - ${p}`);
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const problems = verify();
    process.exitCode = problems.length ? 1 : 0;
  } finally {
    closeDb();
  }
}
