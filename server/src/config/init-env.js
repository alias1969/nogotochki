/**
 * Создание .env с нуля: `npm run env:init`.
 *
 * Зачем команда, а не значения по умолчанию в коде.
 *   Раньше в разработке подставлялись заглушки 'dev-secret' и 'dev-pepper' —
 *   ради того, чтобы проект поднимался одной командой. Но заглушка секрета
 *   в коде это ключ, записанный в репозиторий: он уезжает на сервер вместе
 *   с кодом и продолжает работать там, где давно должен был стоять
 *   настоящий. Ошибка при этом молчит — сервис исправно запускается.
 *
 *   Команда решает ту же задачу (поднять проект одним действием), но
 *   значения при этом настоящие, случайные и в репозиторий не попадают:
 *   .env перечислен в .gitignore.
 *
 * Что делает.
 *   Берёт .env.example как образец — порядок и комментарии сохраняются,
 *   чтобы файл оставался читаемым, — и заполняет пустые значения:
 *   секреты случайными строками, пароли демонстрационных аккаунтов
 *   случайными, остальное оставляет пустым (у таких переменных есть
 *   разумные умолчания в env.js).
 *
 *   Существующий .env не трогает: перезаписать его значит сменить перец
 *   и обесценить все пароли в базе разом. Для замены есть --force,
 *   и рядом с ним печатается предупреждение.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = fileURLToPath(new URL('../..', import.meta.url));
const ENV_PATH = join(serverRoot, '.env');
const EXAMPLE_PATH = join(serverRoot, '.env.example');

/** Секрет: 32 случайных байта в hex. Длиннее пароля и не запоминается — так и надо. */
const secret = () => randomBytes(32).toString('hex');

/**
 * Пароль демонстрационного аккаунта.
 *
 * base64url, а не hex: короче при той же стойкости, и его реально
 * скопировать глазами из .env в форму входа.
 */
const demoPassword = () => randomBytes(12).toString('base64url');

/** Какие переменные заполняются сами и чем. Остальные остаются пустыми. */
const GENERATED = {
  SESSION_SECRET: secret,
  PASSWORD_PEPPER: secret,
  SEED_ADMIN_PASSWORD: demoPassword,
  SEED_MASTER_PASSWORD: demoPassword,
  SEED_CLIENT_PASSWORD: demoPassword,
};

export function initEnv({ force = false } = {}) {
  if (!existsSync(EXAMPLE_PATH)) {
    throw new Error('Нет файла .env.example — не из чего делать .env');
  }

  if (existsSync(ENV_PATH) && !force) {
    console.log('Файл .env уже есть — ничего не меняю.');
    console.log('Чтобы пересоздать его с новыми секретами: npm run env:init -- --force');
    console.log('Учтите: смена PASSWORD_PEPPER делает недействительными все пароли в базе.');
    return { created: false };
  }

  if (existsSync(ENV_PATH) && force) {
    const backup = `${ENV_PATH}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    copyFileSync(ENV_PATH, backup);
    console.log(`Прежний .env сохранён: ${backup}`);
  }

  const filled = readFileSync(EXAMPLE_PATH, 'utf8')
    .split('\n')
    .map((line) => {
      const match = line.match(/^([A-Z_]+)=$/);
      if (!match || !(match[1] in GENERATED)) return line;
      return `${match[1]}=${GENERATED[match[1]]()}`;
    })
    .join('\n');

  // Права 600: файл с секретами не должен читаться всеми пользователями машины.
  writeFileSync(ENV_PATH, filled, { mode: 0o600 });

  console.log('Создан .env со свежими секретами.');
  console.log('Заполнены сами: ' + Object.keys(GENERATED).join(', '));
  console.log('Пароли демонстрационных аккаунтов смотрите в .env — в коде их нет.');
  console.log('\nДальше: npm run migrate && npm run seed');
  return { created: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  initEnv({ force: process.argv.includes('--force') });
}
