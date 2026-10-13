import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';

/**
 * Plantillas de tareas: un conjunto de pasos que se repite (p. ej. una
 * inscripción: comprobante, documentos, cronograma). Al aplicarla en un chat se
 * crea una nota-tarea por paso, con su fecha relativa a hoy. Son globales y
 * compartidas por el equipo, como las etiquetas.
 */

export interface TemplateItem {
  text: string;
  /** Días desde hoy para la fecha de seguimiento (null = sin fecha). */
  due_days: number | null;
  /** Hora del recordatorio (HH:MM) o null. */
  due_time: string | null;
  pinned: boolean;
}

export interface NoteTemplate {
  id: number;
  name: string;
  /** Programa al que suele aplicarse (se sugiere primero en esos chats). */
  programa: string | null;
  items: TemplateItem[];
  created_at: string;
  updated_at: string;
}

const MAX_ITEMS = 15;

function parseItems(raw: string | null): TemplateItem[] {
  try {
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as TemplateItem[]) : [];
  } catch {
    return [];
  }
}

/** Valida y normaliza los pasos que llegan del panel. */
function cleanItems(input: unknown): TemplateItem[] {
  if (!Array.isArray(input)) throw new Error('La plantilla no tiene tareas.');
  const items = input
    .map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const text = String(r.text ?? '').trim().slice(0, 500);
      const days = r.due_days === null || r.due_days === '' || r.due_days === undefined ? null : Number(r.due_days);
      const time = String(r.due_time ?? '').trim();
      return {
        text,
        due_days: days !== null && Number.isFinite(days) ? Math.min(Math.max(Math.round(days), 0), 365) : null,
        due_time: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null,
        pinned: r.pinned === true || r.pinned === 1 || r.pinned === '1',
      };
    })
    .filter((i) => i.text);
  if (!items.length) throw new Error('Agregá al menos una tarea con texto.');
  if (items.length > MAX_ITEMS) throw new Error(`Una plantilla admite hasta ${MAX_ITEMS} tareas.`);
  return items;
}

function cleanName(name: unknown): string {
  const value = String(name ?? '').trim().slice(0, 60);
  if (!value) throw new Error('Poné un nombre a la plantilla.');
  return value;
}

function cleanProgram(programa: unknown): string | null {
  const value = String(programa ?? '').trim().slice(0, 120);
  return value || null;
}

function mapRow(r: Omit<NoteTemplate, 'items'> & { items: string | null }): NoteTemplate {
  return { ...r, items: parseItems(r.items) };
}

export function listTemplates(): NoteTemplate[] {
  return all<Omit<NoteTemplate, 'items'> & { items: string | null }>(
    'SELECT id, name, programa, items, created_at, updated_at FROM note_templates ORDER BY name COLLATE NOCASE',
  ).map(mapRow);
}

export function getTemplate(id: number): NoteTemplate | undefined {
  const row = get<Omit<NoteTemplate, 'items'> & { items: string | null }>(
    'SELECT id, name, programa, items, created_at, updated_at FROM note_templates WHERE id = ?',
    id,
  );
  return row ? mapRow(row) : undefined;
}

function ensureUniqueName(name: string, exceptId: number | null): void {
  const clash = get<{ id: number }>('SELECT id FROM note_templates WHERE name = ? COLLATE NOCASE', name);
  if (clash && clash.id !== exceptId) throw new Error('Ya existe una plantilla con ese nombre.');
}

export function createTemplate(
  input: { name: unknown; programa?: unknown; items: unknown },
  userId: number | null,
): NoteTemplate {
  const name = cleanName(input.name);
  const items = cleanItems(input.items);
  ensureUniqueName(name, null);
  const now = nowIso();
  const created = run(
    'INSERT INTO note_templates (name, programa, items, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    name,
    cleanProgram(input.programa),
    JSON.stringify(items),
    userId,
    now,
    now,
  );
  return getTemplate(created.lastInsertRowid)!;
}

export function updateTemplate(id: number, input: { name: unknown; programa?: unknown; items: unknown }): NoteTemplate {
  if (!getTemplate(id)) throw new Error('Plantilla no encontrada.');
  const name = cleanName(input.name);
  const items = cleanItems(input.items);
  ensureUniqueName(name, id);
  run(
    'UPDATE note_templates SET name = ?, programa = ?, items = ?, updated_at = ? WHERE id = ?',
    name,
    cleanProgram(input.programa),
    JSON.stringify(items),
    nowIso(),
    id,
  );
  return getTemplate(id)!;
}

export function deleteTemplate(id: number): void {
  run('DELETE FROM note_templates WHERE id = ?', id);
}
