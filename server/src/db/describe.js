/**
 * Вывод фактической структуры базы: таблицы, поля, типы, ключи.
 *
 * Читает не документ, а саму базу — показывает то, что есть на самом деле.
 * Назначение таблиц подтягивается из сводного списка документа схемы.
 *
 * Запуск: npm run db:describe
 */
import { getDb, closeDb } from './connection.js';
import { readSchemaDoc, parsePurposes } from './schema-doc.js';

const INTERNAL_TABLES = new Set(['schema_migrations']);

/** Короткая пометка о поле: ключ, ссылка, обязательность, значение по умолчанию. */
function marks(column, fk, pkCount) {
  const out = [];
  if (column.pk > 0) out.push(pkCount > 1 ? `PK${column.pk}` : 'PK');
  if (fk) out.push(`FK -> ${fk.table}.${fk.to || 'id'}${fk.on_delete === 'NO ACTION' ? '' : ` (${fk.on_delete})`}`);
  if (column.hidden === 2) out.push('вычисляемое');
  if (column.hidden === 3) out.push('вычисляемое, хранимое');
  if (column.notnull && column.pk === 0) out.push('обязательное');
  if (column.dflt_value && !/strftime/.test(column.dflt_value)) out.push(`по умолчанию ${column.dflt_value}`);
  if (column.dflt_value && /strftime/.test(column.dflt_value)) out.push('по умолчанию — сейчас');
  return out.join(', ');
}

export function describe() {
  const db = getDb();
  const purposes = parsePurposes(readSchemaDoc());

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => r.name).filter((n) => !INTERNAL_TABLES.has(n));

  let totalColumns = 0;

  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_xinfo(${table})`).all();
    const fks = new Map(
      db.prepare(`PRAGMA foreign_key_list(${table})`).all().map((f) => [f.from, f]),
    );
    const pkCount = columns.filter((c) => c.pk > 0).length;
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    totalColumns += columns.length;

    console.log(`\n${table}  (${columns.length} полей, строк: ${rows})`);
    if (purposes.has(table)) console.log(`  ${purposes.get(table)}`);

    const width = Math.max(...columns.map((c) => c.name.length));
    for (const column of columns) {
      const note = marks(column, fks.get(column.name), pkCount);
      console.log(
        `    ${column.name.padEnd(width)}  ${(column.type || '—').padEnd(7)}` +
          (note ? `  ${note}` : ''),
      );
    }

    const indexes = db.prepare(`PRAGMA index_list(${table})`).all()
      .filter((i) => i.origin === 'c');
    for (const index of indexes) {
      const cols = db.prepare(`PRAGMA index_info(${index.name})`).all().map((c) => c.name);
      console.log(`    · ${index.unique ? 'уникальный ' : 'индекс '}${index.name} (${cols.join(', ')})`);
    }
  }

  console.log(`\nВсего: ${tables.length} таблиц, ${totalColumns} полей.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { describe(); } finally { closeDb(); }
}
