/**
 * Общее окружение проверок: путь к базе и демонстрационные аккаунты.
 *
 * Пароли берутся из .env через тот же config/env.js, что и сам сервис:
 * в исходниках их нет ни здесь, ни в seed.js. Один источник на всех —
 * иначе смена пароля в .env чинила бы вход и ломала половину проверок.
 *
 * Пароли аккаунтов, которые проверка заводит сама и сама же удаляет,
 * сюда не относятся: это не доступ к работающей установке, а такие же
 * тестовые данные, как имя «Проба» или телефон +7900…
 */
import { env } from '../src/config/env.js';

/**
 * Файл базы — тот же, с которым работает сервис.
 *
 * Именно из конфигурации, а не `process.env.DATABASE_FILE ?? '...'`:
 * в .env переменная может стоять пустой, и тогда `??` её не отсекает —
 * SQLite получает пустой путь и открывает временную базу, в которой
 * нет ни одной таблицы. Проверка падает с «no such table», и на этот
 * след уходит полчаса.
 */
export const DB_FILE = env.databaseFile;

function requirePassword(name, value) {
  if (!value) {
    throw new Error(
      `Не задан ${name}. Проверки входят демонстрационными аккаунтами, ` +
        'поэтому нужен заполненный .env: выполните `npm run env:init`, ' +
        'затем `npm run db:reset && npm run seed`.',
    );
  }
  return value;
}

export const ADMIN = {
  email: env.seedAdminEmail,
  password: requirePassword('SEED_ADMIN_PASSWORD', env.seedAdminPassword),
};

/** Обе карточки мастеров заводятся с одним паролем — так проще в отладке. */
export const MASTER_PASSWORD = requirePassword('SEED_MASTER_PASSWORD', env.seedMasterPassword);
export const OLGA = { email: 'olga@nogotochki.local', password: MASTER_PASSWORD };
export const IRINA = { email: 'irina@nogotochki.local', password: MASTER_PASSWORD };

export const ANNA = {
  email: 'anna@example.com',
  password: requirePassword('SEED_CLIENT_PASSWORD', env.seedClientPassword),
};
