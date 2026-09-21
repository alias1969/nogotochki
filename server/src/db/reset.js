/**
 * Полная пересборка базы для разработки: удалить файл, применить миграции,
 * залить тестовые данные.
 *
 * Операция необратимая, поэтому в продакшене запрещена.
 *
 * Запуск: npm run db:reset
 */
import { existsSync, rmSync } from 'node:fs';

import { env } from '../config/env.js';
import { closeDb } from './connection.js';
import { runMigrations } from './migrate.js';
import { seed } from './seed.js';

if (env.isProduction) {
  console.error('Пересборка базы запрещена при NODE_ENV=production.');
  process.exit(1);
}

// WAL оставляет рядом с базой два служебных файла — удаляем и их.
for (const suffix of ['', '-wal', '-shm']) {
  const file = env.databaseFile + suffix;
  if (existsSync(file)) {
    rmSync(file);
    console.log(`  удалён: ${file}`);
  }
}

try {
  console.log('Применяю миграции...');
  runMigrations();
  console.log('Заливаю тестовые данные...');
  seed();
} finally {
  closeDb();
}
