/**
 * Точка входа сервиса.
 *
 * Запуск: npm start
 *
 * Перед первым запуском нужна база: npm run migrate && npm run seed.
 */
import { createServer } from './http/server.js';
import { env } from './config/env.js';
import { getDb, closeDb } from './db/connection.js';

// Соединение открывается до начала приёма запросов: если файла базы нет
// или версия Node не та, об этом лучше узнать при старте, а не на первом
// запросе клиента.
getDb();

const server = createServer();

server.listen(env.port, () => {
  console.log(`Ноготочки: API слушает http://localhost:${env.port} (${env.nodeEnv})`);
});

/**
 * Корректная остановка.
 *
 * SQLite в режиме WAL держит служебные файлы рядом с базой; закрытое
 * соединение отдаёт их аккуратно, а не оставляет после убитого процесса.
 */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  });
}
