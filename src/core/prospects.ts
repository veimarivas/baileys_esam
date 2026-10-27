import { get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { addNote, deleteNote, getNote, getOrCreateContact, restoreNote, setNoteStage, updateNote } from './contacts.js';
import { createTag } from './note-tags.js';
import { personTagsByKeys, phoneKeyOf, setPersonName } from './person.js';
import type { SessionRow } from '../types.js';

/**
 * Prospectos de marketing registrados en cronogramas. Cada prospecto es una
 * nota de seguimiento en la ficha de la persona, en la línea del asesor que lo
 * registró (autor = el asesor), con la etiqueta «Prospecto». Así el asesor lo
 * sigue en /notes (área Marketing) y la gerencia/supervisión de marketing lo ve.
 *
 * El estado comercial (nuevo, contactado, interesado, no interesado, inscrito)
 * lo maneja cronogramas y mueve la nota en el pipeline:
 *   nuevo → Por hacer · contactado/interesado → Contactado · no interesado/inscrito → Resuelta.
 */

export const PROSPECT_TAG = 'Prospecto';

export const PROSPECT_STATES: Record<string, string> = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  interesado: 'Interesado',
  no_interesado: 'No interesado',
  inscrito: 'Inscrito',
};

export interface ProspectInput {
  /** Referencia estable en cronogramas (p. ej. `mp:15`). */
  ref: string;
  /** Usuario de cronogramas dueño del prospecto (owner_uid de su línea). */
  account: string;
  phone: string;
  name?: string | null;
  programa?: string | null;
  programaId?: number | null;
  estado?: string | null;
  nota?: string | null;
}

export interface ProspectMeta {
  programa: string | null;
  programa_id: number | null;
  estado: string;
  estado_label: string;
  nombre: string | null;
}

export class ProspectError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

function prospectTagId(): number {
  const row = get<{ id: number }>('SELECT id FROM note_tags WHERE name = ? COLLATE NOCASE', PROSPECT_TAG);
  if (row) return row.id;
  return createTag({ name: PROSPECT_TAG, color: '#d97706' }).id;
}

/** Texto visible de la nota (lo que el asesor lee en /notes y en la ficha). */
function noteText(input: ProspectInput, estadoLabel: string): string {
  const lines = [`Prospecto · ${input.programa?.trim() || 'Sin programa'}`, `Estado: ${estadoLabel}`];
  const nota = (input.nota ?? '').trim();
  if (nota) lines.push('', nota);
  return lines.join('\n').slice(0, 4000);
}

function stageFor(estado: string): 'todo' | 'contacted' | 'done' {
  if (estado === 'inscrito' || estado === 'no_interesado') return 'done';
  if (estado === 'contactado' || estado === 'interesado') return 'contacted';
  return 'todo';
}

export function prospectNoteId(ref: string): number | null {
  return get<{ id: number }>('SELECT id FROM contact_notes WHERE prospect_ref = ? ORDER BY id DESC LIMIT 1', ref)?.id ?? null;
}

/**
 * Crea o actualiza el seguimiento del prospecto. Devuelve la nota y si se creó.
 * Lanza ProspectError si el asesor no tiene usuario o línea en Seguimiento ESAM.
 */
export function upsertProspect(input: ProspectInput, session: SessionRow | undefined): { noteId: number; created: boolean } {
  const ref = String(input.ref ?? '').trim().slice(0, 80);
  if (!ref) throw new ProspectError('Falta la referencia del prospecto.');
  const user = get<{ id: number }>('SELECT id FROM users WHERE source_uid = ?', String(input.account));
  if (!user) throw new ProspectError('El asesor no tiene usuario en Seguimiento ESAM (pedí que lo habiliten en cronogramas).');
  if (!session) throw new ProspectError('El asesor no tiene una línea de WhatsApp en Seguimiento ESAM.');
  const key = phoneKeyOf(input.phone);
  if (!key || key.length < 8) throw new ProspectError('El celular del prospecto no es válido.');

  const estado = PROSPECT_STATES[String(input.estado ?? '')] ? String(input.estado) : 'nuevo';
  const label = PROSPECT_STATES[estado];
  const meta: ProspectMeta = {
    programa: input.programa?.trim() || null,
    programa_id: input.programaId ?? null,
    estado,
    estado_label: label,
    nombre: input.name?.trim() || null,
  };
  const text = noteText(input, label);

  // Nombre de la persona (solo si nadie lo registró antes: no pisa cronogramas ni lo escrito a mano).
  if (meta.nombre && !personTagsByKeys([key]).get(key)?.full_name) setPersonName(key, meta.nombre, user.id);

  const existingId = prospectNoteId(ref);
  const existing = existingId ? getNote(existingId) : undefined;
  if (!existing) {
    const contact = getOrCreateContact(session.id, `${key}@c.us`);
    const today = nowIso().slice(0, 10);
    const note = addNote(contact.id, user.id, text, null, today, [prospectTagId()], false);
    run('UPDATE contact_notes SET prospect_ref = ?, prospect_meta = ? WHERE id = ?', ref, JSON.stringify(meta), note.id);
    const stage = stageFor(estado);
    if (stage !== 'todo') setNoteStage(note.id, stage, user.id, `Estado del prospecto: ${label}`);
    return { noteId: note.id, created: true };
  }

  if (existing.deleted_at) restoreNote(existing.id, user.id);
  const prev = (() => {
    try {
      return JSON.parse(String((existing as { prospect_meta?: string | null }).prospect_meta ?? '{}')) as Partial<ProspectMeta>;
    } catch {
      return {};
    }
  })();
  if (existing.note_text !== text) updateNote(existing.id, { noteText: text }, user.id);
  run('UPDATE contact_notes SET prospect_meta = ? WHERE id = ?', JSON.stringify(meta), existing.id);
  // El pipeline solo se mueve cuando cambia el estado: lo que el asesor movió a
  // mano en /notes se respeta mientras el estado siga igual.
  if (prev.estado !== estado) setNoteStage(existing.id, stageFor(estado), user.id, `Estado del prospecto: ${label}`);
  return { noteId: existing.id, created: false };
}

/** El prospecto se eliminó en cronogramas: su seguimiento va a la papelera. */
export function removeProspect(ref: string): number | null {
  const id = prospectNoteId(String(ref));
  if (!id) return null;
  const note = getNote(id);
  deleteNote(id, note?.user_id ?? null);
  return id;
}
