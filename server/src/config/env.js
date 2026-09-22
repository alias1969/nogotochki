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
 *
 * Граница между ними простая: если значение вправе менять администратор
 * салона — оно в базе; если менять его вправе только тот, у кого есть
 * доступ к серверу, — оно здесь.
 *
 * **Значений секретов в этом файле нет ни одного, в том числе для разработки.**
 * Заглушка вида 'dev-secret' — это ключ, записанный в репозиторий: он уезжает
 * на сервер вместе с кодом и молча работает там, где должен был стоять
 * настоящий секрет. Поэтому SESSION_SECRET и PASSWORD_PEPPER обязательны
 * всегда, а не только в проде; сгенерировать их разом умеет `npm run env:init`.
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
        'Выполните `npm run env:init` — она создаст .env и сгенерирует секреты, — ' +
        'или скопируйте .env.example в .env и заполните значения вручную.',
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

  /**
   * Ключ, которым подписываются хеши токенов сессии.
   *
   * Обязателен в любом окружении. Значения по умолчанию у него нет
   * и быть не может: подставить сюда строку из кода — то же самое,
   * что выложить ключ в репозиторий.
   */
  sessionSecret: required('SESSION_SECRET'),
  sessionTtlHours: number('SESSION_TTL_HOURS', 24 * 14),

  /**
   * Срок жизни ссылки восстановления пароля.
   *
   * Здесь, а не в settings: это параметр безопасности, а не правило
   * работы студии. Администратору незачем и опасно двигать его
   * с экрана настроек — сутки вместо часа заметно расширяют окно,
   * в котором утёкшее письмо ещё пускает в аккаунт.
   */
  passwordResetTtlMinutes: number('PASSWORD_RESET_TTL_MINUTES', 60),

  /**
   * Адрес сайта — из него собирается ссылка в письме.
   *
   * Сервер не знает, под каким доменом его открывают: заголовок Host
   * приходит из запроса и подделывается, а ссылку восстановления
   * по подделанному адресу отправлять нельзя.
   */
  appUrl: optional('APP_URL', `http://localhost:${number('PORT', 3000)}`),

  /**
   * Перец: подмешивается к паролю перед хешированием и в базу не попадает.
   *
   * Тоже обязателен всегда. Смена значения делает недействительными все
   * прежние пароли — поэтому он и не может иметь умолчания в коде:
   * иначе на сервере молча работал бы перец, известный всем.
   */
  passwordPepper: required('PASSWORD_PEPPER'),

  /**
   * Доверять ли заголовку X-Forwarded-For при определении адреса клиента.
   *
   * Включать только вместе с настроенным обратным прокси: без него любой
   * желающий обходит ограничение частоты, подставляя в заголовок новый
   * адрес на каждый запрос.
   */
  trustProxy: optional('TRUST_PROXY', 'false') === 'true',

  /**
   * Ограничение частоты для входа и регистрации.
   *
   * Умолчания разные для прода и разработки, и это не послабление
   * «чтобы не мешало»: набор проверок за один прогон регистрирует около
   * полусотни аккаунтов и намеренно ошибается паролем десятки раз —
   * с боевыми значениями он блокировал бы сам себя, и разработчик
   * привык бы отключать защиту. Ограничение работает в обоих режимах,
   * различаются только числа; боевые значения указаны в .env.example
   * и задаются явно на сервере.
   */
  loginMaxAttempts: number('LOGIN_MAX_ATTEMPTS', nodeEnv === 'production' ? 10 : 200),
  loginWindowMinutes: number('LOGIN_WINDOW_MINUTES', 5),
  registerMaxAttempts: number('REGISTER_MAX_ATTEMPTS', nodeEnv === 'production' ? 10 : 500),
  registerWindowMinutes: number('REGISTER_WINDOW_MINUTES', 60),

  /**
   * Учётные данные демонстрационных аккаунтов.
   *
   * Нужны только команде `npm run seed`, которая в проде не запускается.
   * Умолчаний нет намеренно: пароль, записанный в коде, остаётся рабочим
   * паролем к аккаунту администратора на любой машине, где эту команду
   * когда-нибудь выполнили. Отсутствие значения проверяет сам seed.js —
   * здесь пусто, потому что обычному запуску сервиса они не нужны.
   */
  seedAdminEmail: optional('SEED_ADMIN_EMAIL', 'admin@nogotochki.local'),
  seedAdminPassword: optional('SEED_ADMIN_PASSWORD', null),
  seedMasterPassword: optional('SEED_MASTER_PASSWORD', null),
  seedClientPassword: optional('SEED_CLIENT_PASSWORD', null),

  logLevel: optional('LOG_LEVEL', 'info'),
  serverRoot,
};
