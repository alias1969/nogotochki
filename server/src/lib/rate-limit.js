/**
 * Ограничение частоты запросов.
 *
 * Нужно там, где запрос перебирают: вход и регистрация. Пароль из восьми
 * знаков перебирается быстро, если пробовать можно сколько угодно раз,
 * а форма регистрации без ограничения — это кнопка «завести тысячу
 * аккаунтов скриптом».
 *
 * Счётчики живут в памяти процесса, а не в базе. Причина: это не данные
 * сервиса, а защита от машинного перебора, и писать строку в SQLite
 * на каждую неудачную попытку входа — значит подарить тому же перебору
 * ещё и нагрузку на диск. Цена решения честная: перезапуск сервиса
 * обнуляет счётчики, а при нескольких процессах у каждого будет свой.
 * Для одной студии на одном VPS (паспорт, раздел «Инструменты») этого
 * достаточно; если процессов станет несколько, счётчики придётся
 * переносить в общее хранилище.
 *
 * Окно скользящее, а не фиксированное: при фиксированном окне лимит
 * обходится очередью на стыке двух окон — десять попыток в конце первой
 * минуты и ещё десять в начале второй.
 */
import { tooManyRequests } from './http-error.js';

/** Чаще раза в минуту чистить память незачем: записи и так короткие. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Один ограничитель — одна защищаемая операция.
 *
 * `max` попыток за `windowMs`. Ключ задаёт вызывающий: для входа это
 * и адрес, и e-mail — адрес ловит перебор паролей к разным аккаунтам
 * с одной машины, e-mail ловит перебор одного аккаунта с разных машин.
 */
export function createLimiter({ name, max, windowMs }) {
  /** ключ → массив меток времени попыток, по возрастанию */
  const hits = new Map();
  let lastSweep = Date.now();

  const fresh = (list, now) => list.filter((moment) => now - moment < windowMs);

  /** Уборка: записи, у которых окно целиком в прошлом, держать незачем. */
  function sweep(now) {
    if (now - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = now;
    for (const [key, list] of hits) {
      const alive = fresh(list, now);
      if (alive.length === 0) hits.delete(key);
      else hits.set(key, alive);
    }
  }

  /** Сколько секунд ждать до освобождения места. */
  function retryAfter(list, now) {
    const oldest = list[0];
    return Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
  }

  return {
    name,
    max,
    windowMs,

    /**
     * Проверить, не регистрируя попытку.
     *
     * Вызывается до работы обработчика: исчерпавшему лимит незачем
     * добираться ни до базы, ни до проверки пароля.
     */
    check(key) {
      const now = Date.now();
      sweep(now);
      const list = fresh(hits.get(key) ?? [], now);
      if (list.length >= max) {
        throw tooManyRequests(
          'Слишком много попыток — подождите и попробуйте снова',
          retryAfter(list, now),
        );
      }
      return max - list.length;
    },

    /** Записать попытку. Возвращает, сколько осталось до лимита. */
    hit(key) {
      const now = Date.now();
      const list = fresh(hits.get(key) ?? [], now);
      list.push(now);
      hits.set(key, list);
      return Math.max(0, max - list.length);
    },

    /** Забыть попытки по ключу — например, после успешного входа. */
    forget(key) {
      hits.delete(key);
    },

    /** Сколько ключей сейчас под наблюдением. Для проверок и отладки. */
    size() {
      return hits.size;
    },
  };
}

/**
 * Адрес, с которого пришёл запрос.
 *
 * За обратным прокси настоящий адрес лежит в X-Forwarded-For, но верить
 * этому заголовку можно только тогда, когда прокси действительно свой:
 * иначе любой желающий обходит ограничение, подставляя в заголовок
 * новый адрес на каждый запрос. Поэтому заголовок читается лишь при
 * TRUST_PROXY=true, и включать его нужно вместе с настройкой прокси.
 */
export function clientAddress(req, { trustProxy }) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
