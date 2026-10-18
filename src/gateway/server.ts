import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import { config } from '../config.js';
import { get } from '../db/index.js';
import { logger } from '../logger.js';
import { SessionManager } from '../baileys/manager.js';
import { registerWebhook } from '../core/webhooks.js';
import { typeForMime } from '../core/phone.js';
import { systemHealth } from '../core/system-health.js';

/** Envuelve un handler async para capturar errores. */
function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
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
