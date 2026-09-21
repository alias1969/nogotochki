/**
 * Подключение к SQLite.
 *
 * Используется встроенный модуль node:sqlite — внешних зависимостей у проекта нет.
 * Соединение одно на процесс: SQLite это файл, а не сервер, и держать пул
 * подключений к нему незачем.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { env } from '../config/env.js';
import { loadSqlite } from '../config/runtime.js';

// Драйвер загружается отложенно, чтобы на неподходящей версии Node
// показать понятное объяснение вместо ERR_UNKNOWN_BUILTIN_MODULE.
const { DatabaseSync } = loadSqlite();

let db = null;

/**
 * Настройки соединения. Применяются к каждому новому подключению.
 *
 * foreign_keys — в SQLite внешние ключи выключены по умолчанию. Без этой
 *   строки все 28 внешних ключей схемы написаны, но не работают, причём молча.
 * journal_mode = WAL — календарь читают намного чаще, чем пишут записи;
 *   в этом режиме чтение не блокируется записью.
 * busy_timeout — вместо мгновенной ошибки «база занята» подождать освобождения.
 * synchronous = NORMAL — безопасный компромисс скорости и надёжности при WAL.
 */
function applyPragmas(connection) {
  connection.exec('PRAGMA foreign_keys = ON');
  connection.exec('PRAGMA journal_mode = WAL');
  connection.exec('PRAGMA busy_timeout = 5000');
  connection.exec('PRAGMA synchronous = NORMAL');
}

/** Открывает соединение при первом обращении и возвращает его при последующих. */
export function getDb() {
  if (db) return db;

  mkdirSync(dirname(env.databaseFile), { recursive: true });
  db = new DatabaseSync(env.databaseFile);
  applyPragmas(db);
  return db;
}

/** Закрывает соединение. Нужно скриптам, чтобы процесс завершился сам. */
export function closeDb() {
  if (!db) return;
  db.close();
  db = null;
}

/**
 * Выполняет функцию в транзакции: либо применяются все изменения, либо ни одного.
 *
 * BEGIN IMMEDIATE, а не просто BEGIN: блокировка на запись берётся сразу.
 * Это важно для создания записи — проверка занятости слота и вставка должны
 * быть одной неделимой операцией, иначе двое клиентов займут одно время.
 */
export function transaction(fn) {
  const connection = getDb();
  connection.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(connection);
    connection.exec('COMMIT');
    return result;
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

/** Проверка целостности ссылок. Пустой массив — битых ссылок нет. */
export function checkForeignKeys() {
  return getDb().prepare('PRAGMA foreign_key_check').all();
}
