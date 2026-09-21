/**
 * Требования к среде выполнения.
 *
 * Проект работает на встроенном модуле node:sqlite и не имеет внешних
 * зависимостей — устанавливать через npm нечего. Расплата за это одна:
 * модуль появился не во всех версиях Node.
 *
 *   до 22.5.0   модуля node:sqlite нет вообще
 *   22.5–23.3   есть, но только с флагом --experimental-sqlite
 *   с 23.4.0    доступен без флага — это и есть наш минимум
 *   24.x LTS    рекомендуемая версия для сервера
 *
 * Node 23 — нечётная ветка, она уже снята с поддержки, поэтому на сервере
 * ставим 24 LTS. Нужная версия записана в .nvmrc.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Минимальная версия, в которой node:sqlite работает без флага. */
export const MIN_NODE_VERSION = '23.4.0';

/** Версия, которую ставим на сервере. */
export const RECOMMENDED_NODE_VERSION = '24';

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

export function isNodeVersionSupported(version = process.versions.node) {
  return compareVersions(version, MIN_NODE_VERSION) >= 0;
}

function help() {
  return [
  `Текущая версия Node.js: ${process.versions.node}.`,
  `Нужна ${MIN_NODE_VERSION} или новее — в ней встроенный модуль node:sqlite`,
  'работает без дополнительных флагов.',
  '',
  'Как поставить нужную версию:',
  `  nvm install ${RECOMMENDED_NODE_VERSION} && nvm use ${RECOMMENDED_NODE_VERSION}`,
  '',
  'На хостинге версия обычно переключается в панели управления',
  'или командой из документации хостера.',
  ].join('\n');
}

/**
 * Загружает драйвер SQLite и объясняет по-человечески, что делать,
 * если версия Node не подходит.
 *
 * Загрузка отложенная, через createRequire: обычный import сорвался бы
 * на этапе связывания модулей, до того как этот код успел бы выполниться,
 * и разработчик увидел бы только ERR_UNKNOWN_BUILTIN_MODULE без пояснений.
 */
export function loadSqlite() {
  if (!isNodeVersionSupported()) {
    throw new Error(`Версия Node.js слишком старая.\n\n${help()}`);
  }
  try {
    return require('node:sqlite');
  } catch (error) {
    throw new Error(
      `Не удалось загрузить встроенный модуль node:sqlite.\n\n${help()}`,
      { cause: error },
    );
  }
}
