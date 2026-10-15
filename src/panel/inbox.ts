import fs from 'node:fs';
import path from 'node:path';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../logger.js';
import { all, get } from '../db/index.js';
import { panelBus } from './events.js';
import { esamEsAdmin, sessionScopeFor, type UserRow } from '../auth/users.js';
import type { SessionManager } from '../baileys/manager.js';
import * as conversations from '../core/conversations.js';
import {
  addNote,
  deleteNote,
  getNote,
  getOrCreateContact,
  listAllNotes,
  listNoteHistory,
  listNotes,
  markAssignmentSeen,
  markContacted,
  markFromTemplate,
  myDay,
  noteAssignees,
  personLines,
  noteDTO,
  noteStats,
  noteVisibleIn,
  personChatsForNote,
  restoreNote,
  setNoteDone,
  setNotePinned,
  setNoteStage,
  snoozeNote,
  updateNote,
  type NoteStatus,
  type PipelineStage,
} from '../core/contacts.js';
import * as noteTags from '../core/note-tags.js';
import { personTagsByKeys, phoneKeyOf, setPersonName } from '../core/person.js';
import { teamMembers } from '../core/team.js';
import { listNotifications, markNoteRead, markRead, notify, supervisorIds, unreadCount, type NotificationKind } from '../core/notifications.js';
import * as noteTemplates from '../core/note-templates.js';
import * as quickReplies from '../core/quick-replies.js';
import { getSticker } from '../core/stickers.js';
import { storeIncoming, storeNoteAudio } from '../core/media.js';
import { typeForMime } from '../core/phone.js';
import { transcribe } from '../core/transcriber.js';

/**
 * Rutas JSON del inbox (consumidas por `public/app.js`). Se registran desde
 * `panel/server.ts` recibiendo el contexto compartido (auth, rate limit,
 * resolucion de chat y el propio SessionManager).
 */

type AuthedRequest = Request & { user?: UserRow };

export interface InboxContext {
  manager: SessionManager;
  requireUser: RequestHandler;
  requireSection: (section: string) => RequestHandler;
  rateLimit: (max: number, windowMs: number) => RequestHandler;
  resolveChatParam: (sessionId: string, param: string) => { chatId: string; conv: Record<string, unknown> | undefined };
  upload: { single(field: string): RequestHandler };
}

function ah(fn: (req: AuthedRequest, res: Response) => Promise<unknown> | unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as AuthedRequest, res)).catch(next);
  };
}

export function registerInboxRoutes(app: Express, ctx: InboxContext): void {
  const { manager } = ctx;
  const auth = [ctx.requireUser, ctx.requireSection('conversations')];

  /**
   * Valida acceso a la sesion y a la conversacion del usuario. Responde con el
   * `chatId` real (resuelto tolerando @lid/@c.us) o `null` si ya se respondio.
   */
  function resolveAuthorized(
    req: AuthedRequest,
    res: Response,
    sessionId: string,
    chatParam: string,
  ): { chatId: string; session: NonNullable<ReturnType<SessionManager['byId']>> } | null {
    const user = req.user!;
    const scope = sessionScopeFor(user);
    if (scope !== null && !scope.includes(sessionId)) {
      res.status(403).json({ error: 'No tenés acceso a esta sesión.' });
      return null;
    }
    const session = manager.byId(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Sesión de WhatsApp no encontrada.' });
      return null;
    }
    const { chatId, conv } = ctx.resolveChatParam(sessionId, chatParam);
    if (conv && !conversations.canAccessConversation(user, conv as never)) {
      res.status(403).json({ error: 'No tenés acceso a esta conversación.' });
      return null;
    }
    const row = conversations.getConversation(sessionId, chatId);
    if (row && !conversations.canAccessConversation(user, row)) {
      res.status(403).json({ error: 'No tenés acceso a esta conversación.' });
      return null;
    }
    return { chatId, session };
  }

  /** Solo el autor de una nota (o un admin) puede editarla o eliminarla. */
  function canEditNote(user: UserRow, note: { user_id: number | null }): boolean {
    return note.user_id === user.id || esamEsAdmin(user);
  }

  function withPermissions<T extends { user_id: number | null; assigned_to?: number | null }>(
    user: UserRow,
    note: T,
  ): T & { can_edit: boolean; assigned_to_me: boolean } {
    return {
      ...note,
      can_edit: canEditNote(user, note),
      assigned_to_me: !!note.assigned_to && note.assigned_to === user.id,
      supervisor: esamEsAdmin(user),
    };
  }

  /** Responsable válido (usuario habilitado) o null. */
  function parseAssignee(raw: unknown): number | null {
    const id = Number(raw);
    if (!Number.isFinite(id) || id <= 0) return null;
    return noteAssignees().some((u) => u.id === id) ? id : null;
  }

  /**
   * Nota accesible para el usuario: existe y es de una persona que se atiende
   * en alguna sesión de su alcance (aunque se haya registrado desde otra línea).
   * Responde 404/403 y devuelve `null` si no.
   */
  function accessibleNote(
    req: AuthedRequest,
    res: Response,
    opts: { allowDeleted?: boolean } = {},
  ): NonNullable<ReturnType<typeof getNote>> | null {
    const note = getNote(Number(req.params.id));
    if (!note) {
      res.status(404).json({ error: 'Nota no encontrada.' });
      return null;
    }
    if (note.deleted_at && !opts.allowDeleted) {
      res.status(409).json({ error: 'La nota está en la papelera. Restaurala para modificarla.' });
      return null;
    }
    const scope = noteScope(req.user!);
    if (!noteVisibleIn(note.id, scope, req.user!.id)) {
      res.status(403).json({ error: 'No tenés acceso a esta nota.' });
      return null;
    }
    return note;
  }

  /**
   * Avisa en vivo (SSE) a quien tenga abierta a la persona en cualquier línea.
   * No lleva el texto de la nota: solo qué chats deben recargar sus notas.
   */
  function publishNoteChange(noteId: number, action: string, actorId: number | null = null): void {
    const chats = personChatsForNote(noteId);
    const assignedTo = getNote(noteId)?.assigned_to ?? null;
    if (!chats.length && !assignedTo) return;
    panelBus.publish('note', {
      noteId,
      action,
      actorId,
      assignedTo,
      // El responsable recibe el aviso aunque la persona no esté en su línea.
      userIds: assignedTo ? [assignedTo] : [],
      sessionIds: [...new Set(chats.map((c) => c.session_id))],
      chats: chats.map((c) => ({ sessionId: c.session_id, chatId: c.chat_id })),
    });
  }

  /**
   * Alcance de las notas: el Super Admin supervisa las de todas las líneas;
   * el resto, las de sus números (y las de personas en común).
   */
  function noteScope(user: UserRow): string[] | null {
    return esamEsAdmin(user) ? null : sessionScopeFor(user);
  }

  /**
   * Avisa (campana) los hechos de una nota: al Super Admin, todo lo que registra
   * el equipo; al responsable, lo que le derivan; a quien derivó, el contacto y
   * la resolución. El enlace abre la nota en Notas y tareas.
   */
  function announce(
    noteId: number,
    event: 'created' | 'reassigned' | 'contacted' | 'resolved',
    actor: UserRow,
    extra: { templateName?: string; count?: number } = {},
  ): void {
    const n = listAllNotes({ ids: [noteId], sessionIds: null, status: 'all', limit: 1 })[0];
    if (!n) return;
    const who = actor.name ?? actor.username ?? 'Alguien';
    const contact = n.contact_name || (n.contact_phone ? `+${n.contact_phone}` : n.chat_id.split('@')[0]);
    const phone = n.contact_phone ? `+${n.contact_phone}` : '';
    const text = (n.note_text ?? 'Nota de voz').replace(/\s+/g, ' ').slice(0, 160);
    const link = `/notes?nota=${noteId}`;
    const kindLabel = extra.templateName ? `aplicó la plantilla «${extra.templateName}» (${extra.count} tareas)` : n.due_at ? 'registró una tarea' : 'registró una nota';
    const supervisors = supervisorIds();
    const send = (ids: Array<number | null>, kind: NotificationKind, title: string, body: string) =>
      notify(ids, { kind, noteId, actorId: actor.id, title, body, link });

    if (event === 'created' || event === 'reassigned') {
      if (n.assigned_to && n.assigned_to !== actor.id) {
        send([n.assigned_to], 'derived_to_you', `${who} te derivó a ${contact}`, `${phone ? `${phone} · ` : ''}${text}`);
        send(supervisors.filter((id) => id !== n.assigned_to), 'derived', `${who} derivó a ${contact} con ${n.assigned_name ?? 'otra persona'}`, text);
      } else if (event === 'created') {
        send(supervisors, 'note_created', `${who} ${kindLabel} · ${contact}`, text);
      }
    } else if (event === 'contacted') {
      send([n.assigned_by, n.user_id, ...supervisors], 'contacted', `${who} se comunicó con ${contact}`, n.contact_result ?? 'Contacto confirmado.');
    } else if (event === 'resolved') {
      send([n.assigned_by, n.user_id, ...supervisors], 'resolved', `${who} resolvió la tarea de ${contact}`, text);
    }
  }

  /** `tag_ids` puede llegar como arreglo (JSON) o como texto JSON (multipart). */
  function parseTagIds(raw: unknown): number[] {
    try {
      const list = typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : []) : raw;
      return Array.isArray(list) ? list.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
    } catch {
      return [];
    }
  }

  /** Bandera booleana que puede llegar como JSON (true) o multipart ('1'/'true'). */
  function parseFlag(raw: unknown): boolean {
    return raw === true || raw === 1 || raw === '1' || raw === 'true';
  }

  /** Hora válida (HH:MM) o null. */
  function parseTime(raw: unknown): string | null {
    const value = String(raw ?? '').trim();
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
  }

  /** Fecha local AAAA-MM-DD (misma zona que `date('now','localtime')` de SQLite). */
  function localYmd(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** Fecha límite válida (AAAA-MM-DD) o null. */
  function parseDue(raw: unknown): string | null {
    const value = String(raw ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  }

  // ── Lectura ────────────────────────────────────────────────────────────────

  app.get(
    '/inbox/conversations',
    ...auth,
    ah((req, res) => {
      const status = typeof req.query.status === 'string' ? req.query.status : null;
      const q = typeof req.query.q === 'string' ? req.query.q : null;
      res.json(conversations.listConversations(req.user!, { status, q }));
    }),
  );

  app.get(
    '/inbox/search',
    ...auth,
    ah((req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      res.json(conversations.searchMessages(req.user!, q));
    }),
  );

  app.get(
    '/inbox/quick-replies',
    ...auth,
    ah((req, res) => {
      res.json(quickReplies.listQuickReplies(req.user!.id));
    }),
  );

  // Equipo: compañeros con número, siempre a mano para iniciar o seguir la
  // conversación desde la línea del usuario.
  app.get(
    '/inbox/team',
    ...auth,
    ah((req, res) => {
      const me = req.user!;
      const members = teamMembers()
        .filter((m) => m.user_id !== me.id)
        .map((m) => {
          let conv: ReturnType<typeof conversations.findConversationForUser>;
          for (const k of m.keys) {
            conv = conversations.findConversationForUser(me, k);
            if (conv) break;
          }
          return {
            user_id: m.user_id,
            name: m.name,
            area: m.area,
            phone: m.phone,
            line_ready: m.line_ready,
            conversation: conv ?? null,
          };
        });
      res.json({ members });
    }),
  );

  // Abre un chat desde un enlace (p. ej. desde Notas y tareas): busca la
  // conversación del número en las líneas del usuario.
  app.get(
    '/inbox/find',
    ...auth,
    ah((req, res) => {
      const chat = typeof req.query.chat === 'string' ? req.query.chat : '';
      res.json({ conversation: conversations.findConversationForUser(req.user!, chat) ?? null });
    }),
  );

  // Foto de perfil de un contacto (o de la misma persona en otra línea).
  app.get(
    '/inbox/avatar/:contactId',
    ...auth,
    ah((req, res) => {
      const contact = get<{ id: number; session_id: string; phone_key: string | null; avatar_path: string | null }>(
        'SELECT id, session_id, phone_key, avatar_path FROM contacts WHERE id = ?',
        Number(req.params.contactId),
      );
      if (!contact) return res.status(404).end();
      const scope = esamEsAdmin(req.user!) ? null : sessionScopeFor(req.user!);
      if (scope !== null && !scope.includes(contact.session_id)) return res.status(403).end();
      let file = contact.avatar_path && fs.existsSync(contact.avatar_path) ? contact.avatar_path : null;
      if (!file && contact.phone_key) {
        const others = all<{ avatar_path: string }>(
          'SELECT avatar_path FROM contacts WHERE phone_key = ? AND avatar_path IS NOT NULL ORDER BY updated_at DESC',
          contact.phone_key,
        );
        file = others.map((o) => o.avatar_path).find((p) => fs.existsSync(p)) ?? null;
      }
      if (!file) return res.status(404).end();
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.sendFile(path.resolve(file));
    }),
  );

  // Foto de perfil de quien escribe en un grupo (se pide a WhatsApp una vez y se guarda).
  app.get(
    '/inbox/participant-avatar/:session/:jid',
    ...auth,
    ah(async (req, res) => {
      const sessionId = String(req.params.session);
      const scope = esamEsAdmin(req.user!) ? null : sessionScopeFor(req.user!);
      if (scope !== null && !scope.includes(sessionId)) return res.status(403).end();
      let file: string | null = null;
      try {
        file = await Promise.race([
          manager.participantAvatar(sessionId, String(req.params.jid)),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
        ]);
      } catch {
        file = null;
      }
      if (!file) {
        // Sin foto (o privada): el navegador no reintenta en la próxima hora.
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.status(404).end();
      }
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.sendFile(path.resolve(file));
    }),
  );

  app.get(
    '/inbox/sessions',
    ...auth,
    ah((req, res) => {
      const user = req.user!;
      const scope = sessionScopeFor(user);
      const sessions = manager
        .list()
        .filter((s) => scope === null || scope.includes(s.id))
        .map((s) => ({ id: s.id, name: s.name, phone: s.phone, expected_phone: s.expected_phone }));
      res.json({ sessions });
    }),
  );

  app.get(
    '/inbox/:session/:chat/messages',
    ...auth,
    ah((req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      const after = Number(req.query.after ?? 0) || 0;
      const limit = Number(req.query.limit ?? 10) || 10;
      let before: { occurredAt: string; id: number } | null = null;
      if (typeof req.query.before === 'string' && req.query.before) {
        const [occurredAt, idRaw] = req.query.before.split('|');
        const id = Number(idRaw);
        if (occurredAt && Number.isFinite(id)) before = { occurredAt, id };
      }
      const page = conversations.listMessages(resolved.session.id, resolved.chatId, { after, before, limit });
      res.json({ chatId: resolved.chatId, messages: page.messages, hasMore: page.hasMore });
    }),
  );

  app.get(
    '/inbox/:session/:chat/participants',
    ...auth,
    ah(async (req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      if (!resolved.chatId.endsWith('@g.us')) return res.json([]);
      try {
        res.json(await manager.groupParticipants(resolved.session.id, resolved.chatId));
      } catch (err) {
        res.status(502).json({ error: (err as Error).message });
      }
    }),
  );

  app.post(
    '/inbox/:session/:chat/avatar',
    ...auth,
    ah((req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      manager.ensureAvatar(resolved.session.id, resolved.chatId);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/inbox/:session/:chat/notes',
    ...auth,
    ah((req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      const contact = getOrCreateContact(resolved.session.id, resolved.chatId);
      res.json(listNotes(contact.id).map((n) => withPermissions(req.user!, n)));
    }),
  );

  // La persona en todas las líneas: datos de su ficha y actividad (sin mensajes).
  app.get(
    '/inbox/:session/:chat/person',
    ...auth,
    ah((req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      const contact = getOrCreateContact(resolved.session.id, resolved.chatId);
      const lines = personLines(contact.id);
      const current = lines.find((l) => l.contact_id === contact.id) ?? null;
      const others = lines.filter((l) => l.contact_id !== contact.id);
      // Datos que faltan en esta ficha y se conocen desde otra línea.
      const pick = (key: 'name' | 'email' | 'company' | 'programa') => {
        if (current?.[key]) return null;
        const from = others.find((l) => l[key]);
        return from ? { value: from[key], line: from.session_name || from.session_phone || 'otra línea' } : null;
      };
      const key = contact.phone_key ?? (resolved.chatId.endsWith('@g.us') ? null : resolved.chatId.endsWith('@lid') ? resolved.chatId : phoneKeyOf(resolved.chatId));
      const tags = key ? personTagsByKeys([key]).get(key) : undefined;
      res.json({
        programa: current?.programa ?? tags?.programas[0] ?? null,
        full_name: tags?.full_name ?? null,
        name_source: tags?.name_source ?? null,
        name_by: tags?.name_by ?? null,
        can_name: !!key,
        programas: tags?.programas ?? [],
        lines: others,
        fill: { name: pick('name'), email: pick('email'), company: pick('company'), programa: pick('programa') },
      });
    }),
  );

  // ── Escritura ───────────────────────────────────────────────────────────────

  // Nombre de la persona registrado a mano (contactos que no llegaron desde
  // cronogramas). Se guarda por número: lo ven todas las líneas.
  app.put(
    '/inbox/:session/:chat/name',
    ...auth,
    ah((req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      const contact = getOrCreateContact(resolved.session.id, resolved.chatId);
      const key = contact.phone_key ?? (resolved.chatId.endsWith('@g.us') ? null : resolved.chatId.endsWith('@lid') ? resolved.chatId : phoneKeyOf(resolved.chatId));
      if (!key) return res.status(422).json({ error: 'Este chat no tiene un número al que asociar el nombre.' });
      const name = String(req.body?.name ?? '').trim();
      if (name.length > 120) return res.status(422).json({ error: 'El nombre es demasiado largo (máx. 120 caracteres).' });
      setPersonName(key, name || null, req.user!.id);
      // Refresca a quien tenga a esta persona abierta o en la lista, en cualquier línea.
      const chats = all<{ session_id: string; chat_id: string }>('SELECT session_id, chat_id FROM contacts WHERE phone_key = ?', key);
      if (!chats.some((c) => c.session_id === resolved.session.id && c.chat_id === resolved.chatId)) {
        chats.push({ session_id: resolved.session.id, chat_id: resolved.chatId });
      }
      for (const c of chats) panelBus.publish('conversation', { sessionId: c.session_id, chatId: c.chat_id });
      res.json({ ok: true, person: personTagsByKeys([key]).get(key) ?? null });
    }),
  );

  app.post(
    '/inbox/:session/:chat/send',
    ...auth,
    ctx.rateLimit(60, 60_000),
    ah(async (req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      const text = String(req.body?.text ?? '').slice(0, 4096).trim();
      const replyTo = req.body?.reply_to_wa_id ? String(req.body.reply_to_wa_id) : null;
      if (!text) return res.status(422).json({ error: 'El mensaje está vacío.' });

      const result = await manager.sendText(resolved.session.id, resolved.chatId, text, null, {
        quoteWaId: replyTo,
        senderUid: req.user!.id,
        human: true,
      });
      conversations.tagOutbound(resolved.session.id, resolved.chatId, {
        waMessageId: result.messageId ?? null,
        senderUid: req.user!.id,
        replyToWaId: replyTo,
      });
      res.json({ ok: true, messageId: result.messageId ?? null });
    }),
  );

  app.post(
    '/inbox/:session/:chat/media',
    ...auth,
    ctx.rateLimit(60, 60_000),
    ctx.upload.single('file'),
    ah(async (req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      const file = (req as AuthedRequest & { file?: { buffer: Buffer; originalname: string; mimetype: string } }).file;
      if (!file) return res.status(422).json({ error: 'Falta el archivo.' });
      const caption = String(req.body?.caption ?? '') || undefined;

      let type = typeForMime(file.mimetype);
      if (type === 'document' && file.mimetype.startsWith('image/')) type = 'image';
      const result = await manager.sendMedia(resolved.session.id, resolved.chatId, {
        type,
        contents: file.buffer,
        mimetype: file.mimetype,
        filename: file.originalname,
        caption,
        ptt: false,
      }, null, { senderUid: req.user!.id, human: true });
      conversations.tagOutbound(resolved.session.id, resolved.chatId, {
        waMessageId: result.messageId ?? null,
        senderUid: req.user!.id,
      });
      res.json({ ok: true, messageId: result.messageId ?? null });
    }),
  );

  app.post(
    '/inbox/:session/:chat/voice',
    ...auth,
    ctx.rateLimit(60, 60_000),
    ctx.upload.single('audio'),
    ah(async (req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      const file = (req as AuthedRequest & { file?: { buffer: Buffer; originalname: string; mimetype: string } }).file;
      if (!file) return res.status(422).json({ error: 'Falta el audio.' });
      // Nota de voz: OGG/Opus es lo que espera WhatsApp. Si llega webm (fallback
      // del navegador), se envía como audio normal para que no falle el PTT.
      const isOgg = /ogg/i.test(file.mimetype) || /\.ogg$/i.test(file.originalname);
      const mimetype = isOgg ? 'audio/ogg; codecs=opus' : file.mimetype || 'audio/ogg';
      const result = await manager.sendMedia(resolved.session.id, resolved.chatId, {
        type: 'audio',
        contents: file.buffer,
        mimetype,
        filename: isOgg ? (file.originalname || 'nota-voz.ogg') : (file.originalname || 'audio.webm'),
        ptt: isOgg,
      }, null, { senderUid: req.user!.id, human: true });
      conversations.tagOutbound(resolved.session.id, resolved.chatId, {
        waMessageId: result.messageId ?? null,
        senderUid: req.user!.id,
      });
      res.json({ ok: true, messageId: result.messageId ?? null });
    }),
  );

  app.post(
    '/inbox/:session/:chat/sticker',
    ...auth,
    ctx.rateLimit(30, 60_000),
    ah(async (req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      const sticker = getSticker(Number(req.body?.sticker_id ?? 0));
      if (!sticker) return res.status(404).json({ error: 'Sticker no encontrado.' });
      const result = await manager.sendStickerFile(resolved.session.id, resolved.chatId, sticker.media_path);
      conversations.tagOutbound(resolved.session.id, resolved.chatId, {
        waMessageId: result.messageId ?? null,
        senderUid: req.user!.id,
      });
      res.json({ ok: true, messageId: result.messageId ?? null });
    }),
  );

  app.post(
    '/inbox/:session/:chat/sync',
    ...auth,
    ctx.rateLimit(10, 60_000),
    ah(async (req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      const count = Number(req.body?.count ?? 50) || 50;
      const result = await manager.syncHistory(resolved.session.id, resolved.chatId, count);
      res.json({
        ok: true,
        added: result.added,
        message: result.added > 0
          ? `Historial sincronizado: ${result.added} mensajes nuevos.`
          : result.requested === 0
            ? 'No hay historial almacenado para anclar la sincronización. Esperá que llegue algún mensaje del chat.'
            : 'Sin mensajes nuevos. WhatsApp no entregó historial anterior.',
      });
    }),
  );

  app.post(
    '/inbox/:session/:chat/read',
    ...auth,
    ah(async (req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      await manager.markChatRead(resolved.session.id, resolved.chatId).catch((err) =>
        logger.warn({ err: (err as Error).message }, 'No se pudo marcar como leído'),
      );
      conversations.markConversationRead(resolved.session.id, resolved.chatId);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/inbox/:session/:chat/reaction',
    ...auth,
    ah(async (req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      const messageId = Number(req.body?.message_id ?? 0);
      const emoji = String(req.body?.emoji ?? '').slice(0, 16);
      const message = conversations.getMessageById(messageId);
      if (!message || message.session_id !== resolved.session.id || message.chat_id !== resolved.chatId) {
        return res.status(404).json({ error: 'Mensaje no encontrado en esta conversación.' });
      }
      try {
        await manager.sendReaction(resolved.session.id, resolved.chatId, messageId, emoji, req.user!.id);
      } catch (err) {
        return res.status(502).json({ error: (err as Error).message });
      }
      panelBus.publish('reaction', {
        sessionId: resolved.session.id,
        chatId: resolved.chatId,
        messageId,
      });
      res.json({ ok: true, reactions: conversations.reactionsFor(messageId) });
    }),
  );

  app.post(
    '/inbox/:session/:chat/notes',
    ...auth,
    ctx.upload.single('audio'),
    ah((req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      const contact = getOrCreateContact(resolved.session.id, resolved.chatId);
      const text = String(req.body?.text ?? '').trim();
      const file = (req as AuthedRequest & { file?: { buffer: Buffer; originalname: string; mimetype: string } }).file;
      if (!text && !file) return res.status(422).json({ error: 'La nota debe tener texto o audio.' });

      if (text.length > 4000) return res.status(422).json({ error: 'La nota es demasiado larga (máx. 4000 caracteres).' });

      const sourceId = Number(req.body?.source_message_id) || 0;
      let audioPath: string | null = null;
      if (file) {
        audioPath = storeNoteAudio(file.buffer, file.mimetype, file.originalname || 'nota-voz.ogg');
      }
      const note = addNote(
        contact.id,
        req.user!.id,
        text || null,
        audioPath,
        parseDue(req.body?.due_at),
        parseTagIds(req.body?.tag_ids),
        parseFlag(req.body?.pinned),
        {
          assignedTo: parseAssignee(req.body?.assigned_to),
          dueTime: parseTime(req.body?.due_time),
          sourceMessageId: sourceId && conversations.messageInChat(sourceId, resolved.session.id, resolved.chatId) ? sourceId : null,
        },
      );
      publishNoteChange(note.id, note.assigned_to && note.assigned_to !== req.user!.id ? 'assigned' : 'created', req.user!.id);
      announce(note.id, 'created', req.user!);
      res.status(201).json(withPermissions(req.user!, note));
    }),
  );

  // ── Etiquetas de notas (globales) ───────────────────────────────────────────

  app.get(
    '/notes/tags',
    ...auth,
    ah((req, res) => {
      res.json({ tags: noteTags.listTagsWithUsage(noteScope(req.user!)), colors: noteTags.NOTE_TAG_COLORS });
    }),
  );

  app.post(
    '/notes/tags',
    ...auth,
    ah((req, res) => {
      try {
        res.status(201).json(noteTags.createTag({ name: String(req.body?.name ?? ''), color: req.body?.color }));
      } catch (err) {
        res.status(422).json({ error: (err as Error).message });
      }
    }),
  );

  app.put(
    '/notes/tags/:id',
    ...auth,
    ah((req, res) => {
      try {
        res.json(noteTags.updateTag(Number(req.params.id), { name: String(req.body?.name ?? ''), color: req.body?.color }));
      } catch (err) {
        res.status(422).json({ error: (err as Error).message });
      }
    }),
  );

  app.delete(
    '/notes/tags/:id',
    ...auth,
    ah((req, res) => {
      noteTags.deleteTag(Number(req.params.id));
      res.json({ ok: true });
    }),
  );

  // ── Todas las notas (con filtros) ───────────────────────────────────────────

  app.get(
    '/notes/all',
    ...auth,
    ah((req, res) => {
      const user = req.user!;
      const scope = noteScope(user);
      const tagId = Number(req.query.tag ?? 0) || null;
      const rawStatus = String(req.query.status ?? (String(req.query.overdue ?? '') === '1' ? 'overdue' : 'pending'));
      const status = (['pending', 'overdue', 'today', 'week', 'pinned', 'done', 'all', 'trash', 'derived'] as NoteStatus[]).includes(rawStatus as NoteStatus)
        ? (rawStatus as NoteStatus)
        : 'pending';
      const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
      const orderBy = String(req.query.order ?? '') === 'created' ? 'created' : 'due';
      const authorId = String(req.query.mine ?? '') === '1' ? user.id : null;
      const assignedTo = String(req.query.assigned ?? '') === '1' ? user.id : null;
      const ids = String(req.query.ids ?? '')
        .split(',')
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x) && x > 0)
        .slice(0, 50);
      // En /notes cada usuario ve solo lo suyo: lo que escribió, lo que derivó y lo
      // que le derivaron. El Super Admin supervisa todo. (En la ficha del chat se
      // siguen viendo las notas de la persona de todos, para dar continuidad.)
      const admin = esamEsAdmin(user);
      const ownerId = admin ? null : user.id;
      const listScope = admin ? scope : null;
      res.json({
        supervisor: admin,
        notes: listAllNotes({ tagId, status: ids.length ? 'all' : status, q, orderBy, authorId, assignedTo, ids, viewerId: user.id, sessionIds: listScope, ownerId })
          .map((n) => withPermissions(user, n)),
        stats: noteStats({ sessionIds: listScope, authorId, assignedTo, viewerId: user.id, ownerId }),
      });
    }),
  );

  // Resumen del día del usuario (para el aviso al entrar).
  app.get(
    '/notes/my-day',
    ...auth,
    ah((req, res) => {
      res.json(myDay(req.user!.id));
    }),
  );

  // ── Plantillas de tareas (globales) ─────────────────────────────────────────

  app.get(
    '/notes/templates',
    ...auth,
    ah((_req, res) => {
      res.json(noteTemplates.listTemplates());
    }),
  );

  app.post(
    '/notes/templates',
    ...auth,
    ah((req, res) => {
      try {
        res.status(201).json(noteTemplates.createTemplate(req.body ?? {}, req.user!.id));
      } catch (err) {
        res.status(422).json({ error: (err as Error).message });
      }
    }),
  );

  app.put(
    '/notes/templates/:id',
    ...auth,
    ah((req, res) => {
      try {
        res.json(noteTemplates.updateTemplate(Number(req.params.id), req.body ?? {}));
      } catch (err) {
        res.status(422).json({ error: (err as Error).message });
      }
    }),
  );

  app.delete(
    '/notes/templates/:id',
    ...auth,
    ah((req, res) => {
      noteTemplates.deleteTemplate(Number(req.params.id));
      res.json({ ok: true });
    }),
  );

  // Aplica una plantilla en un chat: una tarea por paso, con fechas desde hoy.
  app.post(
    '/inbox/:session/:chat/notes/template',
    ...auth,
    ah((req, res) => {
      const resolved = resolveAuthorized(req, res, String(req.params.session), String(req.params.chat));
      if (!resolved) return;
      const template = noteTemplates.getTemplate(Number(req.body?.template_id));
      if (!template) return res.status(404).json({ error: 'Plantilla no encontrada.' });
      const contact = getOrCreateContact(resolved.session.id, resolved.chatId);
      const assignedTo = parseAssignee(req.body?.assigned_to);
      const created = template.items.map((item) => {
        const due = item.due_days === null ? null : localYmd(new Date(Date.now() + item.due_days * 86_400_000));
        const note = addNote(contact.id, req.user!.id, item.text, null, due, [], item.pinned, {
          assignedTo,
          dueTime: due ? item.due_time : null,
        });
        markFromTemplate(note.id, req.user!.id, template.name);
        return note;
      });
      if (created.length) {
        publishNoteChange(created[0].id, assignedTo && assignedTo !== req.user!.id ? 'assigned' : 'created', req.user!.id);
        announce(created[0].id, 'created', req.user!, { templateName: template.name, count: created.length });
      }
      res.status(201).json({ created: created.length });
    }),
  );

  // Pospone el recordatorio de una tarea (minutos desde ahora o «mañana»).
  app.post(
    '/inbox/notes/:id/snooze',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res);
      if (!note) return;
      const minutes = Math.min(Math.max(Number(req.body?.minutes) || 15, 5), 7 * 24 * 60);
      const at = new Date(Date.now() + minutes * 60_000);
      const p = (n: number) => String(n).padStart(2, '0');
      snoozeNote(note.id, localYmd(at), `${p(at.getHours())}:${p(at.getMinutes())}`, req.user!.id);
      publishNoteChange(note.id, 'edited', req.user!.id);
      res.json(withPermissions(req.user!, noteDTO(note.id)!));
    }),
  );

  // Personas a las que se puede asignar una tarea (de todas las líneas).
  app.get(
    '/notes/assignees',
    ...auth,
    ah((req, res) => {
      res.json({ me: req.user!.id, users: noteAssignees() });
    }),
  );

  // Editar una nota (solo su autor o un admin).
  app.put(
    '/inbox/notes/:id',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res);
      if (!note) return;
      if (!canEditNote(req.user!, note)) {
        return res.status(403).json({ error: 'Solo el autor de la nota puede editarla.' });
      }
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : undefined;
      if (text !== undefined && text.length > 4000) {
        return res.status(422).json({ error: 'La nota es demasiado larga (máx. 4000 caracteres).' });
      }
      try {
        updateNote(note.id, {
          noteText: text === undefined ? undefined : text || null,
          dueAt: req.body?.due_at !== undefined ? parseDue(req.body.due_at) : undefined,
          dueTime: req.body?.due_time !== undefined ? parseTime(req.body.due_time) : undefined,
          tagIds: req.body?.tag_ids !== undefined ? parseTagIds(req.body.tag_ids) : undefined,
          pinned: req.body?.pinned !== undefined ? parseFlag(req.body.pinned) : undefined,
          assignedTo: req.body?.assigned_to !== undefined ? parseAssignee(req.body.assigned_to) : undefined,
        }, req.user!.id);
      } catch (err) {
        return res.status(422).json({ error: (err as Error).message });
      }
      const after = getNote(note.id);
      const reassigned = !!after?.assigned_to && after.assigned_to !== note.assigned_to && after.assigned_to !== req.user!.id;
      publishNoteChange(note.id, reassigned ? 'assigned' : 'edited', req.user!.id);
      if (reassigned) announce(note.id, 'reassigned', req.user!);
      res.json(withPermissions(req.user!, noteDTO(note.id)!));
    }),
  );

  // Completar / reabrir el seguimiento (cualquiera del equipo con acceso).
  app.patch(
    '/inbox/notes/:id/done',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res);
      if (!note) return;
      const done = req.body?.done !== false && String(req.body?.done) !== '0';
      setNoteDone(note.id, req.user!.id, done);
      publishNoteChange(note.id, done ? 'done' : 'reopened', req.user!.id);
      if (done && note.assigned_to) announce(note.id, 'resolved', req.user!);
      res.json(withPermissions(req.user!, noteDTO(note.id)!));
    }),
  );

  // La persona abrió la nota: sus avisos quedan leídos y, si es el responsable,
  // la derivación queda «vista».
  app.post(
    '/inbox/notes/:id/seen',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res, { allowDeleted: true });
      if (!note) return;
      markNoteRead(req.user!.id, note.id);
      if (markAssignmentSeen(note.id, req.user!.id)) publishNoteChange(note.id, 'seen', req.user!.id);
      res.json({ ...withPermissions(req.user!, noteDTO(note.id)!), unread: unreadCount(req.user!.id) });
    }),
  );

  // El responsable confirma que se comunicó con el contacto (con el resultado).
  app.post(
    '/inbox/notes/:id/contacted',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res);
      if (!note) return;
      if (note.assigned_to !== req.user!.id && !esamEsAdmin(req.user!)) {
        return res.status(403).json({ error: 'Solo la persona a la que se derivó puede confirmar el contacto.' });
      }
      const result = String(req.body?.result ?? '').trim().slice(0, 1000);
      if (result.length < 3) {
        return res.status(422).json({ error: 'Contá brevemente cómo fue la comunicación (al menos unas palabras).' });
      }
      markContacted(note.id, req.user!.id, result);
      publishNoteChange(note.id, 'contacted', req.user!.id);
      announce(note.id, 'contacted', req.user!);
      res.json(withPermissions(req.user!, noteDTO(note.id)!));
    }),
  );

  // Pipeline: mover la nota de etapa (Por hacer · En gestión · Contactado · Resuelta).
  app.post(
    '/inbox/notes/:id/stage',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res);
      if (!note) return;
      const user = req.user!;
      // La mueve quien la escribió, quien la tiene asignada o el Super Admin.
      if (!canEditNote(user, note) && note.assigned_to !== user.id) {
        return res.status(403).json({ error: 'Solo quien registró la nota o su responsable puede moverla.' });
      }
      const stage = String(req.body?.stage ?? '') as PipelineStage;
      if (!['todo', 'doing', 'contacted', 'done'].includes(stage)) return res.status(422).json({ error: 'Etapa inválida.' });
      const result = String(req.body?.result ?? '').trim().slice(0, 1000);
      if (stage === 'contacted' && result.length < 3) {
        return res.status(422).json({ error: 'Contá brevemente cómo fue la comunicación (al menos unas palabras).' });
      }
      setNoteStage(note.id, stage, user.id, result);
      publishNoteChange(note.id, `stage:${stage}`, user.id);
      if (stage === 'contacted') announce(note.id, 'contacted', user);
      if (stage === 'done' && note.assigned_to) announce(note.id, 'resolved', user);
      res.json(withPermissions(user, noteDTO(note.id)!));
    }),
  );

  // Campana: últimas notificaciones y no leídas.
  app.get(
    '/notifications',
    ...auth,
    ah((req, res) => {
      res.json({ unread: unreadCount(req.user!.id), items: listNotifications(req.user!.id, 30) });
    }),
  );

  app.post(
    '/notifications/read',
    ...auth,
    ah((req, res) => {
      const all = req.body?.all === true || req.body?.all === '1';
      const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map((x) => Number(x)) : [];
      markRead(req.user!.id, all ? 'all' : ids);
      res.json({ unread: unreadCount(req.user!.id) });
    }),
  );

  // Marcar / desmarcar como importante (cualquiera del equipo con acceso:
  // es un aviso para quien atienda a la persona desde cualquier línea).
  app.patch(
    '/inbox/notes/:id/pin',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res);
      if (!note) return;
      const pinned = parseFlag(req.body?.pinned);
      setNotePinned(note.id, pinned, req.user!.id);
      publishNoteChange(note.id, pinned ? 'pinned' : 'unpinned', req.user!.id);
      res.json(withPermissions(req.user!, noteDTO(note.id)!));
    }),
  );

  // Mandar una nota a la papelera (solo su autor o un admin). Se puede restaurar.
  app.delete(
    '/inbox/notes/:id',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res);
      if (!note) return;
      if (!canEditNote(req.user!, note)) {
        return res.status(403).json({ error: 'Solo el autor de la nota puede eliminarla.' });
      }
      deleteNote(note.id, req.user!.id);
      publishNoteChange(note.id, 'deleted', req.user!.id);
      res.json({ ok: true });
    }),
  );

  // Restaurar una nota de la papelera (su autor o un admin).
  app.post(
    '/inbox/notes/:id/restore',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res, { allowDeleted: true });
      if (!note) return;
      if (!canEditNote(req.user!, note)) {
        return res.status(403).json({ error: 'Solo el autor de la nota (o un admin) puede restaurarla.' });
      }
      restoreNote(note.id, req.user!.id);
      publishNoteChange(note.id, 'restored', req.user!.id);
      res.json(withPermissions(req.user!, noteDTO(note.id)!));
    }),
  );

  // Historial de cambios de una nota (cualquiera del equipo con acceso).
  app.get(
    '/inbox/notes/:id/history',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res, { allowDeleted: true });
      if (!note) return;
      res.json(listNoteHistory(note.id));
    }),
  );

  app.get(
    '/inbox/notes/:id/audio',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res, { allowDeleted: true });
      if (!note) return;
      if (!note.audio_path || !fs.existsSync(note.audio_path)) return res.status(404).end();
      res.sendFile(path.resolve(note.audio_path), { headers: { 'Content-Type': 'audio/ogg' } });
    }),
  );

  app.post(
    '/inbox/bulk',
    ...auth,
    ah((req, res) => {
      const user = req.user!;
      const ids = Array.isArray(req.body?.conversation_ids)
        ? req.body.conversation_ids.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n)).slice(0, 200)
        : [];
      const action = String(req.body?.action ?? '') as conversations.BulkAction;
      if (!ids.length) return res.status(422).json({ error: 'Seleccioná al menos una conversación.' });
      if (action !== 'mark_read') return res.status(422).json({ error: 'Acción inválida.' });
      const updated = conversations.bulkAction(user, ids, 'mark_read', null);
      res.json({ ok: true, updated });
    }),
  );

  // ── Plantillas rápidas (CRUD) ────────────────────────────────────────────────

  app.post(
    '/inbox/quick-replies',
    ...auth,
    ah((req, res) => {
      const user = req.user!;
      const shared = !!req.body?.shared && esamEsAdmin(user);
      try {
        const reply = quickReplies.createQuickReply(user.id, {
          shortcut: String(req.body?.shortcut ?? ''),
          content: String(req.body?.content ?? ''),
          shared,
        });
        res.status(201).json(reply);
      } catch (err) {
        res.status(422).json({ error: (err as Error).message });
      }
    }),
  );

  app.put(
    '/inbox/quick-replies/:id',
    ...auth,
    ah((req, res) => {
      const user = req.user!;
      const shared = !!req.body?.shared && esamEsAdmin(user);
      try {
        const reply = quickReplies.updateQuickReply(Number(req.params.id), user.id, {
          shortcut: String(req.body?.shortcut ?? ''),
          content: String(req.body?.content ?? ''),
          shared,
        });
        res.json(reply);
      } catch (err) {
        res.status(422).json({ error: (err as Error).message });
      }
    }),
  );

  app.delete(
    '/inbox/quick-replies/:id',
    ...auth,
    ah((req, res) => {
      quickReplies.deleteQuickReply(Number(req.params.id));
      res.json({ ok: true });
    }),
  );

  // ── Transcripción (reutiliza el endpoint existente si se prefiere) ───────────

  app.post(
    '/inbox/messages/:id/transcribe',
    ...auth,
    ctx.rateLimit(20, 60_000),
    ah(async (req, res) => {
      const msg = conversations.getMessageById(Number(req.params.id));
      if (!msg || !msg.media_path) {
        return res.status(404).json({ ok: false, error: 'El mensaje no tiene audio.' });
      }
      const result = await transcribe(msg.media_path, msg.media_mime);
      if (result.ok && result.text) manager.saveTranscription(msg.id, result.text);
      res.json({ ok: result.ok, text: result.text, error: result.error });
    }),
  );
}
