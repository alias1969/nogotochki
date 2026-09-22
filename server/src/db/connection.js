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

/**
 * Свои SQL-функции.
 *
 * ulower — приведение к нижнему регистру, понимающее кириллицу.
 *
 * Встроенный lower() в SQLite работает только с латиницей: lower('Клиент')
 * возвращает 'Клиент' без изменений. Это не настройка и не сборка —
 * так устроен сам движок, юникодные таблицы регистра в него не входят.
 * Поиск клиента по имени «клиент» молча не находил бы ничего, а понять
 * почему — отдельное приключение.
 *
 * Функция объявлена детерминированной: от одного входа всегда один
 * результат, и SQLite вправе кешировать вызовы и использовать её
 * в выражениях индексов.
 */
function registerFunctions(connection) {
  connection.function('ulower', { deterministic: true }, (value) =>
    value === null || value === undefined ? null : String(value).toLowerCase(),
  );
}

/** Открывает соединение при первом обращении и возвращает его при последующих. */
export function getDb() {
  if (db) return db;

  mkdirSync(dirname(env.databaseFile), { recursive: true });
  db = new DatabaseSync(env.databaseFile);
  applyPragmas(db);
  registerFunctions(db);
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
 * BEGIN IMMEDIATE, а не BEGIN и не BEGIN EXCLUSIVE. Разница в том,
 * когда берётся блокировка на запись:
 *
 *   BEGIN (то же самое, что BEGIN DEFERRED) — по умолчанию. Транзакция
 *     начинается читателем и становится писателем только на первой
 *     вставке. До этого момента её может опередить другая: обе прочитали,
 *     что слот свободен, обе решили вставлять — и вторая получает
 *     SQLITE_BUSY уже посреди работы. Откатывать и начинать заново
 *     приходится с середины, а в худшем случае возникает взаимная
 *     блокировка двух транзакций, повысивших уровень одновременно.
 *
 *   BEGIN IMMEDIATE — блокировка на запись берётся сразу, в самом начале.
 *     Вторая транзакция ждёт своей очереди на входе (сколько ждать,
 *     задаёт PRAGMA busy_timeout выше), а не на полпути. Для создания
 *     записи это и нужно: «проверить занятость и вставить» обязано быть
 *     одной неделимой операцией, иначе двое клиентов займут одно время.
 *     Проверка, выполненная до взятия блокировки, ничего не гарантирует.
 *
 *   BEGIN EXCLUSIVE — блокирует ещё и читателей. В режиме WAL это лишнее:
 *     писатель и так один, а календарь читают в десятки раз чаще,
 *     чем пишут, и останавливать чтение на время каждой записи незачем.
 *
 * Пишущих транзакций в SQLite всё равно не может быть двух одновременно.
 * IMMEDIATE не добавляет строгости — он переносит неизбежное ожидание
 * в начало, где его можно спокойно переждать, а не в середину,
 * где оно оборачивается ошибкой.
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
