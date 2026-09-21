/**
 * Чтение и проверка переменных окружения.
 *
 * Единственное место, которое обращается к process.env напрямую.
 * Остальной код импортирует готовый объект env и не знает, откуда взялись значения.
 *
 * Здесь только настройки среды запуска и секреты. Правила работы студии
 * (длительность резерва, горизонт записи, часовой пояс) лежат в таблице
 * settings: их меняет администратор на экране A11, а не системный администратор
 * в файле на сервере.
 */
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = fileURLToPath(new URL('../..', import.meta.url));

// .env не обязателен: в проде переменные обычно приходят из окружения процесса.
try {
  process.loadEnvFile(join(serverRoot, '.env'));
} catch {
  // Файла нет — работаем с тем, что уже есть в process.env.
}

const raw = process.env;

/** Обязательная переменная: без неё сервис не запускается. */
function required(name) {
  const value = raw[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Не задана переменная окружения ${name}. ` +
        `Скопируйте .env.example в .env и заполните значения.`,
    );
  }
  return value.trim();
}

/** Необязательная переменная со значением по умолчанию. */
function optional(name, fallback) {
  const value = raw[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function number(name, fallback) {
  const value = optional(name, String(fallback));
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Переменная ${name} должна быть числом, получено: ${value}`);
  }
  return parsed;
}

const nodeEnv = optional('NODE_ENV', 'development');
const databaseFile = optional('DATABASE_FILE', 'data/nogotochki.db');

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: number('PORT', 3000),

  /** Абсолютный путь к файлу базы: относительный достраивается от папки server/. */
  databaseFile: isAbsolute(databaseFile) ? databaseFile : join(serverRoot, databaseFile),
  databaseBackupDir: optional('DATABASE_BACKUP_DIR', join(serverRoot, 'data/backups')),

  // Секреты обязательны в проде и имеют заглушки в разработке,
  // чтобы поднять проект одной командой, ничего не заполняя.
  sessionSecret:
    nodeEnv === 'production' ? required('SESSION_SECRET') : optional('SESSION_SECRET', 'dev-secret'),
  sessionTtlHours: number('SESSION_TTL_HOURS', 24 * 14),
  passwordPepper:
    nodeEnv === 'production' ? required('PASSWORD_PEPPER') : optional('PASSWORD_PEPPER', 'dev-pepper'),

  seedAdminEmail: optional('SEED_ADMIN_EMAIL', 'admin@nogotochki.local'),
  seedAdminPassword: optional('SEED_ADMIN_PASSWORD', 'admin12345'),

  logLevel: optional('LOG_LEVEL', 'info'),
  serverRoot,
};
