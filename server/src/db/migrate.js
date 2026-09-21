/**
 * Миграции: применение SQL-файлов из migrations/ по порядку имён.
 *
 * Применённые миграции записываются в таблицу schema_migrations, поэтому
 * команду можно запускать сколько угодно раз — второй запуск ничего не делает.
 *
 * Правило: применённый файл миграции не меняют. Любая правка схемы — новый файл
 * с большим номером, и сначала она вносится в Docs/db-schema.md.
 *
 * Запуск: npm run migrate
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb, closeDb } from './connection.js';

const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url));

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT    PRIMARY KEY,
        applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )
  `);
}

/** Применяет все ещё не применённые миграции. Возвращает список применённых. */
export function runMigrations({ silent = false } = {}) {
  const db = getDb();
  ensureMigrationsTable(db);

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((row) => row.name),
  );
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const freshlyApplied = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');

    // Каждая миграция — одна транзакция: либо применилась целиком, либо никак.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(file);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Миграция ${file} не применилась: ${error.message}`, { cause: error });
    }

    freshlyApplied.push(file);
    if (!silent) console.log(`  применена: ${file}`);
  }

  if (!silent) {
    console.log(
      freshlyApplied.length
        ? `Готово. Новых миграций: ${freshlyApplied.length}.`
        : 'Все миграции уже применены.',
    );
  }
  return freshlyApplied;
}

// Запуск напрямую: node src/db/migrate.js
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runMigrations();
  } finally {
    closeDb();
  }
}
