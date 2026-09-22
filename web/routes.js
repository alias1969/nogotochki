/**
 * Карта экранов в адреса страниц.
 *
 * Идентификаторы — те же, что в «Карта связей прототипа Ноготочки.xlsx»
 * (лист «Экраны»). Лендинг — это L1, и по листу «Переходы» из него ведут
 * ровно четыре связи: B1 «Записаться онлайн» (в том числе из карточки
 * услуги и карточки мастера), C1 «Войти», C2 «Регистрация».
 *
 * Остальных страниц в web/ ещё нет. Адреса собраны здесь, а не разбросаны
 * по разметке, чтобы появление настоящих экранов правилось в одном файле,
 * а не поиском по href.
 */
export const SCREENS = {
  L1: 'index.html',                 // Главная — лендинг
  B1: 'booking-services.html',      // Запись. Шаг 1 — Услуги
  C1: 'login.html',                 // Вход
  C2: 'register.html',              // Регистрация
  B2: 'booking-master.html',        // Запись. Шаг 2 — Мастер
  B3: 'booking-time.html',          // Запись. Шаг 3 — Дата и время
  B5: 'booking-confirm.html',       // Запись. Шаг 5 — Подтверждение
  B6: 'booking-done.html',          // Запись подтверждена
  C3: 'forgot-password.html',       // Восстановление пароля — запрос
  C4: 'reset-password.html',        // Восстановление пароля — новый пароль
  K1: 'cabinet-appointments.html',  // Личный кабинет — Предстоящие записи
  K2: 'cabinet-history.html',       // Личный кабинет — История
  K4: 'cabinet-notifications.html', // Личный кабинет — Уведомления
  K3: 'booking-reschedule.html',    // Перенос записи
  K5: 'cabinet-profile.html',       // Личный кабинет — Профиль
};

/**
 * Куда ведёт форма после успеха.
 *
 * По листу «Переходы»: C1 «Войти» → K1 и C2 «Зарегистрироваться» → K1.
 * У нового аккаунта записей нет, поэтому K1 открывается пустым — это
 * то же состояние экрана, а не отдельная страница.
 *
 * Самого K1 в web/ ещё нет: он собирается отдельно. Адрес объявлен здесь,
 * чтобы формы уже вели куда надо, а не куда придётся.
 */
export const AFTER_AUTH = SCREENS.K1;

/**
 * Выбор клиента на пути записи — в адресе страницы.
 *
 * Так его уже переносит лендинг: карточка услуги ведёт на шаг 1
 * с `?service=`, карточка мастера — с `?master=`. Здесь то же самое,
 * только набор услуг стал списком.
 *
 * Почему адрес, а не хранилище браузера. По листу «Переходы» с каждого
 * шага есть путь назад, и выбор при этом сохраняется: «Назад» на шаге 2
 * возвращает на шаг 1 с теми же услугами. Адрес это умеет сам — кнопкой
 * браузера, закладкой, ссылкой, присланной себе же. Копия того же выбора
 * в sessionStorage начала бы спорить с адресом, и на первом же «назад»
 * они разошлись бы. В хранилище остаётся только то, что к записи
 * не относится, — выбранная тема.
 *
 * Резерв слота (шаг 3) в адрес не попадёт: он живёт на сервере и держится
 * гостевой cookie, а не строкой запроса.
 */
export const selection = {
  /**
   * Прочитать выбор из адреса.
   *
   * `services` — список, `service` — одна услуга: так приходит переход
   * с карточки на лендинге. Разбираются оба, потому что лендинг уже
   * выпущен с `?service=`, и ломать его ссылки незачем.
   */
  read(search = location.search) {
    const params = new URLSearchParams(search);
    const raw = params.get('services') ?? params.get('service') ?? '';
    const services = raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isInteger(id) && id > 0);

    const master = params.get('master');
    return {
      // Дубли убираются здесь: повторный id в адресе сервер считает
      // ошибкой (idList в validate.js), а править чужую ссылку руками
      // человек не обязан.
      services: [...new Set(services)],
      master: master === 'any' ? 'any' : (Number.isInteger(Number(master)) && Number(master) > 0 ? Number(master) : null),
    };
  },

  /** Собрать адрес шага с текущим выбором. */
  href(screen, { services = [], master = null } = {}) {
    const params = new URLSearchParams();
    if (services.length) params.set('services', services.join(','));
    if (master !== null) params.set('master', String(master));
    const query = params.toString();
    return query ? `${SCREENS[screen]}?${query}` : SCREENS[screen];
  },
};

/**
 * Ссылка на шаг 1 записи.
 *
 * Прототип передавал выбор строкой-слагом собственного словаря
 * (`?service=man-cover`). Здесь уходит настоящий id из API: словарь
 * названий, который надо чинить при каждом переименовании услуги,
 * шагу записи не нужен.
 */
export function bookingHref({ serviceId, masterId } = {}) {
  const params = new URLSearchParams();
  if (serviceId != null) params.set('service', String(serviceId));
  if (masterId != null) params.set('master', String(masterId));
  const query = params.toString();
  return query ? `${SCREENS.B1}?${query}` : SCREENS.B1;
}
