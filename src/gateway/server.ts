import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import { config } from '../config.js';
import { get } from '../db/index.js';
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
import { teamMembers } from '../core/team.js';
import { listDirectory } from '../core/directory.js';
import { phoneKeyOf } from '../core/person.js';

const KINDS: ChatKind[] = ['individual', 'group', 'team'];

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
