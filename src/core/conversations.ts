import fs from 'node:fs';
import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { sessionScopeFor, type UserRow } from '../auth/users.js';
import { phoneFromChatId } from './phone.js';
import { resolveChatId } from './lid.js';
import { noteCountsFor, type PersonNoteCounts } from './contacts.js';
import { personTagsByKeys, phoneKeyOf, type PersonTags } from './person.js';
import { teamTagFor, type TeamTag } from './team.js';
import type { ConversationRow, MessageRow } from '../types.js';

/**
 * Consultas y mutaciones del inbox. Toda funcion recibe la fila de usuario para
 * aplicar el alcance: un admin ve las conversaciones de las sesiones de su
 * alcance (o todas si es local); un agente no-admin ve solo las asignadas a el.
 */

/** Se excluyen estados y canales del inbox (los grupos sí se incluyen). */
export function inboxWhere(alias = 'c'): string {
  return `${alias}.chat_id NOT LIKE '%@broadcast' AND ${alias}.chat_id NOT LIKE '%@newsletter'`;
}

export const INBOX_WHERE = inboxWhere('c');

export interface ConversationDTO {
  id: number;
  session_id: string;
  chat_id: string;
  status: string;
  unread_count: number;
  last_message_text: string | null;
  last_message_at: string | null;
  last_direction: string | null;
  /** Programa del último envío masivo (también en grupos, donde no hay persona). */
  programa: string | null;
  contact: {
    id: number | null;
    /** Hay foto de perfil (propia o de la misma persona en otra línea). */
    avatar: boolean;
    name: string | null;
    phone: string | null;
    email: string | null;
    company: string | null;
    avatar_path: string | null;
  };
  assigned_agent: { id: number; name: string | null } | null;
  /** Notas pendientes de la persona (sumando todas las líneas). */
  notes: PersonNoteCounts;
  /** Nombre completo y programas según cronogramas (de cualquier línea). */
  person: PersonTags;
  /** El contacto es un compañero (usuario del sistema): su nombre y área. */
  team: TeamTag | null;
}

export interface MessageDTO {
  id: number;
  /** wamid de WhatsApp (para citar/responder). */
  wa_message_id: string | null;
  direction: string;
  content_type: string;
  body: string | null;
  media_path: string | null;
  media_mime: string | null;
  media_filename: string | null;
  media_seconds: number | null;
  /**
   * Estado del adjunto: 'ok' (archivo en disco), 'pending' (se baja de WhatsApp
   * al abrirlo), 'unfetched' (guardado sin referencia: se recupera desde el
   * teléfono al pulsar Descargar), 'missing' (ya no está disponible) o null.
   */
  media_status: 'ok' | 'pending' | 'unfetched' | 'missing' | null;
  transcription: string | null;
  status: string;
  occurred_at: string;
  sender_type: string | null;
  sender: { id: number; name: string | null } | null;
  /** Chat grupal (`@g.us`). */
  is_group: boolean;
  /** Nombre del autor del mensaje (participante en grupos). */
  sender_name: string | null;
  /** Chat del autor (para abrir su conversación desde un grupo). */
  sender_chat_id: string | null;
  sender_phone: string | null;
  reply_to: {
    id: number | null;
    wa_message_id: string;
    body: string | null;
    content_type: string;
    /** El mensaje citado es nuestro (agente / teléfono de la línea). */
    from_me: boolean;
    /** Contacto autor del mensaje citado (para mostrar/abrir en grupos). */
    sender_name: string | null;
    sender_phone: string | null;
    sender_chat_id: string | null;
  } | null;
  /** Reacciones: emoji + quién la puso (nombre y número para mostrar en el chat). */
  reactions: Array<{
    emoji: string;
    actor_type: string;
    actor_id: string | null;
    /** Nombre legible de quien reaccionó ('' si no se sabe). */
    name: string;
    /** Número de WhatsApp de quien reaccionó (null si no se conoce). */
    phone: string | null;
  }>;
}

interface Scope {
  sql: string;
  params: unknown[];
}

/**
 * Condicion SQL de alcance por usuario. Devuelve `null` cuando el usuario es
 * admin sin restriccion de sesiones (ve todo). `alias` es el alias de la tabla
 * de conversaciones en la consulta. El acceso se limita a las sesiones/números
 * del usuario (no hay asignación por agente en este proyecto).
 */
function scopeClause(user: UserRow, alias = 'c'): Scope | null {
  const scope = sessionScopeFor(user);
  if (scope === null) return null;
  const ids = scope.length ? scope.map(() => '?').join(',') : 'NULL';
  return { sql: `${alias}.session_id IN (${ids})`, params: [...scope] };
}

export function getConversation(sessionId: string, chatId: string): ConversationRow | undefined {
  return get<ConversationRow>(
    'SELECT * FROM conversations WHERE session_id = ? AND chat_id = ?',
    sessionId,
    chatId,
  );
}

/** Autoriza el acceso de un usuario a una conversacion (por sesión/número). */
export function canAccessConversation(user: UserRow, conv: ConversationRow): boolean {
  const scope = sessionScopeFor(user);
  if (scope === null) return true;
  return scope.includes(conv.session_id);
}

interface ConvJoinRow {
  id: number;
  session_id: string;
  chat_id: string;
  status: string;
  unread_count: number;
  last_message_text: string | null;
  last_message_at: string | null;
  last_direction: string | null;
  programa: string | null;
  contact_id: number | null;
  ct_name: string | null;
  ct_phone: string | null;
  ct_email: string | null;
  ct_company: string | null;
  ct_avatar: string | null;
  ct_phone_key: string | null;
  agent_id: number | null;
  agent_name: string | null;
}

const NO_NOTES: PersonNoteCounts = { open: 0, pinned: 0, overdue: 0 };

const NO_PERSON: PersonTags = { full_name: null, programas: [] };

/** Clave de la persona: la de su ficha o, si falta, la del número del chat. */
function personKey(row: { ct_phone_key: string | null; chat_id: string }): string | null {
  if (row.chat_id.endsWith('@g.us')) return null;
  // Número oculto (@lid): la clave es el propio identificador (permite registrar su nombre).
  return row.ct_phone_key ?? (row.chat_id.endsWith('@lid') ? row.chat_id : phoneKeyOf(row.chat_id));
}

function mapConversation(
  row: ConvJoinRow,
  notes?: Map<number, PersonNoteCounts>,
  people?: Map<string, PersonTags>,
  avatars?: Set<string>,
): ConversationDTO {
  return {
    id: row.id,
    session_id: row.session_id,
    chat_id: row.chat_id,
    status: row.status,
    unread_count: Number(row.unread_count ?? 0),
    last_message_text: row.last_message_text,
    last_message_at: row.last_message_at,
    last_direction: row.last_direction,
    programa: row.programa,
    contact: {
      id: row.contact_id,
      avatar: !!row.contact_id && (!!row.ct_avatar || (!!personKey(row) && !!avatars?.has(personKey(row)!))),
      name: row.ct_name,
      phone: row.ct_phone,
      email: row.ct_email,
      company: row.ct_company,
      avatar_path: row.ct_avatar,
    },
    assigned_agent: row.agent_id ? { id: row.agent_id, name: row.agent_name } : null,
    notes: (row.contact_id && notes?.get(row.contact_id)) || NO_NOTES,
    person: people?.get(personKey(row) ?? '') ?? NO_PERSON,
    team: teamTagFor(personKey(row)),
  };
}

function mapConversations(rows: ConvJoinRow[]): ConversationDTO[] {
  const notes = noteCountsFor(rows.map((r) => r.contact_id ?? 0));
  const keys = [...new Set(rows.map(personKey).filter((k): k is string => !!k))];
  const people = personTagsByKeys(keys);
  // Personas con foto en alguna línea (la foto se sirve desde la que la tenga).
  const avatars = new Set(
    keys.length
      ? all<{ phone_key: string }>(
          `SELECT DISTINCT phone_key FROM contacts WHERE avatar_path IS NOT NULL AND phone_key IN (${keys.map(() => '?').join(',')})`,
          ...keys,
        ).map((r) => r.phone_key)
      : [],
  );
  return rows.map((r) => mapConversation(r, notes, people, avatars));
}

const CONV_SELECT = `SELECT c.id, c.session_id, c.chat_id, c.status, c.unread_count, c.last_message_text,
    c.last_message_at, c.last_direction, c.programa, c.contact_id,
    ct.name AS ct_name, ct.phone AS ct_phone, ct.email AS ct_email, ct.company AS ct_company,
    ct.avatar_path AS ct_avatar, ct.phone_key AS ct_phone_key,
    u.id AS agent_id, u.name AS agent_name
  FROM conversations c
  LEFT JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN users u ON u.id = c.assigned_agent_id`;

/**
 * Conversación de un chat dentro del alcance del usuario, tolerando otro
 * formato del número (@c.us, @s.whatsapp.net, @lid ya unido) o la misma
 * persona en otra de sus líneas. Para abrir un chat desde un enlace.
 */
export function findConversationForUser(user: UserRow, chatParam: string): ConversationDTO | undefined {
  const chat = chatParam.trim();
  if (!chat) return undefined;
  const key = chat.endsWith('@g.us') ? null : phoneKeyOf(chat);
  const where: string[] = [INBOX_WHERE];
  const params: unknown[] = [];
  const scope = scopeClause(user);
  if (scope) {
    where.push(scope.sql);
    params.push(...scope.params);
  }
  where.push(key ? '(c.chat_id = ? OR ct.phone_key = ?)' : 'c.chat_id = ?');
  params.push(chat, ...(key ? [key] : []));
  const row = get<ConvJoinRow>(
    `${CONV_SELECT} WHERE ${where.join(' AND ')}
     ORDER BY (c.chat_id = ?) DESC, COALESCE(c.last_message_at, c.updated_at) DESC LIMIT 1`,
    ...params,
    chat,
  );
  return row ? mapConversations([row])[0] : undefined;
}

/** ¿El mensaje pertenece a ese chat de esa línea? (para enlazar una nota a su mensaje). */
export function messageInChat(messageId: number, sessionId: string, chatId: string): boolean {
  return !!get('SELECT 1 FROM messages WHERE id = ? AND session_id = ? AND chat_id = ?', messageId, sessionId, chatId);
}

/** DTO de una conversacion puntual (con contacto y agente). */
export function conversationDTO(sessionId: string, chatId: string): ConversationDTO | undefined {
  const row = get<ConvJoinRow>(
    `${CONV_SELECT} WHERE c.session_id = ? AND c.chat_id = ?`,
    sessionId,
    chatId,
  );
  return row ? mapConversations([row])[0] : undefined;
}

/** Lista de conversaciones del alcance del usuario, filtrable por estado y texto. */
export function listConversations(
  user: UserRow,
  opts: { status?: string | null; q?: string | null; limit?: number } = {},
): ConversationDTO[] {
  const where: string[] = [INBOX_WHERE];
  const params: unknown[] = [];

  const scope = scopeClause(user);
  if (scope) {
    where.push(scope.sql);
    params.push(...scope.params);
  }
  if (opts.status && ['open', 'pending', 'closed'].includes(opts.status)) {
    where.push('c.status = ?');
    params.push(opts.status);
  }
  if (opts.q) {
    where.push(
      "(COALESCE(ct.name, c.contact_name, '') LIKE ? OR c.chat_id LIKE ? OR COALESCE(c.last_message_text, '') LIKE ?)",
    );
    const like = `%${opts.q}%`;
    params.push(like, like, like);
  }

  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 500);
  const rows = all<ConvJoinRow>(
    `${CONV_SELECT} WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC LIMIT ${limit}`,
    ...params,
  );
  return mapConversations(rows);
}

function messageReactions(messageIds: number[], sessionId: string): Map<number, MessageDTO['reactions']> {
  const map = new Map<number, MessageDTO['reactions']>();
  if (!messageIds.length) return map;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = all<{ message_id: number; emoji: string; actor_type: string; actor_id: string | null }>(
    `SELECT message_id, emoji, actor_type, actor_id FROM message_reactions WHERE message_id IN (${placeholders})`,
    ...messageIds,
  );
  const cache = new Map<string, { name: string; phone: string | null }>();
  for (const r of rows) {
    const list = map.get(r.message_id) ?? [];
    const actor = reactionActor(sessionId, r.actor_type, r.actor_id, cache);
    list.push({
      emoji: r.emoji,
      actor_type: r.actor_type,
      actor_id: r.actor_id,
      name: actor.name,
      phone: actor.phone,
    });
    map.set(r.message_id, list);
  }
  return map;
}

/**
 * Quién reaccionó: nombre y número. El compañero del sistema (`users`), el
 * nombre de la ficha, el registrado a mano para esa persona en cualquier línea
 * o su número de WhatsApp. En reacciones guardadas antes de 2026-10-18 en un
 * grupo queda el JID del grupo (WhatsApp solo informa quién reacciona en vivo)
 * y no se puede saber: se devuelve vacío y el panel muestra "Participante".
 */
function reactionActor(
  sessionId: string,
  actorType: string,
  actorId: string | null,
  cache: Map<string, { name: string; phone: string | null }>,
): { name: string; phone: string | null } {
  const id = String(actorId ?? '').trim();
  const key = `${actorType}|${id}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let out: { name: string; phone: string | null };
  if (actorType === 'agent') {
    if (!id) {
      out = { name: 'Tu teléfono', phone: null };
    } else {
      const user = get<{ name: string | null }>('SELECT name FROM users WHERE id = ?', Number(id) || -1);
      out = { name: user?.name || 'Agente', phone: null };
    }
  } else if (!id || id.endsWith('@g.us')) {
    out = { name: '', phone: null };
  } else {
    const chat = resolveChatId(id);
    const contact = get<{ name: string | null; phone: string | null }>(
      'SELECT name, phone FROM contacts WHERE session_id = ? AND chat_id = ?',
      sessionId,
      chat,
    );
    const phone = contact?.phone || phoneFromChatId(chat) || null;
    const personKey = phoneKeyOf(phone || chat);
    const tags = personKey ? personTagsByKeys([personKey]).get(personKey) : undefined;
    out = { name: contact?.name || tags?.full_name || '', phone };
  }
  cache.set(key, out);
  return out;
}

interface MessageJoinRow extends MessageRow {
  reply_id: number | null;
  reply_body: string | null;
  reply_type: string | null;
  reply_contact: string | null;
  reply_sender_jid: string | null;
  reply_chat_id: string | null;
  reply_direction: string | null;
  reply_agent: string | null;
  sender_name: string | null;
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

/** Estado del adjunto de un mensaje (se consulta el disco solo para la página visible). */
function mediaStatus(row: MessageRow): MessageDTO['media_status'] {
  if (!MEDIA_TYPES.has(row.content_type)) return row.media_path ? 'ok' : null;
  if (row.media_path && fs.existsSync(row.media_path)) return 'ok';
  if (row.media_state === 'missing') return 'missing';
  return row.media_ref ? 'pending' : 'unfetched';
}

/**
 * Mensaje citado con su autor: si el citado es nuestro, el agente («Tú» si no
 * se sabe); si es de un contacto, su nombre o número (también cuando el
 * original no está guardado, con lo que informó WhatsApp en la respuesta).
 */
function replyRef(row: MessageJoinRow): NonNullable<MessageDTO['reply_to']> {
  const fromUs = row.reply_direction === 'out';
  const jid = row.reply_sender_jid ?? (row.reply_id ? null : row.reply_to_sender ?? null);
  const chat = jid ? resolveChatId(jid) : null;
  return {
    id: row.reply_id,
    wa_message_id: row.reply_to_wa_id!,
    body: row.reply_body ?? row.reply_to_body ?? null,
    content_type: row.reply_type ?? 'text',
    from_me: fromUs,
    sender_name: fromUs ? row.reply_agent || 'Tú' : row.reply_contact,
    sender_phone: !fromUs && chat ? phoneFromChatId(chat) || null : null,
    sender_chat_id: !fromUs && chat && !chat.endsWith('@g.us') ? chat : null,
  };
}

function mapMessage(row: MessageJoinRow, reactions: MessageDTO['reactions']): MessageDTO {
  return {
    id: row.id,
    wa_message_id: row.wa_message_id,
    direction: row.direction,
    content_type: row.content_type,
    body: row.body,
    media_path: row.media_path,
    media_mime: row.media_mime,
    media_filename: row.media_filename,
    media_seconds: row.media_seconds,
    media_status: mediaStatus(row),
    transcription: row.transcription,
    status: row.status,
    occurred_at: row.occurred_at,
    sender_type: row.sender_type ?? (row.direction === 'in' ? 'customer' : 'agent'),
    sender: row.sender_uid ? { id: row.sender_uid, name: row.sender_name } : null,
    is_group: String(row.chat_id ?? '').endsWith('@g.us'),
    sender_name: row.direction === 'in' ? row.contact_name : null,
    sender_chat_id: row.direction === 'in' && row.sender_jid ? resolveChatId(row.sender_jid) : null,
    sender_phone: row.direction === 'in' && row.sender_jid ? phoneFromChatId(resolveChatId(row.sender_jid)) || null : null,
    reply_to: row.reply_to_wa_id ? replyRef(row) : null,
    reactions,
  };
}

const MSG_SELECT = `SELECT m.*, r.id AS reply_id, r.body AS reply_body, r.content_type AS reply_type,
    r.contact_name AS reply_contact, r.sender_jid AS reply_sender_jid, r.chat_id AS reply_chat_id,
    r.direction AS reply_direction, ru.name AS reply_agent,
    u.name AS sender_name
  FROM messages m
  LEFT JOIN messages r ON r.wa_message_id = m.reply_to_wa_id AND r.session_id = m.session_id
  LEFT JOIN users ru ON ru.id = r.sender_uid
  LEFT JOIN users u ON u.id = m.sender_uid`;

export interface MessagePage {
  messages: MessageDTO[];
  /** Hay mensajes anteriores al primero devuelto (para paginar hacia atrás). */
  hasMore: boolean;
}

export interface MessageQuery {
  /** Id mayor visto: devuelve solo los mensajes nuevos (polling incremental). */
  after?: number;
  /** Cursor (fecha + id) del mensaje más antiguo cargado: trae los anteriores. */
  before?: { occurredAt: string; id: number } | null;
  /** Cuántos mensajes traer (5-10 por página). */
  limit?: number;
}

/**
 * Mensajes de un chat ordenados por fecha. Sin cursor devuelve los más recientes
 * (el historial se guarda por bloques, no en orden de inserción). `before` pagina
 * hacia atrás y `after` trae solo los nuevos (polling incremental).
 */
export function listMessages(sessionId: string, chatId: string, query: MessageQuery = {}): MessagePage {
  const limit = Math.min(Math.max(query.limit ?? 10, 1), 100);
  const after = query.after ?? 0;
  let rows: MessageJoinRow[];
  let hasMore = false;

  if (after > 0) {
    rows = all<MessageJoinRow>(
      `${MSG_SELECT} WHERE m.session_id = ? AND m.chat_id = ? AND m.id > ?
       ORDER BY m.occurred_at ASC, m.id ASC LIMIT ?`,
      sessionId,
      chatId,
      after,
      limit,
    );
  } else if (query.before) {
    rows = all<MessageJoinRow>(
      `${MSG_SELECT} WHERE m.session_id = ? AND m.chat_id = ? AND (m.occurred_at, m.id) < (?, ?)
       ORDER BY m.occurred_at DESC, m.id DESC LIMIT ?`,
      sessionId,
      chatId,
      query.before.occurredAt,
      query.before.id,
      limit + 1,
    );
    hasMore = rows.length > limit;
    rows = rows.slice(0, limit).reverse();
  } else {
    rows = all<MessageJoinRow>(
      `${MSG_SELECT} WHERE m.session_id = ? AND m.chat_id = ?
       ORDER BY m.occurred_at DESC, m.id DESC LIMIT ?`,
      sessionId,
      chatId,
      limit + 1,
    );
    hasMore = rows.length > limit;
    rows = rows.slice(0, limit).reverse();
  }

  fillGroupSenderNames(rows);
  const reactions = messageReactions(rows.map((r) => r.id), sessionId);
  return { messages: rows.map((r) => mapMessage(r, reactions.get(r.id) ?? [])), hasMore };
}

/**
 * Mensajes de grupo con autor pero sin nombre (el historial no trae el
 * «pushName»): se toma el último nombre que esa persona usó en cualquier
 * mensaje, su nombre completo de cronogramas o el de su ficha de contacto.
 */
function fillGroupSenderNames(rows: MessageJoinRow[]): void {
  const isGroup = (r: MessageJoinRow) => String(r.chat_id).endsWith('@g.us');
  const missing = rows.filter((r) => r.direction === 'in' && !r.contact_name && r.sender_jid && isGroup(r));
  // Autor del mensaje citado sin nombre (de un contacto, no nuestro).
  const replyJid = (r: MessageJoinRow) => r.reply_sender_jid ?? (r.reply_id ? null : r.reply_to_sender ?? null);
  const missingReply = rows.filter((r) => r.reply_to_wa_id && r.reply_direction !== 'out' && !r.reply_contact && replyJid(r));
  if (!missing.length && !missingReply.length) return;
  const jids = [...new Set([...missing.map((r) => String(r.sender_jid)), ...missingReply.map((r) => String(replyJid(r)))])];
  const ph = jids.map(() => '?').join(',');
  const known = new Map(
    all<{ sender_jid: string; contact_name: string }>(
      `SELECT sender_jid, contact_name FROM messages
        WHERE sender_jid IN (${ph}) AND contact_name IS NOT NULL AND contact_name <> ''
        GROUP BY sender_jid`,
      ...jids,
    ).map((r) => [r.sender_jid, r.contact_name]),
  );
  const keys = [...new Set(jids.map((j) => phoneKeyOf(resolveChatId(j))).filter((k): k is string => !!k))];
  const people = personTagsByKeys(keys);
  const contactNames = new Map(
    keys.length
      ? all<{ phone_key: string; name: string }>(
          `SELECT phone_key, name FROM contacts WHERE phone_key IN (${keys.map(() => '?').join(',')})
            AND name IS NOT NULL AND name <> '' AND chat_id NOT LIKE '%@g.us' GROUP BY phone_key`,
          ...keys,
        ).map((r) => [r.phone_key, r.name])
      : [],
  );
  const nameOf = (jid: string) => {
    const key = phoneKeyOf(resolveChatId(jid)) ?? '';
    return known.get(jid) ?? people.get(key)?.full_name ?? contactNames.get(key) ?? null;
  };
  for (const r of missing) r.contact_name = nameOf(String(r.sender_jid));
  for (const r of missingReply) r.reply_contact = nameOf(String(replyJid(r)));
}

export function getMessageById(id: number): MessageRow | undefined {
  return get<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
}

export type BulkAction = 'close' | 'open' | 'pending' | 'mark_read' | 'assign';

/** Aplica una accion a varias conversaciones del alcance (solo admin). */
export function bulkAction(
  user: UserRow,
  conversationIds: number[],
  action: BulkAction,
  agentId: number | null = null,
): number {
  if (!conversationIds.length) return 0;
  const scope = scopeClause(user, 'conversations');
  const clauses: string[] = [inboxWhere('conversations')];
  const setParams: unknown[] = [];
  let setSql: string;

  switch (action) {
    case 'close':
      setSql = 'status = ?, closed_at = ?, updated_at = ?';
      setParams.push('closed', nowIso(), nowIso());
      break;
    case 'open':
      setSql = 'status = ?, closed_at = NULL, updated_at = ?';
      setParams.push('open', nowIso());
      break;
    case 'pending':
      setSql = 'status = ?, closed_at = NULL, updated_at = ?';
      setParams.push('pending', nowIso());
      break;
    case 'mark_read':
      setSql = 'unread_count = 0, updated_at = ?';
      setParams.push(nowIso());
      break;
    case 'assign':
      setSql = 'assigned_agent_id = ?, updated_at = ?';
      setParams.push(agentId, nowIso());
      break;
  }

  const whereParams: unknown[] = [];
  if (scope) {
    clauses.push(scope.sql);
    whereParams.push(...scope.params);
  }
  const idPlaceholders = conversationIds.map(() => '?').join(',');
  const result = run(
    `UPDATE conversations SET ${setSql} WHERE ${clauses.join(' AND ')} AND id IN (${idPlaceholders})`,
    ...setParams,
    ...whereParams,
    ...conversationIds,
  );
  return result.changes;
}

interface SearchRow {
  message_id: number;
  session_id: string;
  chat_id: string;
  body: string | null;
  sender_type: string | null;
  occurred_at: string;
}

export interface SearchResult {
  conversation: ConversationDTO;
  snippet: string;
  match_count: number;
  match_at: string;
}

function ftsAvailable(): boolean {
  return get<{ value: string }>("SELECT value FROM configs WHERE key = 'fts5'")?.value === '1';
}

/** Construye el termino FTS en modo booleano tolerante a prefijos. */
function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, '').trim())
    .filter((t) => t.length >= 2)
    .map((t) => `"${t}"*`)
    .join(' ');
}

/** Busca en el historial (>=3 letras) y agrupa por conversacion. */
export function searchMessages(user: UserRow, q: string): SearchResult[] {
  const term = (q ?? '').trim();
  if (term.length < 3) return [];

  const scope = scopeClause(user);
  const scopeSql = scope ? ` AND ${scope.sql}` : '';
  const scopeParams = scope?.params ?? [];
  const baseSelect = `SELECT m.id AS message_id, m.session_id, m.chat_id, m.body, m.sender_type, m.occurred_at
       FROM messages m
       JOIN conversations c ON c.session_id = m.session_id AND c.chat_id = m.chat_id`;

  let rows: SearchRow[] = [];
  if (ftsAvailable()) {
    const match = ftsQuery(term);
    if (match) {
      try {
        rows = all<SearchRow>(
          baseSelect.replace('FROM messages m', 'FROM messages_fts f JOIN messages m ON m.id = f.rowid')
            + ` WHERE messages_fts MATCH ?${scopeSql} ORDER BY m.id DESC LIMIT 40`,
          match,
          ...scopeParams,
        );
      } catch {
        rows = [];
      }
    }
  }
  if (!rows.length) {
    const like = `%${term}%`;
    rows = all<SearchRow>(
      `${baseSelect} WHERE (m.body LIKE ? OR m.transcription LIKE ?)${scopeSql} ORDER BY m.id DESC LIMIT 40`,
      like,
      like,
      ...scopeParams,
    );
  }

  const grouped = new Map<string, { row: SearchRow; count: number }>();
  for (const row of rows) {
    const key = `${row.session_id}\u0000${row.chat_id}`;
    const current = grouped.get(key);
    if (current) current.count++;
    else grouped.set(key, { row, count: 1 });
  }

  const out: SearchResult[] = [];
  for (const { row, count } of grouped.values()) {
    const conversation = conversationDTO(row.session_id, row.chat_id);
    if (!conversation) continue;
    out.push({
      conversation,
      snippet: highlightSnippet(row.body ?? '', term),
      match_count: count,
      match_at: row.occurred_at,
    });
  }
  return out;
}

function highlightSnippet(text: string, term: string): string {
  const snippet = text.slice(0, 160);
  return term
    .split(/\s+/)
    .filter(Boolean)
    .reduce((acc, w) => acc.replace(new RegExp(escapeRegExp(w), 'gi'), `«${w}»`), snippet);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Marca como leida (contador local; el acuse real lo hace el manager). */
export function markConversationRead(sessionId: string, chatId: string): void {
  run(
    'UPDATE conversations SET unread_count = 0, updated_at = ? WHERE session_id = ? AND chat_id = ?',
    nowIso(),
    sessionId,
    chatId,
  );
}

/** Registra/actualiza (o quita) la reaccion de un actor a un mensaje. */
export function setReaction(
  messageId: number,
  sessionId: string,
  chatId: string,
  actorType: 'agent' | 'customer',
  actorId: string,
  emoji: string,
): void {
  if (!emoji) {
    run(
      'DELETE FROM message_reactions WHERE message_id = ? AND actor_type = ? AND actor_id = ?',
      messageId,
      actorType,
      actorId,
    );
    return;
  }
  run(
    `INSERT INTO message_reactions (message_id, session_id, chat_id, actor_type, actor_id, emoji, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id, actor_type, actor_id) DO UPDATE SET emoji = excluded.emoji`,
    messageId,
    sessionId,
    chatId,
    actorType,
    actorId,
    emoji,
    nowIso(),
  );
}

/** Reacciones de un mensaje (para devolver el estado tras reaccionar). */
export function reactionsFor(messageId: number, sessionId: string): MessageDTO['reactions'] {
  const cache = new Map<string, { name: string; phone: string | null }>();
  return all<{ emoji: string; actor_type: string; actor_id: string | null }>(
    'SELECT emoji, actor_type, actor_id FROM message_reactions WHERE message_id = ?',
    messageId,
  ).map((r) => {
    const actor = reactionActor(sessionId, r.actor_type, r.actor_id, cache);
    return { emoji: r.emoji, actor_type: r.actor_type, actor_id: r.actor_id, name: actor.name, phone: actor.phone };
  });
}

/**
 * Atribuye un mensaje saliente al agente que lo envio y guarda la cita. Se usa
 * tras `manager.send*`; si no hay `waMessageId` cae al ultimo saliente del chat.
 */
export function tagOutbound(
  sessionId: string,
  chatId: string,
  opts: { waMessageId?: string | null; senderUid?: number | null; replyToWaId?: string | null },
): void {
  const target = opts.waMessageId
    ? get<{ id: number }>('SELECT id FROM messages WHERE wa_message_id = ? LIMIT 1', opts.waMessageId)
    : get<{ id: number }>(
        "SELECT id FROM messages WHERE session_id = ? AND chat_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1",
        sessionId,
        chatId,
      );
  if (!target) return;
  run(
    `UPDATE messages SET sender_type = 'agent', sender_uid = COALESCE(?, sender_uid),
        reply_to_wa_id = COALESCE(?, reply_to_wa_id)
      WHERE id = ?`,
    opts.senderUid ?? null,
    opts.replyToWaId ?? null,
    target.id,
  );
}