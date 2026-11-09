import { all, foldText, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { esamAreaName } from '../auth/users.js';
import { displayPhoneNumber } from './lid.js';
import type { ContactNoteRow, ContactRow } from '../types.js';

/**
 * Ficha de contacto del inbox: una por (sesión, chat). El gateway la va
 * completando con el nombre que manda WhatsApp y el panel la puede editar o
 * enriquecer (email, empresa) desde la columna de contacto.
 */

export interface ContactPatch {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
  avatarPath?: string | null;
}

export function getContactByChat(sessionId: string, chatId: string): ContactRow | undefined {
  return get<ContactRow>('SELECT * FROM contacts WHERE session_id = ? AND chat_id = ?', sessionId, chatId);
}

/** Devuelve la ficha del chat o la crea vacía si no existe. */
export function getOrCreateContact(sessionId: string, chatId: string): ContactRow {
  const existing = getContactByChat(sessionId, chatId);
  if (existing) return existing;
  const now = nowIso();
  run(
    `INSERT INTO contacts (session_id, chat_id, phone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, chat_id) DO NOTHING`,
    sessionId,
    chatId,
    displayPhoneNumber(chatId),
    now,
    now,
  );
  return getContactByChat(sessionId, chatId)!;
}

/**
 * Crea/actualiza la ficha del chat. Solo escribe los campos provistos (los
 * `undefined` se ignoran, los `null` limpian el valor).
 */
export function upsertContact(sessionId: string, chatId: string, patch: ContactPatch = {}): ContactRow {
  getOrCreateContact(sessionId, chatId);

  const has = (k: keyof ContactPatch) => Object.prototype.hasOwnProperty.call(patch, k);
  const name = has('name') ? patch.name ?? null : undefined;
  const phone = has('phone') ? patch.phone ?? null : undefined;
  const email = has('email') ? patch.email ?? null : undefined;
  const company = has('company') ? patch.company ?? null : undefined;
  const avatarPath = has('avatarPath') ? patch.avatarPath ?? null : undefined;

  run(
    `UPDATE contacts SET
        name = CASE WHEN ? = 1 THEN ? ELSE name END,
        phone = CASE WHEN ? = 1 THEN COALESCE(?, phone) ELSE phone END,
        email = CASE WHEN ? = 1 THEN ? ELSE email END,
        company = CASE WHEN ? = 1 THEN ? ELSE company END,
        avatar_path = CASE WHEN ? = 1 THEN ? ELSE avatar_path END,
        updated_at = ?
      WHERE session_id = ? AND chat_id = ?`,
    name !== undefined ? 1 : 0,
    name ?? null,
    phone !== undefined ? 1 : 0,
    phone ?? null,
    email !== undefined ? 1 : 0,
    email ?? null,
    company !== undefined ? 1 : 0,
    company ?? null,
    avatarPath !== undefined ? 1 : 0,
    avatarPath ?? null,
    nowIso(),
    sessionId,
    chatId,
  );
  return getContactByChat(sessionId, chatId)!;
}

export function setAvatar(sessionId: string, chatId: string, avatarPath: string | null): void {
  upsertContact(sessionId, chatId, { avatarPath });
}

/** Id del contacto de un chat (lo usa la conversación al persistir mensajes). */
export function contactIdFor(sessionId: string, chatId: string): number {
  return getOrCreateContact(sessionId, chatId).id;
}

/**
 * Registra un contacto grupal: guarda el asunto como nombre (sin pisar uno ya
 * editado) y limpia el teléfono, que no aplica a los grupos.
 */
export function setContactGroup(sessionId: string, chatId: string, name: string | null): void {
  getOrCreateContact(sessionId, chatId);
  run(
    'UPDATE contacts SET name = COALESCE(name, ?), phone = NULL, updated_at = ? WHERE session_id = ? AND chat_id = ?',
    name,
    nowIso(),
    sessionId,
    chatId,
  );
}

export interface NoteTagLite {
  id: number;
  name: string;
  color: string;
}

/** Persona a la que se derivó una nota. */
export interface NoteAssigneeLite {
  id: number;
  name: string;
  area: string | null;
  area_label: string;
  /** Es el responsable principal (`contact_notes.assigned_to`). */
  primary: boolean;
}

export interface ContactNoteWithAuthor extends ContactNoteRow {
  author_name: string | null;
  done_by_name: string | null;
  assigned_name: string | null;
  assigned_area: string | null;
  /** Área de quien registró la nota (para ordenar /notes por área). */
  author_area?: string | null;
  assigned_by_name: string | null;
  contacted_by_name: string | null;
  /** Línea (sesión) desde la que se registró la nota. */
  session_id: string;
  session_name: string | null;
  session_phone: string | null;
  tags: NoteTagLite[];
  /** Todas las personas a las que se derivó (la primera es la principal). */
  assignees: NoteAssigneeLite[];
}

/** Columnas comunes de una nota con su autor, quién la completó y su línea de origen. */
const NOTE_SELECT = `SELECT n.*, u.name AS author_name, d.name AS done_by_name, a.name AS assigned_name,
    a.esam_area AS assigned_area, u.esam_area AS author_area, ab.name AS assigned_by_name, cb.name AS contacted_by_name,
    ct.session_id AS session_id, s.name AS session_name, COALESCE(s.phone, s.expected_phone) AS session_phone
  FROM contact_notes n
  JOIN contacts ct ON ct.id = n.contact_id
  LEFT JOIN sessions s ON s.id = ct.session_id
  LEFT JOIN users u ON u.id = n.user_id
  LEFT JOIN users d ON d.id = n.done_by
  LEFT JOIN users a ON a.id = n.assigned_to
  LEFT JOIN users ab ON ab.id = n.assigned_by
  LEFT JOIN users cb ON cb.id = n.contacted_by`;

/**
 * Fichas de la misma persona en todas las líneas: la propia más las que
 * comparten teléfono. Condición SQL sobre `alias.id` con un parámetro (el id).
 */
function samePersonClause(alias: string): string {
  return `${alias}.id IN (
    SELECT p.id FROM contacts me JOIN contacts p
      ON p.id = me.id OR (me.phone_key IS NOT NULL AND p.phone_key = me.phone_key)
     WHERE me.id = ?)`;
}

/** Orden de seguimiento: importantes pendientes, con fecha (la más próxima), sin fecha, resueltas. */
const FOLLOWUP_ORDER = `(n.done_at IS NOT NULL), (n.pinned = 0), (n.due_at IS NULL), n.due_at ASC,
  COALESCE(n.due_time, '99:99') ASC, COALESCE(n.done_at, n.created_at) DESC, n.id DESC`;

/** Etiquetas de varias notas, agrupadas por id (una sola consulta). */
function tagsByNote(noteIds: number[]): Map<number, NoteTagLite[]> {
  const map = new Map<number, NoteTagLite[]>();
  if (!noteIds.length) return map;
  const placeholders = noteIds.map(() => '?').join(',');
  const rows = all<{ note_id: number; id: number; name: string; color: string }>(
    `SELECT nt.note_id, t.id, t.name, t.color
       FROM contact_note_tags nt JOIN note_tags t ON t.id = nt.tag_id
      WHERE nt.note_id IN (${placeholders})
      ORDER BY t.name COLLATE NOCASE`,
    ...noteIds,
  );
  for (const r of rows) {
    const list = map.get(r.note_id) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    map.set(r.note_id, list);
  }
  return map;
}

/**
 * Personas derivadas de varias notas, agrupadas por id. Incluye las notas
 * antiguas que solo tienen `assigned_to` (sin filas en la tabla nueva).
 */
function assigneesByNote(noteIds: number[]): Map<number, NoteAssigneeLite[]> {
  const map = new Map<number, NoteAssigneeLite[]>();
  if (!noteIds.length) return map;
  const placeholders = noteIds.map(() => '?').join(',');
  const rows = all<{ note_id: number; id: number; name: string | null; area: string | null; is_primary: number }>(
    `SELECT x.note_id, x.id, x.name, x.area, x.is_primary
       FROM (
         SELECT na.note_id, u.id,
                COALESCE(NULLIF(u.name, ''), NULLIF(u.username, ''), u.email, 'Usuario ' || u.id) AS name,
                u.esam_area AS area,
                CASE WHEN n.assigned_to = u.id THEN 1 ELSE 0 END AS is_primary,
                na.created_at
           FROM contact_note_assignees na
           JOIN users u ON u.id = na.user_id
           JOIN contact_notes n ON n.id = na.note_id
          WHERE na.note_id IN (${placeholders})
         UNION ALL
         SELECT n.id AS note_id, u.id,
                COALESCE(NULLIF(u.name, ''), NULLIF(u.username, ''), u.email, 'Usuario ' || u.id) AS name,
                u.esam_area AS area, 1 AS is_primary, n.created_at
           FROM contact_notes n JOIN users u ON u.id = n.assigned_to
          WHERE n.id IN (${placeholders})
            AND NOT EXISTS (SELECT 1 FROM contact_note_assignees x WHERE x.note_id = n.id)
       ) x
      ORDER BY x.note_id, x.is_primary DESC, x.name COLLATE NOCASE`,
    ...noteIds,
    ...noteIds,
  );
  for (const r of rows) {
    const list = map.get(r.note_id) ?? [];
    list.push({
      id: r.id,
      name: r.name ?? `Usuario ${r.id}`,
      area: r.area,
      area_label: esamAreaName(r.area),
      primary: !!r.is_primary,
    });
    map.set(r.note_id, list);
  }
  return map;
}

function withTags<T extends { id: number }>(rows: T[]): Array<T & { tags: NoteTagLite[]; assignees: NoteAssigneeLite[] }> {
  const ids = rows.map((r) => r.id);
  const tags = tagsByNote(ids);
  const assignees = assigneesByNote(ids);
  return rows.map((r) => ({
    ...r,
    tags: tags.get(r.id) ?? [],
    assignees: assignees.get(r.id) ?? [],
  }));
}

/** Ids de las personas a las que está derivada una nota (principal primero). */
export function noteAssigneeIds(noteId: number): number[] {
  const rows = all<{ user_id: number; is_primary: number }>(
    `SELECT na.user_id, CASE WHEN n.assigned_to = na.user_id THEN 1 ELSE 0 END AS is_primary
       FROM contact_note_assignees na JOIN contact_notes n ON n.id = na.note_id
      WHERE na.note_id = ?
      ORDER BY is_primary DESC, na.created_at, na.user_id`,
    noteId,
  );
  if (rows.length) return rows.map((r) => r.user_id);
  const primary = getNote(noteId)?.assigned_to;
  return primary ? [primary] : [];
}

/** ¿La nota está derivada a esta persona? */
export function isNoteAssignee(noteId: number, userId: number): boolean {
  return !!get(
    `SELECT 1 FROM contact_notes n
      WHERE n.id = ? AND (n.assigned_to = ? OR EXISTS (
        SELECT 1 FROM contact_note_assignees na WHERE na.note_id = n.id AND na.user_id = ?))`,
    noteId,
    userId,
    userId,
  );
}

/**
 * Reemplaza las personas derivadas de una nota. La primera de `userIds` queda
 * como responsable principal (`assigned_to`) para las vistas que ya lo usaban.
 * Devuelve `true` si la derivación cambió.
 */
export function setNoteAssignees(
  noteId: number,
  userIds: number[],
  assignedBy: number | null,
  opts: { log?: boolean } = {},
): boolean {
  const note = getNote(noteId);
  if (!note) return false;
  const valid = [...new Set(userIds.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  const current = noteAssigneeIds(noteId);
  const primary = valid[0] ?? null;
  const changed = !sameIds(valid, current) || primary !== (note.assigned_to ?? null);
  if (!changed) return false;

  const now = nowIso();
  run('DELETE FROM contact_note_assignees WHERE note_id = ?', noteId);
  for (const id of valid) {
    run(
      'INSERT OR IGNORE INTO contact_note_assignees (note_id, user_id, created_at) VALUES (?, ?, ?)',
      noteId,
      id,
      now,
    );
  }
  // Solo se reinicia el estado de la derivación cuando cambia el responsable
  // principal (o se quita la derivación): agregar una persona más no borra la
  // confirmación de contacto que ya había hecho el equipo.
  if (primary !== (note.assigned_to ?? null) || !valid.length) {
    run(
      `UPDATE contact_notes SET assigned_to = ?, assigned_by = ?, assigned_at = ?,
              seen_at = NULL, contacted_at = NULL, contacted_by = NULL, contact_result = NULL,
              updated_at = ?
        WHERE id = ?`,
      primary,
      primary ? assignedBy : null,
      primary ? now : null,
      now,
      noteId,
    );
  } else {
    run('UPDATE contact_notes SET assigned_to = ?, updated_at = ? WHERE id = ?', primary, now, noteId);
  }

  if (opts.log !== false) {
    const names = valid.map((id) => userName(id)).filter((name): name is string => !!name);
    logNoteEvent(noteId, assignedBy, 'assigned', undefined, names.length ? names.join(', ') : null);
  }
  return true;
}

export function setNoteTags(noteId: number, tagIds: number[]): void {
  run('DELETE FROM contact_note_tags WHERE note_id = ?', noteId);
  const unique = [...new Set(tagIds.map((n) => Number(n)).filter((n) => Number.isFinite(n)))];
  for (const tagId of unique) {
    run('INSERT OR IGNORE INTO contact_note_tags (note_id, tag_id) VALUES (?, ?)', noteId, tagId);
  }
}

/** Nota con etiquetas y autor (una sola). */
export function noteDTO(id: number): ContactNoteWithAuthor | undefined {
  const row = get<ContactNoteWithAuthor>(`${NOTE_SELECT} WHERE n.id = ?`, id);
  return row ? withTags([row])[0] : undefined;
}

/**
 * Notas de una persona en todas las líneas (por teléfono), en orden de
 * seguimiento: primero las importantes pendientes, luego las pendientes con
 * fecha (la más próxima arriba), las pendientes sin fecha y al final las
 * completadas (la más reciente arriba).
 */
export function listNotes(contactId: number, limit = 200): ContactNoteWithAuthor[] {
  const rows = all<ContactNoteWithAuthor>(
    `${NOTE_SELECT}
      WHERE n.deleted_at IS NULL AND ${samePersonClause('ct')}
      ORDER BY ${FOLLOWUP_ORDER}
      LIMIT ?`,
    contactId,
    limit,
  );
  return withTags(rows);
}

export interface PersonNoteCounts {
  /** Pendientes (sin completar). */
  open: number;
  /** Importantes pendientes. */
  pinned: number;
  /** Pendientes con fecha vencida. */
  overdue: number;
}

/**
 * Conteo de notas pendientes por ficha, sumando las de la misma persona en
 * otras líneas (para el indicador de la lista de conversaciones).
 */
export function noteCountsFor(contactIds: number[]): Map<number, PersonNoteCounts> {
  const map = new Map<number, PersonNoteCounts>();
  const ids = [...new Set(contactIds.filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return map;
  const rows = all<{ contact_id: number; open: number; pinned: number; overdue: number }>(
    `SELECT me.id AS contact_id,
            SUM(CASE WHEN n.done_at IS NULL THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN n.done_at IS NULL AND n.pinned = 1 THEN 1 ELSE 0 END) AS pinned,
            SUM(CASE WHEN n.done_at IS NULL AND n.due_at < ${TODAY} THEN 1 ELSE 0 END) AS overdue
       FROM contacts me
       JOIN contacts p ON p.id = me.id OR (me.phone_key IS NOT NULL AND p.phone_key = me.phone_key)
       JOIN contact_notes n ON n.contact_id = p.id AND n.deleted_at IS NULL
      WHERE me.id IN (${ids.map(() => '?').join(',')})
      GROUP BY me.id`,
    ...ids,
  );
  for (const r of rows) {
    map.set(r.contact_id, { open: Number(r.open ?? 0), pinned: Number(r.pinned ?? 0), overdue: Number(r.overdue ?? 0) });
  }
  return map;
}

/**
 * Chats (línea + chat) de la persona dueña de una nota: la ficha de la nota y
 * las de otras líneas con el mismo teléfono. Se usa para avisar en vivo.
 */
export function personChatsForNote(noteId: number): Array<{ session_id: string; chat_id: string }> {
  return all<{ session_id: string; chat_id: string }>(
    `SELECT p.session_id, p.chat_id
       FROM contact_notes n
       JOIN contacts me ON me.id = n.contact_id
       JOIN contacts p ON p.id = me.id OR (me.phone_key IS NOT NULL AND p.phone_key = me.phone_key)
      WHERE n.id = ?`,
    noteId,
  );
}

export function getNote(id: number): ContactNoteRow | undefined {
  return get<ContactNoteRow>('SELECT * FROM contact_notes WHERE id = ?', id);
}

/**
 * ¿La nota es visible dentro de estas sesiones? Lo es si se registró en una
 * de ellas o si la persona tiene ficha en alguna (la misma persona atendida
 * desde otra línea). `null` = sin restricción.
 */
export function noteVisibleIn(id: number, sessionIds: string[] | null, viewerId: number | null = null): boolean {
  if (sessionIds === null) return !!getNote(id);
  if (viewerId && isNoteAssignee(id, viewerId)) return true;
  if (!sessionIds.length) return false;
  const inList = sessionIds.map(() => '?').join(',');
  return !!get(
    `SELECT 1 FROM contact_notes n JOIN contacts ct ON ct.id = n.contact_id
      WHERE n.id = ? AND (ct.session_id IN (${inList})
         OR (ct.phone_key IS NOT NULL AND EXISTS (
              SELECT 1 FROM contacts o WHERE o.phone_key = ct.phone_key AND o.session_id IN (${inList}))))`,
    id,
    ...sessionIds,
    ...sessionIds,
  );
}

export function addNote(
  contactId: number,
  userId: number | null,
  noteText: string | null,
  audioPath: string | null,
  dueAt: string | null = null,
  tagIds: number[] = [],
  pinned = false,
  extra: {
    assignedTo?: number | null;
    assigneeIds?: number[];
    sourceMessageId?: number | null;
    dueTime?: string | null;
  } = {},
): ContactNoteWithAuthor {
  const assigneeIds = [
    ...new Set(
      (extra.assigneeIds ?? (extra.assignedTo ? [extra.assignedTo] : []))
        .map(Number)
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  ];
  const primary = assigneeIds[0] ?? null;
  const now = nowIso();
  const created = run(
    `INSERT INTO contact_notes (contact_id, user_id, note_text, audio_path, due_at, due_time, pinned, assigned_to,
       assigned_by, assigned_at, source_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    contactId,
    userId,
    noteText,
    audioPath,
    dueAt || null,
    dueAt ? extra.dueTime || null : null,
    pinned ? 1 : 0,
    primary,
    primary ? userId : null,
    primary ? now : null,
    extra.sourceMessageId ?? null,
    now,
  );
  setNoteTags(created.lastInsertRowid, tagIds);
  if (assigneeIds.length) {
    for (const id of assigneeIds) {
      run(
        'INSERT OR IGNORE INTO contact_note_assignees (note_id, user_id, created_at) VALUES (?, ?, ?)',
        created.lastInsertRowid,
        id,
        now,
      );
    }
    if (assigneeIds.some((id) => id !== userId)) {
      const names = assigneeIds.map((id) => userName(id)).filter((name): name is string => !!name);
      logNoteEvent(created.lastInsertRowid, userId, 'assigned', undefined, names.join(', ') || null);
    }
  }
  return noteDTO(created.lastInsertRowid)!;
}

export function updateNote(
  noteId: number,
  patch: {
    noteText?: string | null;
    dueAt?: string | null;
    dueTime?: string | null;
    tagIds?: number[];
    pinned?: boolean;
    /** Compatibilidad: un solo responsable. */
    assignedTo?: number | null;
    /** Varias personas derivadas (la primera queda como principal). */
    assignedToIds?: number[];
  },
  userId: number | null = null,
): void {
  const current = getNote(noteId);
  if (!current) throw new Error('Nota no encontrada.');
  const text = patch.noteText !== undefined ? patch.noteText : current.note_text;
  const due = patch.dueAt !== undefined ? patch.dueAt || null : current.due_at;
  const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : current.pinned;
  const dueTime = due ? (patch.dueTime !== undefined ? patch.dueTime || null : current.due_time) : null;
  if (!text && !current.audio_path) throw new Error('La nota no puede quedar vacía.');
  const prevTags = tagNames(noteId);
  const tagsChanged = patch.tagIds !== undefined && !sameIds(patch.tagIds, tagIdsOf(noteId));
  if (text !== current.note_text || due !== current.due_at || tagsChanged) {
    logNoteEvent(noteId, userId, 'edited', { text: current.note_text, due: current.due_at, tags: prevTags });
  }
  if (pinned !== current.pinned) logNoteEvent(noteId, userId, pinned ? 'pinned' : 'unpinned');
  run(
    `UPDATE contact_notes SET note_text = ?, due_at = ?, due_time = ?, pinned = ?, updated_at = ?,
            reminded_at = CASE WHEN due_at IS ? AND due_time IS ? THEN reminded_at ELSE NULL END
      WHERE id = ?`,
    text,
    due,
    dueTime,
    pinned,
    nowIso(),
    due,
    dueTime,
    noteId,
  );
  if (patch.tagIds) setNoteTags(noteId, patch.tagIds);
  const nextIds = patch.assignedToIds !== undefined
    ? patch.assignedToIds
    : patch.assignedTo !== undefined
      ? (patch.assignedTo ? [patch.assignedTo] : [])
      : undefined;
  if (nextIds !== undefined) setNoteAssignees(noteId, nextIds, userId);
}

/** El responsable abrió la derivación: queda registrado una sola vez. */
export function markAssignmentSeen(noteId: number, userId: number): boolean {
  const changed = run(
    `UPDATE contact_notes SET seen_at = ? WHERE id = ? AND seen_at IS NULL
       AND (assigned_to = ? OR EXISTS (
         SELECT 1 FROM contact_note_assignees na WHERE na.note_id = contact_notes.id AND na.user_id = ?))`,
    nowIso(),
    noteId,
    userId,
    userId,
  ).changes;
  if (changed) logNoteEvent(noteId, userId, 'seen');
  return !!changed;
}

/** El responsable confirma que se comunicó con el contacto, con el resultado. */
export function markContacted(noteId: number, userId: number, result: string): void {
  const now = nowIso();
  run(
    `UPDATE contact_notes SET contacted_at = ?, contacted_by = ?, contact_result = ?, seen_at = COALESCE(seen_at, ?)
      WHERE id = ?`,
    now,
    userId,
    result || null,
    now,
    noteId,
  );
  logNoteEvent(noteId, userId, 'contacted', undefined, result || null);
}

export type PipelineStage = 'todo' | 'doing' | 'contacted' | 'done';

/**
 * Mueve una nota en el pipeline de seguimiento:
 * - `todo` / `doing`: etapa manual; si estaba resuelta o con contacto, se reabre.
 * - `contacted`: confirma el contacto con su resultado.
 * - `done`: la marca resuelta.
 */
export function setNoteStage(noteId: number, stage: PipelineStage, userId: number, result = ''): void {
  const current = getNote(noteId);
  if (!current) throw new Error('Nota no encontrada.');
  if (stage === 'done') {
    setNoteDone(noteId, userId, true);
    return;
  }
  if (current.done_at) setNoteDone(noteId, userId, false);
  if (stage === 'contacted') {
    markContacted(noteId, userId, result);
    return;
  }
  if (current.contacted_at) {
    run('UPDATE contact_notes SET contacted_at = NULL, contacted_by = NULL, contact_result = NULL WHERE id = ?', noteId);
  }
  run('UPDATE contact_notes SET pipeline_stage = ?, updated_at = ? WHERE id = ?', stage, nowIso(), noteId);
  if (stage === 'doing') logNoteEvent(noteId, userId, 'stage', undefined, 'En gestión');
  else if (current.pipeline_stage === 'doing' || current.contacted_at) logNoteEvent(noteId, userId, 'stage', undefined, 'Por hacer');
}

/** Pospone el recordatorio: nueva fecha y hora, y vuelve a avisar. */
export function snoozeNote(noteId: number, dueAt: string, dueTime: string, userId: number | null = null): void {
  const current = getNote(noteId);
  if (!current) return;
  logNoteEvent(noteId, userId, 'snoozed', undefined, `${dueAt} ${dueTime}`);
  run('UPDATE contact_notes SET due_at = ?, due_time = ?, reminded_at = NULL WHERE id = ?', dueAt, dueTime, noteId);
}

/** Marca o desmarca una nota como importante (fijada en el chat). */
export function setNotePinned(noteId: number, pinned: boolean, userId: number | null = null): void {
  const changed = run('UPDATE contact_notes SET pinned = ? WHERE id = ? AND pinned <> ?', pinned ? 1 : 0, noteId, pinned ? 1 : 0);
  if (changed.changes) logNoteEvent(noteId, userId, pinned ? 'pinned' : 'unpinned');
}

/** Marca el seguimiento de una nota como completado (o lo reabre). */
export function setNoteDone(noteId: number, userId: number | null, done: boolean): void {
  const changed = run(
    `UPDATE contact_notes SET done_at = ?, done_by = ?
      WHERE id = ? AND (done_at IS NULL) = ?`,
    done ? nowIso() : null,
    done ? userId : null,
    noteId,
    done ? 1 : 0,
  );
  if (changed.changes) logNoteEvent(noteId, userId, done ? 'done' : 'reopened');
}

/**
 * Manda la nota a la papelera (no se borra: conserva texto, etiquetas e
 * historial y se puede restaurar desde /notes).
 */
export function deleteNote(id: number, userId: number | null = null): void {
  const changed = run(
    'UPDATE contact_notes SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL',
    nowIso(),
    userId,
    id,
  );
  if (changed.changes) logNoteEvent(id, userId, 'deleted');
}

/** Saca la nota de la papelera. */
export function restoreNote(id: number, userId: number | null = null): void {
  const changed = run(
    'UPDATE contact_notes SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_at IS NOT NULL',
    id,
  );
  if (changed.changes) logNoteEvent(id, userId, 'restored');
}

/**
 * Vacía la papelera: elimina definitivamente todas las notas eliminadas y sus
 * datos asociados (etiquetas, historial y avisos). Solo se expone al Super Admin.
 */
export function emptyTrash(): number {
  const ids = all<{ id: number }>('SELECT id FROM contact_notes WHERE deleted_at IS NOT NULL').map((r) => r.id);
  if (!ids.length) return 0;

  const placeholders = ids.map(() => '?').join(',');
  run(`DELETE FROM notifications WHERE note_id IN (${placeholders})`, ...ids);
  run(`DELETE FROM contact_note_history WHERE note_id IN (${placeholders})`, ...ids);
  run(`DELETE FROM contact_note_tags WHERE note_id IN (${placeholders})`, ...ids);

  const result = run(`DELETE FROM contact_notes WHERE id IN (${placeholders})`, ...ids);
  return result.changes;
}

// ── Historial de cambios ─────────────────────────────────────────────────────

export type NoteAction =
  | 'edited'
  | 'done'
  | 'reopened'
  | 'pinned'
  | 'unpinned'
  | 'deleted'
  | 'restored'
  | 'assigned'
  | 'snoozed'
  | 'template'
  | 'seen'
  | 'contacted'
  | 'stage';

export interface NoteHistoryEntry {
  id: number;
  action: NoteAction;
  user_name: string | null;
  /** Solo en `edited`: cómo estaba la nota antes del cambio. */
  prev_text: string | null;
  prev_due_at: string | null;
  prev_tags: string[];
  /** En `assigned`: nombre del nuevo responsable (null = quedó sin asignar). */
  detail: string | null;
  created_at: string;
}

function userName(id: number): string | null {
  return get<{ name: string | null }>('SELECT name FROM users WHERE id = ?', id)?.name ?? null;
}

function tagIdsOf(noteId: number): number[] {
  return all<{ tag_id: number }>('SELECT tag_id FROM contact_note_tags WHERE note_id = ?', noteId).map((r) => r.tag_id);
}

function tagNames(noteId: number): string[] {
  return all<{ name: string }>(
    `SELECT t.name FROM contact_note_tags nt JOIN note_tags t ON t.id = nt.tag_id
      WHERE nt.note_id = ? ORDER BY t.name COLLATE NOCASE`,
    noteId,
  ).map((r) => r.name);
}

function sameIds(a: number[], b: number[]): boolean {
  const x = [...new Set(a.map(Number))].sort();
  const y = [...new Set(b.map(Number))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function logNoteEvent(
  noteId: number,
  userId: number | null,
  action: NoteAction,
  prev?: { text: string | null; due: string | null; tags: string[] },
  detail: string | null = null,
): void {
  run(
    `INSERT INTO contact_note_history (note_id, user_id, action, prev_text, prev_due_at, prev_tags, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    noteId,
    userId,
    action,
    prev?.text ?? null,
    prev?.due ?? null,
    prev ? JSON.stringify(prev.tags) : null,
    detail,
    nowIso(),
  );
}

/** Deja constancia de que la nota nació de una plantilla. */
export function markFromTemplate(noteId: number, userId: number | null, templateName: string): void {
  logNoteEvent(noteId, userId, 'template', undefined, templateName);
}

export interface PersonLine {
  contact_id: number;
  session_id: string;
  session_name: string | null;
  session_phone: string | null;
  chat_id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  programa: string | null;
  status: string | null;
  last_message_at: string | null;
  last_direction: string | null;
  unread_count: number | null;
  first_at: string | null;
}

/**
 * La persona en todas las líneas: una fila por ficha con el mismo teléfono,
 * con la actividad de su conversación (sin el texto de los mensajes).
 */
export function personLines(contactId: number): PersonLine[] {
  return all<PersonLine>(
    `SELECT p.id AS contact_id, p.session_id, s.name AS session_name, COALESCE(s.phone, s.expected_phone) AS session_phone,
            p.chat_id, p.name, p.email, p.company, c.programa, c.status, c.last_message_at, c.last_direction,
            c.unread_count, c.created_at AS first_at
       FROM contacts me
       JOIN contacts p ON p.id = me.id OR (me.phone_key IS NOT NULL AND p.phone_key = me.phone_key)
       LEFT JOIN conversations c ON c.session_id = p.session_id AND c.chat_id = p.chat_id
       LEFT JOIN sessions s ON s.id = p.session_id
      WHERE me.id = ?
      ORDER BY COALESCE(c.last_message_at, '') DESC`,
    contactId,
  );
}

export interface MyDay {
  overdue: number;
  today: number;
  /** Tareas de hoy, con hora primero (hasta 6). */
  items: Array<{ id: number; note_text: string | null; due_at: string; due_time: string | null; contact: string; chat_id: string; session_id: string }>;
}

/** Condición SQL: la nota está derivada al usuario (principal o adicional). */
function assignedToUserClause(alias: string): string {
  return `(${alias}.assigned_to = ? OR EXISTS (
    SELECT 1 FROM contact_note_assignees cna WHERE cna.note_id = ${alias}.id AND cna.user_id = ?))`;
}

/** Resumen del día de un usuario: sus tareas (asignadas o propias sin responsable). */
export function myDay(userId: number): MyDay {
  const mine = `(${assignedToUserClause('n')} OR (n.assigned_to IS NULL AND n.user_id = ?))
    AND n.done_at IS NULL AND n.deleted_at IS NULL`;
  const counts = get<{ overdue: number | null; today: number | null }>(
    `SELECT SUM(CASE WHEN n.due_at < ${TODAY} THEN 1 ELSE 0 END) AS overdue,
            SUM(CASE WHEN n.due_at = ${TODAY} THEN 1 ELSE 0 END) AS today
       FROM contact_notes n WHERE ${mine}`,
    userId,
    userId,
    userId,
  );
  const items = all<MyDay['items'][number]>(
    `SELECT n.id, n.note_text, n.due_at, n.due_time, COALESCE(ct.name, ct.phone, ct.chat_id) AS contact,
            ct.chat_id, ct.session_id
       FROM contact_notes n JOIN contacts ct ON ct.id = n.contact_id
      WHERE ${mine} AND n.due_at <= ${TODAY}
      ORDER BY n.due_at ASC, COALESCE(n.due_time, '99:99') ASC
      LIMIT 6`,
    userId,
    userId,
    userId,
  );
  return { overdue: Number(counts?.overdue ?? 0), today: Number(counts?.today ?? 0), items };
}

/** Personas a las que se puede asignar una tarea (de cualquier línea), con su área. */
export function noteAssignees(): Array<{ id: number; name: string; area: string | null; area_label: string }> {
  const rows = all<{ id: number; name: string | null; area: string | null }>(
    `SELECT id, COALESCE(NULLIF(name, ''), NULLIF(username, ''), email, 'Usuario ' || id) AS name, esam_area AS area
       FROM users
      WHERE esam_autorizado = 1 OR source = 'local'`,
  );
  return rows
    .map((u) => ({
      id: u.id,
      name: u.name ?? `Usuario ${u.id}`,
      area: u.area,
      area_label: esamAreaName(u.area),
    }))
    .sort((a, b) => a.area_label.localeCompare(b.area_label, 'es') || a.name.localeCompare(b.name, 'es'));
}

/** Historial de una nota, del más antiguo al más reciente (la creación la da la propia nota). */
export function listNoteHistory(noteId: number): NoteHistoryEntry[] {
  return all<Omit<NoteHistoryEntry, 'prev_tags'> & { prev_tags: string | null }>(
    `SELECT h.id, h.action, u.name AS user_name, h.prev_text, h.prev_due_at, h.prev_tags, h.detail, h.created_at
       FROM contact_note_history h LEFT JOIN users u ON u.id = h.user_id
      WHERE h.note_id = ?
      ORDER BY h.created_at ASC, h.id ASC`,
    noteId,
  ).map((r) => {
    let tags: string[] = [];
    try {
      tags = r.prev_tags ? (JSON.parse(r.prev_tags) as string[]) : [];
    } catch {
      tags = [];
    }
    return { ...r, prev_tags: tags };
  });
}

export interface GlobalNote extends ContactNoteWithAuthor {
  deleted_by_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  chat_id: string;
  session_id: string;
}

/**
 * Estado de seguimiento para filtrar:
 * pending = sin completar · overdue = vencidas · today = vencen hoy ·
 * week = vencen en los próximos 7 días · pinned = importantes pendientes ·
 * done = completadas · all = todas · trash = en la papelera ·
 * derived = derivadas a otra persona y aún sin resolver.
 */
export type NoteStatus = 'pending' | 'overdue' | 'today' | 'week' | 'pinned' | 'done' | 'all' | 'trash' | 'derived';

const TODAY = "date('now','localtime')";

function statusClause(status: NoteStatus): string | null {
  switch (status) {
    case 'pending':
      return 'n.done_at IS NULL';
    case 'overdue':
      return `n.done_at IS NULL AND n.due_at IS NOT NULL AND n.due_at < ${TODAY}`;
    case 'today':
      return `n.done_at IS NULL AND n.due_at = ${TODAY}`;
    case 'week':
      return `n.done_at IS NULL AND n.due_at > ${TODAY} AND n.due_at <= date('now','localtime','+7 day')`;
    case 'pinned':
      return 'n.done_at IS NULL AND n.pinned = 1';
    case 'derived':
      return `n.done_at IS NULL AND (n.assigned_to IS NOT NULL OR EXISTS (
        SELECT 1 FROM contact_note_assignees na WHERE na.note_id = n.id))`;
    case 'done':
      return 'n.done_at IS NOT NULL';
    default:
      return null;
  }
}

/**
 * Condición de alcance: `null` = sin restricción; `[]` = no ve ninguna sesión.
 * Incluye las notas de otras líneas sobre personas que también tienen ficha en
 * las sesiones del usuario (el detalle es de la persona, no del número).
 */
function scopeClause(
  sessionIds: string[] | null | undefined,
  where: string[],
  params: unknown[],
  viewerId: number | null = null,
): boolean {
  if (sessionIds === null || sessionIds === undefined) return true;
  // Las tareas asignadas al usuario se ven siempre, sean de la línea que sean.
  const mine = viewerId ? ` OR ${assignedToUserClause('n')}` : '';
  if (!sessionIds.length) {
    if (!viewerId) return false;
    where.push(assignedToUserClause('n'));
    params.push(viewerId, viewerId);
    return true;
  }
  const inList = sessionIds.map(() => '?').join(',');
  where.push(`(ct.session_id IN (${inList}) OR (ct.phone_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM contacts o WHERE o.phone_key = ct.phone_key AND o.session_id IN (${inList})))${mine})`);
  params.push(...sessionIds, ...sessionIds);
  if (viewerId) params.push(viewerId, viewerId);
  return true;
}

/** Área de la nota: la de su responsable principal (o de la primera derivada) o la de quien la registró. */
const NOTE_AREA_SQL = `LOWER(COALESCE(
  (SELECT ua.esam_area FROM users ua WHERE ua.id = n.assigned_to),
  (SELECT ua2.esam_area FROM contact_note_assignees na
     JOIN users ua2 ON ua2.id = na.user_id
    WHERE na.note_id = n.id AND NULLIF(ua2.esam_area, '') IS NOT NULL
    ORDER BY na.created_at, na.user_id LIMIT 1),
  (SELECT uu.esam_area FROM users uu WHERE uu.id = n.user_id), ''))`;

/**
 * Restringe a las notas de un usuario: autor, quien derivó o responsable. Con
 * `alsoArea`, además todas las notas de esa área (supervisión por área, p. ej.
 * la gerencia y la supervisión de marketing ven todo marketing).
 */
function ownerClause(ownerId: number | null | undefined, where: string[], params: unknown[], alsoArea?: string | null): void {
  if (!ownerId) return;
  if (alsoArea) {
    where.push(`(n.user_id = ? OR ${assignedToUserClause('n')} OR n.assigned_by = ? OR ${NOTE_AREA_SQL} = ?)`);
    params.push(ownerId, ownerId, ownerId, ownerId, alsoArea);
    return;
  }
  where.push(`(n.user_id = ? OR ${assignedToUserClause('n')} OR n.assigned_by = ?)`);
  params.push(ownerId, ownerId, ownerId, ownerId);
}

/** ¿La nota es de esta área? (para dar acceso a la supervisión del área). */
export function noteInArea(noteId: number, area: string): boolean {
  return !!get<{ id: number }>(`SELECT n.id FROM contact_notes n WHERE n.id = ? AND ${NOTE_AREA_SQL} = ?`, noteId, area);
}

/** Lista global de notas, con filtros, orden y alcance por sesiones del usuario. */
export function listAllNotes(opts: {
  tagId?: number | null;
  status?: NoteStatus;
  q?: string | null;
  /** Solo notas de este autor. */
  authorId?: number | null;
  /** `null` = todas las sesiones (admin local); `[]` = ninguna. */
  sessionIds?: string[] | null;
  /** Quién consulta: ve además las tareas que tiene asignadas. */
  viewerId?: number | null;
  /** Solo tareas asignadas a este usuario. */
  assignedTo?: number | null;
  /** Solo estas notas (p. ej. la de una notificación). */
  ids?: number[];
  /** Solo las notas de este usuario: escritas, derivadas por él o derivadas a él. */
  ownerId?: number | null;
  /** Con `ownerId`: además, todas las notas de esta área (supervisión). */
  ownerArea?: string | null;
  orderBy?: 'created' | 'due';
  limit?: number;
} = {}): GlobalNote[] {
  const where: string[] = [];
  const params: unknown[] = [];
  // Quien consulta sus tareas asignadas las ve aunque el alcance de sesiones
  // esté vacío (p. ej. una línea propia sin conversaciones todavía).
  if (!scopeClause(opts.sessionIds, where, params, opts.viewerId ?? opts.assignedTo ?? null)) return [];
  ownerClause(opts.ownerId, where, params, opts.ownerArea);
  if (opts.assignedTo) {
    where.push(assignedToUserClause('n'));
    params.push(opts.assignedTo, opts.assignedTo);
  }
  if (opts.ids?.length) {
    where.push(`n.id IN (${opts.ids.map(() => '?').join(',')})`);
    params.push(...opts.ids);
  }
  if (opts.tagId) {
    where.push('EXISTS (SELECT 1 FROM contact_note_tags nt WHERE nt.note_id = n.id AND nt.tag_id = ?)');
    params.push(opts.tagId);
  }
  const status = opts.status ?? 'all';
  where.push(status === 'trash' ? 'n.deleted_at IS NOT NULL' : 'n.deleted_at IS NULL');
  const st = statusClause(status);
  if (st) where.push(st);
  if (opts.authorId) {
    where.push('n.user_id = ?');
    params.push(opts.authorId);
  }
  if (opts.q) {
    // Sin acentos ni mayúsculas; también por responsable y etiqueta. `%` y `_`
    // del texto buscado se toman literales.
    const like = `%${foldText(opts.q).replace(/[!%_]/g, (c) => '!' + c)}%`;
    const f = (col: string) => `fold(${col}) LIKE ? ESCAPE '!'`;
    where.push(`(${f("COALESCE(n.note_text,'')")} OR ${f("COALESCE(ct.name,'')")} OR ${f("COALESCE(ct.phone,'')")}
      OR ${f('ct.chat_id')} OR ${f("COALESCE(a.name,'')")}
      OR EXISTS (SELECT 1 FROM contact_note_assignees qa JOIN users qau ON qau.id = qa.user_id
                  WHERE qa.note_id = n.id AND ${f('qau.name')})
      OR EXISTS (SELECT 1 FROM contact_note_tags qt JOIN note_tags t ON t.id = qt.tag_id
                  WHERE qt.note_id = n.id AND ${f('t.name')}))`);
    params.push(like, like, like, like, like, like, like);
  }

  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  // Por fecha límite: pendientes con fecha (vencidas primero), luego sin fecha,
  // luego completadas. Por registro: la más nueva primero.
  const order = status === 'trash'
    ? 'ORDER BY n.deleted_at DESC, n.id DESC'
    : opts.orderBy === 'due'
      ? `ORDER BY ${FOLLOWUP_ORDER}`
      : 'ORDER BY n.created_at DESC, n.id DESC';
  const rows = all<GlobalNote>(
    `SELECT n.*, u.name AS author_name, d.name AS done_by_name, x.name AS deleted_by_name, a.name AS assigned_name,
            a.esam_area AS assigned_area, u.esam_area AS author_area, ab.name AS assigned_by_name, cb.name AS contacted_by_name,
            COALESCE(
              (SELECT pn.full_name FROM person_names pn WHERE pn.phone_key = COALESCE(ct.phone_key, ct.chat_id)),
              (SELECT pp.full_name FROM person_programs pp WHERE pp.phone_key = ct.phone_key AND pp.full_name IS NOT NULL
                ORDER BY pp.last_at DESC LIMIT 1),
              ct.name) AS contact_name, ct.phone AS contact_phone, ct.chat_id AS chat_id, ct.session_id AS session_id,
            s.name AS session_name, COALESCE(s.phone, s.expected_phone) AS session_phone
       FROM contact_notes n
       LEFT JOIN users u ON u.id = n.user_id
       LEFT JOIN users d ON d.id = n.done_by
       LEFT JOIN users x ON x.id = n.deleted_by
       LEFT JOIN users a ON a.id = n.assigned_to
       LEFT JOIN users ab ON ab.id = n.assigned_by
       LEFT JOIN users cb ON cb.id = n.contacted_by
       JOIN contacts ct ON ct.id = n.contact_id
       LEFT JOIN sessions s ON s.id = ct.session_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ${order}
      LIMIT ?`,
    ...params,
    limit,
  );
  return withTags(rows);
}

export interface NoteStats {
  pending: number;
  overdue: number;
  today: number;
  week: number;
  pinned: number;
  done: number;
  all: number;
  trash: number;
  derived: number;
  /** Derivadas que el responsable todavía no abrió. */
  derived_unseen: number;
  /** Derivadas vistas pero sin confirmación de contacto. */
  derived_no_contact: number;
  /** Derivadas con contacto confirmado (sin resolver aún). */
  derived_contacted: number;
}

/** Conteos por estado de seguimiento (para los indicadores de /notes). */
export function noteStats(opts: {
  sessionIds?: string[] | null;
  authorId?: number | null;
  viewerId?: number | null;
  assignedTo?: number | null;
  ownerId?: number | null;
  ownerArea?: string | null;
} = {}): NoteStats {
  const where: string[] = [];
  const params: unknown[] = [];
  const empty: NoteStats = {
    pending: 0, overdue: 0, today: 0, week: 0, pinned: 0, done: 0, all: 0, trash: 0,
    derived: 0, derived_unseen: 0, derived_no_contact: 0, derived_contacted: 0,
  };
  if (!scopeClause(opts.sessionIds, where, params, opts.viewerId ?? opts.assignedTo ?? null)) return empty;
  ownerClause(opts.ownerId, where, params, opts.ownerArea);
  if (opts.assignedTo) {
    where.push(assignedToUserClause('n'));
    params.push(opts.assignedTo, opts.assignedTo);
  }
  if (opts.authorId) {
    where.push('n.user_id = ?');
    params.push(opts.authorId);
  }
  const sum = (status: NoteStatus) =>
    `SUM(CASE WHEN n.deleted_at IS NULL${statusClause(status) ? ` AND ${statusClause(status)}` : ''} THEN 1 ELSE 0 END)`;
  const derived = '(n.assigned_to IS NOT NULL OR EXISTS (SELECT 1 FROM contact_note_assignees dna WHERE dna.note_id = n.id))';
  const row = get<Record<keyof NoteStats, number | null>>(
    `SELECT ${sum('pending')} AS pending, ${sum('overdue')} AS overdue, ${sum('today')} AS today,
            ${sum('week')} AS week, ${sum('pinned')} AS pinned, ${sum('done')} AS done, ${sum('all')} AS "all",
            SUM(CASE WHEN n.deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trash,
            ${sum('derived')} AS derived,
            SUM(CASE WHEN n.deleted_at IS NULL AND n.done_at IS NULL AND ${derived} AND n.seen_at IS NULL AND n.contacted_at IS NULL THEN 1 ELSE 0 END) AS derived_unseen,
            SUM(CASE WHEN n.deleted_at IS NULL AND n.done_at IS NULL AND ${derived} AND n.seen_at IS NOT NULL AND n.contacted_at IS NULL THEN 1 ELSE 0 END) AS derived_no_contact,
            SUM(CASE WHEN n.deleted_at IS NULL AND n.done_at IS NULL AND ${derived} AND n.contacted_at IS NOT NULL THEN 1 ELSE 0 END) AS derived_contacted
       FROM contact_notes n JOIN contacts ct ON ct.id = n.contact_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    ...params,
  );
  return {
    pending: Number(row?.pending ?? 0),
    overdue: Number(row?.overdue ?? 0),
    today: Number(row?.today ?? 0),
    week: Number(row?.week ?? 0),
    pinned: Number(row?.pinned ?? 0),
    done: Number(row?.done ?? 0),
    all: Number(row?.all ?? 0),
    trash: Number(row?.trash ?? 0),
    derived: Number(row?.derived ?? 0),
    derived_unseen: Number(row?.derived_unseen ?? 0),
    derived_no_contact: Number(row?.derived_no_contact ?? 0),
    derived_contacted: Number(row?.derived_contacted ?? 0),
  };
}
