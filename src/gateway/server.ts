import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { all, get } from '../db/index.js';
import { logger } from '../logger.js';
import { SessionManager } from '../baileys/manager.js';
import { registerWebhook } from '../core/webhooks.js';
import { addOptout, isBlocked, listOptouts, normalizeChatId } from '../core/optout.js';
import { typeForMime } from '../core/phone.js';
import { systemHealth } from '../core/system-health.js';
import {
  chatSummaryForSession,
  findConversationInSessions,
  listChatsForSession,
  listMessages,
  type ChatKind,
} from '../core/conversations.js';
import { teamMembers, teamTagFor } from '../core/team.js';
import { directoryPrograms, listDirectory } from '../core/directory.js';
import { getPersonCi, personTagsByKeys, phoneKeyOf, setPersonCi, setPersonName, setPersonProgram } from '../core/person.js';
import { addNote, deleteNote, getOrCreateContact, listNotes, personLines, setNoteDone, setNotePinned, upsertContact, type ContactNoteWithAuthor, type ContactPatch } from '../core/contacts.js';
import { findByEmail } from '../auth/users.js';
import { prospectInfo } from '../core/prospects.js';
import { groupSends, personSends, type PersonSends } from '../core/person-sends.js';

const KINDS: ChatKind[] = ['individual', 'group', 'team'];

/**
 * El usuario del panel que firma una nota. Se busca por el correo de quien la
 * escribe en el HUB; si no está registrado en el panel, firma el dueño de la
 * línea. Si tampoco, la nota queda sin autor (la ve el equipo igual).
 */
function usuarioPanel(sessionId: string, email: unknown): number | null {
  const candidatos = [
    typeof email === 'string' ? email.trim() : '',
    get<{ owner_email: string | null }>('SELECT owner_email FROM sessions WHERE id = ?', sessionId)?.owner_email ?? '',
  ];
  for (const correo of candidatos) {
    if (!correo) continue;
    const user = findByEmail(correo);
    if (user) return user.id;
  }
  return null;
}

/** Nota tal como la consume el HUB (sin rutas internas de audio/imagen). */
function notaParaHub(n: ContactNoteWithAuthor) {
  return {
    id: n.id,
    text: n.note_text,
    created_at: n.created_at,
    due_at: n.due_at,
    due_time: n.due_time,
    done_at: n.done_at,
    pinned: !!n.pinned,
    personal: !!n.personal,
    author: n.author_name,
    done_by: n.done_by_name,
    assigned: n.assigned_name,
    assigned_area: n.assigned_area,
    session_id: n.session_id,
    session_name: n.session_name,
    tags: (n.tags ?? []).map((t) => ({ name: t.name, color: t.color })),
  };
}

/**
 * Ficha de una persona: sus datos, los programas, el CI y lo que se conoce
 * desde otras líneas. Es la misma información que arma el panel en
 * `/inbox/:session/:chat/person` (esto es su versión HTTP para el ESAM HUB).
 */
function fichaPersona(sessionId: string, chatId: string) {
  const contact = getOrCreateContact(sessionId, chatId);
  const lines = personLines(contact.id);
  const current = lines.find((l) => l.contact_id === contact.id) ?? null;
  const others = lines.filter((l) => l.contact_id !== contact.id);
  const pick = (key: 'name' | 'email' | 'company' | 'programa') => {
    if (current?.[key]) return null;
    const from = others.find((l) => l[key]);
    return from ? { value: from[key], line: from.session_name || from.session_phone || 'otra línea' } : null;
  };
  const key = contact.phone_key
    ?? (chatId.endsWith('@g.us') ? null : chatId.endsWith('@lid') ? chatId : phoneKeyOf(chatId));
  const tags = key ? personTagsByKeys([key]).get(key) : undefined;

  return {
    programa: current?.programa ?? tags?.programas[0] ?? null,
    full_name: tags?.full_name ?? null,
    name_source: tags?.name_source ?? null,
    name_by: tags?.name_by ?? null,
    can_name: !!key,
    programas: tags?.programas ?? [],
    prospect: key ? prospectInfo(key) : null,
    team: teamTagFor(key),
    ci: key ? getPersonCi(key) : null,
    contact: { name: contact.name, phone: contact.phone, email: contact.email, company: contact.company },
    fill: { name: pick('name'), email: pick('email'), company: pick('company'), programa: pick('programa') },
    first_at: current?.first_at ?? null,
    lines: others,
  };
}

/** Cursor de mensajes: fecha + id del más antiguo cargado (paginar hacia atrás). */
function encodeBefore(occurredAt: string, id: number): string {
  return Buffer.from(`${occurredAt}|${id}`, 'utf8').toString('base64url');
}

function decodeBefore(raw: unknown): { occurredAt: string; id: number } | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const [occurredAt, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    const n = Number(id);
    return occurredAt && Number.isInteger(n) ? { occurredAt, id: n } : null;
  } catch {
    return null;
  }
}

/** Envuelve un handler async para capturar errores. */
function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/**
 * La segunda barrera del opt-out, para los envíos MASIVOS que llegan por API.
 *
 * Hasta acá solo el motor de lotes de este gateway (`core/batches.ts`) miraba
 * la lista de «no enviar». Los envíos que entran por estas rutas —que es lo que
 * usa el CRM— salían igual a quien había pedido la baja. Si el CRM se olvidaba
 * de filtrar, no había nada detrás.
 *
 * **Solo con `bulk: true`**, y a propósito: el gateway no puede distinguir un
 * masivo de una respuesta 1:1, y bloquear las respuestas sería un error. Una
 * persona que pidió la baja y después escribe «hola, quiero info del programa»
 * tiene que poder recibir una respuesta: lo que no quiere es publicidad. El que
 * manda decide qué es un masivo; el gateway lo hace cumplir.
 *
 * Responde 409 y no 4xx genérico para que el llamador pueda distinguir «no se
 * mandó porque pidió la baja» de un error de verdad.
 */
function bloqueadoParaMasivo(req: Request, res: Response, chatId: string): boolean {
  if (req.body?.bulk === true && isBlocked(chatId)) {
    res.status(409).json({ message: 'El destinatario pidió no recibir mensajes.', blocked: true });
    return true;
  }
  return false;
}

/**
 * Gateway REST compatible con OpenWA (`/api/sessions/...`), consumido por
 * `App\Services\OpenWA\OpenWaApi` de openwa_basico. Drop-in en el puerto 2785.
 */
export function createGatewayApp(manager: SessionManager) {
  const app = express();
  app.use(express.json({ limit: '64mb' }));

  // Auth por X-API-Key (si API_KEY está vacío, se permite en desarrollo).
  app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/healthz') return next();
    if (!config.apiKey) return next();
    if (req.header('X-API-Key') === config.apiKey) return next();
    res.status(401).json({ message: 'API key inválida.' });
  });

  // Estado del proceso (sin datos sensibles): lo usan el gestor de procesos,
  // `scripts/restart.cjs` y el monitoreo. Versión, arranque, salud de las líneas,
  // tamaño de la base y de los logs, y cola de webhooks.
  const healthHandler = (_req: Request, res: Response): void => {
    res.json(systemHealth(manager.list()));
  };
  app.get('/health', healthHandler);
  app.get('/healthz', healthHandler);

  // ── Sesiones ───────────────────────────────────────────────────────────────

  app.get(
    '/api/sessions',
    ah(async (_req, res) => {
      res.json(manager.list().map((s) => ({ id: s.id, name: s.name, status: s.status, phone: s.phone })));
    }),
  );

  app.post(
    '/api/sessions',
    ah(async (req, res) => {
      const name = String(req.body?.name ?? '').trim();
      if (!name) {
        res.status(422).json({ message: 'El nombre de sesión es obligatorio.' });
        return;
      }
      const apiKey = String(req.header('X-API-Key') ?? '') || null;
      const secret = `whsec_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      const row = manager.createSession(name, apiKey, secret);
      res.status(201).json({ id: row.id, name: row.name, status: row.status });
    }),
  );

  app.get(
    '/api/sessions/:sessionId',
    ah(async (req, res) => {
      const row = manager.byId(String(req.params.sessionId));
      if (!row) {
        res.status(404).json({ message: 'Sesión no encontrada.' });
        return;
      }
      res.json({ id: row.id, name: row.name, status: row.status, phone: row.phone, lastError: row.last_error });
    }),
  );

  app.post(
    '/api/sessions/:sessionId/start',
    ah(async (req, res) => {
      await manager.start(String(req.params.sessionId));
      const row = manager.byId(String(req.params.sessionId));
      res.json({ status: row?.status ?? 'connecting', phone: row?.phone ?? null });
    }),
  );

  app.post(
    '/api/sessions/:sessionId/stop',
    ah(async (req, res) => {
      await manager.stop(String(req.params.sessionId));
      res.json({ status: 'disconnected' });
    }),
  );

  app.post(
    '/api/sessions/:sessionId/logout',
    ah(async (req, res) => {
      await manager.logout(String(req.params.sessionId));
      res.json({ status: 'disconnected' });
    }),
  );

  app.get(
    '/api/sessions/:sessionId/qr',
    ah(async (req, res) => {
      const qr = await manager.qr(String(req.params.sessionId));
      res.json({ qrCode: qr });
    }),
  );

  app.post(
    '/api/sessions/:sessionId/pairing-code',
    ah(async (req, res) => {
      const phone = String(req.body?.phoneNumber ?? '');
      if (!phone) {
        res.status(422).json({ message: 'Falta phoneNumber.' });
        return;
      }
      const code = await manager.pairing(String(req.params.sessionId), phone);
      res.json({ code, pairingCode: code });
    }),
  );

  app.post(
    '/api/sessions/:sessionId/webhooks',
    ah(async (req, res) => {
      const url = String(req.body?.url ?? '');
      const secret = String(req.body?.secret ?? '');
      const events = Array.isArray(req.body?.events) ? req.body.events.map(String) : [];
      if (!url) {
        res.status(422).json({ message: 'Falta url.' });
        return;
      }
      registerWebhook(String(req.params.sessionId), url, secret, events);
      res.status(201).json({ ok: true });
    }),
  );

  app.post(
    '/api/sessions/:sessionId/presence/subscribe',
    ah(async (req, res) => {
      await manager.presenceSubscribe(String(req.params.sessionId), String(req.body?.chatId ?? ''));
      res.json({ ok: true });
    }),
  );

  // ── Opt-out (lista de «no enviar») ─────────────────────────────────────────
  //
  // Para que un CRM conectado pueda mantener su lista sincronizada con esta en
  // los dos sentidos. La lista es GLOBAL —no por línea—: quien pidió la baja la
  // pidió a la institución, no a un número. El `:sessionId` de la ruta se
  // guarda como dato de origen y mantiene la forma de las demás rutas.

  app.get(
    '/api/sessions/:sessionId/optouts',
    ah(async (req, res) => {
      // `since` es un ISO: los `created_at` se guardan con el mismo formato,
      // así que la comparación de texto ordena bien. Sin `since`, la lista
      // completa (es la primera sincronización).
      const since = typeof req.query.since === 'string' ? req.query.since : '';
      const rows = listOptouts().filter((r) => !since || r.created_at > since);
      res.json(
        rows.map((r) => ({
          chatId: r.chat_id,
          phone: r.phone,
          reason: r.reason,
          source: r.source,
          sessionId: r.session_id,
          createdAt: r.created_at,
        })),
      );
    }),
  );

  app.post(
    '/api/sessions/:sessionId/optouts',
    ah(async (req, res) => {
      const normalized = normalizeChatId(String(req.body?.chatId ?? ''));
      if (!normalized) {
        res.status(422).json({ message: 'chatId inválido.' });
        return;
      }
      addOptout(
        normalized,
        String(req.body?.reason ?? 'Solicitó la baja (desde el CRM)'),
        String(req.body?.source ?? 'crm'),
        String(req.params.sessionId),
      );
      res.status(201).json({ chatId: normalized });
    }),
  );

  // ── Contactos y grupos ─────────────────────────────────────────────────────

  app.get(
    '/api/sessions/:sessionId/contacts',
    ah(async (req, res) => {
      const limit = parseInt(String(req.query.limit ?? '1000'), 10) || 1000;
      res.json(await manager.contacts(String(req.params.sessionId), limit));
    }),
  );

  app.get(
    '/api/sessions/:sessionId/contacts/check/:number',
    ah(async (req, res) => {
      res.json(await manager.checkNumber(String(req.params.sessionId), String(req.params.number)));
    }),
  );

  app.get(
    '/api/sessions/:sessionId/groups',
    ah(async (req, res) => {
      res.json(await manager.groups(String(req.params.sessionId)));
    }),
  );

  app.get(
    '/api/sessions/:sessionId/groups/join-info',
    ah(async (req, res) => {
      const code = String(req.query.code ?? '');
      res.json(await manager.groupJoinInfo(String(req.params.sessionId), code));
    }),
  );

  // ── Envío de mensajes ──────────────────────────────────────────────────────

  app.post(
    '/api/sessions/:sessionId/messages/send-text',
    ah(async (req, res) => {
      const chatId = String(req.body?.chatId ?? '');
      const text = String(req.body?.text ?? '');
      if (bloqueadoParaMasivo(req, res, chatId)) return;
      const result = await manager.sendText(String(req.params.sessionId), chatId, text);
      res.json(result);
    }),
  );

  const mediaRoutes: Array<{ route: string; type: string }> = [
    { route: 'send-image', type: 'image' },
    { route: 'send-video', type: 'video' },
    { route: 'send-audio', type: 'audio' },
    { route: 'send-document', type: 'document' },
    { route: 'send-sticker', type: 'sticker' },
  ];

  for (const { route, type } of mediaRoutes) {
    app.post(
      `/api/sessions/:sessionId/messages/${route}`,
      ah(async (req, res) => {
        const chatId = String(req.body?.chatId ?? '');
        if (bloqueadoParaMasivo(req, res, chatId)) return;
        const mimetype = String(req.body?.mimetype ?? 'application/octet-stream');
        const contents = Buffer.from(String(req.body?.base64 ?? ''), 'base64');
        if (contents.length === 0) {
          res.status(422).json({ message: 'base64 inválido.' });
          return;
        }
        const result = await manager.sendMedia(String(req.params.sessionId), chatId, {
          type,
          contents,
          mimetype: type === 'sticker' ? mimetype || 'image/webp' : mimetype,
          filename: req.body?.filename ? String(req.body.filename) : undefined,
          caption: req.body?.caption ? String(req.body.caption) : undefined,
          ptt: req.body?.ptt === true,
        });
        res.json(result);
      }),
    );
  }

  // ── Lectura para el CRM (H0 de PLAN_HISTORIAL_BAILEYS.md del ESAM HUB) ──────
  //
  // El historial que el panel muestra, por línea y SOLO lectura: chats con las
  // pestañas del panel (Números, Grupos, Equipo), mensajes paginados hacia
  // atrás, compañeros del equipo y el directorio de cronogramas.
  //
  // La llave de este gateway es una sola: el corte por cuenta y por línea lo
  // hace el CRM (el wacrm), que es quien la guarda y sabe de quién es cada línea.
  // Acá solo se valida que la línea exista.

  const lineaOk = (req: Request, res: Response): string | null => {
    const sessionId = String(req.params.sessionId);
    if (!manager.byId(sessionId)) {
      res.status(404).json({ message: 'Sesión no encontrada.' });
      return null;
    }
    return sessionId;
  };

  app.get(
    '/api/sessions/:sessionId/chats/summary',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      res.json(chatSummaryForSession(sessionId));
    }),
  );

  app.get(
    '/api/sessions/:sessionId/chats',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const kind = KINDS.includes(String(req.query.kind) as ChatKind) ? (String(req.query.kind) as ChatKind) : null;
      res.json(
        listChatsForSession(sessionId, {
          kind,
          q: typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null,
          limit: parseInt(String(req.query.limit ?? '50'), 10) || 50,
          cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
        }),
      );
    }),
  );

  // Un chat (para abrirlo desde un lead o un contacto del directorio).
  app.get(
    '/api/sessions/:sessionId/chats/:chatId',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const chat = findConversationInSessions([sessionId], String(req.params.chatId));
      if (!chat) {
        res.status(404).json({ message: 'Chat no encontrado en esta línea.' });
        return;
      }
      res.json(chat);
    }),
  );

  // Foto de perfil de un chat (individual o grupo). El panel la sirve por sus
  // propias rutas; esta es la misma foto para el CRM (ESAM HUB), que solo
  // habla con este gateway por HTTP. La primera vez se le pide a WhatsApp y
  // queda guardada; después sale del disco.
  app.get(
    '/api/sessions/:sessionId/chats/:chatId/avatar',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const chatId = String(req.params.chatId);
      let file = await manager.chatAvatar(sessionId, chatId);
      // Los miembros de un grupo llegan como @s.whatsapp.net y la ficha del
      // contacto puede estar guardada en otra variante: se busca por número.
      if (!file) file = await manager.participantAvatar(sessionId, chatId);
      if (!file || !fs.existsSync(file)) {
        res.status(404).json({ message: 'Sin foto de perfil.' });
        return;
      }
      const tipo = file.endsWith('.png')
        ? 'image/png'
        : file.endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg';
      res.setHeader('Content-Type', tipo);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(fs.readFileSync(file));
    }),
  );

  app.get(
    '/api/sessions/:sessionId/chats/:chatId/messages',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const chat = findConversationInSessions([sessionId], String(req.params.chatId));
      if (!chat) {
        res.status(404).json({ message: 'Chat no encontrado en esta línea.' });
        return;
      }
      const after = parseInt(String(req.query.after ?? '0'), 10) || 0;
      const page = listMessages(sessionId, chat.chat_id, {
        before: after ? null : decodeBefore(req.query.before),
        after,
        limit: parseInt(String(req.query.limit ?? '40'), 10) || 40,
      });
      const primero = page.messages[0];
      res.json({
        chat_id: chat.chat_id,
        messages: page.messages,
        has_more: page.hasMore,
        // Para pedir los anteriores: ?before=<next_before>
        next_before: page.hasMore && primero ? encodeBefore(primero.occurred_at, primero.id) : null,
      });
    }),
  );

  // Compañeros del equipo y su chat en esta línea (pestaña Equipo). Se excluye
  // al dueño de la línea: no tiene sentido «escribirse a sí mismo».
  app.get(
    '/api/sessions/:sessionId/team',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const row = manager.byId(sessionId);
      const propias = new Set(
        [row?.phone, row?.expected_phone].filter((p): p is string => !!p).map((p) => phoneKeyOf(p)).filter(Boolean),
      );
      const members = teamMembers()
        .filter((m) => !m.keys.some((k) => propias.has(k)))
        .map((m) => {
          let conversation = null;
          for (const k of m.keys) {
            conversation = findConversationInSessions([sessionId], k) ?? null;
            if (conversation) break;
          }
          return { user_id: m.user_id, name: m.name, area: m.area, area_key: m.area_key, phone: m.phone, line_ready: m.line_ready, conversation };
        });
      res.json({ members });
    }),
  );

  // Envíos del sistema a la persona (cobranzas, notas, asistencias…) o al
  // grupo, con su acuse. Es la solapa «Envíos» de la ficha del panel.
  app.get(
    '/api/sessions/:sessionId/chats/:chatId/sends',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const chatId = String(req.params.chatId);

      let data: PersonSends;
      if (chatId.endsWith('@g.us')) {
        data = groupSends(sessionId, chatId);
      } else {
        const contact = getOrCreateContact(sessionId, chatId);
        const key = contact.phone_key ?? (chatId.endsWith('@lid') ? chatId : phoneKeyOf(chatId));
        data = personSends(key);
      }

      // La ruta del adjunto la arma el HUB con su propia sesión.
      res.json({
        ...data,
        items: data.items.map(({ mediaUrl, ...item }) => ({ ...item, has_media: !!mediaUrl })),
      });
    }),
  );

  // Adjunto de un envío del sistema (por ejemplo, el QR de pago). Se entrega
  // solo si pertenece a la ficha abierta: el grupo, o el número de la persona
  // en cualquiera de las líneas.
  app.get(
    '/api/sessions/:sessionId/chats/:chatId/sends/:itemId/media',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const chatId = String(req.params.chatId);
      const itemId = Number(req.params.itemId) || 0;
      const item = get<{ id: number; chat_id: string; media_path: string | null; media_mime: string | null }>(
        `SELECT bi.id, bi.chat_id, bi.media_path, bi.media_mime
           FROM batch_items bi JOIN batches b ON b.id = bi.batch_id
          WHERE bi.id = ?`,
        itemId,
      );
      if (!item?.media_path) {
        res.status(404).json({ message: 'Adjunto no disponible.' });
        return;
      }

      let permitido = false;
      if (chatId.endsWith('@g.us')) {
        permitido = item.chat_id === chatId;
      } else {
        const contact = getOrCreateContact(sessionId, chatId);
        const key = contact.phone_key ?? (chatId.endsWith('@lid') ? chatId : phoneKeyOf(chatId));
        permitido = !!key && (item.chat_id === `${key}@c.us` || item.chat_id === `${key}@s.whatsapp.net`);
      }
      if (!permitido) {
        res.status(404).json({ message: 'Adjunto no disponible.' });
        return;
      }

      const base = path.resolve(config.storageDir);
      const file = path.resolve(item.media_path);
      if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) {
        res.status(404).json({ message: 'Adjunto no disponible.' });
        return;
      }
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Type', item.media_mime || 'application/octet-stream');
      res.send(fs.readFileSync(file));
    }),
  );

  // Grupos en los que participa una persona. `sessions` son las líneas que el
  // HUB ya validó para este usuario (el panel recorre las suyas).
  app.get(
    '/api/sessions/:sessionId/chats/:chatId/groups',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const chatId = String(req.params.chatId);
      if (chatId.endsWith('@g.us')) {
        res.json({ groups: [] });
        return;
      }
      const contact = getOrCreateContact(sessionId, chatId);
      const key = contact.phone_key ?? (chatId.endsWith('@lid') ? chatId : phoneKeyOf(chatId));
      if (!key) {
        res.json({ groups: [] });
        return;
      }

      const pedidas = String(req.query.sessions ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      // La línea abierta primero: si el grupo está en varias, no se duplica.
      const orden = [sessionId, ...pedidas.filter((id) => id !== sessionId)];

      const seen = new Set<string>();
      const groups: Array<{
        id: string;
        chat_id: string;
        name: string;
        participant_count: number;
        session_id: string;
        session_name: string | null;
        session_phone: string | null;
      }> = [];

      for (const id of orden) {
        const line = get<{ id: string; name: string | null; phone: string | null }>(
          'SELECT id, name, phone FROM sessions WHERE id = ?',
          id,
        );
        if (!line) continue;
        try {
          const found = await manager.groupsForPhone(id, key);
          for (const g of found) {
            if (seen.has(g.id)) continue;
            seen.add(g.id);
            groups.push({
              id: g.id,
              chat_id: g.id,
              name: g.name,
              participant_count: g.participantCount,
              session_id: id,
              session_name: line.name,
              session_phone: line.phone,
            });
          }
        } catch {
          // Línea desconectada o sin grupos: se sigue con las demás.
        }
      }

      groups.sort((a, b) => a.name.localeCompare(b.name, 'es'));
      res.json({ groups });
    }),
  );

  // Notas internas de la persona (las mismas de la ficha del panel).
  app.get(
    '/api/sessions/:sessionId/chats/:chatId/notes',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const contact = getOrCreateContact(sessionId, String(req.params.chatId));
      const viewer = usuarioPanel(sessionId, req.query.viewer_email);
      const notes = listNotes(contact.id, 200, viewer);
      res.json({ notes: notes.map(notaParaHub) });
    }),
  );

  // Registrar una nota interna (texto y fecha de seguimiento opcional).
  app.post(
    '/api/sessions/:sessionId/chats/:chatId/notes',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const contact = getOrCreateContact(sessionId, String(req.params.chatId));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = String(body.text ?? '').trim();
      if (!text) {
        res.status(422).json({ message: 'La nota no puede estar vacía.' });
        return;
      }
      if (text.length > 4000) {
        res.status(422).json({ message: 'La nota es demasiado larga (máx. 4000 caracteres).' });
        return;
      }
      const dueRaw = body.due_at === null || body.due_at === undefined ? '' : String(body.due_at).slice(0, 10);
      if (dueRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dueRaw)) {
        res.status(422).json({ message: 'La fecha de seguimiento no es válida.' });
        return;
      }
      const pinned = body.pinned === true || body.pinned === 1 || body.pinned === '1';
      const user = usuarioPanel(sessionId, body.sender_email);
      const note = addNote(contact.id, user, text, null, dueRaw || null, [], pinned);
      res.status(201).json({ note: notaParaHub(note) });
    }),
  );

  /** La nota pedida pertenece a la ficha del chat (no se toca otra). */
  const notaDelChat = (contactId: number, noteId: number) => get<{ id: number }>(
    'SELECT id FROM contact_notes WHERE id = ? AND contact_id = ? AND deleted_at IS NULL',
    noteId,
    contactId,
  );

  app.post(
    '/api/sessions/:sessionId/chats/:chatId/notes/:noteId/done',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const contact = getOrCreateContact(sessionId, String(req.params.chatId));
      const noteId = Number(req.params.noteId) || 0;
      if (!noteId || !notaDelChat(contact.id, noteId)) {
        res.status(404).json({ message: 'Nota no encontrada en esta ficha.' });
        return;
      }
      const done = (req.body ?? {}).done !== false;
      setNoteDone(noteId, usuarioPanel(sessionId, (req.body ?? {}).sender_email), done);
      res.json({ ok: true, done });
    }),
  );

  app.post(
    '/api/sessions/:sessionId/chats/:chatId/notes/:noteId/pin',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const contact = getOrCreateContact(sessionId, String(req.params.chatId));
      const noteId = Number(req.params.noteId) || 0;
      if (!noteId || !notaDelChat(contact.id, noteId)) {
        res.status(404).json({ message: 'Nota no encontrada en esta ficha.' });
        return;
      }
      const pinned = (req.body ?? {}).pinned === true;
      setNotePinned(noteId, pinned, usuarioPanel(sessionId, (req.body ?? {}).sender_email));
      res.json({ ok: true, pinned });
    }),
  );

  app.delete(
    '/api/sessions/:sessionId/chats/:chatId/notes/:noteId',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const contact = getOrCreateContact(sessionId, String(req.params.chatId));
      const noteId = Number(req.params.noteId) || 0;
      if (!noteId || !notaDelChat(contact.id, noteId)) {
        res.status(404).json({ message: 'Nota no encontrada en esta ficha.' });
        return;
      }
      const cuerpo = (req.body ?? {}) as { sender_email?: string };
      deleteNote(noteId, usuarioPanel(sessionId, cuerpo.sender_email ?? req.query.sender_email));
      res.json({ ok: true });
    }),
  );

  // Ficha de la persona en esta línea (datos, CI, programas, prospecto).
  app.get(
    '/api/sessions/:sessionId/chats/:chatId/person',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const chatId = String(req.params.chatId);
      const ficha = fichaPersona(sessionId, chatId);
      const grupo = chatId.endsWith('@g.us') ? await manager.groupInfo(sessionId, chatId) : null;
      res.json({ ...ficha, group: grupo });
    }),
  );

  // Guardar los datos de la persona (nombre, email, empresa, CI y programa).
  // Quedan por número: los ven todas las líneas y todos los usuarios.
  app.put(
    '/api/sessions/:sessionId/chats/:chatId/profile',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const chatId = String(req.params.chatId);
      const contact = getOrCreateContact(sessionId, chatId);
      const key = contact.phone_key
        ?? (chatId.endsWith('@g.us') ? null : chatId.endsWith('@lid') ? chatId : phoneKeyOf(chatId));
      if (!key) {
        res.status(422).json({ message: 'Este chat no tiene un número al que asociar los datos.' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      // null = borrar el dato; undefined = no se toca. Un campo vacío llega
      // como null desde Laravel y tiene que limpiar, no guardar "null".
      const texto = (v: unknown) => (v === undefined ? undefined : v === null ? '' : String(v).trim());
      const name = texto(body.name);
      const programa = texto(body.programa);
      const ci = texto(body.ci);
      const email = texto(body.email);
      const company = texto(body.company);

      if (name !== undefined && name.length > 120) return res.status(422).json({ message: 'El nombre es demasiado largo (máx. 120 caracteres).' });
      if (programa !== undefined && programa.length > 160) return res.status(422).json({ message: 'El programa es demasiado largo (máx. 160 caracteres).' });
      if (ci !== undefined && ci.length > 40) return res.status(422).json({ message: 'El carnet de identidad es demasiado largo (máx. 40 caracteres).' });
      if (email !== undefined && email.length > 160) return res.status(422).json({ message: 'El email es demasiado largo (máx. 160 caracteres).' });
      if (company !== undefined && company.length > 120) return res.status(422).json({ message: 'La empresa es demasiado larga (máx. 120 caracteres).' });
      if (name === undefined && programa === undefined && ci === undefined && email === undefined && company === undefined) {
        return res.status(422).json({ message: 'Registrá al menos el nombre, el programa, el CI, el email o la empresa.' });
      }

      const patch: ContactPatch = {};
      if (name !== undefined) patch.name = name || null;
      if (email !== undefined) patch.email = email || null;
      if (company !== undefined) patch.company = company || null;
      const patched = Object.keys(patch).length ? upsertContact(sessionId, chatId, patch) : contact;

      if (name !== undefined) setPersonName(key, name || null, null);
      if (programa !== undefined) setPersonProgram(key, programa || null, null);
      if (ci !== undefined) setPersonCi(key, ci || null, null);

      res.json({
        ok: true,
        person: { ...(personTagsByKeys([key]).get(key) ?? {}), ci: getPersonCi(key) },
        contact: { name: patched.name, phone: patched.phone, email: patched.email, company: patched.company },
      });
    }),
  );

  // Programas existentes, para el selector de la ficha.
  app.get(
    '/api/sessions/:sessionId/programs',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      res.json({ programas: directoryPrograms() });
    }),
  );

  // Miembros de un grupo, con la ficha de cada persona (como en el panel).
  app.get(
    '/api/sessions/:sessionId/chats/:chatId/participants',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      const chatId = String(req.params.chatId);
      if (!chatId.endsWith('@g.us')) {
        res.json([]);
        return;
      }

      try {
        const raw = await manager.groupParticipants(sessionId, chatId);
        const keyOf = (p: (typeof raw)[number]) => (
          (p.phone ? phoneKeyOf(p.phone) : null) ?? (p.id.endsWith('@lid') ? null : phoneKeyOf(p.id))
        );
        const keys = raw.map(keyOf);
        const people = personTagsByKeys(keys);

        // Una sola consulta para saber quién tiene foto guardada.
        const ids = raw.map((p) => String(p.id)).filter(Boolean);
        const conClave = keys.filter((k): k is string => !!k);
        const conFoto = new Set<string>();
        const cond: string[] = [];
        const params: unknown[] = [];
        if (ids.length) {
          cond.push(`chat_id IN (${ids.map(() => '?').join(',')})`);
          params.push(...ids);
        }
        if (conClave.length) {
          cond.push(`phone_key IN (${conClave.map(() => '?').join(',')})`);
          params.push(...conClave);
        }
        if (cond.length) {
          for (const row of all<{ chat_id: string; phone_key: string | null }>(
            `SELECT chat_id, phone_key FROM contacts WHERE avatar_path IS NOT NULL AND (${cond.join(' OR ')})`,
            ...params,
          )) {
            conFoto.add(`c:${row.chat_id}`);
            if (row.phone_key) conFoto.add(`k:${row.phone_key}`);
          }
        }

        // Se entrega el JID como chat (@c.us). WhatsApp devuelve los miembros
        // como @s.whatsapp.net y con esa variante no se encuentra la
        // conversación guardada (el panel hace la misma normalización).
        const comoChat = (id: string) => {
          if (id.endsWith('@g.us') || id.endsWith('@lid')) return id;
          const digitos = id.replace(/@.*$/, '').replace(/\D+/g, '');
          return digitos ? `${digitos}@c.us` : id;
        };

        res.json(raw.map((p, i) => {
          const key = keys[i];
          const tags = key ? people.get(key) : undefined;
          return {
            ...p,
            id: comoChat(String(p.id)),
            phone_key: key,
            full_name: tags?.full_name ?? null,
            name_source: tags?.name_source ?? null,
            programas: tags?.programas ?? [],
            team: teamTagFor(key),
            avatar: conFoto.has(`c:${p.id}`) || (!!key && conFoto.has(`k:${key}`)),
          };
        }));
      } catch (err) {
        res.status(502).json({ message: (err as Error).message });
      }
    }),
  );

  // Directorio de cronogramas (pestaña Contactos), con su chat en esta línea.
  app.get(
    '/api/sessions/:sessionId/directory',
    ah(async (req, res) => {
      const sessionId = lineaOk(req, res);
      if (!sessionId) return;
      res.json(
        listDirectory({
          q: typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) || null : null,
          programa: typeof req.query.programa === 'string' ? req.query.programa.trim() || null : null,
          sessionIds: [sessionId],
          limit: parseInt(String(req.query.limit ?? '100'), 10) || 100,
          offset: parseInt(String(req.query.offset ?? '0'), 10) || 0,
        }),
      );
    }),
  );

  // Descarga de media entrante por id de mensaje.
  app.get(
    '/api/sessions/:sessionId/messages/:chatId/:messageId/media',
    ah(async (req, res) => {
      const row = get<{ id: number }>(
        'SELECT id FROM messages WHERE session_id = ? AND wa_message_id = ?',
        String(req.params.sessionId),
        String(req.params.messageId),
      );
      // Si la media no se bajó (offline/historial), se descarga ahora de WhatsApp.
      const file = row ? await manager.ensureMedia(row.id) : null;
      if (!file || !fs.existsSync(file.path)) {
        res.status(404).json({ message: 'Media no encontrada.' });
        return;
      }
      res.type(file.mime ?? typeForMime(file.path));
      res.send(fs.readFileSync(file.path));
    }),
  );

  // Manejador de errores.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.warn({ err: err.message }, 'Error en el gateway');
    res.status(502).json({ message: err.message });
  });

  return app;
}
