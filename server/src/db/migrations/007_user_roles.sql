-- =====================================================================
-- 007_user_roles.sql — роли списком вместо одного поля
-- =====================================================================
--
-- Источник: Docs/db-schema.md, версия 2.1, раздел 4.21 и решение 7.20.
--
-- Зачем.
--   У одного человека ролей может быть несколько. В маленькой студии
--   это правило, а не исключение: владелица и принимает клиентов,
--   и ведёт прайс. С единственным полем role ей пришлось бы либо
--   заводить второй аккаунт (и разорвать свою историю визитов
--   и выручки), либо переключать себе роль туда-сюда.
--
-- Что делает миграция.
--   1. Заводит user_roles и переносит туда текущие роли один в один:
--      у кого была role = 'master', у того появляется роль master.
--      Ничьи права миграцией не меняются.
--   2. Переносит снимок ролей в сессии: role_at_login -> roles_at_login,
--      список через запятую по алфавиту. Живые сессии переживают
--      миграцию — на момент переноса список роли равен старому
--      единственному значению.
--   3. Удаляет users.role. Оставлять его «для совместимости» нельзя:
--      два источника правды о правах расходятся молча, и обнаруживается
--      это не на тесте, а в тот день, когда клиент увидел чужие записи.
--
-- Порядок важен: users.role читается шагами 1 и 2, поэтому удаляется
-- последним. Вся миграция идёт одной транзакцией (см. migrate.js) —
-- либо переносится всё, либо не меняется ничего.
-- =====================================================================

CREATE TABLE user_roles (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT    NOT NULL CHECK (role IN ('user', 'master', 'admin')),
    granted_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    granted_by  INTEGER          REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, role)
);

-- Обратный вопрос «у кого есть эта роль» первичным ключом не обслуживается:
-- в PRIMARY KEY (user_id, role) роль стоит второй.
CREATE INDEX ix_user_roles_role ON user_roles(role, user_id);

-- granted_by пуст: роли не выдавал никто живой, они были у аккаунта
-- с самого начала. Проставлять сюда первого администратора значило бы
-- записать в журнал выдачи неправду.
INSERT INTO user_roles(user_id, role) SELECT id, role FROM users;

-- Снимок ролей в сессии. NOT NULL требует значения для уже существующих
-- строк — временно ставим пустую строку и тут же заполняем из user_roles.
ALTER TABLE sessions ADD COLUMN roles_at_login TEXT NOT NULL DEFAULT '';

UPDATE sessions SET roles_at_login = (
    SELECT group_concat(r.role) FROM (
        SELECT role FROM user_roles WHERE user_id = sessions.user_id ORDER BY role
    ) r
);

ALTER TABLE sessions DROP COLUMN role_at_login;

ALTER TABLE users DROP COLUMN role;
