-- =====================================================================
-- 001_init.sql — начальная схема сервиса записи «Ноготочки»
-- =====================================================================
--
-- Источник: Docs/db-schema.md, версия 1.5.
-- 20 таблиц, 27 индексов. Таблицы идут в порядке зависимостей.
--
-- Правила работы с миграциями:
--   * этот файл уже применён к базам — менять его задним числом нельзя;
--   * любое изменение структуры вносится сначала в документ схемы,
--     затем отдельным файлом с большим номером;
--   * внешние ключи в SQLite выключены по умолчанию. Их включает
--     connection.js командой PRAGMA foreign_keys = ON при каждом
--     подключении. Без неё все 28 внешних ключей ниже не работают.
--
-- Соглашения по типам:
--   моменты времени  TEXT  'YYYY-MM-DDTHH:MM:SSZ' в UTC
--   даты             TEXT  'YYYY-MM-DD'
--   время суток      TEXT  'HH:MM', местное время студии
--   деньги           INTEGER, копейки
--   логические       INTEGER 0/1
-- =====================================================================


-- ---------------------------------------------------------------------
-- ЛЮДИ И ДОСТУП
-- ---------------------------------------------------------------------
-- Аккаунты всех трёх ролей, сессии входа, ссылки восстановления пароля
-- и справочная матрица прав для экрана «Роли и доступы».

-- users: аккаунты клиентов, мастеров и администраторов
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

-- sessions: активные сессии входа; выход проставляет revoked_at
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

-- password_reset_tokens: одноразовые ссылки восстановления пароля
CREATE TABLE password_reset_tokens (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT    NOT NULL,
    expires_at  TEXT    NOT NULL,
    used_at     TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- role_permissions: матрица прав для показа на экране A10 (правами не управляет)
CREATE TABLE role_permissions (
    role              TEXT    NOT NULL CHECK (role IN ('user', 'master', 'admin')),
    permission_key    TEXT    NOT NULL,
    permission_group  TEXT    NOT NULL,
    title             TEXT    NOT NULL,
    is_allowed        INTEGER NOT NULL DEFAULT 0 CHECK (is_allowed IN (0, 1)),
    note              TEXT,
    PRIMARY KEY (role, permission_key)
);


-- ---------------------------------------------------------------------
-- СПРАВОЧНИКИ СТУДИИ
-- ---------------------------------------------------------------------
-- Всё, что администратор ведёт руками: услуги, мастера, часы работы,
-- нерабочие дни и правила записи.

-- masters: карточка мастера; может существовать до привязки аккаунта
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

-- service_categories: категории услуг для группировки на витрине
CREATE TABLE service_categories (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

-- services: услуги: длительность и цена
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

-- master_services: какой мастер какие услуги выполняет
CREATE TABLE master_services (
    master_id   INTEGER NOT NULL REFERENCES masters(id)  ON DELETE CASCADE,
    service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    PRIMARY KEY (master_id, service_id)
);

-- studio_hours: часы работы студии по дням недели
CREATE TABLE studio_hours (
    weekday     INTEGER PRIMARY KEY CHECK (weekday BETWEEN 1 AND 7),
    is_closed   INTEGER NOT NULL DEFAULT 0 CHECK (is_closed IN (0, 1)),
    open_time   TEXT,
    close_time  TEXT,
    CHECK (is_closed = 1 OR (open_time IS NOT NULL AND close_time IS NOT NULL
                             AND close_time > open_time))
);

-- studio_closures: разовые нерабочие дни: праздники, санитарный день
CREATE TABLE studio_closures (
    id          INTEGER PRIMARY KEY,
    date_from   TEXT    NOT NULL,
    date_to     TEXT    NOT NULL,
    reason      TEXT    NOT NULL,
    created_by  INTEGER          REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK (date_to >= date_from)
);

-- settings: настройки студии и правила записи «ключ — значение»
CREATE TABLE settings (
    key          TEXT    PRIMARY KEY,
    value        TEXT    NOT NULL,
    description  TEXT,
    updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_by   INTEGER          REFERENCES users(id) ON DELETE SET NULL
);


-- ---------------------------------------------------------------------
-- РАСПИСАНИЕ МАСТЕРОВ
-- ---------------------------------------------------------------------
-- Постоянный недельный график, отклонения от него и заявки мастеров
-- на изменение. Свободное время из этих таблиц вычисляется, а не хранится.

-- master_schedules: недельный рабочий график мастера
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

-- schedule_exceptions: отпуск, выходной, закрытое время, дополнительная смена
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

-- schedule_change_requests: заявки мастеров, утверждает администратор
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


-- ---------------------------------------------------------------------
-- ЗАПИСИ И РЕЗЕРВЫ
-- ---------------------------------------------------------------------
-- Центральная часть схемы. Таблицы заранее нарезанных слотов здесь нет:
-- свободное время вычисляется в момент запроса.

-- appointments: записи клиентов
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

-- appointment_services: состав записи со снимком цены и длительности
CREATE TABLE appointment_services (
    appointment_id  INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    service_id      INTEGER NOT NULL REFERENCES services(id)     ON DELETE RESTRICT,
    position        INTEGER NOT NULL DEFAULT 0,
    duration_min    INTEGER NOT NULL CHECK (duration_min > 0),
    price_kopecks   INTEGER NOT NULL CHECK (price_kopecks >= 0),
    PRIMARY KEY (appointment_id, service_id)
);

-- slot_holds: резерв слота на 10 минут, живёт и для гостя
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

-- slot_hold_services: состав резерва до создания записи
CREATE TABLE slot_hold_services (
    hold_id        INTEGER NOT NULL REFERENCES slot_holds(id) ON DELETE CASCADE,
    service_id     INTEGER NOT NULL REFERENCES services(id)   ON DELETE RESTRICT,
    position       INTEGER NOT NULL DEFAULT 0,
    duration_min   INTEGER NOT NULL CHECK (duration_min > 0),
    price_kopecks  INTEGER NOT NULL CHECK (price_kopecks >= 0),
    PRIMARY KEY (hold_id, service_id)
);


-- ---------------------------------------------------------------------
-- УВЕДОМЛЕНИЯ И ЖУРНАЛ
-- ---------------------------------------------------------------------
-- Сообщения внутри личного кабинета и журнал действий над чужими записями.

-- notifications: уведомления внутри кабинета
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

-- audit_log: кто, что и когда менял
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


-- =====================================================================
-- ИНДЕКСЫ
-- =====================================================================

-- --- Уникальность ---
-- Защита от повторов. Частичные индексы по active_slot — главный барьер
-- против двойной записи: NULL в SQLite не конфликтует с NULL, поэтому
-- отменённых записей на одно время может быть сколько угодно,
-- а действующая — только одна.

CREATE UNIQUE INDEX ux_users_email    ON users(email_normalized);
CREATE UNIQUE INDEX ux_sessions_token ON sessions(token_hash);
CREATE UNIQUE INDEX ux_masters_user ON masters(user_id);
CREATE UNIQUE INDEX ux_service_name ON services(category_id, name);
CREATE UNIQUE INDEX ux_reset_token  ON password_reset_tokens(token_hash);
CREATE UNIQUE INDEX ux_appointments_master_slot
    ON appointments(master_id, starts_at, active_slot);
CREATE UNIQUE INDEX ux_appointments_client_slot
    ON appointments(client_id, master_id, starts_at, active_slot);

-- --- Частые запросы ---
-- Проверка сессии, расчёт свободного времени и открытие кабинета —
-- три операции, которые выполняются чаще всего.

CREATE INDEX ix_appointments_master_time  ON appointments(master_id, starts_at);
CREATE INDEX ix_appointments_client_time  ON appointments(client_id, starts_at DESC);
CREATE INDEX ix_appointments_status_time  ON appointments(status, starts_at);
CREATE INDEX ix_holds_master_time         ON slot_holds(master_id, starts_at, expires_at);
CREATE INDEX ix_holds_expires             ON slot_holds(expires_at);
CREATE INDEX ix_holds_session             ON slot_holds(session_token_hash);
CREATE INDEX ix_exceptions_master_time    ON schedule_exceptions(master_id, starts_at);
CREATE INDEX ix_schedules_master          ON master_schedules(master_id, weekday);
CREATE INDEX ix_notifications_user        ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX ix_closures_dates            ON studio_closures(date_from, date_to);
CREATE INDEX ix_appt_services_service     ON appointment_services(service_id);
CREATE INDEX ix_requests_status           ON schedule_change_requests(status, created_at);
CREATE INDEX ix_audit_entity              ON audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX ix_sessions_user             ON sessions(user_id, expires_at);

-- --- Колонки внешних ключей ---
-- SQLite, в отличие от большинства СУБД, не создаёт такие индексы сам.
-- Без них проверка целостности при удалении родителя и любой запрос
-- «в обратную сторону» читают дочернюю таблицу целиком.

CREATE INDEX ix_master_services_service   ON master_services(service_id);
CREATE INDEX ix_requests_master           ON schedule_change_requests(master_id, created_at DESC);
CREATE INDEX ix_reset_tokens_user         ON password_reset_tokens(user_id);
CREATE INDEX ix_audit_actor               ON audit_log(actor_user_id, created_at DESC);
CREATE INDEX ix_holds_client              ON slot_holds(client_id);
CREATE INDEX ix_holds_reschedule          ON slot_holds(reschedule_of_id);
