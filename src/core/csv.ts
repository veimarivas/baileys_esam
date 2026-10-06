import fs from 'node:fs';
import path from 'node:path';
import { typeForMime, chatIdFor } from './phone.js';
import { storeMedia } from './media.js';
import { run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { recount } from './batches.js';

export interface CsvImportResult {
  batchId: number | null;
  total: number;
  skipped: number;
  errors: string[];
}

/**
 * Parser CSV simple (RFC4180 básico): soporta comillas dobles y comas dentro
 * de campos. Devuelve filas como arrays de strings.
 */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

interface CsvContact {
  chat_id: string;
  name: string | null;
  variables: Record<string, string>;
}

/**
 * Importa un CSV de destinatarios y crea un lote. Columnas reconocidas:
 * `chat_id|phone`, `name|nombre` y cualquier otra columna pasa como variable
 * de plantilla (por ejemplo `nombre_completo`, `programa`, `total_adeudado`).
 */
export function importCsvToBatch(
  filePath: string,
  opts: { name?: string; category?: string | null; templateId?: number | null; meta?: Record<string, unknown> },
  createBatch: (payload: {
    name: string;
    category: string | null;
    templateId: number | null;
    items: Array<{ chat_id: string; contact_name: string | null; variables: Record<string, unknown> }>;
    meta: Record<string, unknown>;
  }) => number,
): CsvImportResult {
  const errors: string[] = [];
  if (!fs.existsSync(filePath)) {
    return { batchId: null, total: 0, skipped: 0, errors: ['No existe el archivo.'] };
  }

  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(raw);
  if (rows.length < 2) {
    return { batchId: null, total: 0, skipped: 0, errors: ['El CSV está vacío o sin encabezado.'] };
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const contacts: CsvContact[] = [];
  let skipped = 0;

  for (const line of rows.slice(1)) {
    const record: Record<string, string> = {};
    header.forEach((h, i) => (record[h] = (line[i] ?? '').trim()));

    let chatId = record.chat_id || '';
    if (!chatId && record.phone) chatId = chatIdFor(record.phone);
    if (!chatId) {
      skipped++;
      continue;
    }
    if (!chatId.includes('@')) chatId = chatIdFor(chatId);

    const variables: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      if (['chat_id', 'phone', 'name', 'nombre'].includes(key)) continue;
      if (value !== '') variables[key] = value;
    }

    contacts.push({ chat_id: chatId, name: record.name || record.nombre || null, variables });
  }

  if (contacts.length === 0) {
    return { batchId: null, total: 0, skipped, errors: ['Ninguna fila tenía chat_id/phone válido.'] };
  }

  const batchId = createBatch({
    name: opts.name ?? `Importación CSV ${path.basename(filePath)}`,
    category: opts.category ?? null,
    templateId: opts.templateId ?? null,
    items: contacts.map((c) => ({ chat_id: c.chat_id, contact_name: c.name, variables: c.variables })),
    meta: { source: 'csv', ...(opts.meta ?? {}) },
  });

  return { batchId, total: contacts.length, skipped, errors };
}

/** Importa contactos (chat_id/name) a una tabla ligera de contactos en lotes. */
export function logImport(source: string, total: number): void {
  run('INSERT INTO audit_logs (action, context, created_at) VALUES (?, ?, ?)', `import.${source}`, JSON.stringify({ total }), nowIso());
}

export { recount, typeForMime, storeMedia };
