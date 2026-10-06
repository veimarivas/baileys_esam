import fs from 'node:fs';
import path from 'node:path';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../logger.js';
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
  listNotes,
  noteDTO,
  noteSessionId,
  noteStats,
  setNoteDone,
  updateNote,
  type NoteStatus,
} from '../core/contacts.js';
import * as noteTags from '../core/note-tags.js';
import * as quickReplies from '../core/quick-replies.js';
import { getSticker } from '../core/stickers.js';
import { storeIncoming } from '../core/media.js';
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

  function withPermissions<T extends { user_id: number | null }>(user: UserRow, note: T): T & { can_edit: boolean } {
    return { ...note, can_edit: canEditNote(user, note) };
  }

  /**
   * Nota accesible para el usuario: existe y pertenece a una sesión de su
   * alcance. Responde 404/403 y devuelve `null` si no.
   */
  function accessibleNote(req: AuthedRequest, res: Response): NonNullable<ReturnType<typeof getNote>> | null {
    const note = getNote(Number(req.params.id));
    if (!note) {
      res.status(404).json({ error: 'Nota no encontrada.' });
      return null;
    }
    const scope = sessionScopeFor(req.user!);
    if (scope !== null && !scope.includes(noteSessionId(note.id) ?? '')) {
      res.status(403).json({ error: 'No tenés acceso a esta nota.' });
      return null;
    }
    return note;
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

  // ── Escritura ───────────────────────────────────────────────────────────────

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

      let audioPath: string | null = null;
      if (file) {
        audioPath = storeIncoming(file.buffer, file.mimetype, file.originalname || 'nota-voz.ogg');
      }
      const note = addNote(contact.id, req.user!.id, text || null, audioPath, parseDue(req.body?.due_at), parseTagIds(req.body?.tag_ids));
      res.status(201).json(withPermissions(req.user!, note));
    }),
  );

  // ── Etiquetas de notas (globales) ───────────────────────────────────────────

  app.get(
    '/notes/tags',
    ...auth,
    ah((req, res) => {
      res.json({ tags: noteTags.listTagsWithUsage(sessionScopeFor(req.user!)), colors: noteTags.NOTE_TAG_COLORS });
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
      const scope = sessionScopeFor(user);
      const tagId = Number(req.query.tag ?? 0) || null;
      const rawStatus = String(req.query.status ?? (String(req.query.overdue ?? '') === '1' ? 'overdue' : 'pending'));
      const status = (['pending', 'overdue', 'today', 'week', 'done', 'all'] as NoteStatus[]).includes(rawStatus as NoteStatus)
        ? (rawStatus as NoteStatus)
        : 'pending';
      const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
      const orderBy = String(req.query.order ?? '') === 'created' ? 'created' : 'due';
      const authorId = String(req.query.mine ?? '') === '1' ? user.id : null;
      res.json({
        notes: listAllNotes({ tagId, status, q, orderBy, authorId, sessionIds: scope }).map((n) => withPermissions(user, n)),
        stats: noteStats({ sessionIds: scope, authorId }),
      });
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
          tagIds: req.body?.tag_ids !== undefined ? parseTagIds(req.body.tag_ids) : undefined,
        });
      } catch (err) {
        return res.status(422).json({ error: (err as Error).message });
      }
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
      res.json(withPermissions(req.user!, noteDTO(note.id)!));
    }),
  );

  // Eliminar una nota (solo su autor o un admin).
  app.delete(
    '/inbox/notes/:id',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res);
      if (!note) return;
      if (!canEditNote(req.user!, note)) {
        return res.status(403).json({ error: 'Solo el autor de la nota puede eliminarla.' });
      }
      deleteNote(note.id);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/inbox/notes/:id/audio',
    ...auth,
    ah((req, res) => {
      const note = accessibleNote(req, res);
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
