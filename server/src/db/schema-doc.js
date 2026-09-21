/**
 * Чтение документа схемы Docs/db-schema.md как эталона.
 *
 * Документ — источник правды: сначала правится он, потом появляется миграция.
 * Эти функции позволяют сверить фактическую базу с тем, что написано в документе.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { env } from '../config/env.js';

const DOC_PATH = join(env.serverRoot, '..', 'Docs', 'db-schema.md');

export function readSchemaDoc() {
  return readFileSync(DOC_PATH, 'utf8');
}

export { DOC_PATH };

/** Назначение каждой таблицы — из сводного списка в разделе 3 документа. */
export function parsePurposes(md) {
  const purposes = new Map();
  const rx = /^\|\s*\d+\s*\|\s*`(\w+)`\s*\|\s*([^|]+?)\s*\|/gm;
  for (const m of md.matchAll(rx)) purposes.set(m[1], m[2]);
  return purposes;
}

/**
 * Описания полей из раздела 4: для каждой таблицы список
 * { name, type, obligation } ровно так, как он записан в тексте.
 */
export function parseFields(md) {
  const fields = new Map();
  const sections = md.split(/\n### 4\.\d+\.\s/).slice(1);

  for (const section of sections) {
    const titleMatch = section.match(/^`(\w+)`/);
    if (!titleMatch) continue;

    const body = section.split('\n## ')[0];
    const tableMatch = body.match(/\| Поле \| Тип \| Обяз\. \| Описание \|\n\|[-| ]+\|\n((?:\|.*\n)+)/);
    if (!tableMatch) continue;

    const rows = [];
    for (const line of tableMatch[1].trim().split('\n')) {
      const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.length < 3) continue;
      // В одной ячейке может быть несколько имён: `created_at`, `updated_at`
      const names = [...cells[0].matchAll(/`(\w+)`/g)].map((m) => m[1]);
      for (const name of names) {
        rows.push({ name, type: cells[1].replace(/[`*]/g, '').trim().toUpperCase(), obligation: cells[2] });
      }
    }
    fields.set(titleMatch[1], rows);
  }
  return fields;
}

/** Имена индексов и их уникальность — из SQL-блоков документа. */
export function parseIndexes(md) {
  const indexes = new Map();
  for (const m of md.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(\w+)/g)) {
    indexes.set(m[2], Boolean(m[1]));
  }
  return indexes;
}

/** Сколько ссылок REFERENCES объявлено в документе. */
export function countReferences(md) {
  return [...md.matchAll(/REFERENCES\s+\w+\(/g)].length;
}
