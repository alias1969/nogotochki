# Схема базы данных SQLite — сервис «Ноготочки»

**Версия:** 1.9
**Дата:** 18.09.2026
**Источник:** паспорт продукта (`CLAUDE.md`, `Docs/PassportProject.pages`) и карта связей прототипа (`Docs/Карта связей прототипа Ноготочки.xlsx`, 31 экран).
**Статус:** проект схемы для MVP. Код не написан, документ описывает целевую структуру данных.
**Изменения в 1.1:** повторный проход по всем 31 экрану карты связей. Добавлены три таблицы (`sessions`, `slot_hold_services`, `role_permissions`), четыре поля и новые значения перечислений — см. [раздел 8](#8-ревизия-по-карте-связей).
**Изменения в 1.2:** расчёт свободного времени проверен рабочим запросом на заполненной базе. Добавлена таблица `studio_closures` и три настройки, без которых расчёт не выполняется, — см. [раздел 9](#9-проверка-расчёта-свободного-времени).
**Изменения в 1.3:** проверка полей на дублирование. Убраны четыре избыточных поля, одно стало вычисляемым — см. [раздел 10](#10-дублирование-полей).
**Изменения в 1.4:** сверка всех полей-секретов. Открытого пароля в схеме не было; `slot_holds.session_token` приведён к общему правилу и хранится хешем — см. [раздел 11](#11-поля-с-секретами).
**Изменения в 1.5:** аудит первичных и внешних ключей. Добавлено шесть индексов на FK-колонки, снято лишнее условие у `ux_masters_user` — см. [раздел 12](#12-проверка-ключей).
**Изменения в 1.6:** закрыт риск двойной записи. Пересечение интервалов теперь отсекается на уровне базы двумя триггерами, а не только проверкой в API — см. [раздел 6.3](#63-триггеры-против-пересечения-записей). Раздел 7.9 переписан: ограничение снято.
**Изменения в 1.9:** уникальное имя категории услуг — `ux_service_category_name` (миграция 005). Без него в прайсе заводились две одинаковые категории, и услуги расползались по ним незаметно.
**Изменения в 1.8:** матрица прав `role_permissions` заполнена справочными данными для экрана A10 (миграция 004). Данные справочные, не тестовые: они нужны и в проде.
**Изменения в 1.7:** поле `appointments.allow_overlap` — осознанное наложение, которое администратор ставит вручную. Триггеры пропускают такую запись, но она сама продолжает блокировать чужие — см. [раздел 6.3](#63-триггеры-против-пересечения-записей) и [раздел 7.19](#719-наложение-разрешается-флагом-в-строке-а-не-отключением-проверки).

---

## Оглавление

1. [Соглашения](#1-соглашения)
2. [Данные по экранам](#2-данные-по-экранам)
3. [Список таблиц](#3-список-таблиц)
4. [Описание таблиц](#4-описание-таблиц)
5. [Как вычисляется свободное время](#5-как-вычисляется-свободное-время)
6. [Уникальные ограничения и индексы](#6-уникальные-ограничения-и-индексы)
7. [Спорные решения](#7-спорные-решения)
8. [Ревизия по карте связей](#8-ревизия-по-карте-связей)
9. [Проверка расчёта свободного времени](#9-проверка-расчёта-свободного-времени)
10. [Дублирование полей](#10-дублирование-полей)
11. [Поля с секретами](#11-поля-с-секретами)
12. [Проверка ключей](#12-проверка-ключей)

---

## 1. Соглашения

### 1.1. Формат дат и времени

**Все моменты времени хранятся одной строкой в формате ISO-8601 в UTC:**

```
YYYY-MM-DDTHH:MM:SSZ        например  2026-09-18T07:30:00Z
```

Отдельно от моментов времени хранятся два вспомогательных формата:

| Что | Формат | Пример | Где используется |
|---|---|---|---|
| Момент времени | `YYYY-MM-DDTHH:MM:SSZ` (UTC) | `2026-09-18T07:30:00Z` | `*_at`, `starts_at`, `ends_at`, `expires_at` |
| Календарная дата | `YYYY-MM-DD` | `2026-09-18` | границы действия графика, отпуска |
| Время суток | `HH:MM` | `10:00` | недельный график мастера, часы работы студии |

**Почему именно так:**

- **В SQLite нет типа «дата».** Любая дата всё равно ляжет в `TEXT`, `INTEGER` или `REAL`. Это не ограничение, которое можно обойти, — это то, с чем нужно определиться заранее, иначе в разных таблицах окажутся разные форматы.
- **ISO-8601 сортируется как текст ровно так же, как во времени.** `'2026-09-18T09:00:00Z' < '2026-09-18T10:00:00Z'` — обычное сравнение строк. Значит `ORDER BY starts_at`, `BETWEEN` и сравнения в индексах работают без единой функции преобразования. Именно на этом держится быстрый поиск записей мастера на день.
- **Встроенные функции SQLite (`date()`, `datetime()`, `strftime()`, `julianday()`) понимают этот формат напрямую.** Можно посчитать «записи за последние 30 дней» или сгруппировать выручку по месяцам без внешнего кода.
- **Строку видно глазами.** При отладке базы и при экспорте в CSV значение читается без расшифровки — в отличие от Unix-времени числом.
- **UTC, а не местное время.** Студия одна и живёт в одном часовом поясе, но местное время дважды в год может сдвинуться, а UTC монотонен. Если хранить местное время, то при переводе часов один час либо повторится дважды, либо исчезнет, и запись на 02:30 станет неоднозначной. Часовой пояс студии лежит в настройках (`settings.timezone`, значение `Europe/Moscow`) и применяется только при выводе на экран.
- **Время суток в графике (`HH:MM`) — наоборот, местное.** График мастера — это «работаю с 10:00 до 20:00» в человеческом смысле; он не должен уезжать при переводе часов. Момент времени получается уже при вычислении: дата + время графика + часовой пояс студии → UTC.

Значение по умолчанию для полей создания:

```sql
created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
```

### 1.2. Прочие соглашения

- **Первичные ключи** — `id INTEGER PRIMARY KEY` (псевдоним `rowid`, автоинкремент средствами SQLite).
- **Логические поля** — `INTEGER` со значениями `0` / `1` и ограничением `CHECK (x IN (0,1))`: в SQLite нет типа `BOOLEAN`.
- **Деньги** — `INTEGER` в копейках. Дробные числа (`REAL`) для денег не используются: `0.1 + 0.2` в двоичной плавающей точке не равно `0.3`, и на суммировании чека это рано или поздно вылезет копейкой расхождения в аналитике.
- **Длительность** — `INTEGER`, минуты.
- **Перечисления** (роли, статусы, типы) — `TEXT` с ограничением `CHECK (... IN (...))`. Свободного текста в таких полях нет.
- **Внешние ключи** требуют включения в каждом соединении: `PRAGMA foreign_keys = ON;` — в SQLite они по умолчанию выключены.
- **Удаление**: справочники, на которые ссылаются записи, удаляются только через флаг `is_active` (`ON DELETE RESTRICT`). Каскадом удаляются только подчинённые строки, не имеющие смысла отдельно от родителя.

---

## 2. Данные по экранам

Проход по карте связей: какие данные показывает или изменяет каждый экран и из каких таблиц они берутся.

### Публичная часть и авторизация

| Экран | Что показывает / изменяет | Таблицы |
|---|---|---|
| **L1** Главная — лендинг | Информация о студии, часы работы, список услуг с ценами и длительностью, карточки мастеров | `settings`, `studio_hours`, `service_categories`, `services`, `masters` |
| **C1** Вход | Форма e-mail + пароль; проверка хеша; создание сессии | `users`, `sessions` |
| **C2** Регистрация | Имя, e-mail, телефон, пароль; создание аккаунта с ролью `user` и сессии | `users`, `sessions` |
| **C3** Восстановление — запрос | Ввод e-mail, создание одноразовой ссылки | `users`, `password_reset_tokens` |
| **C4** Восстановление — новый пароль | Проверка живой ссылки, запись нового хеша, сброс прежних сессий | `password_reset_tokens`, `users`, `sessions` |

### Путь записи

| Экран | Что показывает / изменяет | Таблицы |
|---|---|---|
| **B1** Шаг 1 — Услуги | Категории и услуги, длительность и цена каждой, сумма и суммарная длительность выбранных | `service_categories`, `services` |
| **B2** Шаг 2 — Мастер | Мастера, которые умеют делать **все** выбранные услуги, плюс вариант «Любой мастер» | `masters`, `master_services` |
| **B3** Шаг 3 — Дата и время | Календарь на 3 месяца вперёд и свободные слоты; старт резерва на 10 минут | вычисление по `master_schedules`, `schedule_exceptions`, `appointments`, `slot_holds`, `studio_hours`, `settings`; запись в `slot_holds` + `slot_hold_services` |
| **B4** Шаг 4 — Вход в процессе записи | Вход или регистрация, резерв продолжает жить; проверка «у вас уже есть запись к этому мастеру на это время» | `users`, `sessions`, `slot_holds`, `appointments` |
| **B5** Шаг 5 — Подтверждение | Сводка: услуги, мастер, дата и время, сумма; таймер до `expires_at` | `slot_holds`, `slot_hold_services`, `services`, `masters` |
| **B6** Запись подтверждена | Созданная запись и её состав | `appointments`, `appointment_services`, `notifications` |

### Кабинет клиента

| Экран | Что показывает / изменяет | Таблицы |
|---|---|---|
| **K1** Предстоящие записи | Свои будущие записи со статусом `booked`: мастер, услуги, время, сумма; доступность кнопок отмены и переноса | `appointments`, `appointment_services`, `masters`, `settings` |
| **K2** История | Завершённые, отменённые и пропущенные записи со статусами | `appointments`, `appointment_services`, `masters` |
| **K3** Перенос записи | Новые дата и время, счётчик переносов (лимит 3) | `appointments.reschedule_count`, вычисление свободного времени, `slot_holds` (`reschedule_of_id`), `slot_hold_services` |
| **K4** Уведомления | Сообщения сервиса, прочитано / не прочитано | `notifications` |
| **K5** Профиль | Имя, e-mail, телефон, смена пароля, тема оформления, выход | `users`, `sessions` |

### Кабинет мастера

| Экран | Что показывает / изменяет | Таблицы |
|---|---|---|
| **M1** Вход мастера | Форма входа, роль `master` | `users`, `sessions` |
| **M2** Мой день | Свои записи на день: время, услуги, имя и **телефон** клиента; смена статуса на «Завершена» / «Не пришёл», отмена и перенос с причиной | `appointments`, `appointment_services`, `users` (клиент), `audit_log` |
| **M3** Расписание | Своя неделя: рабочие часы, записи, закрытое время; закрытие времени; заявка на изменение графика | `master_schedules`, `schedule_exceptions`, `appointments`, `schedule_change_requests` |
| **M4** Профиль | Профиль, смена пароля, выход, своя загрузка и выручка по своим услугам | `users`, `sessions`, `masters`, агрегаты по `appointments` + `appointment_services` |

### Админ-панель

| Экран | Что показывает / изменяет | Таблицы |
|---|---|---|
| **A1** Вход администратора | Форма входа, роль `admin` | `users`, `sessions` |
| **A2** Сегодня | Показатели дня, ближайшие записи, блок «Требует внимания» (заявки мастеров) | `appointments`, `schedule_change_requests` |
| **A3** Расписание дня | Сетка «мастера × время», записи и блокировки, ручное освобождение слота | `masters`, `master_schedules`, `schedule_exceptions`, `appointments`, `slot_holds` |
| **A4** Записи | Таблица всех записей с фильтрами, создание записи вручную, смена статуса, отмена, перенос | `appointments`, `appointment_services`, `users`, `masters`, `audit_log` |
| **A5** Услуги | Категории, услуги, длительность, цены, активность | `service_categories`, `services`, `master_services` |
| **A6** Мастера | Карточки мастеров, их услуги, статус активности, привязка к аккаунту | `masters`, `users`, `master_services` |
| **A7** Графики | Недельные графики, отпуска, заявки мастеров, конфликты графика с записями | `master_schedules`, `schedule_exceptions`, `schedule_change_requests`, `appointments` |
| **A8** Клиенты | База клиентов: имя, e-mail, телефон, история визитов; заведение клиента вручную без пароля | `users`, `appointments` |
| **A9** Аналитика | Выручка, загрузка, экспорт в CSV (факт выгрузки журналируется) | агрегаты по `appointments`, `appointment_services`, `masters`, `services`; `audit_log` |
| **A10** Роли и доступы | Назначение ролей, привязка аккаунта к карточке мастера, справочная матрица прав | `users.role`, `masters.user_id`, `role_permissions`, `audit_log` |
| **A11** Настройки | График студии, правила записи, отмены и переносов | `studio_hours`, `settings` |

**Что из этого следует:**

- Ни один экран не показывает «заранее нарезанные слоты» — B3, K3, M3 и A3 показывают результат вычисления. Отдельная таблица слотов не нужна (требование 3).
- M2 и A8 показывают контакты клиента, но в разном объёме: мастеру — телефон в своих записях, администратору — ещё и e-mail. Значит контакты лежат в `users`, а ограничение видимости — на уровне API, а не структуры.
- M4 и A9 не хранят ничего своего: и загрузка, и выручка считаются запросами по `appointments`. Отдельных таблиц отчётности в MVP нет.

---

## 3. Список таблиц

| № | Таблица | Назначение |
|---|---|---|
| 1 | `users` | Аккаунты всех ролей: клиенты, мастера, администраторы |
| 2 | `masters` | Карточка мастера: витрина и связь с аккаунтом |
| 3 | `service_categories` | Категории услуг для группировки на витрине |
| 4 | `services` | Услуги: длительность и цена |
| 5 | `master_services` | Какой мастер какие услуги выполняет |
| 6 | `master_schedules` | Недельный рабочий график мастера |
| 7 | `schedule_exceptions` | Отклонения от графика: отпуск, выходной, закрытое время, дополнительная смена |
| 8 | `schedule_change_requests` | Заявки мастеров на изменение графика |
| 9 | `appointments` | Записи клиентов — центральная таблица |
| 10 | `appointment_services` | Состав записи: какие услуги и по какой цене на момент записи |
| 11 | `slot_holds` | Временные резервы слота на 10 минут |
| 12 | `notifications` | Уведомления внутри личного кабинета |
| 13 | `password_reset_tokens` | Одноразовые ссылки восстановления пароля |
| 14 | `audit_log` | Журнал действий мастера и администратора над чужими записями |
| 15 | `studio_hours` | Часы работы студии по дням недели |
| 16 | `settings` | Настройки студии и правила записи |
| 17 | `sessions` | Активные сессии входа для всех ролей |
| 18 | `slot_hold_services` | Состав резерва: какие услуги выбраны до создания записи |
| 19 | `role_permissions` | Справочная матрица прав ролей для экрана A10 |
| 20 | `studio_closures` | Разовые нерабочие дни студии: праздники, санитарные дни |

---

## 4. Описание таблиц

### 4.1. `users` — аккаунты

Единая таблица для всех трёх ролей. Клиент, мастер и администратор входят по e-mail и паролю, различаются полем `role`.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `email` | TEXT | да | E-mail как ввёл пользователь |
| `email_normalized` | TEXT | — | **Вычисляемое:** `lower(trim(email))`. По нему идут поиск и проверка уникальности |
| `password_hash` | TEXT | нет | Хеш пароля (bcrypt / argon2) вместе с солью. `NULL` — клиент заведён администратором вручную и вход ещё не активирован |
| `full_name` | TEXT | да | Имя для отображения |
| `phone` | TEXT | да | Телефон; мастер видит его в своих записях |
| `role` | TEXT | да | `user` / `master` / `admin`, по умолчанию `user` |
| `theme` | TEXT | да | `day` / `evening` — выбранная тема оформления (экран K5) |
| `is_active` | INTEGER | да | `0` / `1`; отключённый аккаунт не входит, но его записи остаются |
| `created_at` | TEXT | да | Момент создания, UTC |
| `updated_at` | TEXT | да | Момент последнего изменения, UTC |

**Пароль в открытом виде не хранится ни в одном поле** (требование 5). Колонки `password` в схеме нет и быть не должно: хеш односторонний, а для входа достаточно сравнить хеш введённого пароля с сохранённым.

Поле `password_hash` необязательное, потому что на экранах A4 и A8 администратор создаёт запись клиенту, который никогда не регистрировался сам. Такой аккаунт существует ради контактов и истории визитов, но войти в него нельзя: проверка входа требует непустого хеша. Клиент активирует вход позже — через восстановление пароля по своему e-mail.

```sql
CREATE TABLE users (
    id                INTEGER PRIMARY KEY,
    email             TEXT    NOT NULL,
    email_normalized  TEXT    GENERATED ALWAYS AS (lower(trim(email))) STORED,
    password_hash     TEXT,
    full_name         TEXT    NOT NULL,
    phone             TEXT    NOT NULL,
    role              TEXT    NOT NULL DEFAULT 'user'
                              CHECK (role IN ('user', 'master', 'admin')),
    theme             TEXT    NOT NULL DEFAULT 'day'
                              CHECK (theme IN ('day', 'evening')),
    is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

### 4.2. `masters` — карточки мастеров

Карточка отделена от аккаунта: у мастера есть публичная витрина (фото, специализация, порядок вывода), которой нет у клиента, и аккаунт может быть создан позже карточки (экран A10 — «привязка аккаунта к карточке мастера»).

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `user_id` | INTEGER | нет | FK → `users.id`; `NULL`, пока аккаунт не привязан |
| `display_name` | TEXT | нет | **Псевдоним для витрины.** Пусто — берётся `users.full_name`. Обязателен только для карточки без аккаунта |
| `specialization` | TEXT | нет | Короткая подпись под именем |
| `bio` | TEXT | нет | Описание в карточке |
| `photo_url` | TEXT | нет | Ссылка на фото |
| `is_active` | INTEGER | да | `0` / `1`; неактивный не показывается в выборе мастера |
| `sort_order` | INTEGER | да | Порядок вывода на лендинге |
| `created_at`, `updated_at` | TEXT | да | UTC |

```sql
CREATE TABLE masters (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER          REFERENCES users(id) ON DELETE RESTRICT,
    display_name    TEXT,
    specialization  TEXT,
    bio             TEXT,
    photo_url       TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK (user_id IS NOT NULL OR display_name IS NOT NULL)
);
```

Имя мастера хранится в `users.full_name` — там же, где имя любого другого человека в сервисе. `display_name` остаётся только как **необязательный псевдоним** для витрины: «Ольга» вместо «Ольга Петровна Смирнова». Имя на экранах берётся как `COALESCE(m.display_name, u.full_name)`.

Ограничение `CHECK` закрывает единственный случай, когда псевдоним обязателен: карточка ещё не привязана к аккаунту (экран A10), и взять имя больше неоткуда.

### 4.3. `service_categories` — категории услуг

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `name` | TEXT | да | Название категории |
| `sort_order` | INTEGER | да | Порядок вывода |
| `is_active` | INTEGER | да | `0` / `1` |

```sql
CREATE TABLE service_categories (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);
```

### 4.4. `services` — услуги

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `category_id` | INTEGER | да | FK → `service_categories.id` |
| `name` | TEXT | да | Название услуги |
| `description` | TEXT | нет | Описание на витрине |
| `duration_min` | INTEGER | да | Длительность в минутах, > 0 |
| `price_kopecks` | INTEGER | да | Цена в копейках, ≥ 0 |
| `is_active` | INTEGER | да | `0` / `1`; снятая с продажи услуга остаётся ради истории |
| `sort_order` | INTEGER | да | Порядок вывода |
| `created_at`, `updated_at` | TEXT | да | UTC |

```sql
CREATE TABLE services (
    id             INTEGER PRIMARY KEY,
    category_id    INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE RESTRICT,
    name           TEXT    NOT NULL,
    description    TEXT,
    duration_min   INTEGER NOT NULL CHECK (duration_min > 0),
    price_kopecks  INTEGER NOT NULL CHECK (price_kopecks >= 0),
    is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

### 4.5. `master_services` — кто что умеет

Связь «многие ко многим». Нужна на экране B2: после выбора услуг показываются только те мастера, которые выполняют **все** выбранные.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `master_id` | INTEGER | PK, FK | → `masters.id` |
| `service_id` | INTEGER | PK, FK | → `services.id` |

```sql
CREATE TABLE master_services (
    master_id   INTEGER NOT NULL REFERENCES masters(id)  ON DELETE CASCADE,
    service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    PRIMARY KEY (master_id, service_id)
);
```

### 4.6. `master_schedules` — недельный график мастера

Постоянный рабочий ритм: «по вторникам с 10:00 до 20:00». Одна строка — один рабочий интервал в один день недели. Двух строк на один день достаточно, чтобы задать перерыв на обед.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `master_id` | INTEGER | да | FK → `masters.id` |
| `weekday` | INTEGER | да | 1 = понедельник … 7 = воскресенье |
| `work_start` | TEXT | да | `HH:MM`, местное время студии |
| `work_end` | TEXT | да | `HH:MM`, строго больше `work_start` |
| `valid_from` | TEXT | да | `YYYY-MM-DD`, с какой даты действует |
| `valid_to` | TEXT | нет | `YYYY-MM-DD` или `NULL` — бессрочно |
| `created_at` | TEXT | да | UTC |

Поля `valid_from` / `valid_to` нужны, чтобы смена графика не переписала прошлое: старые записи должны остаться объяснимыми, а на экране A7 видно, с какой даты начинает действовать новый график.

```sql
CREATE TABLE master_schedules (
    id          INTEGER PRIMARY KEY,
    master_id   INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
    weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    work_start  TEXT    NOT NULL CHECK (work_start LIKE '__:__'),
    work_end    TEXT    NOT NULL CHECK (work_end   LIKE '__:__'),
    valid_from  TEXT    NOT NULL,
    valid_to    TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK (work_end > work_start),
    CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
```

### 4.7. `schedule_exceptions` — отклонения от графика

Всё, что отменяет или добавляет рабочее время в конкретные даты: отпуск, разовый выходной, закрытое мастером время (экран M3, кнопка «Закрыть время»), дополнительная смена.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `master_id` | INTEGER | да | FK → `masters.id` |
| `kind` | TEXT | да | `vacation` / `day_off` / `time_block` / `extra_shift` |
| `starts_at` | TEXT | да | Начало интервала, UTC |
| `ends_at` | TEXT | да | Конец интервала, UTC, строго больше начала |
| `reason` | TEXT | нет | Комментарий («учёба», «приём у врача») |
| `created_by` | INTEGER | да | FK → `users.id`; кто закрыл время — мастер или администратор |
| `created_at` | TEXT | да | UTC |

Первые три типа вычитают время из доступного, `extra_shift` — добавляет.

```sql
CREATE TABLE schedule_exceptions (
    id          INTEGER PRIMARY KEY,
    master_id   INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL
                        CHECK (kind IN ('vacation', 'day_off', 'time_block', 'extra_shift')),
    starts_at   TEXT    NOT NULL,
    ends_at     TEXT    NOT NULL,
    reason      TEXT,
    created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK (ends_at > starts_at)
);
```

### 4.8. `schedule_change_requests` — заявки мастеров на изменение графика

Мастер предлагает изменение (экран M3), администратор утверждает или отклоняет (экран A7). Сам график заявка не меняет — при утверждении администратор правит `master_schedules` или `schedule_exceptions`.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `master_id` | INTEGER | да | FK → `masters.id` |
| `message` | TEXT | да | Что мастер предлагает изменить |
| `desired_from` | TEXT | нет | `YYYY-MM-DD`, с какой даты |
| `desired_to` | TEXT | нет | `YYYY-MM-DD`, по какую дату |
| `status` | TEXT | да | `pending` / `approved` / `rejected` |
| `admin_comment` | TEXT | нет | Ответ администратора |
| `reviewed_by` | INTEGER | нет | FK → `users.id` |
| `reviewed_at` | TEXT | нет | UTC |
| `created_at` | TEXT | да | UTC |

```sql
CREATE TABLE schedule_change_requests (
    id             INTEGER PRIMARY KEY,
    master_id      INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
    message        TEXT    NOT NULL,
    desired_from   TEXT,
    desired_to     TEXT,
    status         TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected')),
    admin_comment  TEXT,
    reviewed_by    INTEGER          REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at    TEXT,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK (status = 'pending' OR reviewed_at IS NOT NULL)
);
```

### 4.9. `appointments` — записи

Центральная таблица сервиса.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `client_id` | INTEGER | да | FK → `users.id` — клиент |
| `master_id` | INTEGER | да | FK → `masters.id` — мастер |
| `starts_at` | TEXT | да | Начало визита, UTC |
| `ends_at` | TEXT | да | Конец визита, UTC, строго больше начала |
| `status` | TEXT | да | `booked` / `completed` / `no_show` / `cancelled` |
| `active_slot` | INTEGER | — | Генерируемое поле: `1` при `booked`, иначе `NULL`; нужно для уникального индекса |
| `cancelled_by_role` | TEXT | нет | `client` / `master` / `admin` |
| `cancelled_by_user_id` | INTEGER | нет | FK → `users.id` |
| `cancel_reason` | TEXT | нет | Причина отмены (мастер и администратор указывают обязательно — проверка на уровне API) |
| `cancelled_at` | TEXT | нет | UTC |
| `reschedule_count` | INTEGER | да | Сколько раз клиент переносил; 0…3 |
| `allow_overlap` | INTEGER | да | `0` / `1`; `1` — администратор осознанно поставил визит поверх занятого времени. Ставится только при `created_by_role = 'admin'` |
| `master_chosen_by_client` | INTEGER | да | `0` / `1`; `0` — клиент выбрал «Любой мастер» на экране B2, мастера подобрал сервис |
| `created_by_role` | TEXT | да | `client` / `admin` — кто создал запись |
| `created_by_user_id` | INTEGER | да | FK → `users.id` |
| `client_note` | TEXT | нет | Комментарий клиента |
| `admin_note` | TEXT | нет | Служебная пометка, клиенту не видна |
| `created_at`, `updated_at` | TEXT | да | UTC |

**Статусы — фиксированный набор из четырёх значений** (требование 4), заданный ограничением `CHECK`:

| Статус | Значение | Кто ставит |
|---|---|---|
| `booked` | Запись подтверждена и ждёт визита | создаётся при подтверждении |
| `completed` | Визит состоялся | мастер (M2), администратор (A4) |
| `no_show` | Клиент не пришёл | мастер (M2), администратор (A4) |
| `cancelled` | Запись отменена | клиент (K1), мастер (M2), администратор (A3, A4) |

Кто именно отменил — отдельным полем `cancelled_by_role`, а не четырьмя разными статусами: иначе любой отчёт «сколько отмен» пришлось бы писать через перечисление трёх значений, и каждый новый способ отмены плодил бы новый статус.

**Отменённая запись не удаляется** — она меняет статус и остаётся в истории (экран K2).

```sql
CREATE TABLE appointments (
    id                    INTEGER PRIMARY KEY,
    client_id             INTEGER NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
    master_id             INTEGER NOT NULL REFERENCES masters(id) ON DELETE RESTRICT,
    starts_at             TEXT    NOT NULL,
    ends_at               TEXT    NOT NULL,
    status                TEXT    NOT NULL DEFAULT 'booked'
                                  CHECK (status IN ('booked', 'completed', 'no_show', 'cancelled')),
    active_slot           INTEGER GENERATED ALWAYS AS
                                  (CASE WHEN status = 'booked' THEN 1 ELSE NULL END) VIRTUAL,
    cancelled_by_role     TEXT             CHECK (cancelled_by_role IN ('client', 'master', 'admin')),
    cancelled_by_user_id  INTEGER          REFERENCES users(id) ON DELETE SET NULL,
    cancel_reason         TEXT,
    cancelled_at          TEXT,
    reschedule_count      INTEGER NOT NULL DEFAULT 0 CHECK (reschedule_count BETWEEN 0 AND 3),
    allow_overlap         INTEGER NOT NULL DEFAULT 0 CHECK (allow_overlap IN (0, 1)),
    master_chosen_by_client INTEGER NOT NULL DEFAULT 1 CHECK (master_chosen_by_client IN (0, 1)),
    created_by_role       TEXT    NOT NULL CHECK (created_by_role IN ('client', 'admin')),
    created_by_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    client_note           TEXT,
    admin_note            TEXT,
    created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK (ends_at > starts_at),
    CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancelled_by_role IS NOT NULL)),
    CHECK (status =  'cancelled' OR cancelled_at IS NULL)
);
```

### 4.10. `appointment_services` — состав записи

Клиент выбирает несколько услуг (экран B1), поэтому связь «запись — услуга» вынесена в отдельную таблицу.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `appointment_id` | INTEGER | PK, FK | → `appointments.id` |
| `service_id` | INTEGER | PK, FK | → `services.id` |
| `position` | INTEGER | да | Порядок услуг внутри визита |
| `duration_min` | INTEGER | да | **Снимок** длительности |
| `price_kopecks` | INTEGER | да | **Снимок** цены |

Два последних поля дублируют `services` намеренно. Если завтра цена маникюра вырастет, прошлые записи и вся аналитика должны остаться с той ценой, по которой клиент записывался. Без снимка отчёт за прошлый месяц будет меняться каждый раз при правке прайса.

Название услуги здесь **не** дублируется: оно берётся по `service_id` из `services`. Переименование услуги — это обычно уточнение формулировки, а не новая услуга, и старым записям правильнее показывать актуальное название. Удалить услугу, на которую ссылается запись, нельзя (`ON DELETE RESTRICT`), так что ссылка никогда не повиснет.

Суммарная длительность и сумма чека в `appointments` не хранятся — они получаются отсюда:

```sql
SELECT SUM(duration_min)  AS duration_min,
       SUM(price_kopecks) AS total_price_kopecks
FROM appointment_services WHERE appointment_id = :id;
```

```sql
CREATE TABLE appointment_services (
    appointment_id  INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    service_id      INTEGER NOT NULL REFERENCES services(id)     ON DELETE RESTRICT,
    position        INTEGER NOT NULL DEFAULT 0,
    duration_min    INTEGER NOT NULL CHECK (duration_min > 0),
    price_kopecks   INTEGER NOT NULL CHECK (price_kopecks >= 0),
    PRIMARY KEY (appointment_id, service_id)
);
```

### 4.11. `slot_holds` — резервы слота

Слот закрепляется за клиентом на 10 минут с момента выбора времени (экран B3), таймер виден на экране подтверждения (B5). Резерв существует до создания записи и живёт отдельно от неё, потому что на шаге B4 клиент может быть ещё не авторизован — резерв держится на токене сессии.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `session_token_hash` | TEXT | да | **Хеш** токена браузера; работает и для гостя, у которого сессии ещё нет |
| `client_id` | INTEGER | нет | FK → `users.id`; заполняется после входа на шаге B4 |
| `master_id` | INTEGER | да | FK → `masters.id` |
| `starts_at` | TEXT | да | Начало резервируемого интервала, UTC |
| `ends_at` | TEXT | да | Конец, UTC |
| `expires_at` | TEXT | да | Момент истечения резерва, UTC |
| `appointment_id` | INTEGER | нет | FK → `appointments.id`; заполняется, когда резерв превратился в запись |
| `reschedule_of_id` | INTEGER | нет | FK → `appointments.id`; заполнено, если резерв взят для **переноса** существующей записи (экран K3) |
| `created_at` | TEXT | да | UTC |

Истёкшие резервы не удаляются немедленно — время освобождается само, потому что при вычислении свободных слотов учитываются только резервы с `expires_at > now`. Отдельная фоновая уборка чистит старые строки.

Поле `reschedule_of_id` нужно экрану K3: перенос идёт по тому же пути, что и новая запись (выбор времени → резерв → подтверждение на B5), но кнопка на B5 называется «Подтвердить перенос», а при подтверждении меняется время **существующей** записи, а не создаётся новая. Без этого поля сервер на шаге подтверждения не знает, что именно подтверждает. Старое время при этом остаётся за клиентом, пока перенос не подтверждён, — это прямо оговорено в карте связей для кнопки «Отмена» на K3.

```sql
CREATE TABLE slot_holds (
    id              INTEGER PRIMARY KEY,
    session_token_hash TEXT  NOT NULL,
    client_id       INTEGER          REFERENCES users(id)   ON DELETE CASCADE,
    master_id       INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
    starts_at       TEXT    NOT NULL,
    ends_at         TEXT    NOT NULL,
    expires_at      TEXT    NOT NULL,
    appointment_id    INTEGER        REFERENCES appointments(id) ON DELETE SET NULL,
    reschedule_of_id  INTEGER        REFERENCES appointments(id) ON DELETE CASCADE,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK (ends_at > starts_at)
);
```

### 4.12. `notifications` — уведомления в кабинете

Экран K4. За пределы личного кабинета уведомления не выходят: интеграции с почтой и Telegram в MVP нет.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `user_id` | INTEGER | да | FK → `users.id` — получатель |
| `kind` | TEXT | да | `booking_created` / `booking_cancelled` / `booking_rescheduled` / `reminder` / `schedule_request_created` / `schedule_request_reviewed` / `system` |
| `title` | TEXT | да | Заголовок |
| `body` | TEXT | да | Текст |
| `appointment_id` | INTEGER | нет | FK → `appointments.id`; переход из уведомления к записи |
| `is_read` | INTEGER | да | `0` / `1` |
| `created_at` | TEXT | да | UTC |
| `read_at` | TEXT | нет | UTC |

```sql
CREATE TABLE notifications (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            TEXT    NOT NULL CHECK (kind IN (
                        'booking_created', 'booking_cancelled', 'booking_rescheduled',
                        'reminder', 'schedule_request_created', 'schedule_request_reviewed',
                        'system')),
    title           TEXT    NOT NULL,
    body            TEXT    NOT NULL,
    appointment_id  INTEGER          REFERENCES appointments(id) ON DELETE SET NULL,
    is_read         INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    read_at         TEXT
);
```

### 4.13. `password_reset_tokens` — восстановление пароля

Экраны C3 и C4.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `user_id` | INTEGER | да | FK → `users.id` |
| `token_hash` | TEXT | да | **Хеш** токена из ссылки, не сам токен |
| `expires_at` | TEXT | да | Момент истечения, UTC |
| `used_at` | TEXT | нет | UTC; заполнен — ссылка уже сработала |
| `created_at` | TEXT | да | UTC |

Хранится хеш, а не сам токен, по той же причине, что и с паролем: утечка базы не должна давать возможность войти в чужой аккаунт по ссылке восстановления.

```sql
CREATE TABLE password_reset_tokens (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT    NOT NULL,
    expires_at  TEXT    NOT NULL,
    used_at     TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

### 4.14. `audit_log` — журнал действий

Паспорт требует: действия мастера и администратора над чужими записями пишутся в журнал — кто, что и когда.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `actor_user_id` | INTEGER | да | FK → `users.id` — кто действовал |
| `actor_role` | TEXT | да | `client` / `master` / `admin` на момент действия |
| `action` | TEXT | да | `create` / `update` / `cancel` / `reschedule` / `status_change` / `login` / `logout` / `password_change` / `role_change` / `export` |
| `entity_type` | TEXT | да | `appointment` / `master_schedule` / `schedule_exception` / `schedule_change_request` / `service` / `master` / `user` / `settings` / `report` |
| `entity_id` | INTEGER | да | Идентификатор изменённой строки |
| `details` | TEXT | нет | JSON: что было и что стало |
| `created_at` | TEXT | да | UTC |

```sql
CREATE TABLE audit_log (
    id             INTEGER PRIMARY KEY,
    actor_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    actor_role     TEXT    NOT NULL CHECK (actor_role IN ('client', 'master', 'admin')),
    action         TEXT    NOT NULL CHECK (action IN (
                       'create', 'update', 'cancel', 'reschedule', 'status_change',
                       'login', 'logout', 'password_change', 'role_change', 'export')),
    entity_type    TEXT    NOT NULL CHECK (entity_type IN (
                       'appointment', 'master_schedule', 'schedule_exception',
                       'schedule_change_request', 'service', 'master', 'user',
                       'settings', 'report')),
    entity_id      INTEGER NOT NULL,
    details        TEXT,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

### 4.15. `studio_hours` — часы работы студии

Экраны L1 и A11. Внешняя рамка: даже если у мастера в графике стоит 09:00, запись раньше открытия студии невозможна.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `weekday` | INTEGER | PK | 1 = понедельник … 7 = воскресенье |
| `is_closed` | INTEGER | да | `0` / `1` — студия закрыта в этот день |
| `open_time` | TEXT | нет | `HH:MM`, местное |
| `close_time` | TEXT | нет | `HH:MM`, местное |

```sql
CREATE TABLE studio_hours (
    weekday     INTEGER PRIMARY KEY CHECK (weekday BETWEEN 1 AND 7),
    is_closed   INTEGER NOT NULL DEFAULT 0 CHECK (is_closed IN (0, 1)),
    open_time   TEXT,
    close_time  TEXT,
    CHECK (is_closed = 1 OR (open_time IS NOT NULL AND close_time IS NOT NULL
                             AND close_time > open_time))
);
```

### 4.16. `settings` — настройки и правила

Экран A11. Таблица «ключ — значение»: правила записи меняются нечасто, но должны редактироваться администратором без участия разработчика.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `key` | TEXT | PK | Имя настройки |
| `value` | TEXT | да | Значение строкой |
| `description` | TEXT | нет | Пояснение для админ-панели |
| `updated_at` | TEXT | да | UTC |
| `updated_by` | INTEGER | нет | FK → `users.id` |

Обязательный набор ключей:

| Ключ | Значение по умолчанию | Смысл |
|---|---|---|
| `studio_name` | `Ноготочки` | Название студии в шапке и в подвале (экран L1) |
| `studio_address` | — | Адрес на лендинге |
| `studio_phone` | — | Телефон на лендинге |
| `studio_about` | — | Текст блока «О студии» |
| `timezone` | `Europe/Moscow` | Часовой пояс студии — для вывода на экран и для человека |
| `utc_offset_minutes` | `180` | **Смещение пояса в минутах.** Именно оно используется в расчётах: SQLite не знает названий поясов |
| `hold_minutes` | `10` | Сколько живёт резерв слота |
| `booking_horizon_days` | `90` | На сколько вперёд открыт календарь (3 месяца) |
| `cancel_deadline_hours` | `24` | За сколько часов клиент ещё может отменить |
| `max_client_reschedules` | `3` | Лимит переносов клиентом |
| `slot_step_minutes` | `15` | Шаг сетки при показе свободного времени |
| `min_lead_time_minutes` | `120` | Минимальный срок до визита: насколько заранее клиент обязан записаться |
| `buffer_after_minutes` | `0` | Технический перерыв после визита — уборка рабочего места. `0` = поведение по паспорту |

```sql
CREATE TABLE settings (
    key          TEXT    PRIMARY KEY,
    value        TEXT    NOT NULL,
    description  TEXT,
    updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_by   INTEGER          REFERENCES users(id) ON DELETE SET NULL
);
```

### 4.17. `sessions` — сессии входа

Входов в карте связей четыре (C1, B4, M1, A1), а кнопка «Выйти» встречается на K5, M2, M3, M4 и на всех одиннадцати экранах админ-панели. Выход должен что-то прекращать, а на шаге B4 вход обязан сохранить уже идущий резерв — значит сессия это хранимая сущность, а не только cookie в браузере.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `user_id` | INTEGER | да | FK → `users.id` |
| `token_hash` | TEXT | да | **Хеш** токена сессии, не сам токен |
| `role_at_login` | TEXT | да | `user` / `master` / `admin` — роль на момент входа |
| `user_agent` | TEXT | нет | Браузер и устройство для списка входов |
| `created_at` | TEXT | да | Момент входа, UTC |
| `last_seen_at` | TEXT | да | Последняя активность, UTC |
| `expires_at` | TEXT | да | Момент истечения, UTC |
| `revoked_at` | TEXT | нет | UTC; заполнено — сессия закрыта выходом или сменой пароля |

Сессия считается живой, если `revoked_at IS NULL AND expires_at > now`.

Зачем нужна отдельная таблица, а не только cookie:

- **Выход должен работать.** Кнопка «Выйти» проставляет `revoked_at`. Без хранимой сессии выход означает лишь «браузер забыл токен», а сам токен остаётся действительным — украденная cookie продолжает пускать в кабинет.
- **Смена пароля должна выбрасывать остальные сеансы.** На K5, M4 и C4 меняется пароль; все прочие сессии этого пользователя помечаются `revoked_at`. Иначе восстановление пароля не решает ту задачу, ради которой его обычно и делают.
- **Роль зафиксирована на момент входа.** Если администратор поменял роль на экране A10, старая сессия не должна молча получить новые права: при расхождении `role_at_login` с текущей ролью сессия закрывается и требуется повторный вход.
- **`slot_holds.session_token_hash` получает опору.** До версии 1.1 это поле ссылалось на сущность, которой в схеме не было.

Гость на шаге B3 сессии ещё не имеет — его резерв держится на анонимном токене браузера. При входе на B4 резерв переписывается на `client_id`, а анонимный токен перестаёт иметь значение.

```sql
CREATE TABLE sessions (
    id             INTEGER PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash     TEXT    NOT NULL,
    role_at_login  TEXT    NOT NULL CHECK (role_at_login IN ('user', 'master', 'admin')),
    user_agent     TEXT,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    last_seen_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    expires_at     TEXT    NOT NULL,
    revoked_at     TEXT,
    CHECK (expires_at > created_at)
);
```

### 4.18. `slot_hold_services` — состав резерва

Клиент выбирает услуги на шаге B1, мастера на B2, время на B3 — а запись появляется только после подтверждения на B5. Всё это время выбранные услуги где-то должны лежать: без них нельзя ни посчитать длительность `T` для поиска свободных слотов на B3, ни показать сводку и сумму на B5.

Особенно это важно для гостя: на шаге B4 он уходит на вход или регистрацию, а карта связей требует, чтобы «резерв продолжал идти» и выбор не потерялся. Хранить корзину только в браузере нельзя — вход на B4 может произойти в другой вкладке, а восстановление пароля (B4 → C3 → C4 → B5) вообще уводит пользователя по ссылке из письма.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `hold_id` | INTEGER | PK, FK | → `slot_holds.id` |
| `service_id` | INTEGER | PK, FK | → `services.id` |
| `position` | INTEGER | да | Порядок услуг |
| `duration_min` | INTEGER | да | Снимок длительности на момент выбора |
| `price_kopecks` | INTEGER | да | Снимок цены на момент выбора |

Снимки здесь по той же причине, что и в `appointment_services`: если администратор поменяет цену на экране A5, пока клиент десять минут смотрит на экран подтверждения, сумма в сводке не должна измениться под рукой.

При подтверждении записи строки переносятся в `appointment_services`, при истечении резерва исчезают вместе с ним (`ON DELETE CASCADE`).

```sql
CREATE TABLE slot_hold_services (
    hold_id        INTEGER NOT NULL REFERENCES slot_holds(id) ON DELETE CASCADE,
    service_id     INTEGER NOT NULL REFERENCES services(id)   ON DELETE RESTRICT,
    position       INTEGER NOT NULL DEFAULT 0,
    duration_min   INTEGER NOT NULL CHECK (duration_min > 0),
    price_kopecks  INTEGER NOT NULL CHECK (price_kopecks >= 0),
    PRIMARY KEY (hold_id, service_id)
);
```

### 4.19. `role_permissions` — матрица прав

Экран A10 называется «Роли и доступы» и, по карте связей, показывает не только назначение ролей, но и **справочную матрицу прав**. Матрица — это данные, которые выводятся на экран, поэтому им нужно место в базе.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `role` | TEXT | PK | `user` / `master` / `admin` |
| `permission_key` | TEXT | PK | Код права, например `appointments.view_all` |
| `permission_group` | TEXT | да | Группа для вывода таблицей: «Записи», «Расписание», «Справочники», «Аналитика» |
| `title` | TEXT | да | Человеческая формулировка права |
| `is_allowed` | INTEGER | да | `0` / `1` |
| `note` | TEXT | нет | Уточнение, например «только свои записи» |

**Важная оговорка.** Эта таблица — справочник для показа на экране, а не источник решений. Права проверяются в коде API при каждом запросе, как требует паспорт. Если сделать матрицу источником правды, любая ошибочная правка строки молча откроет клиенту чужие записи. Поэтому таблица заполняется миграцией вместе с кодом и в админ-панели доступна только на чтение.

```sql
CREATE TABLE role_permissions (
    role              TEXT    NOT NULL CHECK (role IN ('user', 'master', 'admin')),
    permission_key    TEXT    NOT NULL,
    permission_group  TEXT    NOT NULL,
    title             TEXT    NOT NULL,
    is_allowed        INTEGER NOT NULL DEFAULT 0 CHECK (is_allowed IN (0, 1)),
    note              TEXT,
    PRIMARY KEY (role, permission_key)
);
```

### 4.20. `studio_closures` — разовые нерабочие дни студии

`studio_hours` описывает обычную неделю, но студия закрывается и вне расписания: праздники, санитарный день, ремонт. До версии 1.2 это выражалось только отпуском **каждому** мастеру по отдельности — десять мастеров означали десять строк на один и тот же новогодний выходной, и забытая строка открывала запись в закрытый день.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK | Идентификатор |
| `date_from` | TEXT | да | `YYYY-MM-DD`, первый нерабочий день |
| `date_to` | TEXT | да | `YYYY-MM-DD`, последний нерабочий день (совпадает с `date_from` для одного дня) |
| `reason` | TEXT | да | Причина: «Новогодние праздники», «Санитарный день» |
| `created_by` | INTEGER | нет | FK → `users.id` |
| `created_at` | TEXT | да | UTC |

Редактируется администратором на экране A11 вместе с графиком студии.

```sql
CREATE TABLE studio_closures (
    id          INTEGER PRIMARY KEY,
    date_from   TEXT    NOT NULL,
    date_to     TEXT    NOT NULL,
    reason      TEXT    NOT NULL,
    created_by  INTEGER          REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK (date_to >= date_from)
);
```

---

## 5. Как вычисляется свободное время

Таблицы заранее нарезанных слотов в схеме нет (требование 3). Свободное время собирается в момент запроса из четырёх источников.

### 5.1. Что нужно для расчёта

Вход: мастер `M`, дата `D`, суммарная длительность выбранных услуг `T` минут, текущий момент `now`.

| Источник | Что даёт | Без него |
|---|---|---|
| `masters.is_active` | Мастер вообще принимает записи | Запись к уволенному мастеру |
| `master_schedules` | Рабочие интервалы дня недели, действующие на дату `D` | Не с чего начинать |
| `studio_hours` | Внешняя рамка: часы работы студии | Запись до открытия или после закрытия |
| `studio_closures` | Разовые нерабочие дни студии | Запись на санитарный день или 1 января |
| `schedule_exceptions` | Отпуск, выходной, закрытое время, дополнительная смена | Запись поверх отпуска |
| `appointments` (`status='booked'`) | Уже занятое время | Двойная запись |
| `slot_holds` (`expires_at > now`) | Время, которое сейчас кто-то подтверждает | Два клиента на одном экране подтверждения |
| `settings.utc_offset_minutes` | Перевод `HH:MM` графика в момент времени UTC | **Расчёт не выполняется вообще** |
| `settings.slot_step_minutes` | Шаг сетки предлагаемого времени | Неизвестно, какие точки старта показывать |
| `settings.buffer_after_minutes` | Технический перерыв после визита | Записи впритык без уборки |
| `settings.min_lead_time_minutes` | Насколько заранее нужно записаться | Запись «через пять минут» |
| `settings.booking_horizon_days` | Дальняя граница календаря | Календарь открыт в бесконечность |

### 5.2. Откуда берётся длительность `T`

Длительности слота как хранимой величины в схеме нет. Есть две разные вещи, которые легко перепутать:

- **`settings.slot_step_minutes`** — шаг сетки: через сколько минут предлагать следующую точку старта. От длительности визита не зависит.
- **`T`** — длительность самого визита. Считается заново при каждом запросе, потому что у разных клиентов она разная.

**Слот не может иметь фиксированной длины.** Одна и та же точка 10:00 свободна для маникюра на 60 минут и занята для комплекса на 3 часа. «Свободен» — свойство пары «время + длительность», а не времени самого по себе. Это ещё одна причина, по которой таблицы готовых слотов в схеме нет.

Первоисточник длительности один — `services.duration_min`. Дальше она копируется снимками:

```
services.duration_min             ← правит администратор на экране A5
        ↓ клиент выбирает услуги (B1)
slot_hold_services.duration_min   ← снимок на момент выбора, живёт 10 минут
        ↓ подтверждение (B5)
appointment_services.duration_min ← снимок по каждой услуге
appointments.ends_at              ← starts_at + сумма снимков
```

Отдельного поля с суммарной длительностью в `appointments` нет: сумма выражена через `ends_at`, а по услугам — через `appointment_services`.

Снимок на каждом шаге нужен, чтобы правка длительности услуги администратором не меняла задним числом уже созданную запись и не сдвигала `ends_at` у визита, который клиент подтвердил.

Параметр `:total_min` опорного запроса берётся из трёх разных мест в зависимости от экрана:

```sql
-- B1 → B3: клиент только что выбрал услуги
SELECT SUM(duration_min) FROM services
 WHERE id IN (:service_ids) AND is_active = 1;

-- B5 после входа или восстановления пароля: восстановление по живому резерву
SELECT SUM(duration_min) FROM slot_hold_services WHERE hold_id = :hold_id;

-- K3 перенос: длительность берётся у переносимой записи, а не из прайса
SELECT (strftime('%s', ends_at) - strftime('%s', starts_at)) / 60
  FROM appointments WHERE id = :appointment_id;
```

Третий случай содержательный, а не формальный. При переносе длительность обязана прийти из снимка записи: если взять её из текущего прайса, а услуга с тех пор стала длиннее, перенос молча раздвинет визит и может наложиться на следующего клиента.

Во втором случае сумма считается по `slot_hold_services`, а не по `services`, по той же причине — резерв хранит снимок, и за десять минут на экране подтверждения прайс не должен менять картину под рукой.

### 5.3. Порядок вычисления

0. **Проверить день целиком.** Если дата `D` попадает в `studio_closures`, свободного времени нет — дальше можно не считать. Если `studio_hours` для этого дня недели помечен `is_closed = 1`, то же самое.
1. **Взять рабочие интервалы дня.** Из `master_schedules` строки, где `weekday` совпадает с днём недели даты `D`, а `D` попадает в `valid_from … valid_to`. Время суток из графика — местное, поэтому момент UTC получается как `D + work_start − utc_offset_minutes`.
2. **Обрезать по часам студии.** Пересечь полученные интервалы с `studio_hours` для этого дня недели.
3. **Вычесть отклонения.** Из `schedule_exceptions` вычесть интервалы с типами `vacation`, `day_off`, `time_block`; прибавить интервалы `extra_shift`.
4. **Вычесть занятое.** Вычесть интервалы `appointments` этого мастера со статусом `booked` и интервалы `slot_holds` с `expires_at > now`.
5. **Нарезать остаток шагом `slot_step_minutes`** и оставить только те точки старта, от которых **непрерывно помещается весь интервал `T`**. Это прямое требование паспорта: слот доступен, только если от его начала целиком влезает сумма длительностей всех выбранных услуг.
6. **Учесть буфер.** Занятым считается `T + buffer_after_minutes`, но в рабочие часы должно помещаться только `T`: уборка может продолжаться после закрытия.
7. **Отбросить прошедшее и слишком близкое** — раньше чем `now + min_lead_time_minutes` — **и слишком далёкое** — дальше `now + booking_horizon_days`.

### 5.4. Опорный запрос

Запрос ниже выполнен на заполненной базе и возвращает готовый список точек старта. Он приведён здесь, чтобы схему можно было проверить, не дожидаясь кода.

```sql
WITH RECURSIVE
q AS (SELECT :master_id AS master_id, :day AS day, :total_min AS total_min, :now AS now),
cfg AS (SELECT
  CAST((SELECT value FROM settings WHERE key='utc_offset_minutes')   AS INTEGER) AS off_min,
  CAST((SELECT value FROM settings WHERE key='slot_step_minutes')    AS INTEGER) AS step,
  CAST((SELECT value FROM settings WHERE key='buffer_after_minutes') AS INTEGER) AS buf,
  CAST((SELECT value FROM settings WHERE key='min_lead_time_minutes')AS INTEGER) AS lead,
  CAST((SELECT value FROM settings WHERE key='booking_horizon_days') AS INTEGER) AS horizon),

-- шаги 0-2: график мастера, пересечённый с часами студии, плюс дополнительные смены
work AS (
  SELECT strftime('%Y-%m-%dT%H:%M:%SZ',
           datetime(q.day||'T'||max(ms.work_start,sh.open_time)||':00',
                    (-c.off_min)||' minutes')) AS w_start,
         strftime('%Y-%m-%dT%H:%M:%SZ',
           datetime(q.day||'T'||min(ms.work_end,sh.close_time)||':00',
                    (-c.off_min)||' minutes')) AS w_end
  FROM q, cfg c
  JOIN masters m           ON m.id = q.master_id AND m.is_active = 1
  JOIN master_schedules ms ON ms.master_id = q.master_id
       AND ms.weekday = ((CAST(strftime('%w', q.day) AS INTEGER) + 6) % 7) + 1
       AND q.day >= ms.valid_from
       AND (ms.valid_to IS NULL OR q.day <= ms.valid_to)
  JOIN studio_hours sh     ON sh.weekday = ms.weekday AND sh.is_closed = 0
  WHERE max(ms.work_start, sh.open_time) < min(ms.work_end, sh.close_time)
    AND NOT EXISTS (SELECT 1 FROM studio_closures sc
                    WHERE q.day BETWEEN sc.date_from AND sc.date_to)
  UNION ALL
  SELECT e.starts_at, e.ends_at
  FROM q JOIN schedule_exceptions e
    ON e.master_id = q.master_id AND e.kind = 'extra_shift'
   AND date(e.starts_at) = q.day
),

-- шаг 5: сетка шагом slot_step_minutes от начала каждого рабочего интервала
grid(t) AS (
  SELECT w_start FROM work
  UNION
  SELECT strftime('%Y-%m-%dT%H:%M:%SZ',
                  datetime(g.t, '+'||(SELECT step FROM cfg)||' minutes'))
  FROM grid g WHERE g.t < (SELECT max(w_end) FROM work)
),
cand AS (
  SELECT g.t AS starts_at,
    strftime('%Y-%m-%dT%H:%M:%SZ', datetime(g.t,'+'||q.total_min||' minutes'))          AS ends_at,
    strftime('%Y-%m-%dT%H:%M:%SZ', datetime(g.t,'+'||(q.total_min+c.buf)||' minutes'))  AS busy_until
  FROM grid g, q, cfg c
)

SELECT cand.starts_at, cand.ends_at
FROM cand, q, cfg c
WHERE EXISTS (SELECT 1 FROM work w                              -- помещается в рабочее время
              WHERE cand.starts_at >= w.w_start AND cand.ends_at <= w.w_end)
  AND NOT EXISTS (SELECT 1 FROM schedule_exceptions e           -- шаг 3
        WHERE e.master_id = q.master_id AND e.kind <> 'extra_shift'
          AND e.starts_at < cand.busy_until AND e.ends_at > cand.starts_at)
  AND NOT EXISTS (SELECT 1 FROM appointments a                  -- шаг 4: записи
        WHERE a.master_id = q.master_id AND a.status = 'booked'
          AND a.starts_at < cand.busy_until AND a.ends_at > cand.starts_at)
  AND NOT EXISTS (SELECT 1 FROM slot_holds h                    -- шаг 4: живые резервы
        WHERE h.master_id = q.master_id AND h.expires_at > q.now
          AND h.starts_at < cand.busy_until AND h.ends_at > cand.starts_at)
  AND cand.starts_at >= strftime('%Y-%m-%dT%H:%M:%SZ',          -- шаг 7
                                 datetime(q.now,'+'||c.lead||' minutes'))
  AND date(cand.starts_at) <= date(q.now,'+'||c.horizon||' days')
ORDER BY cand.starts_at;
```

Три места, где легко ошибиться:

- **Нумерация дней недели.** В схеме 1 = понедельник … 7 = воскресенье, а `strftime('%w')` возвращает 0 = воскресенье … 6 = суббота. Перевод: `((strftime('%w') + 6) % 7) + 1`.
- **Пересечение интервалов проверяется строгими неравенствами** `a.starts_at < cand.busy_until AND a.ends_at > cand.starts_at`. Нестрогие отсекли бы запись, начинающуюся ровно в момент окончания предыдущей, — а это как раз допустимо.
- **`studio_hours` должна быть заполнена на все семь дней.** Отсутствующая строка означает не «круглосуточно», а «расчёт не найдёт рабочих интервалов» — день молча выпадет из календаря. Семь строк создаются начальной миграцией.

**Почему так, а не таблицей слотов:**

- Таблицу слотов пришлось бы заранее генерировать на 3 месяца вперёд для каждого мастера и пересобирать при каждом изменении графика, отпуска или цены. Любой сбой генерации — и клиент видит несуществующее время.
- Слот в 10:00 «свободен» не сам по себе, а только относительно длительности выбранных услуг: для маникюра за 60 минут он свободен, для комплекса на 3 часа — уже нет. Хранить это признаком в строке невозможно.
- Освобождение времени при отмене, переносе или истечении резерва становится бесплатным: запись меняет статус, резерв протухает — и время само появляется в следующем вычислении. Ничего специально «возвращать в свободные» не нужно.

**Защита от двойной записи** (сценарий 2 из паспорта) держится на трёх вещах одновременно: резерв в `slot_holds`, повторная проверка занятости внутри транзакции перед `INSERT` и уникальный индекс `ux_appointments_master_slot` как последний рубеж. Индекс ловит совпадение начала минута в минуту; пересечения интервалов «10:00–11:30» и «10:30–11:00» индексом не ловятся — их отсекает проверка в транзакции.

---

## 6. Уникальные ограничения и индексы

### 6.1. Уникальные ограничения

| # | Ограничение | Зачем | Что сломается без него |
|---|---|---|---|
| 1 | `ux_users_email` — уникальный `email_normalized` | Один e-mail — один аккаунт | Два аккаунта на один адрес. При входе непонятно, в какой пускать; восстановление пароля меняет пароль «не в том» аккаунте; клиент не находит свои записи, потому что они в другом аккаунте. Нормализация в нижний регистр нужна, чтобы `Anna@mail.ru` и `anna@mail.ru` не считались разными людьми |
| 2 | `ux_masters_user` — уникальный `user_id` в `masters` | Один аккаунт — не больше одной карточки мастера | Один вход ведёт в два разных кабинета мастера. На экране M2 непонятно, чей день показывать, а выручка в M4 задваивается |
| 2а | Он же — **без условия** `WHERE user_id IS NOT NULL` | Обслуживает ещё и проверку внешнего ключа при удалении пользователя | С условием индекс частичный, и SQLite не может опереться на него при проверке FK: удаление пользователя читает всю таблицу мастеров. Условие при этом ничего не давало — обычный `UNIQUE` в SQLite и так допускает сколько угодно `NULL` |
| 3 | `PRIMARY KEY (master_id, service_id)` в `master_services` | Услуга привязана к мастеру один раз | Дубли в списке услуг мастера на A6; на B2 мастер показывается в выборе дважды |
| 4 | `ux_service_name` — уникальная пара `(category_id, name)` | В одной категории нет двух одинаковых услуг | Администратор заводит «Маникюр» дважды с разной ценой; клиент выбирает одну, а в чеке другая сумма |
| 4а | `ux_service_category_name` — уникальное `name` в `service_categories` | Категория заводится один раз | Две категории «Уход» в прайсе. Услуги расползаются по ним незаметно: на витрине два одинаковых раздела, в каждом половина услуг, и администратор не понимает, почему «пропал» маникюр. Ограничение 4 при этом не помогает — оно проверяет пару с `category_id`, а категории разные |
| 5 | `ux_appointments_master_slot` — **частичный** уникальный `(master_id, starts_at)` при `active_slot = 1` | Нельзя создать две действующие записи к одному мастеру на одно время | Ровно сценарий 2 из паспорта: два клиента одновременно подтверждают один слот и оба получают подтверждение. Мастер приходит утром и видит двух человек на 10:00. Слово «действующие» здесь ключевое — частичный индекс считает только `booked`, поэтому на освободившееся после отмены время можно записаться снова |
| 6 | `ux_appointments_client_slot` — **частичный** уникальный `(client_id, master_id, starts_at)` при `active_slot = 1` | Клиент не может записаться к одному мастеру на одно время дважды | Двойной клик по «Подтвердить» создаёт две одинаковые записи. Это же состояние ошибки на экране B4 — «у вас уже есть запись к этому мастеру на это время» |
| 7 | `PRIMARY KEY (appointment_id, service_id)` в `appointment_services` | Услуга входит в запись один раз | Услуга задваивается в составе визита: сумма и длительность больше реальных, слот занят дольше, чем нужно |
| 8 | `ux_reset_token` — уникальный `token_hash` | Ссылка восстановления ведёт ровно в один аккаунт | Совпадение токенов позволяет попасть в чужой аккаунт |
| 9 | `PRIMARY KEY (weekday)` в `studio_hours` | Один день недели описан один раз | Два противоречащих расписания на среду; какое из них рамка — вопрос удачи |
| 10 | `PRIMARY KEY (key)` в `settings` | Настройка задана один раз | Два значения `hold_minutes`; резерв живёт то 10, то 30 минут |
| 11 | `ux_sessions_token` — уникальный `token_hash` в `sessions` | Один токен — одна сессия | Совпадение токенов пускает одного пользователя в чужой кабинет; выход закрывает не ту сессию |
| 12 | `PRIMARY KEY (hold_id, service_id)` в `slot_hold_services` | Услуга попадает в резерв один раз | Услуга задваивается в корзине: длительность `T` завышена, свободных слотов на B3 меньше, чем есть, а в сводке на B5 задвоенная сумма |
| 13 | `PRIMARY KEY (role, permission_key)` в `role_permissions` | Право описано для роли один раз | Матрица на A10 показывает одно и то же право дважды, причём строки могут противоречить друг другу |

```sql
CREATE UNIQUE INDEX ux_users_email    ON users(email_normalized);
CREATE UNIQUE INDEX ux_sessions_token ON sessions(token_hash);
CREATE UNIQUE INDEX ux_masters_user ON masters(user_id);
CREATE UNIQUE INDEX ux_service_name ON services(category_id, name);
CREATE UNIQUE INDEX ux_service_category_name ON service_categories(name);
CREATE UNIQUE INDEX ux_reset_token  ON password_reset_tokens(token_hash);

-- Совпадение минуты начала. С версии 1.7 индекс частичный: осознанное
-- наложение администратора из него исключено, иначе визит, поставленный
-- ровно на то же время, не прошёл бы мимо уникальности.
-- Пересечения при этом по-прежнему ловят триггеры 34-35.
CREATE UNIQUE INDEX ux_appointments_master_slot
    ON appointments(master_id, starts_at, active_slot)
    WHERE allow_overlap = 0;

CREATE UNIQUE INDEX ux_appointments_client_slot
    ON appointments(client_id, master_id, starts_at, active_slot);
```

Приём с `active_slot`: генерируемое поле равно `1` только для действующих записей и `NULL` для всех остальных. В SQLite `NULL` не конфликтует с `NULL` в уникальном индексе, поэтому отменённых и завершённых записей на одно и то же время может быть сколько угодно, а действующая — только одна.

### 6.2. Индексы для скорости

| # | Индекс | Какой экран ускоряет | Что будет без него |
|---|---|---|---|
| 14 | `ix_appointments_master_time (master_id, starts_at)` | B3, M2, M3, A3 — вычисление свободного времени и день мастера | Каждый показ календаря читает всю таблицу записей целиком. На первой сотне записей незаметно, на нескольких тысячах экран выбора времени начинает заметно думать — а его открывает каждый клиент при каждой записи |
| 15 | `ix_appointments_client_time (client_id, starts_at DESC)` | K1, K2, A8 — свои записи и история | Личный кабинет перебирает записи всех клиентов, чтобы найти пять своих |
| 16 | `ix_appointments_status_time (status, starts_at)` | A2, A4, A9 — фильтры и отчёты | Фильтр «отменённые за месяц» и подсчёт выручки идут полным перебором |
| 17 | `ix_holds_master_time (master_id, starts_at, expires_at)` | B3, B5, A3 — проверка резервов | Проверка «занято ли время» на каждом слоте читает все резервы, включая протухшие |
| 18 | `ix_holds_expires (expires_at)` | Фоновая уборка истёкших резервов | Уборщик перебирает всю таблицу; со временем резервы накапливаются и замедляют пункт 14 |
| 19 | `ix_exceptions_master_time (master_id, starts_at)` | B3, M3, A7 — вычет отпусков и закрытого времени | Каждый расчёт свободного времени читает все отклонения всех мастеров за всю историю |
| 20 | `ix_schedules_master (master_id, weekday)` | B3, M3, A7 — рабочие интервалы дня | Мелочь на 5 мастерах, но это самый частый запрос сервиса: он выполняется на каждое открытие календаря |
| 21 | `ix_notifications_user (user_id, is_read, created_at DESC)` | K4 и счётчик непрочитанных в шапке | Счётчик в шапке считается на **каждой** странице кабинета; без индекса это полный перебор уведомлений всех пользователей при каждом открытии любого экрана |
| 22 | `ix_appt_services_service (service_id)` | A9 — выручка и популярность по услугам | Отчёт «сколько раз делали покрытие» перебирает состав всех записей |
| 23 | `ix_requests_status (status, created_at)` | A2, A7 — блок «Требует внимания» | Поиск необработанных заявок читает весь архив заявок |
| 24 | `ix_audit_entity (entity_type, entity_id, created_at DESC)` | История изменений конкретной записи | «Кто отменил эту запись» ищется перебором всего журнала — а журнал растёт быстрее всех остальных таблиц |
| 25 | `ix_sessions_user (user_id, expires_at)` | Проверка сессии на **каждом** запросе; выход из всех сеансов при смене пароля | Самый частый запрос сервиса вообще: он выполняется перед любым действием любого пользователя. Без индекса каждое нажатие любой кнопки перебирает все сессии всех пользователей |
| 26 | `ix_holds_session (session_token_hash)` | B3 → B4 → B5: поиск своего резерва при возврате на экран подтверждения | Клиент возвращается на B5 после входа, а сервер ищет его резерв перебором всех резервов студии |
| 27 | `ix_closures_dates (date_from, date_to)` | Шаг 0 расчёта свободного времени и календарь на B3 | Проверка «закрыта ли студия» выполняется для каждого из 90 дней календаря и каждый раз читает весь список закрытий |
| 28 | `ix_master_services_service (service_id)` | A5 «Мастера услуги», B2 «кто выполняет выбранные услуги» | Обратный вопрос «кто делает эту услугу» не обслуживается первичным ключом: в `PRIMARY KEY (master_id, service_id)` услуга стоит второй, и поиск по ней читает таблицу целиком |
| 29 | `ix_requests_master (master_id, created_at DESC)` | M3 — свои заявки на изменение графика | Мастер открывает расписание, а сервер перебирает заявки всех мастеров студии |
| 30 | `ix_reset_tokens_user (user_id)` | C3 — нет ли у пользователя уже живой ссылки; удаление аккаунта | Повторный запрос ссылки перебирает все токены сервиса |
| 31 | `ix_audit_actor (actor_user_id, created_at DESC)` | «Что делал этот мастер или администратор» | Журнал растёт быстрее остальных таблиц, и выборка по человеку читает его целиком |
| 32 | `ix_holds_client (client_id)` | B4 — «у вас уже есть резерв»; каскадное удаление аккаунта | Проверка перебирает все живые резервы студии |
| 33 | `ix_holds_reschedule (reschedule_of_id)` | K3 — найти живой резерв переноса этой записи | Поиск идёт перебором резервов; при отмене переноса легко не найти и не убрать свой же резерв |

```sql
CREATE INDEX ix_appointments_master_time  ON appointments(master_id, starts_at);
CREATE INDEX ix_appointments_client_time  ON appointments(client_id, starts_at DESC);
CREATE INDEX ix_appointments_status_time  ON appointments(status, starts_at);
CREATE INDEX ix_holds_master_time         ON slot_holds(master_id, starts_at, expires_at);
CREATE INDEX ix_holds_expires             ON slot_holds(expires_at);
CREATE INDEX ix_exceptions_master_time    ON schedule_exceptions(master_id, starts_at);
CREATE INDEX ix_schedules_master          ON master_schedules(master_id, weekday);
CREATE INDEX ix_notifications_user        ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX ix_appt_services_service     ON appointment_services(service_id);
CREATE INDEX ix_requests_status           ON schedule_change_requests(status, created_at);
CREATE INDEX ix_audit_entity              ON audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX ix_sessions_user             ON sessions(user_id, expires_at);
CREATE INDEX ix_holds_session             ON slot_holds(session_token_hash);
CREATE INDEX ix_closures_dates            ON studio_closures(date_from, date_to);

-- индексы на колонках внешних ключей (SQLite их не создаёт сам)
CREATE INDEX ix_master_services_service   ON master_services(service_id);
CREATE INDEX ix_requests_master           ON schedule_change_requests(master_id, created_at DESC);
CREATE INDEX ix_reset_tokens_user         ON password_reset_tokens(user_id);
CREATE INDEX ix_audit_actor               ON audit_log(actor_user_id, created_at DESC);
CREATE INDEX ix_holds_client              ON slot_holds(client_id);
CREATE INDEX ix_holds_reschedule          ON slot_holds(reschedule_of_id);
```

**Почему индексов не больше.** Каждый индекс — это дополнительная работа при каждой вставке и обновлении строки. На масштабе одной студии узкое место — не объём данных, а частота трёх операций: проверка сессии, показ свободного времени и открытие кабинета. Индексы 14–21, 25 и 26 закрывают именно их, остальные — отчёты и обратные связи по внешним ключам.

Индексы 28–33 добавлены после аудита ключей: SQLite, в отличие от большинства СУБД, **не создаёт индекс на колонке внешнего ключа автоматически**. Какие FK-колонки сознательно оставлены без индекса и почему — в [разделе 12](#12-проверка-ключей).

### 6.3. Триггеры против пересечения записей

Уникальный индекс `ux_appointments_master_slot` ловит только **совпадение
минуты начала**. Записи 10:00–11:30 и 10:30–11:00 у одного мастера он
пропускает: в SQLite нет типа-интервала и ограничения исключения,
как `EXCLUDE USING gist` в PostgreSQL.

Поэтому пересечения отсекаются двумя триггерами. Их два, а не один,
потому что запись меняется двумя разными способами:

| # | Триггер | Когда срабатывает | Что ловит |
|---|---|---|---|
| 34 | `trg_appointments_no_overlap_insert` | `BEFORE INSERT`, если новая запись `booked` и `allow_overlap = 0` | Новая запись поверх чужого визита |
| 35 | `trg_appointments_no_overlap_update` | `BEFORE UPDATE`, если после изменения запись `booked` и `allow_overlap = 0` | Перенос на занятое время, смена мастера на занятого, возврат отменённой записи в `booked` |
| 36 | `trg_appointments_overlap_flag_insert` | `BEFORE INSERT`, если `allow_overlap = 1` | Флаг наложения на записи, созданной не администратором |
| 37 | `trg_appointments_overlap_flag_update` | `BEFORE UPDATE`, если `allow_overlap = 1` | Попытку проставить флаг наложения задним числом |

**Условие пересечения** — строгие неравенства в обе стороны:

```
начало нового  <  конец существующего
   И
конец нового   >  начало существующего
```

Строгие, а не нестрогие, намеренно: визиты вплотную — 15:00–16:00
и 16:00–17:00 — пересечением **не** считаются, иначе мастер не смог бы
принимать клиентов подряд. Нестрогие неравенства отсекли бы запись,
начинающуюся ровно в момент окончания предыдущей.

**Отменённые слот не блокируют.** В проверке участвуют только строки
со статусом `booked` — так же, как в частичном уникальном индексе
и в расчёте свободного времени. Время, освободившееся после отмены,
сразу доступно другим.

**Осознанное наложение.** Администратору иногда нужно поставить визит
поверх занятого времени: мастер согласился принять двоих, клиент пришёл
без записи, визит доделывают в чужой слот. Такая запись создаётся
с `allow_overlap = 1`, и триггер её пропускает.

Исключение действует **только в одну сторону**. Флаг стоит в условии
`WHEN` — то есть освобождает от проверки саму вставляемую строку,
— но в подзапросе `EXISTS` фильтра по `allow_overlap` нет. Поэтому
запись, поставленная поверх занятого времени, дальше ведёт себя как
обычная: занимает время в календаре и не даёт записаться на него другим.
Разрешено само наложение, а не запись, которая раздаёт разрешения дальше.

**Флаг доступен только администратору, и это проверяет сама база.**
Триггеры 36 и 37 отказывают, если `allow_overlap = 1` появляется
у записи с `created_by_role <> 'admin'` — при вставке и при изменении.
Проверка роли живёт в API, а это второй контур: путь, который обойдёт
API, всё равно не сможет выписать себе разрешение на наложение.

```sql
CREATE TRIGGER trg_appointments_no_overlap_insert
BEFORE INSERT ON appointments
WHEN NEW.status = 'booked' AND NEW.allow_overlap = 0
BEGIN
    SELECT RAISE(ABORT, 'appointment_overlap')
     WHERE EXISTS (SELECT 1 FROM appointments a
                    WHERE a.master_id = NEW.master_id
                      AND a.status    = 'booked'   -- фильтра по a.allow_overlap нет:
                      AND a.starts_at < NEW.ends_at  -- наложенная запись сама блокирует
                      AND a.ends_at   > NEW.starts_at);
END;

CREATE TRIGGER trg_appointments_overlap_flag_insert
BEFORE INSERT ON appointments
WHEN NEW.allow_overlap = 1 AND NEW.created_by_role <> 'admin'
BEGIN
    SELECT RAISE(ABORT, 'overlap_flag_requires_admin');
END;
```

Триггер на `UPDATE` устроен так же, но исключает саму изменяемую строку
(`a.id <> OLD.id`) — иначе запись пересекалась бы сама с собой при любой
правке, например при смене статуса на `completed`.

**Текст ошибки `appointment_overlap` — часть интерфейса базы.** API ловит
именно его и превращает в ответ 409 с понятным сообщением и списком
ближайших свободных слотов. Наружу текст ошибки SQLite не выходит.

**Что триггеры не заменяют.** Они последний рубеж, а не единственная
защита. Без проверки в коде API клиент видел бы занятое время в календаре
и узнавал о конфликте только в момент подтверждения. Полная защита —
три уровня: резерв в `slot_holds`, проверка внутри транзакции
`BEGIN IMMEDIATE` и эти триггеры.

---

## 7. Спорные решения

Места, где был выбор между несколькими вариантами, и объяснение выбора.

### 7.1. Одна таблица `users` для всех ролей вместо `clients` / `masters` / `admins`

**Альтернатива:** отдельная таблица под каждую роль.

**Выбрано:** одна таблица `users` с полем `role` плюс отдельная `masters` для витрины.

Вход устроен одинаково для всех трёх ролей: e-mail, пароль, восстановление. При разделении логику входа, хеширования и восстановления пришлось бы писать трижды, а внешние ключи вроде «кто отменил запись» пришлось бы делать составными («роль + id»), потому что отменить может любой из трёх. Смена роли на экране A10 в этом варианте превращается в перенос строки между таблицами.

Плата за это решение: часть полей `masters` не применима к клиенту и наоборот, и роль каждый раз нужно проверять в коде API.

### 7.2. Карточка мастера отделена от аккаунта

**Альтернатива:** хранить всё в `users`, а мастера отличать по `role = 'master'`.

**Выбрано:** отдельная таблица `masters` с необязательной ссылкой на `users`.

Решающий аргумент — экран A10: там есть действие «привязка аккаунта к карточке мастера». Значит карточка может существовать раньше аккаунта: администратор заводит мастера, показывает его на лендинге и в выборе, а логин выдаёт позже. Плюс у карточки есть поля, которых нет у клиента: фото, специализация, порядок вывода.

Цена: почти во всех запросах по мастеру нужен `JOIN` двух таблиц.

### 7.3. Отмена — один статус плюс поле «кто отменил», а не три отдельных статуса

**Альтернатива:** статусы `cancelled_by_client`, `cancelled_by_master`, `cancelled_by_admin`.

**Выбрано:** статус `cancelled` + поля `cancelled_by_role`, `cancelled_by_user_id`, `cancel_reason`, `cancelled_at`.

При трёх статусах любой запрос «покажи отменённые» превращается в перечисление трёх значений, и каждое новое место отмены (например, автоотмена по неоплате в будущем) добавляет ещё один статус и ломает все существующие запросы. С одним статусом набор остаётся коротким — четыре значения, — а детали отмены лежат в полях, которые при этом ещё и обязаны заполняться вместе (ограничение `CHECK`).

### 7.4. Перенос меняет ту же запись, а не создаёт новую

**Альтернатива:** при переносе отменять старую запись и создавать новую со ссылкой `rescheduled_from_id`.

**Выбрано:** запись остаётся той же, меняются `starts_at` / `ends_at` и растёт `reschedule_count`.

Экран K3 требует лимит в 3 переноса именно для конкретной записи. При создании новой строки счётчик пришлось бы протаскивать по цепочке записей, а история клиента (K2) засорилась бы техническими отменами, которых клиент не делал: вместо одного визита он увидел бы «отменена, отменена, подтверждена». Что именно изменилось и кто это сделал, фиксирует `audit_log` с действием `reschedule`.

Цена: прежнее время видно только в журнале, а не в самой записи.

### 7.5. Статусы через `CHECK`, а не через таблицу-справочник

**Альтернатива:** таблица `appointment_statuses` и внешний ключ на неё.

**Выбрано:** `CHECK (status IN ('booked','completed','no_show','cancelled'))`.

Набор статусов — часть логики приложения, а не данные, которые администратор редактирует. Новый статус всё равно потребует нового кода: правил перехода, кнопок, текстов на экранах. Справочник в таком случае создаёт иллюзию настраиваемости и добавляет `JOIN` в каждый запрос по записям. `CHECK` при этом даёт то же самое главное свойство — в поле физически не может оказаться произвольный текст вроде «отменена клиентом» с опечаткой.

Цена: изменение набора статусов требует пересоздания таблицы (в SQLite ограничение `CHECK` нельзя изменить командой `ALTER`).

### 7.6. Хранение в UTC, а не в местном времени студии

**Альтернатива:** хранить местное время — студия одна, часовой пояс один.

**Выбрано:** UTC в базе, перевод в местное время при выводе.

Местное время удобнее при чтении базы глазами, но дважды в год оно неоднозначно, если в стране есть переход на летнее время. Час, который повторяется, делает два разных момента одинаковой строкой — и запись «на 02:30» перестаёт определять момент однозначно. UTC монотонен всегда. Это тот случай, когда переделка после запуска стоит дороже, чем неудобство сейчас.

Отдельно оговорено: время суток в графике мастера хранится **местное** (`HH:MM`), потому что «работаю с 10 до 20» — это про местные часы, а не про абсолютный момент.

### 7.7. Снимок цены и длительности в составе записи

**Альтернатива:** хранить только `service_id` и брать цену из `services`.

**Выбрано:** копировать `duration_min` и `price_kopecks` в `appointment_services`, а название брать по ссылке.

Это сознательная денормализация. Без неё повышение цены задним числом меняет сумму всех прошлых визитов, и отчёт за прошлый месяц на экране A9 каждый раз показывает разные числа. Такие таблицы — «документ о сделке», а не ссылка на текущий прайс.

Цена: данные дублируются, и при правке услуги нужно помнить, что прошлые записи не меняются — это и есть желаемое поведение, но его нужно держать в голове.

### 7.8. Резервы в отдельной таблице, а не статусом записи

**Альтернатива:** создавать запись сразу в статусе `pending` и превращать её в `booked` при подтверждении.

**Выбрано:** отдельная таблица `slot_holds`.

На шаге B3 клиент может быть ещё не авторизован — вход происходит только на шаге B4. Запись без `client_id` создать нельзя, а делать это поле необязательным ради 10-минутного резерва — значит ослабить ключевое ограничение самой важной таблицы. Резерв к тому же живёт по другим правилам: он протухает сам и его не нужно хранить в истории.

Побочная выгода: `appointments` содержит только реальные записи, поэтому статистика и выручка считаются без оговорки «кроме брошенных черновиков».

### 7.9. Пересечения интервалов — триггерами, а не только проверкой в коде

**Было ограничением, стало решением.**

`ux_appointments_master_slot` ловит только полное совпадение времени начала. Запись на 10:00–11:30 и запись на 10:30–11:00 у одного мастера индексом не отсекаются — в SQLite нет типа-интервала и ограничения исключения, как в PostgreSQL.

До версии 1.6 отсюда следовало, что проверка пересечений обязана жить в коде API. Это верно, но недостаточно: проверка в коде защищает ровно до тех пор, пока все пути записи проходят через неё. Любой второй путь — ручная правка администратором, скрипт переноса, будущий кабинет мастера — обходит её молча.

Поэтому с версии 1.6 условие пересечения продублировано двумя триггерами ([раздел 6.3](#63-триггеры-против-пересечения-записей)). База перестала зависеть от дисциплины вызывающего кода: запрет выражен там же, где лежат данные.

Проверка в API при этом никуда не делась и остаётся основной: она отсекает конфликт **до** попытки вставки и отвечает клиенту списком свободного времени, а не отказом. Триггер срабатывает только в гонке, когда двое подтверждают один слот в одну и ту же долю секунды. Это прямо связано с риском из паспорта: «если проверка доступности не реализована на уровне API, возможна двойная запись».

### 7.10. Телефон обязателен в `users`

**Альтернатива:** сделать поле необязательным, раз регистрация идёт по e-mail.

**Выбрано:** `phone NOT NULL`.

Экран M2 показывает мастеру телефон клиента — это единственный способ связаться, если клиент опаздывает. Если поле необязательное, требование «телефон нужен для записи» придётся проверять только в коде, и рано или поздно в базе появятся записи без контакта.

Цена: форма регистрации на C2 становится на одно поле длиннее, а администратору при ручном создании клиента на A4/A8 телефон придётся вводить обязательно.

### 7.11. `settings` как таблица «ключ — значение»

**Альтернатива:** таблица с одной строкой и именованными колонками (`hold_minutes`, `cancel_deadline_hours`, …).

**Выбрано:** ключ — значение.

Строгие колонки дают типизацию и `CHECK`, но каждая новая настройка требует миграции схемы. На этапе прототипа набор правил будет меняться чаще всего остального, и таблица «ключ — значение» позволяет добавить правило одной строкой, а на экране A11 отрисовать список настроек единообразно.

Цена: значения хранятся текстом, приведение типа и проверка допустимых диапазонов ложатся на код.

### 7.12. Аналитика и выручка не хранятся, а считаются

**Альтернатива:** таблицы агрегатов — выручка по дням, загрузка мастеров.

**Выбрано:** считать запросами по `appointments` и `appointment_services`.

Одна студия с несколькими мастерами — это порядка тысяч записей в год. Такой объём агрегируется мгновенно, а предподсчитанные таблицы придётся синхронизировать при каждой отмене и смене статуса задним числом, что администратору на A4 прямо разрешено. Рассинхронизация отчёта с реальными записями — худший из возможных багов в аналитике, потому что он тихий.

Цена: если студия сильно вырастет, экран A9 придётся оптимизировать отдельно.

### 7.13. Сессии в базе, а не самодостаточный токен

**Альтернатива:** подписанный токен (JWT), который не требует обращения к базе.

**Выбрано:** таблица `sessions` с хешем токена.

Самодостаточный токен нельзя отозвать: он действителен до истечения срока, что бы ни произошло. А в карте связей кнопка «Выйти» есть почти на каждом экране, и на трёх экранах (K5, M4, C4) меняется пароль. Пользователь, который сменил пароль, вправе ожидать, что чужой открытый сеанс закрылся, — с неотзываемым токеном это не так.

Цена: проверка сессии добавляет обращение к базе на каждый запрос. Для одной студии это дешёвое чтение по индексу, ради которого и заведён `ix_sessions_user`.

### 7.14. Выбранные услуги хранятся в базе, а не в браузере

**Альтернатива:** держать корзину в `localStorage` или в cookie до подтверждения.

**Выбрано:** таблица `slot_hold_services`, привязанная к резерву.

Путь записи по карте связей не линейный: с B4 клиент может уйти на C3 и C4 (восстановление пароля) и вернуться на B5 **по ссылке из письма** — то есть потенциально в другом окне или даже на другом устройстве. Карта связей при этом прямо требует: «если восстановление начато внутри записи и резерв ещё жив» — вернуть клиента на экран подтверждения. Корзина в браузере этот переход не переживёт.

Кроме того, длительность `T` нужна серверу, а не браузеру: именно сервер решает, помещается ли сумма услуг в слот, и доверять этот расчёт клиенту нельзя — иначе занять чужое время можно подделанным запросом.

Цена: у резерва появляется подчинённая таблица, и при истечении резерва чистятся две таблицы вместо одной (это делает `ON DELETE CASCADE`).

### 7.15. Матрица прав хранится, но не управляет доступом

**Альтернатива 1:** не хранить вовсе — отрисовать таблицу прав прямо в вёрстке экрана A10.
**Альтернатива 2:** сделать её настоящим источником прав, который проверяет API.

**Выбрано:** хранить как справочник только для показа.

Против первого варианта: матрица в вёрстке рассинхронизируется с кодом на второй же правке прав, и экран A10 начинает уверенно показывать неправду.

Против второго — риск из паспорта: «ошибка в проверке роли может дать клиенту доступ к чужим записям». Редактируемая матрица превращает случайную правку строки в дыру в доступе, причём беззвучную. Правила доступа остаются в коде, а таблица заполняется миграцией вместе с ним.

Цена: при изменении прав нужно помнить о двух местах — коде и миграции справочника.

### 7.16. `password_hash` может быть пустым

**Альтернатива:** генерировать случайный пароль клиенту, которого администратор завёл вручную.

**Выбрано:** `password_hash` необязательное; аккаунт без хеша существует, но войти в него нельзя.

Администратор создаёт записи вручную (A4) и ведёт базу клиентов (A8) — включая тех, кто пришёл по телефону и никогда не регистрировался. Случайный пароль в этом случае — это настоящий, работающий пароль, который никто никогда не узнает и не сменит: он просто лежит в базе и увеличивает поверхность атаки, ничего не давая взамен. Пустой хеш честнее описывает положение дел: учётной записи для входа ещё нет.

Требование «хранить только хеш» при этом не нарушено: поля для самого пароля по-прежнему нет.

Цена: проверка входа обязана отдельно обрабатывать `NULL` — аккаунт без хеша не должен пускать никого, и сообщение об ошибке не должно выдавать, что такой e-mail в базе есть.

### 7.17. Смещение пояса числом, а не только название пояса

**Альтернатива:** хранить только `timezone = 'Europe/Moscow'` и переводить время в коде приложения.

**Выбрано:** хранить и название, и `utc_offset_minutes = 180`.

Проверка показала, что SQLite не знает названий часовых поясов: `datetime('2026-10-06T10:00:00', 'Europe/Moscow')` возвращает `NULL`. Он умеет только `'localtime'` — то есть пояс **операционной системы сервера**, который на VPS запросто окажется UTC и тихо сдвинет весь календарь на три часа. Без числового смещения запрос свободного времени не выполняется вообще: в проверке он вернул пустой список.

Название пояса при этом остаётся: оно нужно человеку на экране настроек и понадобится коду приложения, если студия переедет.

**Ограничение, которое нужно знать.** Фиксированное смещение верно, пока в поясе нет перевода часов, — в России его нет с 2014 года. Если сервис когда-нибудь запустят там, где часы переводят, одного числа станет мало: потребуется таблица переходов или расчёт на стороне приложения. Для MVP одной студии это оправданное упрощение.

### 7.18. Закрытия студии отдельной таблицей, а не отпуском каждому мастеру

**Альтернатива:** отмечать праздники строкой `vacation` в `schedule_exceptions` для каждого мастера.

**Выбрано:** таблица `studio_closures` на всю студию.

Новогодние праздники при десяти мастерах — это десять строк вместо одной, и достаточно забыть одну, чтобы в закрытый день открылась запись. Кроме того, «студия закрыта» и «мастер в отпуске» — разные факты: первый касается всех и отменяет день целиком, второй касается одного человека. Смешивать их в одной таблице значит потерять возможность отличить их в отчётах.

Цена: расчёт свободного времени получает ещё одну проверку, а администратор — ещё один список на экране A11.

### 7.19. Наложение разрешается флагом в строке, а не отключением проверки

Администратору нужно иметь возможность поставить визит поверх занятого времени: мастер согласился принять двоих, клиент пришёл без записи, предыдущий визит затянулся. Вариантов было три.

**Отключать триггер на время операции** (`PRAGMA` или `DROP`/`CREATE` вокруг вставки) — отвергнуто сразу. Защита, которую снимают ради одной операции, снята для всех операций, идущих в этот момент параллельно. Плюс это требует прав на изменение схемы у кода, который выписывает записи.

**Отдельная таблица исключений** — «этому визиту наложение разрешено». Честно, но громоздко: триггеру пришлось бы заглядывать в неё при каждой вставке, а строка-разрешение живёт отдельно от строки-записи и может её пережить.

**Флаг в самой строке** — выбрано. Разрешение хранится там же, где решение, которое его породило: видно в любой выборке, попадает в экспорт, не может рассинхронизироваться с записью и исчезает вместе с ней.

Ключевая тонкость — **асимметрия**. Флаг стоит только в условии `WHEN`, освобождая от проверки саму вставляемую строку, и отсутствует в подзапросе `EXISTS`. Соблазн был написать `AND a.allow_overlap = 0` и там — тогда наложенная запись перестала бы мешать кому-либо. Это превратило бы её в «прозрачную»: на её время записался бы кто угодно, и администратор получил бы не двоих клиентов в одном слоте, а неизвестно сколько. Разрешено одно конкретное наложение, а не право раздавать наложения дальше.

Вторая тонкость — **кто ставит флаг**. Проверка роли живёт в API, но продублирована триггерами 36–37: `allow_overlap = 1` допустим только при `created_by_role = 'admin'`. Это тот же принцип, что и с пересечениями: запрет, выраженный в базе, действует для всех путей записи, а не только для тех, что идут через обработчики.

---

## 8. Ревизия по карте связей

Повторный проход по всем 31 экрану: что не хватало в версии 1.0 и чем это закрыто в 1.1.

### 8.1. Найденные пробелы

| # | Экраны | Чего не хватало | Что добавлено |
|---|---|---|---|
| 1 | C1, C2, C4, B4, M1, A1 + кнопка «Выйти» на K5, M2–M4, A2–A11 | Сессии не было в схеме вовсе. Вход некуда записать, выходу нечего прекращать, а `slot_holds.session_token` ссылался на несуществующую сущность | Таблица `sessions`, индекс `ix_sessions_user`, ограничение `ux_sessions_token` |
| 2 | B1 → B2 → B3 → B4 → B5 | Выбранные услуги негде было хранить между шагами. Запись появляется только на B5, а длительность `T` нужна уже на B3, сумма — на B5, и всё это должно пережить вход и восстановление пароля на B4 → C3 → C4 | Таблица `slot_hold_services`, индекс `ix_holds_session` |
| 3 | K3, B5 | Резерв не отличал перенос от новой записи. На B5 кнопка называется «Подтвердить перенос» и меняет время существующей записи — сервер не знал, какой именно | Поле `slot_holds.reschedule_of_id` |
| 4 | A10 | «Справочная матрица прав» — это данные на экране, а хранить их было негде | Таблица `role_permissions` |
| 5 | A4, A8 | Администратор заводит клиента вручную, но `password_hash NOT NULL` требовал пароль для человека, который никогда не регистрировался | `password_hash` стал необязательным |
| 6 | B2, A9 | Выбор «Любой мастер» нигде не фиксировался: после подбора мастера запись выглядела так, будто клиент выбрал его сам. Для аналитики загрузки это разные случаи | Поле `appointments.master_chosen_by_client` |
| 7 | A9 | Экспорт данных в CSV не журналировался, хотя это выгрузка клиентской базы | Значения `export` и `report` в `audit_log` |
| 8 | K5, M4, C4, A10 | В журнале не было действий входа, выхода, смены пароля и работы с заявками графика | Значения `logout`, `password_change`, `schedule_change_request` в `audit_log` |
| 9 | M3 → A7, A2 | Мастер отправляет заявку на изменение графика, но администратор не получал уведомления — блок «Требует внимания» на A2 приходилось опрашивать | Тип `schedule_request_created` в `notifications` |
| 10 | L1 | Название, адрес, телефон и текст «О студии» на лендинге негде было хранить | Ключи `studio_name`, `studio_address`, `studio_phone`, `studio_about` в `settings` |

### 8.2. Экраны, которым данных хватало

Проверены и не потребовали изменений:

- **L1, B1, B2** — витрина собирается из `services`, `service_categories`, `masters`, `master_services`.
- **B3** — свободное время по-прежнему вычисляется, таблица слотов не появилась (требование 3 соблюдено).
- **B6, K1, K2** — результат записи и история полностью описываются `appointments` + `appointment_services`.
- **K4** — уведомления закрыты таблицей `notifications`.
- **M2** — день мастера, статусы «Завершена» и «Не пришёл», телефон клиента: `appointments` + `users`.
- **M3, A7** — графики, отпуска, закрытое время и заявки: `master_schedules`, `schedule_exceptions`, `schedule_change_requests`.
- **M4, A9** — загрузка и выручка считаются запросами, отдельных таблиц отчётности нет.
- **A3** — сетка «мастера × время» и ручное освобождение слота: отмена меняет статус, время возвращается само.
- **A5, A6** — справочники услуг и мастеров.
- **A8** — база клиентов: `users` + история по `appointments`.
- **A11** — `studio_hours` и `settings`.
- **C3** — `password_reset_tokens`.

### 8.3. Что осталось за пределами схемы сознательно

- **Отправка писем.** Экран C3 отправляет ссылку, но очереди писем в MVP нет: карта связей помечает переход C3 → C4 как «в прототипе — прямой переход».
- **Конфликты графика (A7).** Ситуация «новый график мастера противоречит существующим записям» вычисляется запросом при сохранении графика, отдельной таблицы конфликтов не нужно.
- **Галерея работ мастера.** На экранах карты связей её нет.
- **Защита от подбора пароля.** Счётчик неудачных попыток входа ни на одном экране не отображается; при необходимости добавляется отдельно, не затрагивая остальную схему.

---

## 9. Проверка расчёта свободного времени

Схема проверена не рассуждением, а исполнением: база создана по этому документу, заполнена данными и опрошена [запросом из раздела 5.4](#54-опорный-запрос).

### 9.1. Что не хватало

| # | Чего не хватало | Как проявлялось | Что добавлено |
|---|---|---|---|
| 1 | Числового смещения часового пояса | `datetime(..., 'Europe/Moscow')` возвращает `NULL`: перевести «10:00 местного» в момент UTC внутри запроса нечем. Расчёт возвращал пустой список | `settings.utc_offset_minutes` |
| 2 | Разовых нерабочих дней студии | Праздник или санитарный день выражался только отпуском каждому мастеру по отдельности; забытая строка открывала запись в закрытый день | Таблица `studio_closures` + индекс `ix_closures_dates` |
| 3 | Минимального срока до визита | Ничто не мешало клиенту записаться на время через пять минут: шаг «отбросить прошедшее» отсекал только уже наступившее | `settings.min_lead_time_minutes` |
| 4 | Технического перерыва после визита | Записи вставали вплотную, без времени на уборку рабочего места | `settings.buffer_after_minutes` (по умолчанию `0` — поведение паспорта) |

Кроме того, в разделе 5 явно зафиксированы три вещи, на которых легко ошибиться: перевод нумерации дней недели, строгие неравенства при проверке пересечений и требование заполнить `studio_hours` на все семь дней.

### 9.2. Контрольный пример

Вторник **6 октября 2026**, мастер Ольга. График: 10:00–14:00 и 15:00–20:00 (обед). Студия открыта 09:00–21:00. Занято: запись 11:00–12:30, закрытое мастером время 16:00–17:00, чужой живой резерв 18:00–19:00. Клиент выбрал услуги на **90 минут**, буфер 15 минут, запрос сделан накануне.

Результат запроса — **12:30**, единственный вариант. Разбор:

- до 12:30 всё перекрывается записью 11:00–12:30;
- 12:45 уже не помещается: 12:45 + 90 мин = 14:15, а интервал заканчивается в 14:00;
- во втором интервале старты с 15:00 до 16:45 упираются в закрытое время, а с 17:00 до 18:30 — в чужой резерв;
- после резерва остаётся меньше 90 минут до 20:00.

### 9.3. Что показали проверки

| Проверка | Результат |
|---|---|
| Базовый расчёт | `12:30` — совпадает с ручным разбором |
| Буфер `0` (режим паспорта) | `12:30` — буфер на этом наборе данных ничего не меняет |
| День внесён в `studio_closures` | Свободного времени нет — закрытие студии работает |
| Запрос в тот же день в 11:00 при сроке 2 часа | `17:00 … 18:30` — близкое время отсечено, а **истёкший резерв** больше не занимает 18:00–19:00: время вернулось в свободные само, без отдельного действия |
| Удалён `utc_offset_minutes` | Свободного времени нет — настройка обязательная, а не удобная |

Четвёртая строка заодно подтверждает ключевое свойство схемы: **освобождение времени ничего не требует.** Резерв протух — и слот снова свободен при следующем вычислении. Так же ведут себя отмена и перенос: запись меняет статус, и время возвращается само, без таблицы слотов, которую пришлось бы чинить.

---

## 10. Дублирование полей

Схема просмотрена на предмет полей, которые хранят одно и то же в нескольких таблицах. Найденное разделилось на три группы: избыточность, которую убрали; вычислимые значения, которые заменили выражением; и снимки, которые оставлены намеренно.

### 10.1. Убрано как избыточное

| Поле | Где дублировалось | Где данные теперь | Как получить |
|---|---|---|---|
| `appointments.duration_min` | То же значение выражалось через `ends_at − starts_at` и через сумму `appointment_services.duration_min` — одна величина в трёх местах | `appointments.starts_at` / `ends_at` | `(strftime('%s', ends_at) − strftime('%s', starts_at)) / 60` |
| `appointments.total_price_kopecks` | Сумма `appointment_services.price_kopecks` | `appointment_services` | `SUM(price_kopecks) … WHERE appointment_id = :id` |
| `appointment_services.service_name` | `services.name` | `services` | `JOIN services ON services.id = appointment_services.service_id` |
| `masters.display_name` как обязательное имя | `users.full_name` | `users.full_name` | `COALESCE(m.display_name, u.full_name)` |

Что это даёт: у каждого значения появляется одно место, где его правят. Раньше смена состава услуг в записи требовала не забыть пересчитать `duration_min`, `total_price_kopecks` **и** `ends_at`; пропуск любого из трёх давал запись, у которой сумма не сходится с составом, а конец визита не совпадает с длительностью. Такое расхождение не ловится ни одним ограничением — база остаётся формально корректной и тихо показывает неправду на экранах K1, M2 и A9.

`display_name` не удалён полностью: он остался **необязательным псевдонимом** для витрины и обязателен только у карточки без привязанного аккаунта, где имя взять больше неоткуда. Это закреплено ограничением `CHECK (user_id IS NOT NULL OR display_name IS NOT NULL)`.

### 10.2. Заменено вычисляемым полем

| Поле | Дублировало | Решение |
|---|---|---|
| `users.email_normalized` | `users.email` | `GENERATED ALWAYS AS (lower(trim(email))) STORED` |

Значение по-прежнему лежит в таблице и по-прежнему индексируется уникальным индексом `ux_users_email` — но вписать в него что-то своё больше нельзя. До этого нормализацию выполнял код приложения, и любое место, забывшее привести адрес к нижнему регистру, пробивало защиту от повторной регистрации: `Anna@mail.ru` проходил мимо уникального индекса, заведённого на нормализованное значение.

### 10.3. Оставлено намеренно

Эти поля повторяют данные из других таблиц, и это не ошибка: они фиксируют **состояние на момент события**, которое позже изменится в первоисточнике.

| Поле | Повторяет | Почему остаётся |
|---|---|---|
| `appointment_services.price_kopecks`, `duration_min` | `services` | Документ о сделке. Повышение цены не должно менять сумму прошлых визитов и отчёт за прошлый месяц на A9 |
| `slot_hold_services.price_kopecks`, `duration_min` | `services` | За десять минут на экране подтверждения прайс не должен поменять сумму под рукой у клиента |
| `sessions.role_at_login` | `users.role` | Роль, выданная при входе. Если администратор сменил роль на A10, старая сессия не должна молча получить новые права |
| `audit_log.actor_role` | `users.role` | Журнал обязан показывать, кем человек был в момент действия, а не кем стал потом |
| `appointments.created_by_role` | роль пользователя из `created_by_user_id` | Различает «клиент записался сам» и «администратор записал вручную» — это свойство самой записи, и оно не должно меняться, если человек потом сменит роль |
| `appointments.cancelled_by_role` | роль пользователя из `cancelled_by_user_id` | Экран K2 показывает «отменена вами» или «отменена студией» для каждой строки истории. Тянуть это из `audit_log` на каждую строку — лишний запрос ради факта, который уже известен |

Общее правило: **дублировать можно то, что описывает прошлое; нельзя то, что описывает настоящее.** Цена услуги в записи — прошлое, она зафиксирована. Название услуги на экране — настоящее, его берут по ссылке.

### 10.4. Проверено и дублированием не является

- **`token_hash` в `sessions` и `password_reset_tokens`** — одинаковое имя, разные сущности: токен сеанса и токен одноразовой ссылки.
- **`description` в `services` и `settings`** — описание услуги и пояснение к настройке.
- **`role` в `role_permissions`** — не копия `users.role`, а измерение справочника: строка описывает право для роли, а не роль пользователя.
- **`settings.timezone` и `settings.utc_offset_minutes`** — название пояса для человека и число для расчёта; обоснование в разделе 7.17.
- **`weekday` в `studio_hours` и `master_schedules`** — день недели студии и день недели мастера, это разные графики.

---

## 11. Поля с секретами

Схема просмотрена на предмет полей, где мог бы оказаться пароль или другой секрет в открытом виде.

### 11.1. Полная сверка

| Таблица и поле | Что хранит | Открытое значение? |
|---|---|---|
| `users.password_hash` | Хеш пароля (bcrypt / argon2) вместе с солью | нет — хеш |
| `password_reset_tokens.token_hash` | Хеш токена из ссылки восстановления | нет — хеш |
| `sessions.token_hash` | Хеш токена сеанса | нет — хеш |
| `slot_holds.session_token_hash` | Хеш токена браузера, удерживающего резерв | нет — хеш (с версии 1.4) |

**Поля для пароля в открытом виде в схеме нет и не было.** Требование 5 заложено с первой версии: колонка называется `password_hash`, хранит результат одностороннего хеширования, и для входа сравниваются хеши, а не пароли. Колонки `password`, `passwd`, `pwd` в схеме отсутствуют.

### 11.2. Что изменено в версии 1.4

Сверка нашла одну несогласованность: `slot_holds.session_token` хранился **в открытом виде**, тогда как все остальные токены сервиса — хешами. Поле переименовано в `session_token_hash` и хранит хеш.

Риск был невелик: токен удерживает слот десять минут и не даёт доступа к личным данным. Но это токен на предъявителя — кто им владеет, тот распоряжается резервом. При утечке базы чужой резерв можно было перехватить и довести до записи от имени того, кто выбирал время. Главное же, что правило «в базе лежат только хеши секретов» должно действовать без исключений: одно исключение со временем становится двумя.

Поиск резерва работает как прежде — по хешу вместо самого токена, индекс `ix_holds_session` перестроен на новое поле.

### 11.3. Правила, которые следуют из этого

- **Хешируется всё, что предъявляют как ключ:** пароли, токены сессий, токены восстановления, токены резерва.
- **Пароль не попадает ни в журнал, ни в `audit_log.details`.** Действие `password_change` фиксирует сам факт смены, без старого и нового значения.
- **Сообщение об ошибке входа не различает «нет такого e-mail» и «неверный пароль»** — иначе форма входа превращается в способ проверить, зарегистрирован ли человек в студии.
- **Пустой `password_hash` не пускает никого.** Это состояние аккаунта, заведённого администратором вручную, а не пароль по умолчанию.

---

## 12. Проверка ключей

Схема проверена на полноту первичных ключей и корректность внешних: цель каждой ссылки, совпадение типов, согласованность действий при удалении и наличие индексов.

### 12.1. Первичные ключи — все на месте

Все 20 таблиц имеют первичный ключ. Четыре из них — составной, и это осознанно:

| Таблица | Ключ | Почему составной |
|---|---|---|
| `master_services` | `(master_id, service_id)` | Связь «многие ко многим», своего идентификатора у строки нет |
| `appointment_services` | `(appointment_id, service_id)` | То же: строка существует только как пара |
| `slot_hold_services` | `(hold_id, service_id)` | То же |
| `role_permissions` | `(role, permission_key)` | Право описывается парой «роль + код права» |

Составной ключ здесь заодно работает ограничением уникальности: услуга не попадёт в одну запись дважды. Суррогатный `id` пришлось бы дополнять отдельным уникальным индексом на ту же пару — то есть хранить то же самое, но в двух местах.

`settings` ключуется по `key`, `studio_hours` — по `weekday`: у обеих таблиц естественный ключ уже есть, и добавлять к нему числовой не за чем.

### 12.2. Внешние ключи — ошибок не найдено

Проверено по всем 28 объявленным внешним ключам:

| Что проверялось | Результат |
|---|---|
| Таблица-цель существует | ✓ все ссылки ведут на существующие таблицы |
| Колонка-цель существует и уникальна | ✓ все ссылаются на первичный ключ |
| Типы совпадают | ✓ везде `INTEGER` → `INTEGER` |
| `ON DELETE SET NULL` только на колонках, допускающих `NULL` | ✓ нарушений нет |

Последняя проверка — самая коварная: `SET NULL` на колонке `NOT NULL` не ловится при создании таблицы и падает только в момент удаления родительской строки, то есть в бою.

Действия при удалении расставлены по трём правилам:

- **`RESTRICT`** — там, где удаление стёрло бы историю: клиент и мастер записи, услуга в составе записи, автор действия в журнале. Сначала нужно разобраться с записями, и только потом удалять.
- **`CASCADE`** — там, где дочерняя строка не имеет смысла отдельно от родителя: сессии и уведомления пользователя, состав резерва, график мастера.
- **`SET NULL`** — там, где ссылка справочная и её потеря не ломает строку: кто последним правил настройку, кто рассмотрел заявку, из какой записи пришло уведомление.

### 12.3. Что исправлено

**1. Шесть колонок внешних ключей получили индексы.** SQLite, в отличие от большинства СУБД, не создаёт индекс на дочерней колонке автоматически. Без него проверка ссылочной целостности при удалении родителя читает дочернюю таблицу целиком, и точно так же читает её любой запрос «в обратную сторону». Добавлены индексы 28–33 из раздела 6.2 — в первую очередь те, по которым реально ходят экраны: «мастера этой услуги» (A5, B2), «мои заявки» (M3), «мой резерв» (B4, K3).

**2. У `ux_masters_user` снято условие `WHERE user_id IS NOT NULL`.** Частичный индекс не годится для проверки внешнего ключа: SQLite не может на него опереться, и удаление пользователя всё равно читало таблицу мастеров целиком. Условие при этом было лишним с самого начала — обычный `UNIQUE` в SQLite допускает сколько угодно строк с `NULL`, так что карточки без привязанного аккаунта ему не мешают.

### 12.4. FK-колонки, сознательно оставленные без индекса

| Колонка | Почему без индекса |
|---|---|
| `appointments.created_by_user_id`, `cancelled_by_user_id` | Нужны только для показа в уже найденной записи; обратный вопрос «все записи, созданные этим администратором» не задаётся ни на одном экране |
| `schedule_exceptions.created_by`, `settings.updated_by`, `studio_closures.created_by` | Справочные ссылки «кто это сделал». Таблицы маленькие, обратных выборок нет |
| `schedule_change_requests.reviewed_by` | То же; выборки идут по `status` и `master_id`, а они проиндексированы |
| `notifications.appointment_id` | Переход всегда из уведомления к записи, никогда наоборот |
| `slot_hold_services.service_id` | `services` защищена `RESTRICT` и не удаляется; обратный вопрос «в каких резервах эта услуга» не задаётся |
| `slot_holds.appointment_id` | Заполняется один раз при подтверждении и больше не читается |

Общее основание: индекс стоит работы при каждой вставке, а `users`, `appointments` и `services` в этом сервисе **не удаляются** — вместо удаления меняется `is_active` или статус. Значит проверка ссылочной целостности по этим колонкам в обычной работе не выполняется вовсе.

### 12.5. Известное ограничение: `audit_log.entity_id`

`audit_log` ссылается на изменённую строку парой «`entity_type` + `entity_id`», и внешнего ключа на ней нет — объявить один FK сразу на девять таблиц невозможно.

Следствие: журнал может сослаться на строку, которой больше нет. Поэтому `audit_log.details` обязан хранить достаточно контекста, чтобы запись журнала читалась сама по себе — «отменена запись клиента Анны к мастеру Ольге на 6 октября 10:00», а не только идентификатор. Проверять целостность таких ссылок база не будет.

### 12.6. Главный риск — не в самих ключах

Все внешние ключи в SQLite **выключены по умолчанию** и включаются заново в каждом соединении:

```sql
PRAGMA foreign_keys = ON;
```

Забыть эту строку — значит получить схему, где все 28 внешних ключей написаны, видны в документации и не работают ни одного дня. Ошибки при этом не будет: данные просто начнут расходиться. Поэтому `PRAGMA` ставится в код, который открывает соединение, а не в миграцию, и целостность уже накопленной базы проверяется командой:

```sql
PRAGMA foreign_key_check;
```

Пустой результат означает, что битых ссылок нет.

---

## Приложение. Порядок создания таблиц

Из-за внешних ключей порядок имеет значение:

```
 1. users
 2. sessions                   → users
 3. masters                    → users
 4. service_categories
 5. services                   → service_categories
 6. master_services            → masters, services
 7. studio_hours
 8. studio_closures            → users
 9. settings                   → users
10. role_permissions
11. master_schedules           → masters
12. schedule_exceptions        → masters, users
13. schedule_change_requests   → masters, users
14. appointments               → users, masters
15. appointment_services       → appointments, services
16. slot_holds                 → users, masters, appointments
17. slot_hold_services         → slot_holds, services
18. notifications              → users, appointments
19. password_reset_tokens      → users
20. audit_log                  → users
```

Перед работой с базой в каждом соединении:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
```

`WAL` нужен, потому что сервис читает календарь намного чаще, чем пишет записи: в этом режиме чтение не блокируется записью.

**О риске потери данных.** Файл SQLite лежит на VPS локально — это отмечено в паспорте как риск. Схема этот риск не снимает; нужен отдельный регламент резервного копирования файла базы (например, `VACUUM INTO` по расписанию с выгрузкой копии за пределы сервера).
