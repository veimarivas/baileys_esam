import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { all, get, run } from '../db/index.js';
import { config } from '../config.js';
import { nowIso, delay, randInt } from '../util/async.js';
import { logger } from '../logger.js';
import { WaSession, type DecryptFailure, type DisconnectInfo, type InboundMessage, type QuotedRef } from './session.js';
import { normalizePhone, phoneFromChatId } from '../core/phone.js';
import { storeAvatar, storeIncoming } from '../core/media.js';
import { audit, dispatchEvent } from '../core/webhooks.js';
import { getConfig, setConfig } from '../core/config-store.js';
import { contactIdFor, setAvatar, setContactGroup } from '../core/contacts.js';
import { setReaction } from '../core/conversations.js';
import { addOptout, isOptoutRequest, looksLikeBlock, markBlocked } from '../core/optout.js';
import { recomputeHealth } from '../core/health.js';
import { getPolicy, resetTrust } from '../core/anti-ban.js';
import { phoneKeyOf, tagPerson } from '../core/person.js';
import { lidForPhone, resolveChatId } from '../core/lid.js';
import { panelBus } from '../panel/events.js';
import type { OutboundSender, SessionRow } from '../types.js';

/** Tamaño máximo de media que se envía inline en el webhook (base64). */
const INLINE_MEDIA_LIMIT = 4 * 1024 * 1024;

/** Vista previa del último mensaje para la lista del inbox. */
function messagePreview(body: string | null, contentType: string): string {
  if (contentType === 'text' && body) return body.slice(0, 160);
  return `[${contentType}]`;
}

/** Opciones de envio del inbox: cita y atribucion al agente. */
export interface SendOptions {
  quoteWaId?: string | null;
  senderUid?: number | null;
  /**
   * Envío escrito por una persona en el panel: no se simula "escribiendo…" ni
   * se fuerza la separación mínima (sí el tope por minuto). Los automáticos
   * (lotes, API, auto-respuestas) pasan por todas las guardas anti-baneo.
   */
  human?: boolean;
}

/** Fallas de descifrado recordadas por sesión (ventana de 24 h). */
const DECRYPT_WINDOW_MS = 86_400_000;

/** Descargas de media diferida en paralelo (en segundo plano). */
const MEDIA_WORKERS = 2;

/** Error de descarga que indica que el archivo ya no existe en WhatsApp. */
function isGoneError(message: string): boolean {
  return /\b(404|410|403)\b|not found|gone|media.*(expired|unavailable)|failed to fetch|empty|inválida|re-?upload/i.test(message);
}

/** ¿El chat pertenece al inbox? (individuales y grupos; sin estados ni canales). */
function isInboxChat(chatId: string | null | undefined): boolean {
  if (!chatId) return false;
  if (chatId.endsWith('@broadcast')) return false;
  if (chatId.endsWith('@newsletter')) return false;
  return true;
}

/**
 * ¿El mensaje merece guardarse? Se descartan los tipos sin contenido que emite
 * el protocolo de WhatsApp (recibos, cifrado, sincronización), que de otro modo
 * llenan la base y crean conversaciones fantasma (p. ej. un chat `@lid` de
 * sistema con eventos `unknown`/`protocol` cada pocos segundos).
 */
function isStorableType(type: string | null | undefined): boolean {
  if (!type) return false;
  return !['unknown', 'protocol', 'reaction', 'senderKeyDistribution', 'pollUpdate', 'protocolMessage'].includes(type);
}

/**
 * Administra las sesiones (una instancia `WaSession` por fila de `sessions`),
 * persiste mensajes/conversaciones y despacha los webhooks.
 */
export class SessionManager implements OutboundSender {
  private sessions = new Map<string, WaSession>();

  /** Callback opcional para auto-respuestas (lo registra el arranque). */
  private autoReplyHandler: ((sessionId: string, chatId: string, text: string) => void) | null = null;
  /** Chats a los que ya se les intento traer la foto de perfil. */
  private avatarTried = new Set<string>();
  /** Sesiones con una sincronizacion de historial en curso (evita solapes). */
  private resuming = new Set<string>();
  /**
   * Procesamiento en orden de los mensajes entrantes por sesión. Antes cada
   * mensaje se procesaba en paralelo: al reconectar con cientos de mensajes
   * offline competían por la base y podían duplicarse.
   */
  private inboundChains = new Map<string, Promise<void>>();
  /** Envíos en orden por sesión (separación mínima y tope por minuto). */
  private sendChains = new Map<string, Promise<unknown>>();
  private recentSends = new Map<string, number[]>();
  /** Media diferida: cola de ids de mensajes y descargas en curso. */
  private mediaQueue: number[] = [];
  private mediaActive = 0;
  private mediaInFlight = new Map<number, Promise<{ path: string; mime: string | null } | null>>();
  /** Último aviso de "bajar stickers" por chat (evita repetir en cada vista). */
  private stickerPrefetchAt = new Map<string, number>();
  /** Fallas de descifrado recientes por sesión (diagnóstico). */
  private decryptFailures = new Map<string, Array<{ at: number; fromMe: boolean; error: string }>>();

  onIncomingText(handler: (sessionId: string, chatId: string, text: string) => void): void {
    this.autoReplyHandler = handler;
  }

  list(): SessionRow[] {
    return all<SessionRow>('SELECT * FROM sessions ORDER BY id');
  }

  byName(name: string): SessionRow | undefined {
    return get<SessionRow>('SELECT * FROM sessions WHERE name = ?', name);
  }

  byId(id: string): SessionRow | undefined {
    return get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
  }

  /** La sesión principal (la primera creada). */
  primary(): SessionRow | undefined {
    return get<SessionRow>('SELECT * FROM sessions ORDER BY created_at LIMIT 1');
  }

  createSession(name: string, apiKey: string | null, webhookSecret: string | null): SessionRow {
    // Si ya existe una sesión con ese nombre, se devuelve la existente en vez de
    // fallar (el panel y la API pueden reintentar la creación).
    const existing = this.byName(name);
    if (existing) return existing;

    const id = randomUUID();
    const now = nowIso();
    run(
      `INSERT INTO sessions (id, name, api_key, webhook_secret, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'created', ?, ?)`,
      id,
      name,
      apiKey,
      webhookSecret,
      now,
      now,
    );
    audit('session.created', { session_id: id, name });
    return this.byId(id)!;
  }

  private snapshot(sessionId: string): SessionRow {
    const row = this.byId(sessionId);
    if (!row) throw new Error('Sesión no encontrada.');
    return row;
  }

  private updateStatus(sessionId: string, status: string, extra: Record<string, unknown> = {}): void {
    const fields: string[] = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [status, nowIso()];
    for (const [key, value] of Object.entries(extra)) {
      fields.push(`${key} = ?`);
      params.push(value);
    }
    params.push(sessionId);
    run(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`, ...params);
  }

  /** Crea (si hace falta) la instancia y conecta los eventos. */
  private async instance(sessionId: string): Promise<WaSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const row = this.snapshot(sessionId);
    const session = new WaSession({
      name: row.name,
      proxyUrl: row.proxy_url,
      // Respaldo de reintentos tras un reinicio: el texto enviado guardado en la BD.
      lookupSent: (waId: string) => {
        const m = get<{ body: string | null; content_type: string }>(
          "SELECT body, content_type FROM messages WHERE session_id = ? AND wa_message_id = ? AND direction = 'out' LIMIT 1",
          sessionId,
          waId,
        );
        return m?.body && m.content_type === 'text' ? { conversation: m.body } : undefined;
      },
    });

    session.on('status', (status: string) => this.updateStatus(sessionId, status));
    session.on('qr', () => this.updateStatus(sessionId, 'qr', { disconnect_info: null }));
    session.on('ready', (phone: string) => void this.onReady(sessionId, phone));
    session.on('disconnected', (info: DisconnectInfo) => void this.onDisconnected(sessionId, info));
    session.on('message', (msg: InboundMessage) => this.enqueueInbound(sessionId, () => this.onMessage(sessionId, msg)));
    session.on('history', (msg: InboundMessage) => this.enqueueInbound(sessionId, () => this.onHistory(sessionId, msg)));
    session.on('decrypt-failure', (f: DecryptFailure) => this.onDecryptFailure(sessionId, f));
    // Lecturas hechas en el teléfono (van por la misma cola: después de guardar los mensajes).
    session.on('read-self', (r: { chatId: string; messageIds: string[] }) =>
      this.enqueueInbound(sessionId, async () => this.onReadSelf(sessionId, r.chatId, r.messageIds)),
    );
    session.on('chat-unread', (u: { chatId: string; unreadCount: number }) =>
      this.enqueueInbound(sessionId, async () => this.onChatUnread(sessionId, u.chatId, u.unreadCount)),
    );
    session.on('ack', (ack: { messageId: string; status: string }) => void this.onAck(sessionId, ack));
    session.on('presence', (p: { chatId: string; typing: boolean }) => void this.onPresence(sessionId, p));
    session.on('contact-name', (c: { chatId: string; name: string }) => this.onContactName(sessionId, c.chatId, c.name));

    this.sessions.set(sessionId, session);
    return session;
  }

  /** Arranca el socket de una sesión. */
  async start(sessionId: string): Promise<void> {
    const session = await this.instance(sessionId);
    if (session.socket) {
      await session.connect();
      return;
    }
    await session.connect();
  }

  /**
   * Reabre la conexión con las mismas credenciales (sin desvincular): sale de un
   * socket "conectado pero sordo" y WhatsApp entrega lo pendiente como offline.
   */
  async reconnect(sessionId: string): Promise<void> {
    const session = await this.instance(sessionId);
    logger.info({ sessionId }, 'Reconexión manual solicitada');
    await session.stop();
    await delay(1500);
    await session.connect();
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) await session.stop();
    this.updateStatus(sessionId, 'disconnected');
  }

  async logout(sessionId: string): Promise<void> {
    const session = await this.instance(sessionId);
    await session.logout();
    this.sessions.delete(sessionId);
    this.updateStatus(sessionId, 'disconnected', { phone: null, blocked_reason: null, last_error: null });
  }

  async qr(sessionId: string): Promise<string | null> {
    const session = await this.instance(sessionId);
    if (!session.socket) await session.connect();
    // El QR llega por evento asíncrono: se espera hasta ~10 s a que aparezca
    // (o a que la sesión quede lista, p. ej. si ya estaba vinculada).
    for (let i = 0; i < 20; i++) {
      if (session.qrDataUrl) return session.qrDataUrl;
      if (session.isReady()) return null;
      await delay(500);
    }
    return session.qrDataUrl;
  }

  async pairing(sessionId: string, phone: string): Promise<string> {
    const session = await this.instance(sessionId);
    return session.requestPairingCode(normalizePhone(phone));
  }

  async groups(sessionId: string) {
    return (await this.instance(sessionId)).groups();
  }

  async groupParticipants(sessionId: string, chatId: string) {
    return (await this.instance(sessionId)).groupParticipants(chatId);
  }

  async groupJoinInfo(sessionId: string, code: string) {
    return (await this.instance(sessionId)).groupJoinInfo(code);
  }

  async checkNumber(sessionId: string, number: string) {
    return (await this.instance(sessionId)).checkNumber(number);
  }

  async contacts(sessionId: string, limit?: number) {
    return (await this.instance(sessionId)).contacts(limit);
  }

  async presenceSubscribe(sessionId: string, chatId: string): Promise<void> {
    const session = await this.instance(sessionId);
    await session.presenceSubscribe(chatId);
  }

  // ── OutboundSender ───────────────────────────────────────────────────────────

  async sendText(
    sessionId: string,
    chatId: string,
    text: string,
    contactName?: string | null,
    opts: SendOptions = {},
  ) {
    const quote = this.quoteRef(sessionId, opts.quoteWaId);
    let result: { messageId?: string };
    try {
      result = await this.guardedSend(sessionId, chatId, { preview: text, typing: 'composing', human: !!opts.human }, (session) =>
        session.sendText(chatId, text, quote),
      );
    } catch (err) {
      this.handleSendFailure(sessionId, chatId, err);
      throw err;
    }
    this.persistOutbound(sessionId, chatId, contactName ?? null, 'text', text, null, null, result.messageId ?? null, null, null, 'panel', undefined, {
      replyToWaId: opts.quoteWaId ?? null,
      senderUid: opts.senderUid ?? null,
    });
    panelBus.publish('message', { sessionId, chatId, direction: 'out', body: text, content_type: 'text', occurred_at: nowIso() });
    return { messageId: result.messageId };
  }

  async sendMedia(
    sessionId: string,
    chatId: string,
    opts: { type: string; contents: Buffer; mimetype: string; filename?: string; caption?: string; ptt?: boolean },
    contactName?: string | null,
    sendOpts: SendOptions = {},
  ) {
    const quote = this.quoteRef(sessionId, sendOpts.quoteWaId);
    let mediaPath: string | null = null;
    try {
      mediaPath = storeIncoming(opts.contents, opts.mimetype, opts.filename ?? null);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'No se pudo guardar media saliente');
    }
    let result: { messageId?: string };
    try {
      const typing = opts.type === 'audio' ? 'recording' : 'composing';
      result = await this.guardedSend(sessionId, chatId, { preview: opts.caption ?? null, typing, human: !!sendOpts.human }, (session) =>
        session.sendMedia(
          chatId,
          opts.type,
          opts.contents,
          opts.mimetype,
          opts.filename,
          opts.caption,
          opts.ptt ?? false,
          quote,
        ),
      );
    } catch (err) {
      this.handleSendFailure(sessionId, chatId, err);
      throw err;
    }
    this.persistOutbound(sessionId, chatId, contactName ?? null, opts.type, opts.caption ?? null, opts.mimetype, mediaPath, result.messageId ?? null, null, null, 'panel', undefined, {
      replyToWaId: sendOpts.quoteWaId ?? null,
      senderUid: sendOpts.senderUid ?? null,
    });
    panelBus.publish('message', { sessionId, chatId, direction: 'out', body: opts.caption ?? `[${opts.type}]`, content_type: opts.type, occurred_at: nowIso() });
    return { messageId: result.messageId };
  }

  /**
   * Reacciona a un mensaje (o retira la reaccion con emoji vacio): envia el
   * `react` a WhatsApp, lo persiste para el actor y avisa al panel.
   */
  async sendReaction(
    sessionId: string,
    chatId: string,
    messageId: number,
    emoji: string,
    actorUid: number | null,
  ): Promise<void> {
    const session = await this.requireReady(sessionId);
    const row = get<{ wa_message_id: string | null; direction: string }>(
      'SELECT wa_message_id, direction FROM messages WHERE id = ?',
      messageId,
    );
    if (!row?.wa_message_id) throw new Error('Este mensaje no se puede reaccionar (sin wamid).');
    await session.sendReaction(chatId, { id: row.wa_message_id, fromMe: row.direction === 'out' }, emoji);
    setReaction(messageId, sessionId, chatId, 'agent', String(actorUid ?? ''), emoji);
    panelBus.publish('reaction', { sessionId, chatId, messageId });
  }

  /**
   * Ejecuta un envío pasando por las guardas anti-baneo de la política de la
   * sesión: un envío a la vez por sesión, separación mínima con azar, tope de
   * envíos por minuto (ráfagas) y "escribiendo…" previo en los automáticos.
   */
  private async guardedSend<T>(
    sessionId: string,
    chatId: string,
    opts: { preview: string | null; typing: 'composing' | 'recording' | null; human: boolean },
    send: (session: WaSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.requireReady(sessionId);
    const previous = this.sendChains.get(sessionId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        await this.antiBanWait(sessionId, session, chatId, opts);
        try {
          return await send(session);
        } finally {
          this.markSent(sessionId);
        }
      });
    this.sendChains.set(sessionId, task.catch(() => undefined));
    return task;
  }

  private async antiBanWait(
    sessionId: string,
    session: WaSession,
    chatId: string,
    opts: { preview: string | null; typing: 'composing' | 'recording' | null; human: boolean },
  ): Promise<void> {
    let policy;
    try {
      policy = getPolicy(sessionId);
    } catch {
      return;
    }
    if (!policy.active) return;
    const now = Date.now();
    const recent = (this.recentSends.get(sessionId) ?? []).filter((t) => now - t < 60_000);
    this.recentSends.set(sessionId, recent);
    let waitMs = 0;
    // Separación mínima entre envíos (con azar para no ser periódico).
    if (!opts.human && recent.length && policy.min_gap_seconds > 0) {
      const last = recent[recent.length - 1];
      const gap = policy.min_gap_seconds * 1000 + randInt(0, 1500);
      waitMs = Math.max(waitMs, last + gap - now);
    }
    // Tope de ráfaga: no más de N envíos en 60 s (también para el panel).
    if (policy.burst_per_minute > 0 && recent.length >= policy.burst_per_minute) {
      const oldest = recent[recent.length - policy.burst_per_minute];
      waitMs = Math.max(waitMs, oldest + 60_000 - now + randInt(200, 1200));
    }
    if (waitMs > 0) await delay(Math.min(waitMs, 90_000));
    if (!opts.human && opts.typing && policy.typing_simulation) {
      await session.simulateTyping(chatId, opts.preview, opts.typing);
    }
  }

  private markSent(sessionId: string): void {
    const list = this.recentSends.get(sessionId) ?? [];
    list.push(Date.now());
    if (list.length > 200) list.splice(0, list.length - 200);
    this.recentSends.set(sessionId, list);
  }

  /** Arma la referencia de cita desde el mensaje guardado. */
  private quoteRef(sessionId: string, waId?: string | null): QuotedRef | null {
    if (!waId) return null;
    const row = get<{ direction: string; body: string | null; content_type: string; sender_jid: string | null }>(
      'SELECT direction, body, content_type, sender_jid FROM messages WHERE session_id = ? AND wa_message_id = ? LIMIT 1',
      sessionId,
      waId,
    );
    if (!row) return { id: waId, fromMe: false, body: '' };
    return {
      id: waId,
      fromMe: row.direction === 'out',
      body: row.body ?? `[${row.content_type}]`,
      participant: row.sender_jid,
    };
  }

  /**
   * Ante un fallo de envío, detecta si es un bloqueo/reporte: marca el destino
   * en la lista negra y reinicia el warm-up de la sesión (sección 2.3).
   */
  private handleSendFailure(sessionId: string, chatId: string, err: unknown): void {
    const message = (err as Error).message;
    try {
      if (looksLikeBlock(message)) {
        markBlocked(chatId, `Bloqueo detectado al enviar: ${message}`, sessionId);
        resetTrust(sessionId);
        logger.warn({ sessionId, chatId }, 'Posible bloqueo/reporte detectado: destino en lista negra');
      }
      recomputeHealth(sessionId, { lastError: message });
    } catch (healthErr) {
      logger.warn({ err: (healthErr as Error).message }, 'No se pudo actualizar la salud de la sesión');
    }
  }

  /** Envía un sticker WebP desde la biblioteca. */
  async sendStickerFile(sessionId: string, chatId: string, filePath: string) {
    const contents = fs.readFileSync(filePath);
    let stored: string | null = null;
    try {
      stored = storeIncoming(contents, 'image/webp', null);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'No se pudo guardar el sticker saliente');
    }
    const result = await this.guardedSend(sessionId, chatId, { preview: null, typing: null, human: true }, (session) =>
      session.sendMedia(chatId, 'sticker', contents, 'image/webp'),
    );
    this.persistOutbound(sessionId, chatId, null, 'sticker', null, 'image/webp', stored, result.messageId ?? null, null, null, 'panel');
    panelBus.publish('message', { sessionId, chatId, direction: 'out', body: '[sticker]', content_type: 'sticker', occurred_at: nowIso() });
    return { messageId: result.messageId };
  }

  /** Asocia programa a la conversación (lo usa el BatchRunner). */
  tagConversation(
    sessionId: string,
    chatId: string,
    tag: { contactName?: string | null; programa?: string | null; programaId?: number | null },
  ): void {
    // Por persona (número): así lo ven todas las líneas, no solo la que envió.
    tagPerson(chatId, { fullName: tag.contactName, programa: tag.programa, programaId: tag.programaId, sessionId });
    const row = this.byId(sessionId);
    run(
      `INSERT INTO conversations (session_id, whatsapp_phone, chat_id, contact_name, programa, programa_id, last_message_at, last_direction, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'out', ?, ?)
       ON CONFLICT(session_id, chat_id) DO UPDATE SET
         contact_name = COALESCE(excluded.contact_name, conversations.contact_name),
         programa = COALESCE(excluded.programa, conversations.programa),
         programa_id = COALESCE(excluded.programa_id, conversations.programa_id),
         updated_at = excluded.updated_at`,
      sessionId,
      row?.phone ?? null,
      chatId,
      tag.contactName ?? null,
      tag.programa ?? null,
      tag.programaId ?? null,
      nowIso(),
      nowIso(),
      nowIso(),
    );
  }

  private async requireReady(sessionId: string): Promise<WaSession> {
    const session = await this.instance(sessionId);
    if (!session.isReady()) {
      await session.connect();
      // Tras un reinicio la sesión tarda unos segundos en quedar lista: se
      // espera (hasta ~25 s) en vez de fallar el envío de inmediato.
      for (let i = 0; i < 50 && !session.isReady(); i++) {
        await delay(500);
      }
    }
    if (!session.isReady()) throw new Error('La sesión de WhatsApp no está conectada.');
    return session;
  }

  // ── Eventos ──────────────────────────────────────────────────────────────────

  private async onReady(sessionId: string, phone: string): Promise<void> {
    const row = this.snapshot(sessionId);
    const normalized = normalizePhone(phone);

    // Número autorizado: el de la sesión, el global, o el del usuario dueño
    // (cronogramas). Si ninguno está definido, se permite (modo bootstrap).
    let expected = row.expected_phone ?? getConfig('expected_phone');
    if (!expected && row.owner_uid) {
      const owner = get<{ esam_numero: string | null }>(
        'SELECT esam_numero FROM users WHERE source_uid = ?',
        row.owner_uid,
      );
      if (owner?.esam_numero) expected = normalizePhone(owner.esam_numero);
    }

    if (expected && normalizePhone(expected) !== normalized) {
      logger.warn({ sessionId, expected, phone }, 'Número vinculado no autorizado: se desvincula');
      const session = this.sessions.get(sessionId);
      await session?.logout();
      this.sessions.delete(sessionId);
      this.updateStatus(sessionId, 'blocked', {
        phone: null,
        blocked_reason: 'El número vinculado no es el autorizado por ESAM',
        phone_verified_at: null,
      });
      return;
    }

    this.updateStatus(sessionId, 'ready', {
      phone: normalized,
      last_error: null,
      blocked_reason: null,
      phone_verified_at: expected ? nowIso() : row.phone_verified_at,
    });
    audit('session.ready', { session_id: sessionId, phone: normalized });
    await dispatchEvent(sessionId, 'session.status', { status: 'ready', phone: normalized });
    recomputeHealth(sessionId);
    // Rellena en segundo plano los huecos de mensajes de chats conocidos.
    void this.resumeHistories(sessionId);
  }

  private async onDisconnected(sessionId: string, info: DisconnectInfo): Promise<void> {
    const reason = info.title;
    const extra: Record<string, unknown> = { last_error: reason, disconnect_info: JSON.stringify(info) };
    // Las credenciales se borraron: el número ya no está vinculado.
    if (info.kind === 'logged_out' || info.kind === 'banned') {
      extra.phone = null;
      this.sessions.delete(sessionId);
    }
    this.updateStatus(sessionId, 'disconnected', extra);
    audit('session.disconnected', { session_id: sessionId, code: info.code, kind: info.kind });
    await dispatchEvent(sessionId, 'session.disconnected', { reason, code: info.code, kind: info.kind });
    recomputeHealth(sessionId, { lastError: reason });
  }

  /**
   * Nombre de perfil que comparte WhatsApp para un chat: completa el de la
   * conversación y la ficha si todavía no tienen (no crea contactos nuevos ni
   * pisa un nombre ya registrado).
   */
  private onContactName(sessionId: string, chatId: string, name: string): void {
    try {
      const changed =
        run(
          `UPDATE conversations SET contact_name = ? WHERE session_id = ? AND chat_id = ? AND (contact_name IS NULL OR contact_name = '')`,
          name,
          sessionId,
          chatId,
        ).changes +
        run(
          `UPDATE contacts SET name = ? WHERE session_id = ? AND chat_id = ? AND (name IS NULL OR name = '')`,
          name,
          sessionId,
          chatId,
        ).changes;
      if (changed) panelBus.publish('conversation', { sessionId, chatId });
    } catch {
      // best-effort
    }
  }

  /** «Reparar cifrado» sin desvincular (contactos que ven «Esperando el mensaje»). */
  async repairEncryption(sessionId: string): Promise<number> {
    const session = await this.instance(sessionId);
    logger.warn({ sessionId }, 'Reparación de cifrado solicitada');
    audit('session.repair', { session_id: sessionId });
    return session.repairEncryption();
  }

  /**
   * Diagnóstico de la conexión para la vista Conexión: estado, último cierre
   * explicado, permisos de las credenciales y otra instancia del servicio.
   */
  async diagnose(sessionId: string): Promise<{
    status: string;
    phone: string | null;
    ready: boolean;
    disconnect: DisconnectInfo | null;
    auth: { ok: boolean; path: string; error?: string };
    lastError: string | null;
    blockedReason: string | null;
  }> {
    const row = this.snapshot(sessionId);
    const session = await this.instance(sessionId);
    let disconnect = session.lastDisconnect;
    if (!disconnect && (row as any).disconnect_info) {
      try {
        disconnect = JSON.parse((row as any).disconnect_info) as DisconnectInfo;
      } catch {
        disconnect = null;
      }
    }
    return {
      status: row.status,
      phone: row.phone ?? null,
      ready: session.isReady(),
      disconnect,
      auth: session.authWritable(),
      lastError: session.lastError ?? row.last_error ?? null,
      blockedReason: row.blocked_reason ?? null,
    };
  }

  private async onMessage(sessionId: string, msg: InboundMessage): Promise<void> {
    const row = this.byId(sessionId);
    if (!row) return;

    // Estados/boletines fuera; individuales y grupos entran al inbox.
    if (!isInboxChat(msg.chatId)) return;

    // Reacciones: no generan burbuja; actualizan la tabla de reacciones.
    if (msg.type === 'reaction' && msg.reaction) {
      this.handleReaction(sessionId, msg);
      return;
    }

    // Tipos sin contenido (protocolo, sincronización, desconocidos): se ignoran.
    if (!isStorableType(msg.type)) return;

    // Idempotencia: el mismo mensaje puede llegar por `notify` y por `append`.
    if (msg.id && this.messageExists(sessionId, msg.id)) {
      // Ya guardado (p. ej. por una versión anterior sin referencia de media):
      // se completa la referencia para poder descargar el archivo.
      this.backfillMediaRef(sessionId, msg);
      this.backfillSender(sessionId, msg);
      return;
    }

    // Nombre de la conversación: asunto del grupo o pushName del contacto.
    const convName = await this.conversationName(sessionId, msg);

    // Guarda la media del mensaje: sirve tanto para entrantes como para los
    // salientes enviados desde el teléfono (fotos, audio, video, documentos).
    let mediaPath: string | null = null;
    if (msg.mediaBuffer && msg.mediaMime) {
      try {
        mediaPath = storeIncoming(msg.mediaBuffer, msg.mediaMime, msg.filename);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'No se pudo guardar media del mensaje');
      }
    }

    // Mensajes salientes generados desde otro dispositivo: se guardan sin webhook.
    if (msg.fromMe) {
      const rowId = this.persistOutbound(
        sessionId,
        msg.chatId,
        null,
        msg.type,
        msg.body,
        msg.mediaMime,
        mediaPath,
        msg.id,
        msg.seconds,
        msg.filename,
        'phone',
        msg.timestamp,
        { mediaRef: msg.mediaRef ?? null, replyToWaId: msg.quotedWaId ?? null },
      );
      if (!mediaPath && msg.mediaRef && msg.offline) this.queueMediaDownload(rowId);
      // Avisar al panel: antes los enviados desde el teléfono no refrescaban el chat.
      panelBus.publish('message', {
        sessionId,
        chatId: msg.chatId,
        direction: 'out',
        body: msg.body,
        content_type: msg.type,
        occurred_at: new Date(msg.timestamp * 1000).toISOString(),
      });
      return;
    }

    const inboundId = this.persistInbound(sessionId, row.phone ?? null, msg, mediaPath);
    if (!mediaPath && msg.mediaRef && msg.offline) this.queueMediaDownload(inboundId);

    this.upsertConversation(
      sessionId,
      msg.chatId,
      convName,
      'in',
      true,
      messagePreview(msg.body, msg.type),
      new Date(msg.timestamp * 1000).toISOString(),
    );
    if (msg.isGroup && convName) setContactGroup(sessionId, msg.chatId, convName);
    void this.refreshAvatar(sessionId, msg.chatId);

    // Auto-respuestas y opt-out solo aplican a chats individuales.
    if (!msg.isGroup) {
      if (isOptoutRequest(msg.body, getPolicy(null).optout_keywords)) {
        addOptout(msg.chatId, 'Solicitó la baja', 'reply', sessionId);
      }
      // Respuestas automáticas por palabra clave (texto entrante).
      if (msg.type === 'text' && msg.body && this.autoReplyHandler) {
        try {
          this.autoReplyHandler(sessionId, msg.chatId, msg.body);
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'Error en auto-respuesta');
        }
      }
    }

    panelBus.publish('message', {
      sessionId,
      chatId: msg.chatId,
      direction: 'in',
      body: msg.body,
      content_type: msg.type,
      contact_name: convName,
      occurred_at: new Date(msg.timestamp * 1000).toISOString(),
      unread: true,
    });

    // Payload para webhooks (mismo contrato que OpenWA).
    const media = msg.mediaBuffer && msg.mediaMime && msg.mediaBuffer.length <= INLINE_MEDIA_LIMIT
      ? { mimetype: msg.mediaMime, filename: msg.filename, data: msg.mediaBuffer.toString('base64') }
      : undefined;

    // Sin `await`: un receptor lento o caído no debe frenar la recepción (los
    // fallos quedan en la cola de reintentos de webhooks).
    void dispatchEvent(sessionId, 'message.received', {
      kind: msg.isGroup ? 'group' : 'individual',
      from: msg.chatId,
      isGroup: msg.isGroup,
      contact: { pushName: msg.isGroup ? null : msg.pushName, name: msg.isGroup ? null : msg.pushName },
      group: msg.isGroup ? { id: msg.chatId, name: convName } : null,
      participant: msg.isGroup ? { id: msg.senderJid ?? null, name: msg.pushName ?? null } : null,
      type: msg.type,
      body: msg.body,
      id: msg.id,
      timestamp: msg.timestamp,
      hasMedia: !!media,
      media,
    }).catch((err) => logger.warn({ err: (err as Error).message }, 'No se pudo despachar el webhook de mensaje'));
  }

  /**
   * El número leyó mensajes en el teléfono (recibo `read-self`). WhatsApp marca
   * como leído todo lo anterior al último mensaje leído, así que se marcan como
   * leídos los entrantes hasta el más reciente de esos y se recalcula el
   * contador con los que quedan después.
   */
  private onReadSelf(sessionId: string, chatId: string, messageIds: string[]): void {
    if (!chatId || !messageIds.length) return;
    const placeholders = messageIds.map(() => '?').join(',');
    const last = get<{ occurred_at: string }>(
      `SELECT MAX(occurred_at) AS occurred_at FROM messages
        WHERE session_id = ? AND wa_message_id IN (${placeholders})`,
      sessionId,
      ...messageIds,
    );
    if (!last?.occurred_at) return;
    this.applyReadUpTo(sessionId, chatId, last.occurred_at);
  }

  /** Contador de no leídos informado por WhatsApp para el chat. */
  private onChatUnread(sessionId: string, chatId: string, unreadCount: number): void {
    if (!chatId) return;
    const conv = get<{ unread_count: number }>(
      'SELECT unread_count FROM conversations WHERE session_id = ? AND chat_id = ?',
      sessionId,
      chatId,
    );
    if (!conv) return;
    if (unreadCount === 0) {
      // Leído en el teléfono: todo lo entrante queda leído.
      this.applyReadUpTo(sessionId, chatId, null);
      return;
    }
    if (unreadCount > 0) {
      // Los N entrantes más recientes son los que siguen sin leer en el teléfono.
      run(
        `UPDATE messages SET status = 'received'
          WHERE id IN (SELECT id FROM messages WHERE session_id = ? AND chat_id = ? AND direction = 'in'
                        ORDER BY occurred_at DESC, id DESC LIMIT ?)
            AND COALESCE(status, '') IN ('read', 'received')`,
        sessionId,
        chatId,
        unreadCount,
      );
    }
    // -1 = "marcar como no leído" en el teléfono; N = mensajes sin leer.
    const value = unreadCount < 0 ? Math.max(1, conv.unread_count) : unreadCount;
    if (value === conv.unread_count) return;
    run('UPDATE conversations SET unread_count = ?, updated_at = ? WHERE session_id = ? AND chat_id = ?', value, nowIso(), sessionId, chatId);
    panelBus.publish('conversation', { sessionId, chatId, unread_count: value });
  }

  /**
   * Marca como leídos los entrantes del chat hasta `upTo` (o todos si es null) y
   * deja el contador con los entrantes posteriores aún no leídos.
   */
  private applyReadUpTo(sessionId: string, chatId: string, upTo: string | null): void {
    run(
      `UPDATE messages SET status = 'read'
        WHERE session_id = ? AND chat_id = ? AND direction = 'in'
          AND COALESCE(status, '') NOT IN ('read', 'played')
          ${upTo ? 'AND occurred_at <= ?' : ''}`,
      ...(upTo ? [sessionId, chatId, upTo] : [sessionId, chatId]),
    );
    const pending = upTo
      ? get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM messages
            WHERE session_id = ? AND chat_id = ? AND direction = 'in' AND occurred_at > ?
              AND COALESCE(status, '') NOT IN ('read', 'played')`,
          sessionId,
          chatId,
          upTo,
        )?.c ?? 0
      : 0;
    const res = run(
      'UPDATE conversations SET unread_count = ?, updated_at = ? WHERE session_id = ? AND chat_id = ? AND unread_count <> ?',
      pending,
      nowIso(),
      sessionId,
      chatId,
      pending,
    );
    if (res.changes) panelBus.publish('read', { sessionId, chatId, unread_count: pending });
  }

  /** Encola el procesamiento de un mensaje entrante (orden y sin solapes por sesión). */
  private enqueueInbound(sessionId: string, task: () => Promise<void>): void {
    const previous = this.inboundChains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task).catch((err) => {
      logger.warn({ sessionId, err: (err as Error).message }, 'Error procesando mensaje entrante');
    });
    this.inboundChains.set(sessionId, next);
  }

  /** Registra un mensaje que no se pudo descifrar (para diagnóstico en el panel). */
  private onDecryptFailure(sessionId: string, f: DecryptFailure): void {
    const now = Date.now();
    const list = (this.decryptFailures.get(sessionId) ?? []).filter((x) => now - x.at < DECRYPT_WINDOW_MS);
    list.push({ at: now, fromMe: f.fromMe, error: f.error });
    if (list.length > 500) list.splice(0, list.length - 500);
    this.decryptFailures.set(sessionId, list);
    // Log acotado: el primero y luego cada 25 para no inundar el registro.
    if (list.length === 1 || list.length % 25 === 0) {
      logger.warn(
        { sessionId, chatId: f.chatId, fromMe: f.fromMe, error: f.error, last24h: list.length },
        'Mensaje que no se pudo descifrar (WhatsApp pedirá el reenvío)',
      );
    }
    try {
      setConfig(
        `decrypt_failures:${sessionId}`,
        JSON.stringify({
          count: list.length,
          from_phone: list.filter((x) => x.fromMe).length,
          last_at: new Date(now).toISOString(),
          last_error: f.error,
        }),
      );
    } catch {
      // best-effort
    }
  }

  /** Resumen de fallas de descifrado de las últimas 24 h (para el panel). */
  decryptStats(sessionId: string): { count: number; fromPhone: number; lastAt: string | null; lastError: string | null } {
    const now = Date.now();
    const list = (this.decryptFailures.get(sessionId) ?? []).filter((x) => now - x.at < DECRYPT_WINDOW_MS);
    const last = list[list.length - 1];
    return {
      count: list.length,
      fromPhone: list.filter((x) => x.fromMe).length,
      lastAt: last ? new Date(last.at).toISOString() : null,
      lastError: last?.error ?? null,
    };
  }

  // ── Media diferida ───────────────────────────────────────────────────────────

  /** Encola la descarga en segundo plano de la media de un mensaje (offline). */
  private queueMediaDownload(messageId: number | null): void {
    if (!messageId || !config.media.downloadOffline) return;
    this.mediaQueue.push(messageId);
    this.pumpMedia();
  }

  private pumpMedia(): void {
    while (this.mediaActive < MEDIA_WORKERS && this.mediaQueue.length) {
      const id = this.mediaQueue.shift()!;
      this.mediaActive++;
      void this.ensureMedia(id)
        .catch(() => null)
        .then((result) => {
          if (result) {
            const row = get<{ session_id: string; chat_id: string }>('SELECT session_id, chat_id FROM messages WHERE id = ?', id);
            if (row) panelBus.publish('media', { sessionId: row.session_id, chatId: row.chat_id, messageId: id });
          }
        })
        .finally(() => {
          this.mediaActive--;
          this.pumpMedia();
        });
    }
  }

  /**
   * Al abrir un chat, baja los stickers pendientes (pesan poco) para que se vean
   * solos, como en WhatsApp, sin que el usuario pulse "Descargar". Se limita por
   * chat y se repite como mucho cada 90 s; los que ya fallaron quedan marcados
   * como `missing` y no se vuelven a intentar.
   */
  prefetchStickers(sessionId: string, chatId: string, limit = 40): void {
    const key = `${sessionId}:${chatId}`;
    const last = this.stickerPrefetchAt.get(key) ?? 0;
    if (Date.now() - last < 90_000) return;
    if (this.stickerPrefetchAt.size > 500) this.stickerPrefetchAt.clear();
    this.stickerPrefetchAt.set(key, Date.now());
    const rows = all<{ id: number }>(
      `SELECT id FROM messages
        WHERE session_id = ? AND chat_id = ? AND content_type = 'sticker'
          AND media_path IS NULL AND media_state IS NULL
          AND media_ref IS NOT NULL AND media_ref <> ''
        ORDER BY id DESC LIMIT ?`,
      sessionId,
      chatId,
      limit,
    );
    for (const r of rows) this.queueMediaDownload(r.id);
  }

  /**
   * Devuelve el archivo de la media de un mensaje, descargándolo de WhatsApp si
   * hace falta (con tiempo máximo). Si WhatsApp ya no lo tiene, lo marca como
   * `missing` para no volver a intentarlo en cada vista (salvo `retry`).
   * `null` = no disponible (o la sesión no está conectada en este momento).
   */
  async ensureMedia(
    messageId: number,
    opts: { retry?: boolean } = {},
  ): Promise<{ path: string; mime: string | null } | null> {
    const row = this.mediaRow(messageId);
    if (!row) return null;
    if (row.media_path && fs.existsSync(row.media_path)) return { path: row.media_path, mime: row.media_mime };
    // Sin referencia (guardado por una versión anterior): solo se intenta
    // recuperarla cuando alguien pulsa "Descargar"/"Reintentar".
    if (!row.media_ref && !opts.retry) return null;
    if (row.media_state === 'missing' && !opts.retry) return null;
    const session = row.session_id ? this.sessions.get(row.session_id) : undefined;
    if (!session?.isReady()) return null;

    const pending = this.mediaInFlight.get(messageId);
    if (pending) return pending;
    const job = (async () => {
      try {
        let ref = row.media_ref;
        if (!ref) ref = await this.recoverMediaRef(session, row);
        if (!ref) throw new Error('El teléfono no devolvió el mensaje original (sin referencia de media).');
        const timeout = ['video', 'document'].includes(row.content_type) ? 90_000 : config.media.downloadTimeoutMs;
        const buffer = await session.downloadMediaRef(ref, timeout);
        const filePath = storeIncoming(buffer, row.media_mime, row.media_filename);
        run("UPDATE messages SET media_path = ?, media_state = 'ok' WHERE id = ?", filePath, messageId);
        return { path: filePath, mime: row.media_mime };
      } catch (err) {
        const message = (err as Error).message ?? '';
        // Caducado/borrado en WhatsApp o sin respuesta: se marca para no
        // reintentar en cada vista; el panel ofrece "Reintentar".
        run("UPDATE messages SET media_state = 'missing' WHERE id = ?", messageId);
        logger.info(
          { messageId, gone: isGoneError(message), err: message },
          'Media no disponible en WhatsApp',
        );
        return null;
      } finally {
        this.mediaInFlight.delete(messageId);
      }
    })();
    this.mediaInFlight.set(messageId, job);
    return job;
  }

  private mediaRow(messageId: number) {
    return get<{
      id: number;
      session_id: string | null;
      chat_id: string;
      wa_message_id: string | null;
      direction: string;
      sender_jid: string | null;
      occurred_at: string;
      content_type: string;
      media_path: string | null;
      media_mime: string | null;
      media_filename: string | null;
      media_ref: string | null;
      media_state: string | null;
    }>(
      `SELECT id, session_id, chat_id, wa_message_id, direction, sender_jid, occurred_at, content_type,
              media_path, media_mime, media_filename, media_ref, media_state
         FROM messages WHERE id = ?`,
      messageId,
    );
  }

  /**
   * Recupera la referencia de media de un mensaje guardado sin ella: pide al
   * teléfono el tramo del chat justo anterior al mensaje siguiente (historial
   * bajo demanda). Al llegar, `backfillMediaRef` completa la referencia de este
   * mensaje y de los vecinos que tampoco la tenían.
   */
  private async recoverMediaRef(
    session: WaSession,
    row: NonNullable<ReturnType<SessionManager['mediaRow']>>,
  ): Promise<string | null> {
    if (!row.session_id || !row.wa_message_id) return null;
    const anchor = get<{ wa_message_id: string; direction: string; occurred_at: string; sender_jid: string | null }>(
      `SELECT wa_message_id, direction, occurred_at, sender_jid FROM messages
        WHERE session_id = ? AND chat_id = ? AND wa_message_id IS NOT NULL
          AND (occurred_at > ? OR (occurred_at = ? AND id > ?))
        ORDER BY occurred_at ASC, id ASC LIMIT 1`,
      row.session_id,
      row.chat_id,
      row.occurred_at,
      row.occurred_at,
      row.id,
    );
    if (!anchor) {
      logger.info({ messageId: row.id }, 'Sin mensaje posterior para pedir el historial: no se puede recuperar la media');
      return null;
    }
    const ts = Date.parse(anchor.occurred_at);
    const isGroup = row.chat_id.endsWith('@g.us');
    // WhatsApp identifica muchos chats por LID: se prueba primero con el LID y,
    // si el teléfono no responde, con el número.
    const pnJid = (jid: string | null) => (jid && jid.endsWith('@c.us') ? jid.replace('@c.us', '@s.whatsapp.net') : jid);
    const participant = isGroup && anchor.sender_jid ? lidForPhone(anchor.sender_jid) ?? pnJid(anchor.sender_jid) : null;
    const targets = isGroup ? [row.chat_id] : [lidForPhone(row.chat_id), row.chat_id].filter((x): x is string => !!x);
    for (const target of targets) {
      try {
        await session.fetchHistory(target, 30, {
          id: anchor.wa_message_id,
          fromMe: anchor.direction === 'out',
          timestampMs: Number.isFinite(ts) ? ts : Date.now(),
          participant,
        });
      } catch (err) {
        logger.info({ messageId: row.id, target, err: (err as Error).message }, 'No se pudo pedir el historial al teléfono');
        continue;
      }
      // La respuesta llega por `messaging-history.set` y pasa por la cola de entrada.
      for (let i = 0; i < 16; i++) {
        const ref = get<{ media_ref: string | null }>('SELECT media_ref FROM messages WHERE id = ?', row.id)?.media_ref;
        if (ref) return ref;
        await delay(500);
      }
      logger.info({ messageId: row.id, target }, 'El teléfono no respondió el pedido de historial');
    }
    return null;
  }

  /** Completa la referencia de media de un mensaje ya guardado sin ella. */
  private backfillMediaRef(sessionId: string, msg: InboundMessage): void {
    if (!msg.mediaRef || !msg.id) return;
    try {
      const res = run(
        `UPDATE messages SET media_ref = ?, media_state = NULL
          WHERE session_id = ? AND wa_message_id = ? AND media_ref IS NULL`,
        msg.mediaRef,
        sessionId,
        msg.id,
      );
      if (res.changes && msg.offline) {
        const row = get<{ id: number; media_path: string | null }>(
          'SELECT id, media_path FROM messages WHERE session_id = ? AND wa_message_id = ? LIMIT 1',
          sessionId,
          msg.id,
        );
        if (row && !row.media_path) this.queueMediaDownload(row.id);
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'No se pudo completar la referencia de media');
    }
  }

  /** Nombre a mostrar de la conversación: asunto del grupo o pushName. */
  private async conversationName(sessionId: string, msg: InboundMessage): Promise<string | null> {
    // En un mensaje propio el pushName es el del dueño del número, no el del contacto.
    if (!msg.isGroup) return msg.fromMe ? null : msg.pushName ?? null;
    const contact = get<{ name: string | null }>(
      'SELECT name FROM contacts WHERE session_id = ? AND chat_id = ?',
      sessionId,
      msg.chatId,
    );
    if (contact?.name) return contact.name;
    const session = this.sessions.get(sessionId);
    const subject = await session?.groupSubject(msg.chatId);
    return subject ?? null;
  }

  /**
   * Mensajes que llegan por `messaging-history.set` (sync bajo demanda o al
   * reconectar). Se guardan sin webhook ni auto-respuesta, evitando duplicados.
   */
  private async onHistory(sessionId: string, msg: InboundMessage): Promise<void> {
    const row = this.byId(sessionId);
    if (!row) return;
    if (!isInboxChat(msg.chatId)) return;
    if (!isStorableType(msg.type)) return;
    if (msg.id && this.messageExists(sessionId, msg.id)) {
      // Ya guardado (p. ej. por una versión anterior sin referencia de media):
      // se completa la referencia para poder descargar el archivo.
      this.backfillMediaRef(sessionId, msg);
      this.backfillSender(sessionId, msg);
      return;
    }

    const convName = await this.conversationName(sessionId, msg);

    let mediaPath: string | null = null;
    if (msg.mediaBuffer && msg.mediaMime) {
      try {
        mediaPath = storeIncoming(msg.mediaBuffer, msg.mediaMime, msg.filename);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'No se pudo guardar media del historial');
      }
    }

    // La media del historial se baja recién cuando alguien abre el mensaje.
    if (msg.fromMe) {
      this.persistOutbound(sessionId, msg.chatId, null, msg.type, msg.body, msg.mediaMime, mediaPath, msg.id, msg.seconds, msg.filename, 'phone', msg.timestamp, {
        mediaRef: msg.mediaRef ?? null,
        replyToWaId: msg.quotedWaId ?? null,
      });
    } else {
      // Entrante del historial: se guarda como leído (no genera tildes azules al
      // abrir el chat); si sigue sin leer en el teléfono, lo indica `chat-unread`.
      this.persistInbound(sessionId, row.phone ?? null, msg, mediaPath, 'read');
    }
    this.upsertConversation(
      sessionId,
      msg.chatId,
      convName,
      msg.fromMe ? 'out' : 'in',
      // El historial NO suma no leídos: son mensajes viejos que en general ya se
      // leyeron en el teléfono. El contador real llega con los chats del
      // historial (`chat-unread`) y con los recibos `read-self`.
      false,
      messagePreview(msg.body, msg.type),
      new Date(msg.timestamp * 1000).toISOString(),
    );
    if (msg.isGroup && convName) setContactGroup(sessionId, msg.chatId, convName);
    // Historial (no un mensaje en vivo): el panel refresca el hilo, pero no debe
    // sonar ni avisar como si acabara de llegar.
    panelBus.publish('message', { sessionId, chatId: msg.chatId, direction: msg.fromMe ? 'out' : 'in', history: true, content_type: msg.type, occurred_at: new Date(msg.timestamp * 1000).toISOString() });
  }

  /**
   * Mensaje de grupo guardado sin autor (versiones anteriores no lo tomaban del
   * historial): al volver a recibirlo se completan su número y su nombre.
   */
  private backfillSender(sessionId: string, msg: InboundMessage): void {
    if (!msg.isGroup || msg.fromMe || !msg.id || (!msg.senderJid && !msg.pushName)) return;
    run(
      `UPDATE messages SET sender_jid = COALESCE(sender_jid, ?), contact_name = COALESCE(contact_name, ?)
        WHERE session_id = ? AND wa_message_id = ? AND (sender_jid IS NULL OR contact_name IS NULL)`,
      msg.senderJid ?? null,
      msg.pushName ?? null,
      sessionId,
      msg.id,
    );
  }

  /** ¿Ya existe un mensaje con ese id de WhatsApp en la sesión? */
  private messageExists(sessionId: string, waMessageId: string): boolean {
    const row = get<{ c: number }>('SELECT COUNT(*) c FROM messages WHERE session_id = ? AND wa_message_id = ?', sessionId, waMessageId);
    return (row?.c ?? 0) > 0;
  }

  private persistInbound(
    sessionId: string,
    sessionPhone: string | null,
    msg: InboundMessage,
    mediaPath: string | null,
    status: 'received' | 'read' = 'received',
  ): number {
    const result = run(
      `INSERT INTO messages (session_id, session_phone, chat_id, contact_name, direction, content_type, body, media_mime, media_path, media_filename, media_seconds, wa_message_id, reply_to_wa_id, sender_jid, media_ref, media_state, sender_type, status, occurred_at, created_at)
       VALUES (?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'customer', ?, ?, ?)`,
      sessionId,
      sessionPhone,
      msg.chatId,
      msg.pushName,
      msg.type,
      msg.body,
      msg.mediaMime,
      mediaPath,
      msg.filename,
      msg.seconds,
      msg.id,
      msg.quotedWaId ?? null,
      msg.senderJid ?? null,
      msg.mediaRef ?? null,
      mediaPath ? 'ok' : null,
      status,
      new Date(msg.timestamp * 1000).toISOString(),
      nowIso(),
    );
    if (msg.quotedWaId && (msg.quotedSender || msg.quotedBody)) {
      run(
        'UPDATE messages SET reply_to_sender = ?, reply_to_body = ? WHERE id = ?',
        msg.quotedSender ?? null,
        msg.quotedBody ?? null,
        result.lastInsertRowid,
      );
    }
    return result.lastInsertRowid;
  }

  private async onAck(sessionId: string, ack: { messageId: string; status: string }): Promise<void> {
    run('UPDATE messages SET status = ? WHERE wa_message_id = ?', ack.status, ack.messageId);
    run('UPDATE batch_items SET status = ? WHERE message_id = ? AND status = ?', 'sent', ack.messageId, 'pending');
    panelBus.publish('ack', { sessionId, messageId: ack.messageId, status: ack.status });
    if (ack.status === 'failed') {
      const row = get<{ chat_id: string }>('SELECT chat_id FROM messages WHERE wa_message_id = ? LIMIT 1', ack.messageId);
      if (row?.chat_id) markBlocked(row.chat_id, 'Fallo de entrega reportado por WhatsApp', sessionId);
      recomputeHealth(sessionId, { lastError: 'Fallo de entrega reportado por WhatsApp' });
    }
    await dispatchEvent(sessionId, 'message.ack', { messageId: ack.messageId, status: ack.status });
  }

  private async onPresence(sessionId: string, p: { chatId: string; typing: boolean }): Promise<void> {
    panelBus.publish('presence', { sessionId, chatId: p.chatId, typing: p.typing });
    await dispatchEvent(sessionId, 'presence.update', {
      chatId: p.chatId,
      participants: [{ state: p.typing ? 'composing' : 'paused' }],
    });
  }

  /** Registra una reaccion entrante (del cliente o del propio telefono). */
  private handleReaction(sessionId: string, msg: InboundMessage): void {
    const targetWaId = msg.reaction?.targetWaId;
    const emoji = msg.reaction?.emoji ?? '';
    if (!targetWaId) return;
    const target = get<{ id: number }>(
      'SELECT id FROM messages WHERE session_id = ? AND wa_message_id = ? LIMIT 1',
      sessionId,
      targetWaId,
    );
    if (!target) return;
    const actorType = msg.fromMe ? 'agent' : 'customer';
    // En grupos el reactor es un participante concreto, no el grupo: sin esto
    // todos aparecían como una sola reacción sin saber quién la puso.
    const actorId = msg.fromMe ? '' : msg.senderJid ? resolveChatId(msg.senderJid) : msg.chatId;
    // Reacciones guardadas por versiones anteriores en grupos: se les puso el JID
    // del grupo (no se sabía quién). Si ahora llega la misma reacción con autor,
    // se borra la vieja para no contarla dos veces.
    if (!msg.fromMe && msg.chatId.endsWith('@g.us') && actorId !== msg.chatId && emoji) {
      run(
        `DELETE FROM message_reactions
          WHERE message_id = ? AND actor_type = 'customer' AND actor_id = ? AND emoji = ?`,
        target.id,
        msg.chatId,
        emoji,
      );
    }
    setReaction(target.id, sessionId, msg.chatId, actorType, actorId, emoji);
    panelBus.publish('reaction', { sessionId, chatId: msg.chatId, messageId: target.id });
  }

  /** Trae la foto de perfil del contacto una vez por chat (best-effort). */
  /** Trae la foto de perfil del chat si todavía no la hay (la usa el panel al abrir un chat). */
  ensureAvatar(sessionId: string, chatId: string): void {
    void this.refreshAvatar(sessionId, chatId);
  }

  /**
   * Foto de perfil de un participante de grupo: la guardada para esa persona
   * (en cualquier línea) o, si no hay, se pide a WhatsApp una sola vez.
   */
  async participantAvatar(sessionId: string, jid: string): Promise<string | null> {
    const chatId = resolveChatId(jid);
    if (!chatId || chatId.endsWith('@g.us')) return null;
    const key = chatId.endsWith('@lid') ? null : phoneKeyOf(chatId);
    const find = () => {
      const rows = key
        ? all<{ avatar_path: string }>(
            'SELECT avatar_path FROM contacts WHERE phone_key = ? AND avatar_path IS NOT NULL ORDER BY updated_at DESC',
            key,
          )
        : all<{ avatar_path: string }>(
            'SELECT avatar_path FROM contacts WHERE chat_id = ? AND avatar_path IS NOT NULL',
            chatId,
          );
      return rows.map((r) => r.avatar_path).find((p) => fs.existsSync(p)) ?? null;
    };
    const found = find();
    if (found) return found;
    await this.refreshAvatar(sessionId, chatId);
    return find();
  }

  private async refreshAvatar(sessionId: string, chatId: string): Promise<void> {
    const key = `${sessionId}:${chatId}`;
    if (this.avatarTried.has(key)) return;
    this.avatarTried.add(key);
    try {
      const contact = get<{ avatar_path: string | null }>(
        'SELECT avatar_path FROM contacts WHERE session_id = ? AND chat_id = ?',
        sessionId,
        chatId,
      );
      // Si ya hay foto y el archivo existe, no se vuelve a pedir.
      if (contact?.avatar_path && fs.existsSync(contact.avatar_path)) return;
      const session = this.sessions.get(sessionId);
      if (!session?.isReady()) return;
      const url = await session.profilePictureUrl(chatId);
      if (!url) return;
      const res = await fetch(url);
      if (!res.ok) return;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length) return;
      const filePath = storeAvatar(buffer, res.headers.get('content-type') ?? 'image/jpeg');
      setAvatar(sessionId, chatId, filePath);
      panelBus.publish('conversation', { sessionId, chatId });
    } catch (err) {
      logger.warn({ err: (err as Error).message, sessionId, chatId }, 'No se pudo traer la foto de perfil');
    }
  }

  // ── Persistencia ─────────────────────────────────────────────────────────────
  private persistOutbound(
    sessionId: string,
    chatId: string,
    contactName: string | null,
    contentType: string,
    body: string | null,
    mediaMime: string | null,
    mediaPath: string | null,
    messageId: string | null,
    seconds: number | null = null,
    filename: string | null = null,
    origin: string | null = null,
    timestampSec?: number,
    extra: { replyToWaId?: string | null; senderUid?: number | null; mediaRef?: string | null } = {},
  ): number {
    const row = this.byId(sessionId);
    const occurredAt = timestampSec ? new Date(timestampSec * 1000).toISOString() : nowIso();
    const result = run(
      `INSERT INTO messages (session_id, session_phone, chat_id, contact_name, direction, content_type, body, media_mime, media_path, media_filename, media_seconds, wa_message_id, origin, reply_to_wa_id, media_ref, media_state, sender_type, sender_uid, status, occurred_at, created_at)
       VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, 'sent', ?, ?)`,
      sessionId,
      row?.phone ?? null,
      chatId,
      contactName,
      contentType,
      body,
      mediaMime,
      mediaPath,
      filename,
      seconds,
      messageId,
      origin,
      extra.replyToWaId ?? null,
      extra.mediaRef ?? null,
      mediaPath ? 'ok' : null,
      extra.senderUid ?? null,
      occurredAt,
      nowIso(),
    );
    this.upsertConversation(sessionId, chatId, contactName, 'out', false, messagePreview(body, contentType), occurredAt);
    return result.lastInsertRowid;
  }

  private upsertConversation(
    sessionId: string,
    chatId: string,
    contactName: string | null,
    direction: 'in' | 'out',
    incrementUnread: boolean,
    lastText: string | null = null,
    occurredAt: string | null = null,
  ): void {
    const row = this.byId(sessionId);
    let contactId: number | null = null;
    try {
      contactId = contactIdFor(sessionId, chatId);
    } catch {
      contactId = null;
    }
    // El historial se guarda por bloques: solo se actualiza el "último mensaje"
    // (fecha, texto y dirección) si el mensaje es más reciente que el guardado.
    run(
      `INSERT INTO conversations (session_id, whatsapp_phone, chat_id, contact_name, last_message_at, last_message_text, contact_id, unread_count, last_direction, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, chat_id) DO UPDATE SET
         contact_name = COALESCE(excluded.contact_name, conversations.contact_name),
         last_message_at = CASE WHEN excluded.last_message_at >= COALESCE(conversations.last_message_at, '') THEN excluded.last_message_at ELSE conversations.last_message_at END,
         last_message_text = CASE WHEN excluded.last_message_at >= COALESCE(conversations.last_message_at, '') THEN COALESCE(excluded.last_message_text, conversations.last_message_text) ELSE conversations.last_message_text END,
         last_direction = CASE WHEN excluded.last_message_at >= COALESCE(conversations.last_message_at, '') THEN excluded.last_direction ELSE conversations.last_direction END,
         contact_id = COALESCE(excluded.contact_id, conversations.contact_id),
         unread_count = conversations.unread_count + ?,
         updated_at = excluded.updated_at`,
      sessionId,
      row?.phone ?? null,
      chatId,
      contactName,
      occurredAt ?? nowIso(),
      lastText,
      contactId,
      incrementUnread ? 1 : 0,
      direction,
      nowIso(),
      nowIso(),
      incrementUnread ? 1 : 0,
    );
  }

  /** Arranca las sesiones previamente vinculadas (creds.json presente). */
  async autoStart(): Promise<void> {
    for (const row of this.list()) {
      if (row.status === 'disconnected') continue;
      const creds = path.join(path.resolve(config.authDir), row.name, 'creds.json');
      if (!fs.existsSync(creds)) continue;
      try {
        await this.start(row.id);
      } catch (err) {
        logger.warn({ sessionId: row.id, err: (err as Error).message }, 'No se pudo autoarrancar la sesión');
      }
    }
  }

  /** Teléfono de una sesión (para health). */
  phoneOf(sessionId: string): string | null {
    return this.byId(sessionId)?.phone ?? null;
  }

  /** Suscribe la presencia de un chat (para "escribiendo…"). */
  async subscribePresence(sessionId: string, chatId: string): Promise<void> {
    const session = await this.instance(sessionId);
    await session.presenceSubscribe(chatId);
  }

  /**
   * Marca la conversación como leída: resetea el contador local y envía el acuse
   * de lectura real a WhatsApp para los mensajes entrantes pendientes.
   */
  async markChatRead(sessionId: string, chatId: string): Promise<void> {
    run(
      'UPDATE conversations SET unread_count = 0, updated_at = ? WHERE session_id = ? AND chat_id = ?',
      nowIso(),
      sessionId,
      chatId,
    );
    const session = this.sessions.get(sessionId);
    if (!session?.isReady()) return;

    const rows = all<{ wa_message_id: string | null; sender_jid: string | null }>(
      `SELECT wa_message_id, sender_jid FROM messages
       WHERE session_id = ? AND chat_id = ? AND direction = 'in'
         AND wa_message_id IS NOT NULL AND COALESCE(status, '') <> 'read'
       ORDER BY id DESC LIMIT 200`,
      sessionId,
      chatId,
    );
    if (!rows.length) return;

    await session.readMessages(
      chatId,
      rows.map((r) => ({ id: String(r.wa_message_id), fromMe: false, participant: r.sender_jid })),
    );
    run(
      `UPDATE messages SET status = 'read'
       WHERE session_id = ? AND chat_id = ? AND direction = 'in' AND COALESCE(status, '') <> 'read'`,
      sessionId,
      chatId,
    );
    panelBus.publish('read', { sessionId, chatId });
  }

  /** Registra el texto transcrito de un mensaje. */
  saveTranscription(messageId: number, text: string): void {
    run('UPDATE messages SET transcription = ? WHERE id = ?', text, messageId);
  }

  /**
   * Ancla para `fetchMessageHistory`: el mensaje más antiguo guardado del chat,
   * que Baileys necesita como `oldestMsgKey` (con su timestamp en ms).
   */
  private historyAnchor(
    sessionId: string,
    chatId: string,
  ): { id: string; fromMe: boolean; timestampMs: number } | null {
    const row = get<{ wa_message_id: string | null; direction: string; occurred_at: string }>(
      `SELECT wa_message_id, direction, occurred_at FROM messages
        WHERE session_id = ? AND chat_id = ? AND wa_message_id IS NOT NULL
        ORDER BY occurred_at ASC, id ASC LIMIT 1`,
      sessionId,
      chatId,
    );
    if (!row?.wa_message_id) return null;
    const ts = Date.parse(row.occurred_at);
    return {
      id: String(row.wa_message_id),
      fromMe: row.direction === 'out',
      timestampMs: Number.isFinite(ts) ? ts : Date.now(),
    };
  }

  /**
   * Sincroniza bajo demanda el historial de un chat: pide a WhatsApp los últimos
   * mensajes (`fetchMessageHistory`), que llegan por el evento `history` y se
   * persisten. Devuelve cuántos mensajes nuevos quedaron guardados.
   */
  async syncHistory(sessionId: string, chatId: string, count = 50): Promise<{ requested: number; before: number; added: number }> {
    const session = await this.requireReady(sessionId);
    const before = get<{ c: number }>('SELECT COUNT(*) c FROM messages WHERE session_id = ? AND chat_id = ?', sessionId, chatId)?.c ?? 0;
    const anchor = this.historyAnchor(sessionId, chatId);
    if (!anchor) {
      // Sin un mensaje almacenado no hay ancla para pedir historial anterior.
      return { requested: 0, before, added: 0 };
    }
    const { requested } = await session.fetchHistory(chatId, count, anchor);
    const added = (get<{ c: number }>('SELECT COUNT(*) c FROM messages WHERE session_id = ? AND chat_id = ?', sessionId, chatId)?.c ?? 0) - before;
    run('UPDATE conversations SET history_synced_at = ?, updated_at = ? WHERE session_id = ? AND chat_id = ?', nowIso(), nowIso(), sessionId, chatId);
    audit('history.synced', { session_id: sessionId, chat_id: chatId, requested, added });
    return { requested, before, added };
  }

  /**
   * Sincronización inicial de historial de los chats conocidos de una sesión.
   * Se ejecuta **una sola vez por sesión** (marca persistida en `configs`): a
   * partir de ahí, los mensajes que llegan mientras el servicio no está activo
   * se recuperan solos con los eventos offline (`append`). Al desvincular no se
   * borra la marca ni el historial guardado, así que una re-vinculación no
   * vuelve a sincronizar todo.
   */
  private async resumeHistories(sessionId: string): Promise<void> {
    if (!config.historySync.onReady) return;
    if (this.resuming.has(sessionId)) return;
    if (getConfig(`history_session_synced:${sessionId}`) === '1') return;
    this.resuming.add(sessionId);
    try {
      const ageLimit = new Date(Date.now() - config.historySync.maxAgeDays * 86_400_000).toISOString();
      const freshLimit = new Date(Date.now() - config.historySync.skipFreshHours * 3_600_000).toISOString();
      const rows = all<{ chat_id: string }>(
        `SELECT chat_id FROM conversations
         WHERE session_id = ?
           AND COALESCE(last_message_at, updated_at) >= ?
           AND (history_synced_at IS NULL OR history_synced_at < ?)
         ORDER BY COALESCE(last_message_at, updated_at) DESC
         LIMIT ?`,
        sessionId,
        ageLimit,
        freshLimit,
        config.historySync.maxChats,
      );
      if (!rows.length) return;
      logger.info({ sessionId, chats: rows.length }, 'Sincronizando historial de chats conocidos');
      for (const { chat_id: chatId } of rows) {
        const session = this.sessions.get(sessionId);
        if (!session?.isReady()) break;
        const anchor = this.historyAnchor(sessionId, chatId);
        if (!anchor) continue;
        try {
          await session.fetchHistory(chatId, config.historySync.count, anchor);
          run(
            'UPDATE conversations SET history_synced_at = ?, updated_at = ? WHERE session_id = ? AND chat_id = ?',
            nowIso(),
            nowIso(),
            sessionId,
            chatId,
          );
        } catch (err) {
          logger.warn({ sessionId, chatId, err: (err as Error).message }, 'No se pudo sincronizar el historial del chat');
        }
      }
      // Marca persistida: no se repite en las próximas reconexiones.
      setConfig(`history_session_synced:${sessionId}`, '1');
      logger.info({ sessionId }, 'Sincronización inicial de historial completada (no se repetirá)');
    } catch (err) {
      logger.warn({ sessionId, err: (err as Error).message }, 'Error sincronizando historiales');
    } finally {
      this.resuming.delete(sessionId);
    }
  }

  /** ¿La sesión tiene el número autorizado verificado? */
  isConnected(sessionId: string): boolean {
    const row = this.byId(sessionId);
    return !!row && (row.status === 'ready');
  }

  chatPhone(chatId: string): string {
    return phoneFromChatId(chatId);
  }
}
