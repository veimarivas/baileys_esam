import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import type { NoteTagRow } from '../types.js';

/** Paleta institucional para etiquetas de notas. */
export const NOTE_TAG_COLORS = [
  '#045474',
  '#34c38f',
  '#f1b44c',
  '#f46a6a',
  '#556ee6',
  '#7c3aed',
  '#0891b2',
  '#65a30d',
];

/** Etiquetas de notas (globales, compartidas por el equipo). */
export function listTags(): NoteTagRow[] {
  return all<NoteTagRow>('SELECT * FROM note_tags ORDER BY name COLLATE NOCASE');
}

/**
 * Etiquetas con cuántas notas las usan (total y pendientes de seguimiento),
 * contando solo las notas de las sesiones visibles para el usuario
 * (`null` = todas, `[]` = ninguna).
 */
export function listTagsWithUsage(sessionIds: string[] | null): Array<NoteTagRow & { notes: number; pending: number }> {
  const params: unknown[] = [];
  let scope = '';
  if (sessionIds !== null) {
    if (!sessionIds.length) {
      scope = 'AND 0';
    } else {
      scope = `AND ct.session_id IN (${sessionIds.map(() => '?').join(',')})`;
      params.push(...sessionIds);
    }
  }
  return all<NoteTagRow & { notes: number; pending: number }>(
    `SELECT t.*,
            COUNT(n.id) AS notes,
            SUM(CASE WHEN n.id IS NOT NULL AND n.done_at IS NULL THEN 1 ELSE 0 END) AS pending
       FROM note_tags t
       LEFT JOIN contact_note_tags nt ON nt.tag_id = t.id
       LEFT JOIN contact_notes n ON n.id = nt.note_id
         AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = n.contact_id ${scope})
      GROUP BY t.id
      ORDER BY t.name COLLATE NOCASE`,
    ...params,
  ).map((t) => ({ ...t, notes: Number(t.notes ?? 0), pending: Number(t.pending ?? 0) }));
}

export function getTag(id: number): NoteTagRow | undefined {
  return get<NoteTagRow>('SELECT * FROM note_tags WHERE id = ?', id);
}

export function createTag(input: { name: string; color?: string | null }): NoteTagRow {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('El nombre de la etiqueta es obligatorio.');
  if (get<{ id: number }>('SELECT id FROM note_tags WHERE name = ? COLLATE NOCASE', name)) {
    throw new Error('Ya existe una etiqueta con ese nombre.');
  }
  const now = nowIso();
  const color = /^#[0-9a-fA-F]{6}$/.test(String(input.color ?? '')) ? String(input.color) : NOTE_TAG_COLORS[0];
  const result = run(
    'INSERT INTO note_tags (name, color, created_at, updated_at) VALUES (?, ?, ?, ?)',
    name,
    color,
    now,
    now,
  );
  return getTag(result.lastInsertRowid)!;
}

export function updateTag(id: number, input: { name: string; color?: string | null }): NoteTagRow {
  const current = getTag(id);
  if (!current) throw new Error('Etiqueta no encontrada.');
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('El nombre de la etiqueta es obligatorio.');
  const dup = get<{ id: number }>('SELECT id FROM note_tags WHERE name = ? COLLATE NOCASE AND id <> ?', name, id);
  if (dup) throw new Error('Ya existe una etiqueta con ese nombre.');
  const color = /^#[0-9a-fA-F]{6}$/.test(String(input.color ?? '')) ? String(input.color) : current.color;
  run('UPDATE note_tags SET name = ?, color = ?, updated_at = ? WHERE id = ?', name, color, nowIso(), id);
  return getTag(id)!;
}

export function deleteTag(id: number): void {
  run('DELETE FROM contact_note_tags WHERE tag_id = ?', id);
  run('DELETE FROM note_tags WHERE id = ?', id);
}
