-- =====================================================================
-- 003_admin_overlap_flag.sql — осознанное наложение администратором
-- =====================================================================
--
-- Источник: Docs/db-schema.md, версия 1.7, разделы 6.3 и 7.19.
--
-- Зачем.
--   Триггеры из миграции 002 запрещают пересечение записей у одного
--   мастера. Запрет правильный, но у администратора бывают законные
--   основания его обойти: мастер согласился принять двоих, клиент пришёл
--   без записи, предыдущий визит затянулся и доделывается в чужое время.
--
--   Отключать триггер на время операции нельзя: защита, снятая ради
--   одной вставки, снята и для всех параллельных. Поэтому исключение
--   выражено флагом в самой строке.
--
-- Асимметрия — главное в этой миграции.
--   Флаг стоит только в условии WHEN и освобождает от проверки саму
--   вставляемую строку. В подзапросе EXISTS фильтра по allow_overlap
--   НЕТ — и это не забывчивость. Добавь его там, и наложенная запись
--   стала бы прозрачной: на её время записался бы кто угодно, а вместо
--   двоих клиентов в слоте оказалось бы неизвестно сколько.
--   Разрешено одно конкретное наложение, а не право раздавать наложения.
--
-- Кто ставит флаг.
--   Проверка роли живёт в API (src/api/admin.routes.js), но здесь она
--   продублирована: триггеры 36-37 отказывают, если allow_overlap = 1
--   появляется у записи с created_by_role <> 'admin'. Тот же принцип,
--   что и с пересечениями: запрет в базе действует для всех путей
--   записи, а не только для тех, что идут через обработчики.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Признак
-- ---------------------------------------------------------------------
-- Существующие записи получают 0: все они созданы по обычным правилам.
ALTER TABLE appointments
    ADD COLUMN allow_overlap INTEGER NOT NULL DEFAULT 0 CHECK (allow_overlap IN (0, 1));


-- ---------------------------------------------------------------------
-- Триггеры пересечения — пересозданы с учётом флага
-- ---------------------------------------------------------------------
-- Изменилось ровно одно: в WHEN добавлено NEW.allow_overlap = 0.
-- Тела подзапросов не тронуты.
DROP TRIGGER trg_appointments_no_overlap_insert;
DROP TRIGGER trg_appointments_no_overlap_update;

CREATE TRIGGER trg_appointments_no_overlap_insert
BEFORE INSERT ON appointments
WHEN NEW.status = 'booked' AND NEW.allow_overlap = 0
BEGIN
    SELECT RAISE(ABORT, 'appointment_overlap')
     WHERE EXISTS (
        SELECT 1
          FROM appointments a
         WHERE a.master_id = NEW.master_id
           AND a.status    = 'booked'
           -- Фильтра по a.allow_overlap здесь нет намеренно: запись,
           -- поставленную поверх занятого времени, дальше видно как любую
           -- другую, и записаться на её время нельзя.
           AND a.starts_at < NEW.ends_at
           AND a.ends_at   > NEW.starts_at
     );
END;

CREATE TRIGGER trg_appointments_no_overlap_update
BEFORE UPDATE ON appointments
WHEN NEW.status = 'booked' AND NEW.allow_overlap = 0
BEGIN
    SELECT RAISE(ABORT, 'appointment_overlap')
     WHERE EXISTS (
        SELECT 1
          FROM appointments a
         WHERE a.id       <> OLD.id
           AND a.id       <> NEW.id
           AND a.master_id = NEW.master_id
           AND a.status    = 'booked'
           AND a.starts_at < NEW.ends_at
           AND a.ends_at   > NEW.starts_at
     );
END;


-- ---------------------------------------------------------------------
-- Флаг наложения — только администратору
-- ---------------------------------------------------------------------
-- Второй контур проверки роли. Первый стоит в API и отсекает признак,
-- пришедший в запросе от клиента или мастера; этот не пускает его
-- ни по какому пути вообще, включая ручную правку в консоли.
--
-- Триггеров два по той же причине, что и у пересечений: флаг можно
-- попытаться внести и при вставке, и правкой существующей строки.
CREATE TRIGGER trg_appointments_overlap_flag_insert
BEFORE INSERT ON appointments
WHEN NEW.allow_overlap = 1 AND NEW.created_by_role <> 'admin'
BEGIN
    SELECT RAISE(ABORT, 'overlap_flag_requires_admin');
END;

CREATE TRIGGER trg_appointments_overlap_flag_update
BEFORE UPDATE ON appointments
WHEN NEW.allow_overlap = 1 AND NEW.created_by_role <> 'admin'
BEGIN
    SELECT RAISE(ABORT, 'overlap_flag_requires_admin');
END;


-- ---------------------------------------------------------------------
-- Уникальный индекс — теперь частичный
-- ---------------------------------------------------------------------
-- ux_appointments_master_slot запрещал двум действующим записям одного
-- мастера начинаться в одну минуту. Для осознанного наложения это как раз
-- самый частый случай: администратор ставит второго клиента ровно на то же
-- время. Индекс отказал бы раньше триггера, и флаг ничего не решал бы.
--
-- Поэтому наложенные записи из индекса исключены. Защита при этом
-- не ослабла: совпадение минуты начала — частный случай пересечения
-- интервалов, и его по-прежнему ловят триггеры 34-35.
DROP INDEX ux_appointments_master_slot;

CREATE UNIQUE INDEX ux_appointments_master_slot
    ON appointments(master_id, starts_at, active_slot)
    WHERE allow_overlap = 0;
