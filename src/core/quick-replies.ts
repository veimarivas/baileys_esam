import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import type { QuickReplyRow } from '../types.js';

/**
 * Plantillas rapidas del compositor: atajos que el agente inserta tipeando
 * `/atajo` y que interpolan variables del contacto ({name}, {phone}, etc.).
 */

export interface QuickReplyInput {
  shortcut: string;
  content: string;
  shared?: boolean;
}

/** Normaliza el atajo: sin `/`, minusculas, sin espacios. */
export function normalizeShortcut(input: string): string {
  return (input ?? '')
    .trim()
    .replace(/^\//, '')
    .replace(/\s+/g, '-')
    .toLowerCase();
}

/** Plantillas visibles para el usuario: las compartidas y las propias. */
export function listQuickReplies(userId: number | null): QuickReplyRow[] {
  return all<QuickReplyRow>(
    `SELECT * FROM quick_replies WHERE shared = 1 OR user_id = ?
     ORDER BY shared DESC, shortcut ASC`,
    userId,
  );
}

export function getQuickReply(id: number): QuickReplyRow | undefined {
  return get<QuickReplyRow>('SELECT * FROM quick_replies WHERE id = ?', id);
}

export function createQuickReply(userId: number | null, input: QuickReplyInput): QuickReplyRow {
  const shortcut = normalizeShortcut(input.shortcut);
  if (!shortcut) throw new Error('El atajo es obligatorio.');
  if (!input.content?.trim()) throw new Error('El contenido es obligatorio.');
  if (get<{ id: number }>('SELECT id FROM quick_replies WHERE shortcut = ?', shortcut)) {
    throw new Error(`Ya existe una plantilla rápida con el atajo /${shortcut}.`);
  }
  const created = run(
    `INSERT INTO quick_replies (shortcut, content, user_id, shared, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    shortcut,
    input.content.trim(),
    input.shared ? null : userId,
    input.shared ? 1 : 0,
    nowIso(),
    nowIso(),
  );
  return getQuickReply(created.lastInsertRowid)!;
}

export function updateQuickReply(id: number, userId: number | null, input: QuickReplyInput): QuickReplyRow {
  const current = getQuickReply(id);
  if (!current) throw new Error('La plantilla rápida no existe.');
  const shortcut = normalizeShortcut(input.shortcut);
  if (!shortcut) throw new Error('El atajo es obligatorio.');
  if (!input.content?.trim()) throw new Error('El contenido es obligatorio.');
  const clash = get<{ id: number }>('SELECT id FROM quick_replies WHERE shortcut = ? AND id <> ?', shortcut, id);
  if (clash) throw new Error(`Ya existe una plantilla rápida con el atajo /${shortcut}.`);
  run(
    `UPDATE quick_replies SET shortcut = ?, content = ?, user_id = ?, shared = ?, updated_at = ? WHERE id = ?`,
    shortcut,
    input.content.trim(),
    input.shared ? null : userId,
    input.shared ? 1 : 0,
    nowIso(),
    id,
  );
  return getQuickReply(id)!;
}

export function deleteQuickReply(id: number): void {
  run('DELETE FROM quick_replies WHERE id = ?', id);
}

export interface QuickReplyContact {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
}

/**
 * Interpola variables del contacto. Acepta `{name}` y `{{name}}` para mantener
 * compatibilidad con el motor de plantillas de lotes.
 */
export function renderQuickReply(content: string, contact: QuickReplyContact = {}): string {
  const vars: Record<string, string> = {
    name: contact.name ?? '',
    nombre: contact.name ?? '',
    phone: contact.phone ?? '',
    telefono: contact.phone ?? '',
    email: contact.email ?? '',
    correo: contact.email ?? '',
    company: contact.company ?? '',
    empresa: contact.company ?? '',
  };
  return content
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => vars[key.toLowerCase()] ?? '')
    .replace(/\{\s*(\w+)\s*\}/g, (_m, key: string) => vars[key.toLowerCase()] ?? '');
}
