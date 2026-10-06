import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
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

export interface ContactNoteWithAuthor extends ContactNoteRow {
  author_name: string | null;
  done_by_name: string | null;
  tags: NoteTagLite[];
}

/** Columnas comunes de una nota con su autor y quién la completó. */
const NOTE_SELECT = `SELECT n.*, u.name AS author_name, d.name AS done_by_name
  FROM contact_notes n
  LEFT JOIN users u ON u.id = n.user_id
  LEFT JOIN users d ON d.id = n.done_by`;

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

function withTags<T extends { id: number }>(rows: T[]): Array<T & { tags: NoteTagLite[] }> {
  const tags = tagsByNote(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, tags: tags.get(r.id) ?? [] }));
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
 * Notas de un contacto, en orden de seguimiento: primero las pendientes con
 * fecha (la más próxima arriba), luego las pendientes sin fecha y al final las
 * completadas (la más reciente arriba).
 */
export function listNotes(contactId: number, limit = 200): ContactNoteWithAuthor[] {
  const rows = all<ContactNoteWithAuthor>(
    `${NOTE_SELECT}
      WHERE n.contact_id = ?
      ORDER BY (n.done_at IS NOT NULL), (n.due_at IS NULL), n.due_at ASC,
               COALESCE(n.done_at, n.created_at) DESC, n.id DESC
      LIMIT ?`,
    contactId,
    limit,
  );
  return withTags(rows);
}

export function getNote(id: number): ContactNoteRow | undefined {
  return get<ContactNoteRow>('SELECT * FROM contact_notes WHERE id = ?', id);
}

/** Sesión a la que pertenece una nota (para validar el alcance del usuario). */
export function noteSessionId(id: number): string | null {
  return (
    get<{ session_id: string }>(
      'SELECT ct.session_id FROM contact_notes n JOIN contacts ct ON ct.id = n.contact_id WHERE n.id = ?',
      id,
    )?.session_id ?? null
  );
}

export function addNote(
  contactId: number,
  userId: number | null,
  noteText: string | null,
  audioPath: string | null,
  dueAt: string | null = null,
  tagIds: number[] = [],
): ContactNoteWithAuthor {
  const created = run(
    `INSERT INTO contact_notes (contact_id, user_id, note_text, audio_path, due_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    contactId,
    userId,
    noteText,
    audioPath,
    dueAt || null,
    nowIso(),
  );
  setNoteTags(created.lastInsertRowid, tagIds);
  return noteDTO(created.lastInsertRowid)!;
}

export function updateNote(
  noteId: number,
  patch: { noteText?: string | null; dueAt?: string | null; tagIds?: number[] },
): void {
  const current = getNote(noteId);
  if (!current) throw new Error('Nota no encontrada.');
  const text = patch.noteText !== undefined ? patch.noteText : current.note_text;
  const due = patch.dueAt !== undefined ? patch.dueAt || null : current.due_at;
  if (!text && !current.audio_path) throw new Error('La nota no puede quedar vacía.');
  run('UPDATE contact_notes SET note_text = ?, due_at = ?, updated_at = ? WHERE id = ?', text, due, nowIso(), noteId);
  if (patch.tagIds) setNoteTags(noteId, patch.tagIds);
}

/** Marca el seguimiento de una nota como completado (o lo reabre). */
export function setNoteDone(noteId: number, userId: number | null, done: boolean): void {
  run(
    'UPDATE contact_notes SET done_at = ?, done_by = ? WHERE id = ?',
    done ? nowIso() : null,
    done ? userId : null,
    noteId,
  );
}

export function deleteNote(id: number): void {
  run('DELETE FROM contact_note_tags WHERE note_id = ?', id);
  run('DELETE FROM contact_notes WHERE id = ?', id);
}

export interface GlobalNote extends ContactNoteWithAuthor {
  contact_name: string | null;
  contact_phone: string | null;
  chat_id: string;
  session_id: string;
}

/**
 * Estado de seguimiento para filtrar:
 * pending = sin completar · overdue = vencidas · today = vencen hoy ·
 * week = vencen en los próximos 7 días · done = completadas · all = todas.
 */
export type NoteStatus = 'pending' | 'overdue' | 'today' | 'week' | 'done' | 'all';

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
    case 'done':
      return 'n.done_at IS NOT NULL';
    default:
      return null;
  }
}

/** Condición de alcance: `null` = sin restricción; `[]` = no ve ninguna sesión. */
function scopeClause(sessionIds: string[] | null | undefined, where: string[], params: unknown[]): boolean {
  if (sessionIds === null || sessionIds === undefined) return true;
  if (!sessionIds.length) return false;
  where.push(`ct.session_id IN (${sessionIds.map(() => '?').join(',')})`);
  params.push(...sessionIds);
  return true;
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
  orderBy?: 'created' | 'due';
  limit?: number;
} = {}): GlobalNote[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!scopeClause(opts.sessionIds, where, params)) return [];
  if (opts.tagId) {
    where.push('EXISTS (SELECT 1 FROM contact_note_tags nt WHERE nt.note_id = n.id AND nt.tag_id = ?)');
    params.push(opts.tagId);
  }
  const st = statusClause(opts.status ?? 'all');
  if (st) where.push(st);
  if (opts.authorId) {
    where.push('n.user_id = ?');
    params.push(opts.authorId);
  }
  if (opts.q) {
    where.push("(COALESCE(n.note_text,'') LIKE ? OR COALESCE(ct.name,'') LIKE ? OR COALESCE(ct.phone,'') LIKE ? OR ct.chat_id LIKE ?)");
    const like = `%${opts.q}%`;
    params.push(like, like, like, like);
  }

  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  // Por fecha límite: pendientes con fecha (vencidas primero), luego sin fecha,
  // luego completadas. Por registro: la más nueva primero.
  const order = opts.orderBy === 'due'
    ? 'ORDER BY (n.done_at IS NOT NULL), (n.due_at IS NULL), n.due_at ASC, n.created_at DESC'
    : 'ORDER BY n.created_at DESC, n.id DESC';
  const rows = all<GlobalNote>(
    `SELECT n.*, u.name AS author_name, d.name AS done_by_name,
            ct.name AS contact_name, ct.phone AS contact_phone, ct.chat_id AS chat_id, ct.session_id AS session_id
       FROM contact_notes n
       LEFT JOIN users u ON u.id = n.user_id
       LEFT JOIN users d ON d.id = n.done_by
       JOIN contacts ct ON ct.id = n.contact_id
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
  done: number;
  all: number;
}

/** Conteos por estado de seguimiento (para los indicadores de /notes). */
export function noteStats(opts: { sessionIds?: string[] | null; authorId?: number | null } = {}): NoteStats {
  const where: string[] = [];
  const params: unknown[] = [];
  const empty: NoteStats = { pending: 0, overdue: 0, today: 0, week: 0, done: 0, all: 0 };
  if (!scopeClause(opts.sessionIds, where, params)) return empty;
  if (opts.authorId) {
    where.push('n.user_id = ?');
    params.push(opts.authorId);
  }
  const sum = (status: NoteStatus) => `SUM(CASE WHEN ${statusClause(status)} THEN 1 ELSE 0 END)`;
  const row = get<Record<keyof NoteStats, number | null>>(
    `SELECT ${sum('pending')} AS pending, ${sum('overdue')} AS overdue, ${sum('today')} AS today,
            ${sum('week')} AS week, ${sum('done')} AS done, COUNT(*) AS "all"
       FROM contact_notes n JOIN contacts ct ON ct.id = n.contact_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    ...params,
  );
  return {
    pending: Number(row?.pending ?? 0),
    overdue: Number(row?.overdue ?? 0),
    today: Number(row?.today ?? 0),
    week: Number(row?.week ?? 0),
    done: Number(row?.done ?? 0),
    all: Number(row?.all ?? 0),
  };
}
