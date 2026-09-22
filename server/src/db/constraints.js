/**
 * Опознание отказов базы по защитам от двойной записи.
 *
 * Отдельным файлом, потому что это место стыка: текст 'appointment_overlap'
 * задан триггером в миграции 002, а реагирует на него код API. Пока обе
 * стороны видны в одном файле, связь трудно порвать случайно.
 *
 * Наружу ни текст ошибки SQLite, ни код драйвера не выходят: вызывающий
 * получает булево значение и сам решает, каким ответом это объяснить.
 */

/** Текст из RAISE(ABORT, ...) в триггерах миграции 002. */
const OVERLAP_MARKER = 'appointment_overlap';

/**
 * Пересечение по времени, пойманное триггером.
 *
 * SQLite отдаёт такой отказ с кодом SQLITE_CONSTRAINT_TRIGGER (1811),
 * но опираться только на код нельзя: триггеры могут появиться и другие.
 * Поэтому решает метка из текста, а код — вспомогательный признак.
 */
export function isOverlapViolation(error) {
  return typeof error?.message === 'string' && error.message.includes(OVERLAP_MARKER);
}

/**
 * Совпадение минуты начала, пойманное уникальным индексом.
 *
 * ux_appointments_master_slot — двое на одно время к одному мастеру;
 * ux_appointments_client_slot — двойной клик по «Подтвердить».
 * Для клиента это та же ситуация «время занято», и различать их
 * в ответе незачем.
 */
export function isUniqueViolation(error) {
  return typeof error?.message === 'string' && error.message.includes('UNIQUE constraint failed');
}

/** Любой из трёх рубежей защиты от двойной записи сработал. */
export function isSlotConflict(error) {
  return isOverlapViolation(error) || isUniqueViolation(error);
}
