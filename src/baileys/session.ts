import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  downloadMediaMessage,
  Browsers,
  proto,
  type WASocket,
  type WAMessage,
  type WAMessageKey,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { logger, baileysLogger } from '../logger.js';
import { delay, randInt } from '../util/async.js';
import { phoneFromJid, typeForMime } from '../core/phone.js';
import { rememberLid, resolveChatId, phoneForLid } from '../core/lid.js';
import { applySignalPatch } from './signal-patch.js';

applySignalPatch();

/** Tipos de mensaje con archivo adjunto descargable. */
const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];

/** `messageStubType` de Baileys para un mensaje que no se pudo descifrar. */
const STUB_CIPHERTEXT = 2;

/** Mensajes enviados recordados para responder reintentos de descifrado. */
const SENT_CACHE_SIZE = 3000;

/**
 * Vigilantes contra la sesión "conectada pero sorda" (defectos de Baileys 6.7.x):
 * - el mutex que procesa cada mensaje entrante no tiene tiempo máximo; si una
 *   tarea se cuelga (p. ej. la descarga de un bloque de historial al reconectar),
 *   todos los mensajes siguientes quedan esperando para siempre;
 * - el búfer de eventos solo se vacía por su máquina de estados, sin límite.
 */
const PROCESSING_TIMEOUT_MS = Number(process.env.WATCHDOG_TASK_TIMEOUT_MS) || 90_000;
const BUFFER_MAX_MS = Number(process.env.WATCHDOG_BUFFER_MAX_MS) || 60_000;
/** Bloqueos del mutex en esta ventana que fuerzan a reabrir la conexión. */
const STALLS_TO_RECONNECT = 2;
const STALL_WINDOW_MS = 15 * 60_000;
const TIMED_OUT = Symbol('timed-out');

/**
 * Serializa la parte necesaria de un mensaje con media (clave + contenido) para
 * poder descargar el archivo más tarde (al abrirlo en el panel).
 */
function mediaRefFor(raw: WAMessage): string | null {
  try {
    const message = proto.Message.fromObject(raw.message ?? {});
    const key = raw.key ?? {};
    return JSON.stringify({
      key: {
        remoteJid: key.remoteJid ?? null,
        id: key.id ?? null,
        fromMe: !!key.fromMe,
        participant: key.participant ?? null,
      },
      message: message.toJSON(),
      ts: Number(raw.messageTimestamp ?? 0),
    });
  } catch {
    return null;
  }
}

/** Reconstruye el mensaje guardado por `mediaRefFor`. */
function mediaRefToMessage(ref: string): WAMessage | null {
  try {
    const data = JSON.parse(ref);
    if (!data?.message) return null;
    return {
      key: {
        remoteJid: data.key?.remoteJid ?? undefined,
        id: data.key?.id ?? undefined,
        fromMe: !!data.key?.fromMe,
        participant: data.key?.participant ?? undefined,
      },
      message: proto.Message.fromObject(data.message),
      messageTimestamp: data.ts || undefined,
    } as WAMessage;
  } catch {
    return null;
  }
}

/**
 * Resuelve la versión de WhatsApp Web. Si `BAILEYS_WA_VERSION` está definida
 * (formato `2,3000,1043857760`) se usa esa; si no, la que resuelva Baileys.
 */
async function resolveWaVersion(): Promise<[number, number, number]> {
  const pinned = (config.waVersion ?? '').trim();
  if (pinned) {
    const parts = pinned.split(/[.,\s]+/).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
    if (parts.length >= 3) return [parts[0], parts[1], parts[2]];
  }
  try {
    const { version } = await fetchLatestBaileysVersion();
    return version;
  } catch {
    return [2, 3000, 1043857760];
  }
}

export type SessionStatus =
  | 'created'
  | 'connecting'
  | 'qr'
  | 'ready'
  | 'disconnected'
  | 'blocked';

export interface InboundMessage {
  id: string;
  chatId: string;
  fromMe: boolean;
  isGroup: boolean;
  pushName: string | null;
  type: string;
  body: string | null;
  timestamp: number;
  mediaMime: string | null;
  mediaBuffer: Buffer | null;
  filename: string | null;
  seconds: number | null;
  raw: WAMessage;
  /** JID del participante que escribio (mensajes de grupo). */
  senderJid?: string | null;
  /** wamid del mensaje citado (respuesta con `contextInfo.stanzaId`). */
  quotedWaId?: string | null;
  /** Reaccion entrante: apunta a un wamid y trae el emoji. */
  reaction?: { targetWaId: string; emoji: string } | null;
  /** Referencia serializada para descargar la media más tarde (si no se bajó). */
  mediaRef?: string | null;
  /** `true` si llegó con el socket desconectado (evento `append`). */
  offline?: boolean;
}

/** Mensaje que no se pudo descifrar (sesión de cifrado desfasada). */
export interface DecryptFailure {
  chatId: string;
  fromMe: boolean;
  error: string;
  offline: boolean;
}

/** Referencia minima de un mensaje citado para armar el `quoted` de Baileys. */
export interface QuotedRef {
  id: string;
  fromMe: boolean;
  body?: string | null;
  /** Participante autor en grupos (necesario para citar mensajes de grupo). */
  participant?: string | null;
}

function buildQuoted(chatId: string, quoted: QuotedRef): any {
  const jid = toBaileysJid(chatId);
  return {
    key: {
      remoteJid: jid,
      id: quoted.id,
      fromMe: quoted.fromMe,
      ...(quoted.participant ? { participant: quoted.participant } : {}),
    },
    message: { conversation: quoted.body ?? '' },
  };
}

/** Mensaje servido al UI (normalizado desde la BD). */
export interface HistoryMessage {
  id: number;
  direction: 'in' | 'out' | 'unknown';
  content_type: string;
  body: string | null;
  occurred_at: string;
}

export interface WaSessionOptions {
  /** Nombre de sesión = carpeta de credenciales. */
  name: string;
  proxyUrl?: string | null;
  /**
   * Contenido de un mensaje enviado buscado en la BD (texto). Respaldo de
   * `getMessage` cuando el reintento llega después de un reinicio del servicio.
   */
  lookupSent?: (waMessageId: string) => proto.IMessage | undefined;
}

/** Por qué se cerró la conexión, explicado para quien tiene que resolverlo. */
export interface DisconnectInfo {
  code: number | null;
  /** Clave estable: logged_out, banned, replaced, bad_session, restart, network, unknown. */
  kind: string;
  title: string;
  detail: string;
  /** Qué hacer para volver a conectar. */
  action: string;
  at: string;
}

export function explainDisconnect(code: number | null | undefined, message?: string | null): DisconnectInfo {
  const at = new Date().toISOString();
  const c = typeof code === 'number' ? code : null;
  const base = { code: c, at };
  if (c === DisconnectReason.loggedOut) {
    return {
      ...base,
      kind: 'logged_out',
      title: 'WhatsApp cerró la sesión de este dispositivo',
      detail:
        'El vínculo se cerró desde el teléfono (Dispositivos vinculados) o WhatsApp lo dio de baja, algo frecuente después de muchos envíos seguidos a números que no tienen guardado el contacto. Las credenciales ya no sirven y se borraron.',
      action: 'Generá un QR nuevo y escanealo desde WhatsApp › Dispositivos vinculados. Antes de volver a enviar en masa, revisá el ritmo en Anti-Baneo.',
    };
  }
  if (c === 403) {
    return {
      ...base,
      kind: 'banned',
      title: 'WhatsApp bloqueó el acceso de este número',
      detail:
        'WhatsApp rechazó la conexión (403). Suele indicar que el número fue restringido o suspendido por reportes o por volumen de mensajes. Las credenciales se borraron.',
      action:
        'Abrí WhatsApp en el teléfono: si muestra un aviso de cuenta suspendida, seguí los pasos para solicitar la revisión. Cuando el teléfono funcione normalmente, generá un QR nuevo. Esperá unas horas antes de volver a enviar en masa.',
    };
  }
  if (c === DisconnectReason.connectionReplaced) {
    return {
      ...base,
      kind: 'replaced',
      title: 'Otra conexión abrió esta misma sesión',
      detail:
        'WhatsApp cerró esta conexión porque se abrió otra con las mismas credenciales (por ejemplo, el servicio corriendo dos veces en el servidor). Dos conexiones a la vez dañan el cifrado y los contactos ven «Esperando el mensaje».',
      action:
        'Cerrá WhatsApp Web u otro sistema que use este mismo vínculo, verificá que el servicio corra una sola vez (systemctl status esam-seguimiento) y después usá «Reconectar».',
    };
  }
  if (c === DisconnectReason.badSession) {
    return {
      ...base,
      kind: 'bad_session',
      title: 'Las claves de cifrado quedaron dañadas',
      detail: 'WhatsApp informó una sesión de cifrado inválida. Se regeneran las claves por contacto sin desvincular el número.',
      action: 'Si el problema sigue, usá «Reparar cifrado» y, como último recurso, «Desvincular y generar QR».',
    };
  }
  if (c === DisconnectReason.restartRequired) {
    return { ...base, kind: 'restart', title: 'WhatsApp pidió reiniciar la conexión', detail: 'Es normal después de escanear el QR.', action: 'Se reconecta solo.' };
  }
  if (c === DisconnectReason.timedOut || c === DisconnectReason.connectionLost || c === DisconnectReason.connectionClosed) {
    return {
      ...base,
      kind: 'network',
      title: 'Se perdió la conexión con WhatsApp',
      detail: 'Corte de red o de los servidores de WhatsApp.',
      action: 'Se reconecta solo. Si sigue así varios minutos, revisá la red del servidor y el teléfono.',
    };
  }
  return {
    ...base,
    kind: 'unknown',
    title: 'La conexión se cerró',
    detail: message ? `Detalle técnico: ${message}` : 'WhatsApp cerró la conexión sin dar un motivo.',
    action: 'Se intenta reconectar sola. Si no vuelve, probá «Reconectar» o «Desvincular y generar QR».',
  };
}

/** Traduce un chatId del contrato OpenWA (`@c.us`) al JID de Baileys. */
export function toBaileysJid(chatId: string): string {
  if (chatId.endsWith('@g.us') || chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@lid')) {
    return chatId;
  }
  const digits = chatId.replace(/\D+/g, '');
  return `${digits}@s.whatsapp.net`;
}

/** Traduce un JID de Baileys al contrato OpenWA (`@c.us` para individuales). */
export function toContractJid(jid: string | null | undefined): string {
  if (!jid) return '';
  if (jid.endsWith('@g.us') || jid.endsWith('@lid')) return jid;
  return jid.replace('@s.whatsapp.net', '@c.us');
}

function unwrapMessage(message: any): any {
  if (!message) return {};
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage?.message) return unwrapMessage(message.documentWithCaptionMessage.message);
  if (message.deviceSentMessage?.message) return unwrapMessage(message.deviceSentMessage.message);
  if (message.editedMessage?.message) return unwrapMessage(message.editedMessage.message);
  return message;
}

function describe(message: any): { type: string; body: string | null; mime: string | null; filename: string | null; seconds: number | null } {
  const m = unwrapMessage(message);
  if (m.conversation) return { type: 'text', body: m.conversation, mime: null, filename: null, seconds: null };
  if (m.extendedTextMessage) return { type: 'text', body: m.extendedTextMessage.text ?? null, mime: null, filename: null, seconds: null };
  if (m.imageMessage) return { type: 'image', body: m.imageMessage.caption ?? null, mime: m.imageMessage.mimetype ?? 'image/jpeg', filename: null, seconds: null };
  if (m.videoMessage) return { type: 'video', body: m.videoMessage.caption ?? null, mime: m.videoMessage.mimetype ?? 'video/mp4', filename: null, seconds: m.videoMessage.seconds ?? null };
  if (m.audioMessage) return { type: 'audio', body: null, mime: m.audioMessage.mimetype ?? 'audio/ogg', filename: null, seconds: m.audioMessage.seconds ?? null };
  if (m.documentMessage) {
    return {
      type: 'document',
      body: m.documentMessage.caption ?? null,
      mime: m.documentMessage.mimetype ?? 'application/octet-stream',
      filename: m.documentMessage.fileName ?? null,
      seconds: null,
    };
  }
  if (m.stickerMessage) return { type: 'sticker', body: null, mime: m.stickerMessage.mimetype ?? 'image/webp', filename: null, seconds: null };
  if (m.locationMessage) return { type: 'location', body: null, mime: null, filename: null, seconds: null };
  if (m.contactMessage) return { type: 'contact', body: m.contactMessage.displayName ?? null, mime: null, filename: null, seconds: null };
  if (m.reactionMessage) return { type: 'reaction', body: m.reactionMessage.text ?? null, mime: null, filename: null, seconds: null };
  if (m.protocolMessage) return { type: 'protocol', body: null, mime: null, filename: null, seconds: null };
  return { type: 'unknown', body: null, mime: null, filename: null, seconds: null };
}

/**
 * Una sesión de WhatsApp sobre Baileys (WebSocket, sin navegador).
 * Emite eventos internos que el SessionManager traduce a webhooks/BD.
 */
export class WaSession extends EventEmitter {
  status: SessionStatus = 'created';
  phone: string | null = null;
  qrDataUrl: string | null = null;
  lastError: string | null = null;
  private sock: WASocket | null = null;
  private reconnecting = false;
  /** Arranque de socket en curso (evita abrir dos a la vez). */
  private connecting: Promise<void> | null = null;
  /** Vigilante del búfer de eventos del socket actual. */
  private watchTimer: NodeJS.Timeout | null = null;
  /** Instantes de los últimos bloqueos del mutex (para decidir reconectar). */
  private stalls: number[] = [];
  /** Último evento recibido de WhatsApp (diagnóstico de salud). */
  lastInboundAt: number | null = null;
  private authPath: string;
  /** Asunto de grupo cacheado por JID (evita `groupMetadata` repetido). */
  private groupNames = new Map<string, string>();
  /** Consultas de asunto en curso / fallidas recientes (evita ráfagas al servidor). */
  private groupLookups = new Map<string, Promise<string | null>>();
  private groupMisses = new Map<string, number>();
  /**
   * Contenido de los últimos mensajes enviados. WhatsApp lo pide (`getMessage`)
   * cuando el destinatario no pudo descifrar y solicita un reenvío; sin esto el
   * contacto ve "Esperando el mensaje…" para siempre.
   */
  private sentCache = new Map<string, proto.IMessage>();
  /** Último cierre de conexión relevante (para explicarlo en Conexión). */
  lastDisconnect: DisconnectInfo | null = null;

  constructor(private readonly opts: WaSessionOptions) {
    super();
    this.authPath = path.join(path.resolve(config.authDir), opts.name);
  }

  get name(): string {
    return this.opts.name;
  }

  get socket(): WASocket | null {
    return this.sock;
  }

  isReady(): boolean {
    return this.status === 'ready' && this.sock !== null;
  }

  /**
   * Arranca (o reinicia) el socket. Las llamadas simultáneas comparten el mismo
   * arranque: dos sockets con las mismas credenciales corrompen el cifrado.
   */
  connect(): Promise<void> {
    if (this.sock) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.openSocket().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async openSocket(): Promise<void> {
    if (this.sock) return;
    fs.mkdirSync(this.authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
    // Se fija la versión de WhatsApp Web: la resolución remota con la rc puede
    // devolver una versión incompatible y el handshake se cae en bucle.
    const version = await resolveWaVersion();

    this.status = 'connecting';
    const sock = makeWASocket({
      version,
      logger: baileysLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      browser: Browsers.ubuntu(config.browserName),
      markOnlineOnConnect: false,
      syncFullHistory: config.syncFullHistory,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: true,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 2_000,
      // Reintento de un mensaje que el contacto no pudo descifrar: primero la
      // caché en memoria; si el servicio se reinició, el texto guardado en la BD.
      getMessage: async (key: WAMessageKey) =>
        key?.id ? this.sentCache.get(key.id) ?? this.opts.lookupSent?.(key.id) : undefined,
    });
    this.sock = sock;
    this.installWatchdogs(sock);

    // Si las credenciales no se pueden guardar (p. ej. archivos de root con el
    // servicio corriendo como www-data) el cifrado se desfasa en silencio y los
    // contactos ven «Esperando el mensaje»: se registra como error visible.
    sock.ev.on('creds.update', () => {
      Promise.resolve(saveCreds()).catch((err: Error) => {
        this.lastError = `No se pudieron guardar las credenciales: ${err.message}`;
        logger.error({ session: this.name, path: this.authPath, err: err.message }, 'No se pudieron guardar las credenciales');
      });
    });
    sock.ev.on('connection.update', (update: any) => void this.onConnection(update, sock));
    sock.ev.on('messages.upsert', (payload: any) => void this.onUpsert(payload));
    sock.ev.on('messages.update', (updates: any) => void this.onUpdate(updates));
    sock.ev.on('messaging-history.set', (payload: any) => void this.onHistorySet(payload));
    sock.ev.on('chats.phoneNumberShare', (payload: any) => this.onPhoneNumberShare(payload));
    sock.ev.on('contacts.upsert', (contacts: any) => this.onContacts(contacts));
    sock.ev.on('contacts.update', (contacts: any) => this.onContacts(contacts));
    sock.ev.on('presence.update', (presence: any) => void this.onPresence(presence));
    // Lecturas hechas en el teléfono: el panel refleja lo que se leyó en WhatsApp.
    sock.ev.on('message-receipt.update', (updates: any) => this.onReceiptUpdate(updates));
    sock.ev.on('chats.update', (chats: any) => this.onChatsUpdate(chats));
    sock.ev.on('chats.upsert', (chats: any) => this.onChatsUpdate(chats));

    this.emit('status', this.status);
  }

  /**
   * Instala los vigilantes sobre un socket recién creado:
   * 1. Cada tarea del mutex de procesamiento de Baileys tiene un tiempo máximo:
   *    si se cuelga, la cola sigue (la tarea colgada termina por su cuenta) y, si
   *    se repite, se reabre la conexión (sin re-vincular).
   * 2. Si el búfer de eventos queda retenido más de `BUFFER_MAX_MS`, se libera.
   */
  private installWatchdogs(sock: WASocket): void {
    this.clearWatchdogs();
    const mutex = (sock as any).processingMutex;
    if (mutex && typeof mutex.mutex === 'function' && !mutex.__esamGuarded) {
      const original = mutex.mutex.bind(mutex);
      mutex.mutex = (code: () => Promise<unknown>) => original(() => this.guardTask(sock, code));
      mutex.__esamGuarded = true;
    } else if (!mutex) {
      logger.warn({ session: this.name }, 'Baileys no expone processingMutex: vigilante de procesamiento inactivo');
    }

    let bufferedSince: number | null = null;
    this.watchTimer = setInterval(() => {
      if (this.sock !== sock) return;
      const ev = sock.ev as any;
      if (typeof ev?.isBuffering !== 'function') return;
      if (!ev.isBuffering()) {
        bufferedSince = null;
        return;
      }
      bufferedSince ??= Date.now();
      if (Date.now() - bufferedSince >= BUFFER_MAX_MS) {
        logger.warn(
          { session: this.name, seconds: Math.round((Date.now() - bufferedSince) / 1000) },
          'Baileys retenía los eventos (sincronización inicial sin terminar): se liberan para que entren los mensajes',
        );
        bufferedSince = null;
        try {
          ev.flush();
        } catch (err) {
          logger.warn({ session: this.name, err: (err as Error).message }, 'No se pudo liberar el búfer de eventos');
        }
      }
    }, 5_000);
  }

  private clearWatchdogs(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /** Ejecuta una tarea del mutex de Baileys con tiempo máximo. */
  private async guardTask(sock: WASocket, code: () => Promise<unknown>): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const work = Promise.resolve().then(code);
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), PROCESSING_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([work, timeout]);
      if (result === TIMED_OUT) {
        // La tarea sigue en segundo plano; se evita que su error quede sin capturar.
        work.catch(() => undefined);
        this.onProcessingStall(sock);
        return undefined;
      }
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Una tarea de Baileys superó el tiempo máximo: liberar la cola y, si se repite, reconectar. */
  private onProcessingStall(sock: WASocket): void {
    const now = Date.now();
    this.stalls = this.stalls.filter((t) => now - t < STALL_WINDOW_MS);
    this.stalls.push(now);
    logger.warn(
      { session: this.name, seconds: PROCESSING_TIMEOUT_MS / 1000, recent: this.stalls.length },
      'Una tarea de Baileys quedó colgada; se libera la cola de mensajes entrantes',
    );
    this.emit('stall', { count: this.stalls.length });
    if (this.stalls.length >= STALLS_TO_RECONNECT && this.sock === sock) {
      this.stalls = [];
      logger.warn({ session: this.name }, 'Procesamiento bloqueado repetidamente: se reabre la conexión (sin desvincular)');
      try {
        sock.end(new Error('Vigilante: procesamiento de mensajes bloqueado'));
      } catch {
        // si ya estaba cerrado, onConnection('close') no llega: se fuerza la reconexión
        this.sock = null;
        void this.connect().catch(() => undefined);
      }
    }
  }

  private async onConnection(update: any, sock: WASocket): Promise<void> {
    // Eventos de un socket que ya no es el actual (cerrado a propósito con
    // stop/reconnect o reemplazado): se ignoran para no reconectar dos veces.
    if (sock !== this.sock) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr);
      } catch {
        this.qrDataUrl = null;
      }
      this.status = 'qr';
      this.emit('qr', this.qrDataUrl);
      this.emit('status', this.status);
    }

    if (connection === 'open') {
      logger.info({ session: this.name }, 'Conexión de WhatsApp abierta');
      this.status = 'ready';
      this.qrDataUrl = null;
      this.lastError = null;
      this.phone = phoneFromJid(this.sock?.user?.id ?? '');
      this.emit('status', this.status);
      this.emit('ready', this.phone);
      void this.warmGroupNames();
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const errMessage = (lastDisconnect?.error as Error)?.message ?? null;
      // 401 (cerrada desde el teléfono o dada de baja) y 403 (número restringido):
      // las credenciales ya no sirven.
      const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 403;
      const replaced = statusCode === DisconnectReason.connectionReplaced;
      const registered = !!this.sock?.authState?.creds?.registered;
      const info = explainDisconnect(statusCode, errMessage);
      logger.warn(
        { session: this.name, statusCode, kind: info.kind, registered, err: errMessage },
        'Conexión de WhatsApp cerrada',
      );

      this.clearWatchdogs();
      this.sock = null;
      this.status = loggedOut || replaced ? 'disconnected' : 'connecting';
      if (info.kind !== 'restart' && info.kind !== 'network') this.lastDisconnect = info;
      this.emit('status', this.status);

      if (loggedOut) {
        // Antes las credenciales viejas quedaban: el siguiente «Generar QR»
        // reintentaba con ellas, WhatsApp las rechazaba otra vez y el QR nunca
        // aparecía. Se borran para que el próximo intento pida un QR nuevo.
        this.qrDataUrl = null;
        this.phone = null;
        if (!this.clearAuthDir()) {
          info.detail += ` No se pudieron borrar las credenciales en ${this.authPath} (permisos): el QR no va a aparecer hasta corregirlo.`;
          info.action = `En el servidor: sudo chown -R www-data:www-data ${path.dirname(this.authPath)} y después «Generar QR».`;
        }
        this.lastDisconnect = info;
        this.emit('disconnected', info);
        return;
      }

      if (replaced) {
        // No se reconecta solo: con dos instancias se echarían mutuamente sin fin.
        this.emit('disconnected', info);
        return;
      }

      if (info.kind === 'bad_session') {
        try {
          this.clearSignalSessions();
        } catch {
          // queda registrado; la reconexión sigue igual
        }
      }

      if (!this.reconnecting) {
        this.reconnecting = true;
        await delay(registered ? 3000 : 1500);
        this.reconnecting = false;
        try {
          await this.connect();
        } catch (err) {
          this.lastError = (err as Error).message;
          logger.warn({ session: this.name, err: this.lastError }, 'No se pudo reconectar');
        }
      }
    }
  }

  private async onUpsert(payload: any): Promise<void> {
    // `notify`: mensaje nuevo. `append`: mensaje que llego mientras el socket
    // estaba desconectado (Baileys lo marca como offline). Ambos se procesan.
    const type = payload?.type;
    this.lastInboundAt = Date.now();
    if (type !== 'notify' && type !== 'append') return;
    const incoming = (payload.messages ?? []) as WAMessage[];
    if (type === 'append' && incoming.length) {
      logger.info(
        { session: this.name, count: incoming.length },
        'Mensajes offline recibidos al reconectar',
      );
    }
    // En vivo la media se baja en el acto. La de los mensajes offline NO se baja
    // aquí (bajarla una por una frena la recuperación): se guarda la referencia
    // y el manager la descarga en segundo plano.
    const offline = type === 'append';
    let i = 0;
    for (const raw of incoming) {
      if (config.debugDumpMessages) this.debugDump('upsert', raw);
      if ((raw as any).messageStubType === STUB_CIPHERTEXT && !raw.message) {
        this.reportDecryptFailure(raw, offline);
        continue;
      }
      try {
        const message = await this.mapInbound(raw, { downloadMedia: !offline });
        if (message) {
          message.offline = offline;
          this.emit('message', message);
        }
      } catch (err) {
        logger.warn({ session: this.name, err: (err as Error).message }, 'Error mapeando mensaje entrante');
      }
      // Cede el event loop cada tanto para que el panel siga respondiendo
      // mientras se procesan lotes grandes de mensajes offline.
      if (++i % 25 === 0) await delay(0);
    }
  }

  /**
   * Mensaje que llegó cifrado y no se pudo descifrar. Baileys ya pide el
   * reenvío al remitente; aquí solo se informa para el diagnóstico del panel.
   */
  private reportDecryptFailure(raw: WAMessage, offline: boolean): void {
    const error = String((raw as any).messageStubParameters?.[0] ?? 'desconocido');
    // Recibo sin contenido o mensaje ya descifrado (duplicado): no son fallas reales.
    if (/absent from node|key used already/i.test(error)) return;
    const failure: DecryptFailure = {
      chatId: resolveChatId(raw.key?.remoteJid ?? ''),
      fromMe: !!raw.key?.fromMe,
      error,
      offline,
    };
    this.emit('decrypt-failure', failure);
  }

  /** Vuelca el mensaje crudo a data/debug-messages.jsonl (diagnóstico). */
  private debugDump(source: string, raw: WAMessage): void {
    try {
      const file = path.resolve(config.storageDir, '..', 'debug-messages.jsonl');
      const entry = {
        at: new Date().toISOString(),
        source,
        remoteJid: raw?.key?.remoteJid ?? null,
        fromMe: raw?.key?.fromMe ?? null,
        participant: raw?.key?.participant ?? null,
        pushName: raw?.pushName ?? null,
        message: raw?.message ?? null,
      };
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch {
      // best-effort
    }
  }

  /**
   * Historial que WhatsApp entrega tras `fetchMessageHistory` o al reconectar.
   * Se emiten como mensajes "históricos" para que el manager los persista.
   */
  private async onHistorySet(payload: any): Promise<void> {
    const historyMessages = (payload?.messages ?? []) as WAMessage[];
    const historyContacts = (payload?.contacts ?? []) as any[];
    logger.info(
      {
        session: this.name,
        messages: historyMessages.length,
        contacts: historyContacts.length,
        syncType: payload?.syncType,
        isLatest: payload?.isLatest,
        progress: payload?.progress,
      },
      'Historial recibido (messaging-history.set)',
    );
    // Los contactos del historial traen el par LID<->número cuando WhatsApp lo
    // comparte: se aprovecha para poder mostrar el teléfono en el panel.
    for (const contact of historyContacts) this.mapContact(contact);
    let i = 0;
    for (const raw of historyMessages) {
      try {
        const message = await this.mapInbound(raw, { downloadMedia: false });
        if (message) this.emit('history', message);
      } catch (err) {
        logger.warn({ session: this.name, err: (err as Error).message }, 'Error mapeando mensaje de historial');
      }
      // Cede el event loop para no bloquear el panel durante el historial.
      if (++i % 25 === 0) await delay(0);
    }
    // Los chats del historial traen el contador real de no leídos del teléfono:
    // se aplica DESPUÉS de los mensajes para que sea el valor final.
    this.onChatsUpdate(payload?.chats ?? []);
  }

  /** WhatsApp comparte el número real detrás de un LID: se guarda el mapeo. */
  private onPhoneNumberShare(payload: any): void {
    if (payload?.lid && payload?.jid) rememberLid(payload.lid, payload.jid);
  }

  /** Los contactos traen `id` (LID o PN) y a veces el `lid`: se mapea. */
  private onContacts(contacts: any): void {
    for (const c of (contacts ?? []) as any[]) this.mapContact(c);
  }

  /** Extrae un par LID<->teléfono de un contacto, en cualquiera de sus formas. */
  private mapContact(c: any): void {
    if (!c) return;
    const id: string = c.id ?? '';
    const lid: string = c.lid ?? '';
    // id = número y lid = LID (forma habitual en el historial).
    if (lid && id.endsWith('@s.whatsapp.net')) rememberLid(lid, id);
    // id = LID con el número aparte.
    if (id.endsWith('@lid') && (c.phoneNumber || c.phone || c.pn)) {
      rememberLid(id, c.phoneNumber ?? c.phone ?? c.pn);
    }
    // id = LID y lid = número (orden invertido).
    if (id.endsWith('@lid') && lid.endsWith('@s.whatsapp.net')) rememberLid(id, lid);
  }

  private async mapInbound(raw: WAMessage, opts: { downloadMedia?: boolean } = {}): Promise<InboundMessage | null> {
    const fromMe = !!raw.key.fromMe;
    const rawJid = raw.key.remoteJid ?? '';
    if (!rawJid) return null;
    const key = raw.key as any;

    // WhatsApp entrega los chats individuales como `@lid` (identificador
    // anónimo). Baileys >= 6.7.17 expone el teléfono real en la key
    // (`senderPn`/`participantPn`) y el LID inverso (`senderLid`); se guarda el
    // mapeo para mostrar el número y unir la conversación con la del número.
    if (rawJid.endsWith('@lid')) {
      const pn = key?.senderPn ?? key?.participantPn ?? (raw as any)?.senderPn ?? null;
      if (pn) rememberLid(rawJid, pn);
    } else if (rawJid.endsWith('@s.whatsapp.net')) {
      const lid = key?.senderLid ?? key?.participantLid ?? null;
      if (lid) rememberLid(lid, rawJid);
    }
    if (key?.participant && String(key.participant).endsWith('@lid') && key?.participantPn) {
      rememberLid(key.participant, key.participantPn);
    }

    const remote = resolveChatId(rawJid);
    const desc = describe(raw.message);
    const isGroup = rawJid.endsWith('@g.us');
    const content = unwrapMessage(raw.message);
    // Autor del mensaje dentro de un grupo: se guarda el JID de teléfono (PN) si
    // WhatsApp lo comparte (`participantPn`/`senderPn`); si no, el `participant`.
    // Así el panel muestra el número real y no el identificador anónimo (@lid).
    // En el historial (messaging-history.set) WhatsApp suele dejar el autor en
    // `participant` del propio mensaje y no en la key: se miran ambos.
    let senderJid: string | null = null;
    if (isGroup) {
      const pn = key?.participantPn ?? key?.senderPn ?? (raw as any)?.participantPn ?? null;
      const participant = key?.participant || (raw as any)?.participant || null;
      if (pn) {
        senderJid = resolveChatId(pn);
      } else if (participant) {
        senderJid = String(participant);
      }
    }

    // Respuesta citada: el `contextInfo.stanzaId` apunta al mensaje citado.
    const context =
      content?.extendedTextMessage?.contextInfo ??
      content?.imageMessage?.contextInfo ??
      content?.videoMessage?.contextInfo ??
      content?.documentMessage?.contextInfo ??
      content?.audioMessage?.contextInfo ??
      content?.stickerMessage?.contextInfo ??
      null;
    const quotedWaId: string | null = context?.stanzaId ?? null;

    // Reaccion entrante: apunta a un wamid con el emoji (vacio = se retiro).
    const reactionMessage = content?.reactionMessage;
    const reaction = reactionMessage
      ? { targetWaId: String(reactionMessage.key?.id ?? ''), emoji: String(reactionMessage.text ?? '') }
      : null;

    // La media del historial y la offline NO se descargan al vuelo: bajar la de
    // miles de mensajes satura la CPU y deja el panel sin responder. Se guarda
    // la referencia (`mediaRef`) para bajarla después; en vivo se baja ya.
    let mediaBuffer: Buffer | null = null;
    const hasMedia = MEDIA_TYPES.includes(desc.type);
    if (hasMedia && opts.downloadMedia === true) {
      try {
        mediaBuffer = await this.downloadRaw(raw, config.media.downloadTimeoutMs);
      } catch (err) {
        logger.warn({ session: this.name, err: (err as Error).message }, 'No se pudo descargar la media del mensaje');
      }
    }

    return {
      id: raw.key.id ?? '',
      chatId: remote,
      fromMe,
      isGroup,
      pushName: raw.pushName ?? null,
      type: desc.type,
      body: desc.body,
      timestamp: Number(raw.messageTimestamp ?? Math.floor(Date.now() / 1000)),
      mediaMime: desc.mime,
      mediaBuffer,
      filename: desc.filename,
      seconds: desc.seconds,
      raw,
      senderJid,
      quotedWaId,
      reaction,
      mediaRef: hasMedia ? mediaRefFor(raw) : null,
    };
  }

  /** Descarga la media de un mensaje con tiempo máximo (pide re-subida si caducó). */
  private async downloadRaw(raw: WAMessage, timeoutMs: number): Promise<Buffer> {
    if (!this.sock) throw new Error('La sesión no está arrancada.');
    const sock = this.sock;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        downloadMediaMessage(raw, 'buffer', {}, {
          logger: baileysLogger,
          reuploadRequest: sock.updateMediaMessage,
        }) as Promise<Buffer>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('La descarga de la media no respondió a tiempo.')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Descarga la media a partir de una referencia guardada (`mediaRef`). */
  async downloadMediaRef(ref: string, timeoutMs = config.media.downloadTimeoutMs): Promise<Buffer> {
    const raw = mediaRefToMessage(ref);
    if (!raw) throw new Error('Referencia de media inválida.');
    const buffer = await this.downloadRaw(raw, timeoutMs);
    if (!buffer?.length) throw new Error('La media descargada está vacía.');
    return buffer;
  }

  /**
   * Simula que una persona escribe antes de enviar (anti-baneo): "escribiendo…"
   * durante un tiempo proporcional al texto, con algo de azar.
   */
  async simulateTyping(chatId: string, text: string | null | undefined, kind: 'composing' | 'recording' = 'composing'): Promise<void> {
    if (!this.sock) return;
    const jid = toBaileysJid(chatId);
    const chars = (text ?? '').length;
    const ms = Math.min(6000, 900 + chars * 45) + randInt(0, 900);
    try {
      await this.sock.presenceSubscribe(jid);
      await this.sock.sendPresenceUpdate(kind, jid);
      await delay(ms);
      await this.sock.sendPresenceUpdate('paused', jid);
    } catch {
      // best-effort: si falla la presencia, se envía igual
    }
  }

  private onUpdate(updates: any): void {
    for (const u of updates ?? []) {
      const id = u?.key?.id;
      const status = u?.update?.status;
      if (!id || status === undefined || status === null) continue;
      // Baileys: 0=error, 1=pending, 2=server ack, 3=delivered, 4=read, 5=played
      const mapped =
        status <= 0 ? 'failed' : status === 3 ? 'delivered' : status === 4 ? 'read' : status >= 5 ? 'played' : 'sent';
      // Un "leído" sobre un mensaje ENTRANTE es un recibo `read-self`: lo leyó
      // este mismo número en el teléfono (o en otro dispositivo vinculado).
      if (!u.key.fromMe && (mapped === 'read' || mapped === 'played')) {
        this.emit('read-self', { chatId: resolveChatId(u.key.remoteJid ?? ''), messageIds: [id] });
        continue;
      }
      this.emit('ack', { messageId: id, status: mapped });
    }
  }

  /** Recibos de lectura en grupos: si quien leyó es este mismo número, es `read-self`. */
  private onReceiptUpdate(updates: any): void {
    const me = this.sock?.user;
    const mine = new Set([phoneFromJid(me?.id ?? ''), phoneFromJid((me as any)?.lid ?? '')].filter(Boolean));
    const byChat = new Map<string, string[]>();
    for (const u of updates ?? []) {
      const reader = phoneFromJid(u?.receipt?.userJid ?? '');
      if (!u?.receipt?.readTimestamp || !reader || !mine.has(reader) || !u?.key?.id) continue;
      const chatId = resolveChatId(u.key.remoteJid ?? '');
      byChat.set(chatId, [...(byChat.get(chatId) ?? []), u.key.id]);
    }
    for (const [chatId, messageIds] of byChat) this.emit('read-self', { chatId, messageIds });
  }

  /**
   * Contador de no leídos que informa WhatsApp para un chat (sincronización del
   * estado de la app o historial): 0 = leído en el teléfono, -1 = marcado como
   * no leído, N = mensajes sin leer. `null`/ausente = sin información.
   */
  private onChatsUpdate(chats: any): void {
    for (const c of (chats ?? []) as any[]) {
      if (!c?.id || typeof c.unreadCount !== 'number') continue;
      this.emit('chat-unread', { chatId: resolveChatId(c.id), unreadCount: c.unreadCount });
    }
  }

  private onPresence(presence: any): void {
    const chatId = toContractJid(presence?.id);
    const participants = Object.values(presence?.presences ?? {}) as any[];
    const typing = participants.some((p) => ['composing', 'recording'].includes(p?.lastKnownPresence));
    this.emit('presence', { chatId, typing });
  }

  // ── Envío ──────────────────────────────────────────────────────────────────

  private async doSend(
    jid: string,
    content: any,
    quoted?: QuotedRef | null,
  ): Promise<{ messageId?: string; timestamp?: number }> {
    if (!this.sock) throw new Error('La sesión no está arrancada.');
    const options = quoted ? { quoted: buildQuoted(jid, quoted) } : undefined;
    const result = await this.sock.sendMessage(toBaileysJid(jid), content, options as any);
    this.rememberSent(result?.key?.id, result?.message);
    return {
      messageId: result?.key?.id ?? undefined,
      timestamp: Number(result?.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    };
  }

  /** Guarda el contenido enviado (LRU acotado) para atender reintentos. */
  private rememberSent(id: string | null | undefined, message: proto.IMessage | null | undefined): void {
    if (!id || !message) return;
    this.sentCache.delete(id);
    this.sentCache.set(id, message);
    while (this.sentCache.size > SENT_CACHE_SIZE) {
      const oldest = this.sentCache.keys().next().value;
      if (oldest === undefined) break;
      this.sentCache.delete(oldest);
    }
  }

  async sendText(
    chatId: string,
    text: string,
    quoted?: QuotedRef | null,
  ): Promise<{ messageId?: string; timestamp?: number }> {
    return this.doSend(chatId, { text: text.slice(0, 4096) }, quoted);
  }

  async sendMedia(
    chatId: string,
    type: string,
    contents: Buffer,
    mimetype: string,
    filename?: string,
    caption?: string,
    ptt = false,
    quoted?: QuotedRef | null,
  ): Promise<{ messageId?: string; timestamp?: number }> {
    const content =
      type === 'image'
        ? { image: contents, caption, mimetype, fileName: filename }
        : type === 'video'
          ? { video: contents, caption, mimetype, fileName: filename }
          : type === 'audio'
            ? { audio: contents, mimetype, ptt }
            : type === 'sticker'
              ? { sticker: contents }
              : { document: contents, mimetype, fileName: filename ?? 'archivo', caption };
    return this.doSend(chatId, content, quoted);
  }

  /**
   * Envia una reaccion (o la retira con emoji vacio) a un mensaje. El `key`
   * identifica el mensaje destino dentro del chat.
   */
  async sendReaction(
    chatId: string,
    target: { id: string; fromMe: boolean },
    emoji: string,
  ): Promise<void> {
    if (!this.sock) throw new Error('La sesión no está arrancada.');
    await this.sock.sendMessage(toBaileysJid(chatId), {
      react: {
        text: emoji,
        key: { remoteJid: toBaileysJid(chatId), id: target.id, fromMe: target.fromMe },
      },
    });
  }

  /** URL de la foto de perfil del contacto (best-effort). */
  async profilePictureUrl(chatId: string): Promise<string | null> {
    if (!this.sock) return null;
    try {
      const url = await this.sock.profilePictureUrl(toBaileysJid(chatId), 'image');
      return url ?? null;
    } catch {
      return null;
    }
  }

  // ── Grupos y contactos ───────────────────────────────────────────────────────

  /**
   * Asunto de un grupo, con cache en memoria. Devuelve `null` si no se puede
   * resolver (el manager cae al nombre guardado o al JID).
   */
  async groupSubject(jid: string): Promise<string | null> {
    const cached = this.groupNames.get(jid);
    if (cached) return cached;
    if (!this.sock) return null;
    // Al recuperar cientos de mensajes offline de un mismo grupo, una sola
    // consulta compartida; y si falló hace poco, no se reintenta (rate limit).
    const missAt = this.groupMisses.get(jid);
    if (missAt && Date.now() - missAt < 10 * 60_000) return null;
    const pending = this.groupLookups.get(jid);
    if (pending) return pending;
    const sock = this.sock;
    const lookup = (async () => {
      try {
        const meta: any = await sock.groupMetadata(jid);
        const subject = meta?.subject ?? null;
        if (subject) this.groupNames.set(jid, subject);
        else this.groupMisses.set(jid, Date.now());
        return subject ?? null;
      } catch {
        this.groupMisses.set(jid, Date.now());
        return null;
      } finally {
        this.groupLookups.delete(jid);
      }
    })();
    this.groupLookups.set(jid, lookup);
    return lookup;
  }

  /** Precarga los asuntos de todos los grupos (una sola llamada al conectar). */
  async warmGroupNames(): Promise<void> {
    if (!this.sock) return;
    try {
      const all: any = await this.sock.groupFetchAllParticipating();
      for (const [id, group] of Object.entries(all ?? {})) {
        const g = group as any;
        const subject = g?.subject;
        if (id && subject) this.groupNames.set(id, subject);
        // Los miembros traen el par LID <-> numero: se guarda para mostrar el
        // teléfono real en chats individuales que WhatsApp entrego como @lid.
        for (const p of (g?.participants ?? []) as any[]) {
          const { pnJid, lid } = this.participantPair(p);
          if (lid && pnJid) rememberLid(lid, pnJid);
        }
      }
    } catch {
      // best-effort: si falla, `groupSubject` resolvera bajo demanda.
    }
  }

  /** Participantes de un grupo (para la ficha de contacto del inbox). */
  async groupParticipants(
    jid: string,
  ): Promise<Array<{ id: string; name: string | null; admin: string | null; phone: string | null }>> {
    if (!this.sock) throw new Error('La sesión no está arrancada.');
    const meta: any = await this.sock.groupMetadata(toBaileysJid(jid));
    return ((meta?.participants ?? []) as any[]).map((p) => {
      const { pnJid, lid } = this.participantPair(p);
      // Aprovecha el par lid<->número para completar el mapeo y mostrar el teléfono.
      if (lid && pnJid) rememberLid(lid, pnJid);
      let phone = pnJid ? phoneFromJid(pnJid) : null;
      if (!phone && lid) {
        const pn = phoneForLid(lid);
        if (pn) phone = phoneFromJid(pn);
      }
      // Para escribir se prefiere el número (PN) si se conoce; si no, el lid.
      const target = pnJid ? pnJid : lid ?? String(p.id ?? '');
      return {
        id: target,
        name: p.name ?? p.notify ?? null,
        admin: p.admin ?? null,
        phone: phone || null,
      };
    });
  }

  /**
   * Extrae de un participante de grupo el JID de teléfono (PN) y el LID, en
   * cualquiera de las formas que use WhatsApp (`jid`/`lid`/`phoneNumber`).
   */
  private participantPair(p: any): { pnJid: string | null; lid: string | null } {
    const rawId = String(p?.id ?? '');
    const lid = rawId.endsWith('@lid') ? rawId : String(p?.lid ?? '').endsWith('@lid') ? String(p.lid) : null;
    let pnJid: string | null = null;
    if (String(p?.jid ?? '').endsWith('@s.whatsapp.net')) pnJid = String(p.jid);
    else if (rawId.endsWith('@s.whatsapp.net')) pnJid = rawId;
    else {
      const raw = p?.phoneNumber ?? p?.phone ?? p?.pn;
      const d = String(raw ?? '').replace(/\D+/g, '');
      if (d) pnJid = `${d}@s.whatsapp.net`;
    }
    return { pnJid, lid };
  }

  async groups(): Promise<Array<{ id: string; name: string; subject: string; participantCount: number }>> {
    if (!this.sock) throw new Error('La sesión no está arrancada.');
    const all = await this.sock.groupFetchAllParticipating();
    return Object.values(all ?? {}).map((g: any) => ({
      id: g.id,
      name: g.subject,
      subject: g.subject,
      participantCount: g.participants?.length ?? 0,
    }));
  }

  async groupJoinInfo(code: string): Promise<{ id: string; name: string }> {
    if (!this.sock) throw new Error('La sesión no está arrancada.');
    const g: any = await this.sock.groupGetInviteInfo(code);
    return { id: g.id, name: g.subject };
  }

  async checkNumber(number: string): Promise<{ exists: boolean; jid: string | null }> {
    if (!this.sock) throw new Error('La sesión no está arrancada.');
    const result = await this.sock.onWhatsApp(number);
    const first = (result ?? [])[0] as any;
    return { exists: !!first?.exists, jid: toContractJid(first?.jid) || null };
  }

  async contacts(limit = 1000): Promise<Array<{ id: string; name: string | null }>> {
    const store: any = (this.sock as any)?.store;
    const raw = store?.contacts ?? {};
    return Object.values(raw)
      .slice(0, limit)
      .map((c: any) => ({ id: c.id, name: c.name ?? c.notify ?? null }));
  }

  async presenceSubscribe(chatId: string): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.presenceSubscribe(toBaileysJid(chatId));
    } catch {
      // best-effort
    }
  }

  /**
   * Marca mensajes entrantes como leídos en WhatsApp (doble check azul). Envía
   * el acuse real al servidor para que el teléfono deje de mostrarlos pendientes.
   */
  async readMessages(
    chatId: string,
    keys: Array<{ id: string; fromMe: boolean; participant?: string | null }>,
  ): Promise<void> {
    if (!this.sock || !keys.length) return;
    const jid = toBaileysJid(chatId);
    try {
      await this.sock.readMessages(
        keys.map((k) => ({
          remoteJid: jid,
          fromMe: k.fromMe,
          id: k.id,
          ...(k.participant ? { participant: k.participant } : {}),
        })) as any,
      );
    } catch (err) {
      logger.warn({ session: this.name, err: (err as Error).message }, 'No se pudo enviar el acuse de lectura');
    }
  }

  /**
   * Pide a WhatsApp el historial de un chat (`fetchMessageHistory`). Requiere
   * que la sesión esté conectada y que el servidor tenga mensajes anteriores.
   * Devuelve la cantidad solicitada; los mensajes llegan por `messaging-history.set`.
   */
  async fetchHistory(
    chatId: string,
    count = 50,
    anchor?: { id: string; fromMe: boolean; timestampMs: number; participant?: string | null } | null,
  ): Promise<{ requested: number; available: number }> {
    if (!this.sock) throw new Error('La sesión no está arrancada.');
    // Baileys exige el mensaje más antiguo conocido como ancla (`msg.key`) y su
    // timestamp en milisegundos; sin eso lanza "reading 'remoteJid'".
    if (!anchor?.id) throw new Error('No hay mensajes previos para anclar la sincronización de historial.');
    const jid = toBaileysJid(chatId);
    const requested = Math.max(1, Math.min(100, Math.floor(count)));
    const s = this.sock as any;
    if (typeof s.fetchMessageHistory !== 'function') {
      throw new Error('La versión de Baileys no soporta la sincronización de historial.');
    }
    const oldestMsgKey = {
      remoteJid: jid,
      fromMe: !!anchor.fromMe,
      id: anchor.id,
      ...(anchor.participant ? { participant: anchor.participant } : {}),
    };
    // La peticion puede quedar sin respuesta si el telefono esta offline: con
    // timeout evitamos que bloquee el resto de la sincronizacion.
    const info: any = await Promise.race([
      s.fetchMessageHistory(requested, oldestMsgKey, anchor.timestampMs),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('La sincronización de historial no respondió a tiempo.')), 15_000),
      ),
    ]);
    await delay(2500);
    return { requested, available: Number(info?.count ?? requested) };
  }

  // ── Ciclo de vida ────────────────────────────────────────────────────────────

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.sock) await this.connect();
    if (!this.sock) throw new Error('La sesión no está arrancada.');
    return this.sock.requestPairingCode(phoneNumber);
  }

  async logout(): Promise<void> {
    try {
      await this.sock?.logout();
    } catch {
      // si el socket ya se cerró, igual limpiamos
    }
    this.clearWatchdogs();
    this.clearAuthDir();
    this.status = 'disconnected';
    this.phone = null;
    this.qrDataUrl = null;
    this.sock = null;
    this.emit('status', this.status);
  }

  async stop(): Promise<void> {
    this.clearWatchdogs();
    // Se suelta el socket ANTES de cerrarlo: así su evento de cierre se ignora y
    // no dispara la reconexión automática (cierre intencional).
    const sock = this.sock;
    this.sock = null;
    try {
      sock?.end(undefined);
    } catch {
      // ignore
    }
    this.status = 'disconnected';
    this.emit('status', this.status);
  }

  /** Borra las credenciales. Devuelve `false` si no se pudo (p. ej. permisos). */
  private clearAuthDir(): boolean {
    try {
      fs.rmSync(this.authPath, { recursive: true, force: true });
      return !fs.existsSync(this.authPath);
    } catch (err) {
      logger.error({ session: this.name, path: this.authPath, err: (err as Error).message }, 'No se pudieron borrar las credenciales');
      return false;
    }
  }

  /**
   * Borra las sesiones de cifrado por contacto y de grupo (sin tocar el vínculo
   * del número). La próxima vez que se escriba a cada contacto se negocian claves
   * nuevas: resuelve el «Esperando el mensaje» por claves desfasadas.
   */
  private clearSignalSessions(): number {
    let removed = 0;
    try {
      for (const file of fs.readdirSync(this.authPath)) {
        if (/^(session-|sender-key-)/.test(file)) {
          fs.rmSync(path.join(this.authPath, file), { force: true });
          removed++;
        }
      }
    } catch (err) {
      logger.error({ session: this.name, err: (err as Error).message }, 'No se pudieron limpiar las sesiones de cifrado');
      throw new Error(`No se pudieron borrar las claves de cifrado (${(err as Error).message}). Revisá los permisos de ${this.authPath}.`);
    }
    logger.warn({ session: this.name, removed }, 'Sesiones de cifrado regeneradas');
    return removed;
  }

  /** «Reparar cifrado»: cierra, regenera las claves por contacto y vuelve a conectar. */
  async repairEncryption(): Promise<number> {
    await this.stop();
    const removed = this.clearSignalSessions();
    await delay(1000);
    await this.connect();
    return removed;
  }

  /** ¿Se pueden escribir las credenciales? (si no, el cifrado se desfasa y el QR falla). */
  authWritable(): { ok: boolean; path: string; error?: string } {
    try {
      fs.mkdirSync(this.authPath, { recursive: true });
      const probe = path.join(this.authPath, `.probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      // Todos los archivos existentes deben poder reescribirse.
      for (const file of fs.readdirSync(this.authPath)) {
        fs.accessSync(path.join(this.authPath, file), fs.constants.W_OK);
      }
      return { ok: true, path: this.authPath };
    } catch (err) {
      return { ok: false, path: this.authPath, error: (err as Error).message };
    }
  }
}
