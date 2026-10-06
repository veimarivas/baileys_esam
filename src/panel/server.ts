import path from 'node:path';
import fs from 'node:fs';
import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { all, get, run } from '../db/index.js';
import { logger } from '../logger.js';
import { SessionManager } from '../baileys/manager.js';
import { batchList, card, connectionCard, emptyState, fmtDate, initials, insight, kvList, safeJson, sectionHead, stat, statusBadge, table } from './views.js';
import { esc, renderLayout, renderLogin, renderPlain } from './layout.js';
import { sessionCookieHeader, sessionStore, clearCookieHeader } from '../auth/sessions.js';
import { verifySsoToken, safeNext } from '../auth/sso.js';
import {
  esamEsAdmin,
  esamHome,
  esamPuede,
  esamRoles,
  ensureLocalAdmin,
  ensureUserSession,
  findByLogin,
  findById,
  listUsers,
  registerLogin,
  sessionScopeFor,
  upsertUser,
  usernameAvailableFor,
  verifyPassword,
  type UserRow,
} from '../auth/users.js';
import { listOptouts, addOptout, removeOptout } from '../core/optout.js';
import { audit } from '../core/webhooks.js';
import { getConfig, setConfig } from '../core/config-store.js';
import { monitoringData, reportsData, activityData } from '../core/monitoring.js';
import { recount } from '../core/batches.js';
import type { BatchRunner } from '../core/batches.js';
import { normalizePhone } from '../core/phone.js';
import { panelBus } from './events.js';
import { deleteSticker, getSticker, listStickers, makeSticker, toggleSticker } from '../core/stickers.js';
import { createRule, deleteRule, listRules, MATCH_TYPES, toggleRule } from '../core/autoreply.js';
import * as quickReplies from '../core/quick-replies.js';
import { importCsvToBatch } from '../core/csv.js';
import { createBatch } from '../core/batch-service.js';
import { scheduleBatch } from '../core/scheduler.js';
import { registerAntiBanRoutes } from './anti-ban.js';
import { registerInboxRoutes } from './inbox.js';
import type { SessionRow } from '../types.js';

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
}

/** Extrae una cookie concreta. */
function cookie(req: Request, name: string): string | undefined {
  const header = req.header('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** Variantes de un chat_id para tolerar @c.us, @s.whatsapp.net y @lid. */
function chatIdVariants(chatId: string): string[] {
  const base = String(chatId ?? '').trim();
  const digits = base.replace(/@.*$/, '').replace(/\D+/g, '');
  const set = new Set<string>();
  if (base) set.add(base);
  if (digits) {
    set.add(`${digits}@c.us`);
    set.add(`${digits}@s.whatsapp.net`);
    set.add(`${digits}@lid`);
  }
  return [...set];
}

/**
 * Resuelve el parámetro `:chat` de la URL al chat_id real almacenado, tolerando
 * que el chat haya llegado como `@lid`, `@c.us` o `@s.whatsapp.net`.
 */
function resolveChatParam(
  sessionId: string,
  param: string,
): { chatId: string; conv: Record<string, any> | undefined } {
  const decoded = decodeURIComponent(String(param ?? '')).trim();
  const candidates = chatIdVariants(decoded);
  if (!candidates.length) return { chatId: decoded, conv: undefined };
  const placeholders = candidates.map(() => '?').join(',');
  const conv = get<any>(
    `SELECT * FROM conversations WHERE session_id = ? AND chat_id IN (${placeholders})
     ORDER BY COALESCE(last_message_at, updated_at) DESC LIMIT 1`,
    sessionId,
    ...candidates,
  );
  if (conv) return { chatId: String(conv.chat_id), conv };
  const msg = get<{ chat_id: string }>(
    `SELECT chat_id FROM messages WHERE session_id = ? AND chat_id IN (${placeholders}) ORDER BY id DESC LIMIT 1`,
    sessionId,
    ...candidates,
  );
  return { chatId: msg?.chat_id ?? candidates[0], conv: undefined };
}

/** Consulta del inbox: individuales y grupos, sin estados ni boletines. */
const INBOX_WHERE = `chat_id NOT LIKE '%@broadcast' AND chat_id NOT LIKE '%@newsletter'`;

/**
 * Página de notas internas: tablero de seguimiento (indicadores por estado),
 * listado agrupado por fecha y gestor de etiquetas en la columna lateral.
 * El contenido lo arma `initNotes()` en public/app.js.
 */
function renderNotesPage(): string {
  return `<div class="notes-page" id="notes-page">
    <div class="np-stats" id="np-stats" role="tablist" aria-label="Estado del seguimiento"></div>

    <div class="np-layout">
      <section class="np-main" aria-label="Notas">
        <div class="np-toolbar">
          <label class="notes-search"><span class="ri-search-line" aria-hidden="true"></span>
            <input type="search" id="notes-search" placeholder="Buscar en las notas, por contacto o número…" autocomplete="off" aria-label="Buscar notas" /></label>
          <select id="notes-order" class="form-select form-select-sm" aria-label="Orden">
            <option value="due">Por fecha de seguimiento</option>
            <option value="created">Más recientes primero</option>
          </select>
          <label class="np-mine"><input type="checkbox" class="form-check-input" id="notes-mine" /> Solo mis notas</label>
        </div>
        <div id="np-active" class="np-active"></div>
        <div id="notes-list" class="np-list" aria-live="polite"></div>
      </section>

      <aside class="np-side" aria-label="Etiquetas">
        <div class="np-side-card">
          <div class="np-side-head">
            <h6><span class="ri-price-tag-3-line" aria-hidden="true"></span> Etiquetas</h6>
            <button type="button" id="np-manage" class="btn btn-sm btn-soft-secondary" aria-pressed="false">Gestionar</button>
          </div>
          <div id="np-tags" class="np-tags"></div>
          <div id="np-tag-form" class="np-tag-form" hidden>
            <div class="nk-field-label">Nueva etiqueta</div>
            <input id="tag-name" class="form-control form-control-sm" placeholder="Ej.: Interesado, Pago pendiente…" maxlength="40" />
            <div id="tag-colors" class="tag-colors"></div>
            <button id="tag-save" type="button" class="btn btn-primary btn-sm w-100"><span class="ri-add-line"></span> Crear etiqueta</button>
          </div>
        </div>
        <div class="np-side-card np-tips">
          <h6><span class="ri-lightbulb-line" aria-hidden="true"></span> Para que sirvan de verdad</h6>
          <ul>
            <li>Anotá lo que no queda en el chat: horarios, preferencias, acuerdos.</li>
            <li>Si hay que volver a contactar, poné <b>fecha de seguimiento</b>.</li>
            <li>Marcá <span class="np-tip-check"><span class="ri-check-line"></span></span> cuando esté hecho: deja de figurar como pendiente.</li>
          </ul>
        </div>
      </aside>
    </div>
  </div>`;
}

export function createPanelApp(manager: SessionManager, runner: BatchRunner) {
  ensureLocalAdmin();
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  const uploadSticker = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });
  const uploadCsv = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
  // Estáticos: Velzon vive en public/assets; los propios (app.css/js) en public/.
  app.use('/assets', express.static(path.resolve('public', 'assets')));
  app.use(express.static(path.resolve('public'), { index: false }));

  type AuthedRequest = Request & { user?: UserRow };

  const currentUser = (req: Request): UserRow | undefined => {
    const id = sessionStore.userId(cookie(req, config.sessionCookie));
    return id ? findById(id) : undefined;
  };

  const requireUser = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const user = currentUser(req);
    if (!user) return res.redirect('/login');
    req.user = user;
    next();
  };

  const requireSection = (section: string) => (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !esamPuede(req.user, section)) {
      return res.status(403).send(renderPlain('Acceso denegado', 'No tenés permiso para acceder a esta sección.'));
    }
    // Sin número vinculado, el usuario solo puede usar Conexión.
    if (section !== 'settings' && !isConnected(req.user)) {
      return res.redirect('/settings');
    }
    next();
  };

  /**
   * Devuelve la sesión (número de WhatsApp) que corresponde al usuario.
   *
   * Prioridad:
   * 1) Su propia sesión por `esam_numero` (aunque sea admin).
   * 2) Su sesión por `owner_uid` (espejo de cronogramas).
   * 3) Admin sin número propio: la sesión principal.
   * 4) Usuario normal: sesiones de su alcance.
   */
  const sessionForUser = (user: UserRow): SessionRow | undefined => {
    const allSessions = manager.list();
    const clean = (v: string | null | undefined) => String(v ?? '').replace(/\D+/g, '');
    const numero = clean(user.esam_numero);

    if (numero) {
      const own = allSessions.find((s) => clean(s.expected_phone) === numero || clean(s.phone) === numero);
      if (own) return own;
    }

    if (user.source_uid) {
      const byOwner = allSessions.find((s) => s.owner_uid === user.source_uid);
      if (byOwner) return byOwner;
    }

    const scope = sessionScopeFor(user);
    if (scope === null) {
      // Admin sin número propio: usa la sesión que haya elegido, o la principal.
      const preferred = getConfig(`view_session:${user.id}`);
      if (preferred) {
        const chosen = allSessions.find((s) => s.id === preferred);
        if (chosen) return chosen;
      }
      return manager.primary() ?? allSessions[0];
    }
    for (const s of allSessions) {
      if (scope.includes(s.id) && (s.phone || s.expected_phone)) return s;
    }
    return undefined;
  };

  /** Selector de sesión para administradores sin número propio. */
  const sessionPickerFor = (user: UserRow): string => {
    if (!esamEsAdmin(user) || (user.esam_numero ?? '').trim() !== '') return '';
    const sessions = manager.list();
    if (sessions.length <= 1) return '';
    const current = sessionForUser(user)?.id ?? '';
    const options = sessions
      .map((s) => {
        const label = s.phone ?? s.expected_phone ?? s.name;
        return `<option value="${esc(s.id)}"${s.id === current ? ' selected' : ''}>${esc(label)} · ${esc(s.name)}</option>`;
      })
      .join('');
    return `<form method="post" action="/conversations/session" class="d-inline-flex align-items-center gap-1 me-auto" title="Elegí qué número/sesión ver">
        <select name="session_id" class="form-select form-select-sm" onchange="this.form.submit()" style="width:auto">${options}</select>
      </form>`;
  };

  /**
   * ¿El usuario ya puede usar el panel? Solo si su sesión de WhatsApp está
   * vinculada (`ready`). Mientras no lo esté (creada/qr/connecting/blocked),
   * solo puede acceder a la vista Conexión.
   */
  const isConnected = (user: UserRow): boolean => {
    const session = sessionForUser(user);
    return !!session && session.status === 'ready';
  };

  /** Vista de inicio del usuario: Conexión si aún no vinculó su número. */
  const homeFor = (user: UserRow): string => (isConnected(user) ? esamHome(user) : '/settings');

  /** Rate limit simple por IP+ruta (protege envíos desde el inbox). */
  const rateLimit = (max: number, windowMs: number) => {
    const hits = new Map<string, { count: number; reset: number }>();
    return (req: Request, res: Response, next: NextFunction) => {
      const key = `${req.ip}:${req.path}`;
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.reset < now) {
        hits.set(key, { count: 1, reset: now + windowMs });
        return next();
      }
      entry.count++;
      if (entry.count > max) return res.status(429).send(renderPlain('Demasiadas solicitudes', 'Esperá un momento e intentá de nuevo.'));
      next();
    };
  };

  // ── Autenticación ────────────────────────────────────────────────────────────

  app.get('/login', (req, res) => {
    if (currentUser(req)) return res.redirect('/');
    res.send(renderLogin());
  });

  app.post('/login', (req, res) => {
    const login = String(req.body?.login ?? '').trim();
    const password = String(req.body?.password ?? '');
    const user = findByLogin(login);
    if (!user || !verifyPassword(user, password)) {
      return res.status(401).send(renderLogin('Credenciales inválidas.'));
    }
    if (user.source === 'cronogramas' && !user.esam_autorizado) {
      return res.status(403).send(renderLogin('Tu cuenta no tiene permiso para acceder a Seguimiento ESAM.'));
    }
    // Vincula/crea la sesión de WhatsApp del número del usuario para su historial.
    ensureUserSession(user);
    const { cookie: value, expiresAt } = sessionStore.create(user.id);
    registerLogin(user.id, req.ip ?? null);
    res.setHeader('Set-Cookie', sessionCookieHeader(value, expiresAt));
    res.redirect(homeFor(user));
  });

  app.post('/logout', (req, res) => {
    sessionStore.destroy(cookie(req, config.sessionCookie));
    res.setHeader('Set-Cookie', clearCookieHeader());
    res.redirect('/login');
  });

  // SSO desde cronogramas.
  app.get('/sso', (req, res) => {
    const token = String(req.query.token ?? '');
    const result = verifySsoToken(token, config.ssoSecret);
    if (!result.ok) {
      return res.status(403).send(renderPlain('SSO', result.error));
    }
    const p = result.payload;
    const user = upsertUser({
      sourceUid: p.uid,
      name: p.name ?? null,
      username: usernameAvailableFor(p.username, p.uid),
      email: p.email ?? null,
      source: 'cronogramas',
      autorizado: !!p.autorizado,
      area: p.area ?? null,
      numero: p.numero ? normalizePhone(p.numero) : null,
      roles: Array.isArray(p.roles) ? p.roles : [],
    });
    if (!user.esam_autorizado) {
      return res.status(403).send(renderPlain('SSO', 'Tu cuenta no tiene permiso para acceder a Seguimiento ESAM.'));
    }
    // Vincula/crea la sesión de WhatsApp del número del usuario para su historial.
    ensureUserSession(user);
    const { cookie: value, expiresAt } = sessionStore.create(user.id);
    registerLogin(user.id, req.ip ?? null);
    res.setHeader('Set-Cookie', sessionCookieHeader(value, expiresAt));
    res.redirect(safeNext(p.next, homeFor(user)));
  });

  // ── Raíz ─────────────────────────────────────────────────────────────────────

  app.get('/', (req, res) => {
    const user = currentUser(req);
    res.redirect(user ? homeFor(user) : '/login');
  });

  // ── Actividad por usuario (JSON para auto-refresco) ─────────────────────────

  app.get(
    '/api/activity',
    requireUser,
    requireSection('monitoring'),
    ah(async (req: AuthedRequest, res) => {
      const q = (k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : '');
      const scope = sessionScopeFor(req.user!);
      const data = activityData(
        {
          from: q('from') || undefined,
          to: q('to') || undefined,
          day: q('day') || undefined,
          account: q('account') || undefined,
          area: q('area') || undefined,
        },
        scope === null ? null : scope,
      );
      res.json(data);
    }),
  );

  // ── Eventos en tiempo real (SSE) ─────────────────────────────────────────────

  app.get(
    '/events',
    requireUser,
    requireSection('conversations'),
    (req: AuthedRequest, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\n\n`);

      // Solo eventos de las sesiones/números del usuario (los eventos llevan el
      // texto del mensaje: no deben llegar a otras cuentas).
      const scope = sessionScopeFor(req.user!);
      const onEvent = (event: { type: string; payload: Record<string, unknown> }) => {
        const sid = event.payload?.sessionId;
        if (scope !== null && typeof sid === 'string' && !scope.includes(sid)) return;
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      };
      panelBus.on('event', onEvent);

      const ping = setInterval(() => res.write(': ping\n\n'), 25000);

      req.on('close', () => {
        panelBus.off('event', onEvent);
        clearInterval(ping);
      });
    },
  );

  // Suscripción de presencia (escribiendo…).
  app.post(
    '/presence/subscribe',
    requireUser,
    requireSection('conversations'),
    ah(async (req: AuthedRequest, res) => {
      const raw = String(req.body?.chat ?? '').trim();
      const chatId = raw.includes('@') ? raw : `${raw.replace(/\D+/g, '')}@c.us`;
      const session = sessionForUser(req.user!);
      if (session && chatId) {
        try {
          await manager.subscribePresence(session.id, chatId);
        } catch {
          // best-effort
        }
      }
      res.json({ ok: true });
    }),
  );

  // ── Conexión ─────────────────────────────────────────────────────────────────

  app.get(
    '/settings',
    requireUser,
    requireSection('settings'),
    ah(async (req: AuthedRequest, res) => {
      const session = sessionForUser(req.user!) ?? (esamEsAdmin(req.user!) ? manager.primary() : undefined);
      const sessions = esamEsAdmin(req.user!) ? manager.list() : session ? [session] : [];
      const sessionsCard = sessions.length
        ? `${sectionHead('ri-stack-line', 'Sesiones del gateway', 'Cada sesión es un número de WhatsApp vinculado y su historial de conversaciones.')}
           <div class="card"><div class="card-body py-1">${sessions
             .map((s, i) => {
               const last = i === sessions.length - 1;
               return `<div class="d-flex align-items-center gap-3 py-3${last ? '' : ' border-bottom'}">
                 <span class="avatar-sm rounded-circle av-${i % 8}">${esc(initials(s.owner_name ?? s.name))}</span>
                 <div class="flex-grow-1 min-w-0">
                   <div class="fw-semibold">${esc(s.owner_name ?? s.name)}${s.id === session?.id ? ' <span class="badge bg-primary-subtle text-primary ms-1">Principal</span>' : ''}</div>
                   <div class="text-muted fs-12"><span class="ff-monospace">${esc(s.phone ?? s.expected_phone ?? '—')}</span></div>
                 </div>
                 ${statusBadge(s.status)}
               </div>`;
             })
             .join('')}</div></div>`
        : '';
      const gatewayCard = card(
        'Gateway',
        `${kvList([
          ['Motor', '<span class="badge bg-success-subtle text-success">Baileys · sin Chromium</span>'],
          ['Gateway', `<span class="ff-monospace">http://${esc(config.host)}:${config.port}</span>`],
          ['API v1', `<span class="ff-monospace">http://${esc(config.host)}:${config.apiPort}/api/v1</span>`],
          ['Panel', `<span class="ff-monospace">http://${esc(config.host)}:${config.panelPort}</span>`],
        ])}`,
      );
      const body = `<div class="row g-3">
        <div class="col-lg-7">${connectionCard(session, session?.owner_name ?? undefined)}</div>
        <div class="col-lg-5">${gatewayCard}</div>
      </div>
      ${sessionsCard}`;
      res.send(
        renderLayout('Conexión', req.user!, 'settings', body, {
          flash: flash(req),
          subtitle: 'Vinculá el número de WhatsApp y revisá el estado del gateway.',
          restrictToSettings: !isConnected(req.user!),
        }),
      );
    }),
  );

  app.get(
    '/settings/qr',
    requireUser,
    requireSection('settings'),
    ah(async (req: AuthedRequest, res) => {
      const session = sessionForUser(req.user!) ?? (esamEsAdmin(req.user!) ? manager.primary() : undefined);
      if (!session) return res.json({ connected: false, qrCode: null });
      // `manager.qr()` arranca la sesión si hace falta y espera el QR.
      const code = await manager.qr(session.id);
      const fresh = manager.byId(session.id)!;
      res.json({ connected: fresh.status === 'ready', phone: fresh.phone, qrCode: code });
    }),
  );

  // Crea la sesión (principal) y arranca el socket para vincular el número.
  app.post(
    '/settings/create',
    requireUser,
    requireSection('settings'),
    ah(async (req: AuthedRequest, res) => {
      if (!esamEsAdmin(req.user!)) {
        return res.redirect('/settings?ok=' + encodeURIComponent('Solo un administrador puede crear sesiones.'));
      }
      const name = String(req.body?.name ?? '').trim() || 'esam-principal';
      const row = manager.createSession(name, config.apiKey || null, `whsec_${Math.random().toString(36).slice(2)}`);
      try {
        await manager.start(row.id);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'No se pudo arrancar la sesión creada');
        return res.redirect('/settings?ok=' + encodeURIComponent('Sesión creada, pero no arrancó: ' + (err as Error).message));
      }
      res.redirect('/settings?ok=' + encodeURIComponent('Sesión creada. Pulsá “Mostrar QR” para vincular el número.'));
    }),
  );

  app.post(
    '/settings/pairing',
    requireUser,
    requireSection('settings'),
    ah(async (req: AuthedRequest, res) => {
      const session = sessionForUser(req.user!) ?? (esamEsAdmin(req.user!) ? manager.primary() : undefined);
      if (!session) return res.redirect('/settings');
      try {
        await manager.pairing(session.id, String(req.body?.phone_number ?? ''));
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Pairing falló');
      }
      res.redirect('/settings');
    }),
  );

  app.post(
    '/settings/logout',
    requireUser,
    requireSection('settings'),
    ah(async (req: AuthedRequest, res) => {
      const session = sessionForUser(req.user!) ?? (esamEsAdmin(req.user!) ? manager.primary() : undefined);
      if (session) await manager.logout(session.id);
      res.redirect('/settings');
    }),
  );

  // ── Lotes ────────────────────────────────────────────────────────────────────

  app.get(
    '/batches',
    requireUser,
    requireSection('batches'),
    ah(async (req: AuthedRequest, res) => {
      const rows = all<any>('SELECT * FROM batches ORDER BY id DESC LIMIT 100');
      const body = batchList(rows);
      res.send(
        renderLayout('Lotes', req.user!, 'batches', body, {
          subtitle: 'Seguimiento de envíos por lotes con progreso en vivo.',
          activeHref: '/batches',
        }),
      );
    }),
  );

  app.get(
    '/batches/:id/status',
    requireUser,
    requireSection('batches'),
    ah(async (req: AuthedRequest, res) => {
      const b = get<any>('SELECT * FROM batches WHERE id = ?', Number(req.params.id));
      if (!b) return res.status(404).json({ message: 'No encontrado' });
      const pending = Math.max(0, b.total - b.sent - b.failed - b.skipped);
      const progress = b.total > 0 ? Math.round(((b.sent + b.failed + b.skipped) / b.total) * 100) : 0;
      res.json({ status: b.status, total: b.total, sent: b.sent, failed: b.failed, skipped: b.skipped, pending, progress });
    }),
  );

  app.get(
    '/batches/:id',
    requireUser,
    requireSection('batches'),
    ah(async (req: AuthedRequest, res) => {
      const b = get<any>('SELECT * FROM batches WHERE id = ?', Number(req.params.id));
      if (!b) return res.status(404).send(renderPlain('Lote', 'No encontrado'));
      const items = all<any>('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY id LIMIT 500', b.id);
      const meta = safeJson(b.meta ?? '{}') as any;
      const progress = b.total > 0 ? Math.round(((b.sent + b.failed + b.skipped) / b.total) * 100) : 0;
      const body = `
        <div class="card" data-batch="${b.id}">
          <div class="card-header d-flex align-items-center gap-2">
            <h5 class="card-title mb-0 flex-grow-1">${esc(b.name ?? 'Lote')}</h5>${statusBadge(b.status)}
          </div>
          <div class="card-body">
            <p class="text-muted mb-3"><i class="ri-graduation-cap-line me-1"></i>${esc(meta.programa ?? '—')} · ${esc(meta.tipo ?? meta.category ?? '')}</p>
            ${b.status === 'paused' && meta.anti_ban_pause
              ? `<div class="alert alert-warning d-flex gap-2 align-items-start" role="status"><i class="ri-shield-star-line fs-5"></i><div><b>Pausado por el anti-baneo.</b> ${esc(meta.anti_ban_pause)}</div></div>`
              : ''}
            <div class="row g-3 mb-3">
              <div class="col">${stat('Total', b.total)}</div>
              <div class="col">${stat('Enviados', `<span data-f="sent">${b.sent}</span>`, 'success')}</div>
              <div class="col">${stat('Fallidos', `<span data-f="failed">${b.failed}</span>`, 'danger')}</div>
              <div class="col">${stat('Omitidos', `<span data-f="skipped">${b.skipped}</span>`, 'warning')}</div>
            </div>
            <div class="progress mb-3"><div class="progress-bar bg-success" style="width:${progress}%"></div></div>
            <div class="d-flex flex-wrap gap-2">
              <a class="btn btn-soft-secondary btn-sm" href="/batches"><i class="ri-arrow-left-line me-1"></i>Volver</a>
              <form method="post" action="/batches/${b.id}/pause"><button class="btn btn-soft-warning btn-sm" type="submit"><i class="ri-pause-line me-1"></i>Pausar</button></form>
              <form method="post" action="/batches/${b.id}/resume"><button class="btn btn-soft-success btn-sm" type="submit"><i class="ri-play-line me-1"></i>Reanudar</button></form>
              <form method="post" action="/batches/${b.id}/cancel"><button class="btn btn-soft-danger btn-sm" type="submit"><i class="ri-close-line me-1"></i>Cancelar</button></form>
              ${b.failed > 0 ? `<form method="post" action="/batches/${b.id}/retry"><button class="btn btn-soft-primary btn-sm" type="submit"><i class="ri-refresh-line me-1"></i>Reintentar fallidos</button></form>` : ''}
            </div>
            <form method="post" action="/batches/${b.id}/schedule" class="d-flex align-items-center gap-2 mt-3">
              <span class="text-muted">Programar para</span>
              <input type="datetime-local" name="scheduled_at" class="form-control" style="max-width:220px" />
              <button class="btn btn-soft-primary btn-sm" type="submit">Programar</button>
              ${b.scheduled_at ? `<span class="badge bg-warning-subtle text-warning">Programado: ${esc(fmtDate(b.scheduled_at))}</span>` : ''}
            </form>
          </div>
        </div>
        <div class="card"><div class="card-body pt-0">${table(
          ['#', 'Destinatario', 'Mensaje', 'Estado', 'Error'],
          items.map((it) => [
            String(it.id),
            esc(it.contact_name ?? it.chat_id),
            `<span class="text-muted">${esc((it.body ?? '').slice(0, 60))}</span>`,
            statusBadge(it.status),
            `<span class="text-muted">${esc((it.error ?? '').slice(0, 60))}</span>`,
          ]),
        )}</div></div>`;
      res.send(
        renderLayout('Lote #' + b.id, req.user!, 'batches', body, {
          subtitle: 'Detalle de destinatarios, estado de cada envío y acciones del lote.',
          activeHref: '/batches',
        }),
      );
    }),
  );

  for (const [action, status] of [['pause', 'paused'], ['resume', 'running'], ['cancel', 'cancelled']] as const) {
    app.post(
      `/batches/:id/${action}`,
      requireUser,
      requireSection('batches'),
      ah(async (req: AuthedRequest, res) => {
        const id = Number(req.params.id);
        run('UPDATE batches SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), id);
        if (status === 'cancelled') {
          run("UPDATE batch_items SET status = 'cancelled', updated_at = ? WHERE batch_id = ? AND status = 'pending'", new Date().toISOString(), id);
        }
        audit('batch.' + action, { batch_id: id });
        res.redirect('/batches/' + id);
      }),
    );
  }

  app.post(
    '/batches/:id/retry',
    requireUser,
    requireSection('batches'),
    ah(async (req: AuthedRequest, res) => {
      const id = Number(req.params.id);
      run("UPDATE batch_items SET status = 'pending', error = NULL, updated_at = ? WHERE batch_id = ? AND status = 'failed'", new Date().toISOString(), id);
      recount(id);
      run("UPDATE batches SET status = 'running', finished_at = NULL, updated_at = ? WHERE id = ?", new Date().toISOString(), id);
      res.redirect('/batches/' + id);
    }),
  );

  app.post(
    '/batches/:id/schedule',
    requireUser,
    requireSection('batches'),
    ah(async (req: AuthedRequest, res) => {
      const id = Number(req.params.id);
      const when = String(req.body?.scheduled_at ?? '');
      if (when) {
        const date = new Date(when);
        if (!Number.isNaN(date.getTime()) && date.getTime() > Date.now()) {
          scheduleBatch(id, date.toISOString());
        }
      }
      res.redirect('/batches/' + id);
    }),
  );

  // ── Auto-respuestas ──────────────────────────────────────────────────────────

  app.get(
    '/autoreplies',
    requireUser,
    requireSection('autoreplies'),
    ah(async (req: AuthedRequest, res) => {
      const rows = listRules();
      const body = `
        ${card(
          'Nueva regla',
          `<form method="post" action="/autoreplies">
            <div class="row g-2 mb-2">
              <div class="col-md-5"><input name="keyword" class="form-control" placeholder="Palabra clave / patrón" required /></div>
              <div class="col-md-3"><select name="match_type" class="form-select">${MATCH_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select></div>
              <div class="col-md-2"><input name="cooldown_seconds" class="form-control" type="number" value="3600" title="Enfriamiento (s)" /></div>
              <div class="col-md-2"><button class="btn btn-success w-100" type="submit">Guardar</button></div>
            </div>
            <textarea name="reply_body" class="form-control" rows="3" placeholder="Respuesta automática" required></textarea>
          </form>`,
        )}
        <div class="card"><div class="card-body pt-0">${table(
          ['Palabra clave', 'Tipo', 'Respuesta', 'Enfriamiento', 'Activa', ''],
          rows.map((r) => [
            `<span class="ff-monospace">${esc(r.keyword)}</span>`,
            esc(r.match_type),
            `<span class="text-muted">${esc(r.reply_body.slice(0, 60))}</span>`,
            `${r.cooldown_seconds}s`,
            r.active ? '<span class="badge bg-success-subtle text-success">Sí</span>' : '<span class="badge bg-secondary-subtle text-secondary">No</span>',
            `<span class="d-flex gap-1"><form method="post" action="/autoreplies/${r.id}/toggle"><button class="btn btn-soft-secondary btn-sm" type="submit">${r.active ? 'Desactivar' : 'Activar'}</button></form>
              <form method="post" action="/autoreplies/${r.id}/delete"><button class="btn btn-soft-danger btn-sm" type="submit">Borrar</button></form></span>`,
          ]),
        )}</div></div>`;
      res.send(
        renderLayout('Auto-respuestas', req.user!, 'autoreplies', body, {
          subtitle: 'Respuestas automáticas que se disparan al recibir ciertas palabras clave.',
        }),
      );
    }),
  );

  app.post(
    '/autoreplies',
    requireUser,
    requireSection('autoreplies'),
    ah(async (req: AuthedRequest, res) => {
      createRule(
        String(req.body?.keyword ?? ''),
        String(req.body?.match_type ?? 'contains'),
        String(req.body?.reply_body ?? ''),
        Number(req.body?.cooldown_seconds ?? 3600),
      );
      res.redirect('/autoreplies');
    }),
  );

  for (const [action, fn] of [
    ['toggle', toggleRule],
    ['delete', deleteRule],
  ] as const) {
    app.post(
      `/autoreplies/:id/${action}`,
      requireUser,
      requireSection('autoreplies'),
      ah(async (req: AuthedRequest, res) => {
        fn(Number(req.params.id));
        res.redirect('/autoreplies');
      }),
    );
  }

  // ── Importación CSV ──────────────────────────────────────────────────────────

  app.get(
    '/import',
    requireUser,
    requireSection('batches'),
    ah(async (req: AuthedRequest, res) => {
      const body = card(
        'Importar destinatarios (CSV)',
        `<p class="text-muted">Columnas: <span class="ff-monospace">chat_id|phone, name|nombre</span> y cualquier otra columna
          pasa como variable de plantilla (por ejemplo <span class="ff-monospace">nombre_completo, programa, total_adeudado</span>).</p>
         <form method="post" action="/import" enctype="multipart/form-data">
           <div class="mb-3"><input type="file" name="file" class="form-control" accept=".csv,text/csv" required /></div>
           <div class="row g-2 mb-3">
             <div class="col-md-6"><input name="name" class="form-control" placeholder="Nombre del lote" /></div>
             <div class="col-md-4"><select name="category" class="form-select"><option value="cobranza">cobranza</option><option value="academico">academico</option><option value="">(sin plantilla)</option></select></div>
             <div class="col-md-2"><button class="btn btn-success w-100" type="submit">Importar</button></div>
           </div>
         </form>`,
      );
      res.send(
        renderLayout('Importar CSV', req.user!, 'batches', body, {
          flash: flash(req),
          subtitle: 'Creá un lote a partir de un archivo con destinatarios y variables.',
          activeHref: '/import',
        }),
      );
    }),
  );

  app.post(
    '/import',
    requireUser,
    requireSection('batches'),
    uploadCsv.single('file'),
    ah(async (req: AuthedRequest, res) => {
      const file = (req as AuthedRequest & { file?: { buffer: Buffer; originalname: string } }).file;
      const session = manager.primary();
      if (!file || !session) return res.redirect('/import?ok=' + encodeURIComponent('No se pudo importar.'));
      const { saveUpload } = await import('../core/uploads.js');
      const filePath = saveUpload(file.originalname, file.buffer);
      const result = importCsvToBatch(
        filePath,
        { name: req.body?.name ? String(req.body.name) : undefined, category: req.body?.category ? String(req.body.category) : null },
        (payload) =>
          createBatch(
            {
              sessionId: session.id,
              name: payload.name,
              category: payload.category,
              templateId: payload.templateId,
              items: payload.items,
              meta: { ...payload.meta, source: 'csv' },
            },
            runner,
          ).batchId ?? 0,
      );
      const msg = result.batchId
        ? `Lote #${result.batchId} creado con ${result.total} destinatarios (${result.skipped} omitidos).`
        : `No se creó el lote: ${result.errors.join(' ')}`;
      res.redirect('/import?ok=' + encodeURIComponent(msg));
    }),
  );

  // ── Plantillas ───────────────────────────────────────────────────────────────
  app.get(
    '/templates',
    requireUser,
    requireSection('templates'),
    ah(async (req: AuthedRequest, res) => {
      const rows = all<any>('SELECT * FROM templates ORDER BY category, id DESC');
      const body = `
        ${card(
          'Nueva plantilla',
          `<form method="post" action="/templates">
            <div class="row g-2 mb-3">
              <div class="col-md-6"><input name="name" class="form-control" placeholder="Nombre" required /></div>
              <div class="col-md-4"><select name="category" class="form-select"><option value="cobranza">cobranza</option><option value="academico">academico</option><option value="general">general</option></select></div>
              <div class="col-md-2"><button class="btn btn-success w-100" type="submit">Guardar</button></div>
            </div>
            <textarea name="body" class="form-control" rows="5" placeholder="Texto con {{ variables }}"></textarea>
          </form>`,
        )}
        <div class="card"><div class="card-body pt-0">${table(
          ['Nombre', 'Categoría', 'Variables', 'Activa'],
          rows.map((t) => [esc(t.name), esc(t.category), `<span class="ff-monospace">${esc(t.variables ?? '[]')}</span>`, t.active ? '<span class="badge bg-success-subtle text-success">Sí</span>' : 'No']),
        )}</div></div>`;
      res.send(
        renderLayout('Plantillas', req.user!, 'templates', body, {
          subtitle: 'Textos reutilizables con variables para tus envíos.',
          activeHref: '/templates',
        }),
      );
    }),
  );

  app.post(
    '/templates',
    requireUser,
    requireSection('templates'),
    ah(async (req: AuthedRequest, res) => {
      const { createTemplate } = await import('../core/templates.js');
      createTemplate(String(req.body?.name ?? 'Plantilla'), String(req.body?.category ?? 'general'), String(req.body?.body ?? ''));
      res.redirect('/templates');
    }),
  );

  // ── Plantillas rápidas (atajos del compositor) ────────────────────────────────

  app.get(
    '/quick-replies',
    requireUser,
    requireSection('templates'),
    ah(async (req: AuthedRequest, res) => {
      const rows = quickReplies.listQuickReplies(req.user!.id);
      const body = `
        ${card(
          'Nueva plantilla rápida',
          `<p class="text-muted mb-3">Se insertan en el compositor tipeando <span class="ff-monospace">/atajo</span>. Podés usar variables
            <span class="ff-monospace">{name} {phone} {email} {company}</span>.</p>
           <form method="post" action="/quick-replies">
             <div class="row g-2 mb-2">
               <div class="col-md-4"><input name="shortcut" class="form-control" placeholder="atajo (sin /)" required /></div>
               <div class="col-md-4"><input name="content" class="form-control" placeholder="Texto de la plantilla" required /></div>
               <div class="col-md-2 form-check d-flex align-items-center">
                 <input class="form-check-input me-1" type="checkbox" name="shared" value="1" id="qr-shared" />
                 <label class="form-check-label" for="qr-shared">Compartida</label>
               </div>
               <div class="col-md-2"><button class="btn btn-success w-100" type="submit">Guardar</button></div>
             </div>
           </form>`,
        )}
        <div class="card"><div class="card-body pt-0">${table(
          ['Atajo', 'Contenido', 'Alcance', ''],
          rows.map((r) => [
            `<code class="ff-monospace">/${esc(r.shortcut)}</code>`,
            `<span class="text-muted">${esc(r.content.slice(0, 70))}</span>`,
            r.shared
              ? '<span class="badge bg-primary-subtle text-primary">Compartida</span>'
              : '<span class="badge bg-secondary-subtle text-secondary">Personal</span>',
            `<form method="post" action="/quick-replies/${r.id}/delete"><button class="btn btn-soft-danger btn-sm" type="submit">Borrar</button></form>`,
          ]),
        )}</div></div>`;
      res.send(
        renderLayout('Plantillas rápidas', req.user!, 'templates', body, {
          flash: flash(req),
          subtitle: 'Atajos de respuesta que aceleran el trabajo en el inbox.',
          activeHref: '/quick-replies',
        }),
      );
    }),
  );

  app.post(
    '/quick-replies',
    requireUser,
    requireSection('templates'),
    ah(async (req: AuthedRequest, res) => {
      const user = req.user!;
      try {
        quickReplies.createQuickReply(user.id, {
          shortcut: String(req.body?.shortcut ?? ''),
          content: String(req.body?.content ?? ''),
          shared: !!req.body?.shared && esamEsAdmin(user),
        });
        res.redirect('/quick-replies?ok=' + encodeURIComponent('Plantilla rápida creada.'));
      } catch (err) {
        res.redirect('/quick-replies?ok=' + encodeURIComponent((err as Error).message));
      }
    }),
  );

  app.post(
    '/quick-replies/:id/delete',
    requireUser,
    requireSection('templates'),
    ah(async (req: AuthedRequest, res) => {
      quickReplies.deleteQuickReply(Number(req.params.id));
      res.redirect('/quick-replies?ok=' + encodeURIComponent('Plantilla rápida eliminada.'));
    }),
  );

  // ── Opt-out ──────────────────────────────────────────────────────────────────
  app.get(
    '/optouts',
    requireUser,
    requireSection('optouts'),
    ah(async (req: AuthedRequest, res) => {
      const rows = listOptouts();
      const body = `
        <div class="card"><div class="card-body">
          <form method="post" action="/optouts" class="row g-2">
            <div class="col-md-4"><input name="chat_id" class="form-control" placeholder="591XXXXXXXX" /></div>
            <div class="col-md-3"><button class="btn btn-success w-100" type="submit"><i class="ri-forbid-2-line me-1"></i>Agregar</button></div>
          </form>
        </div></div>
        <div class="card"><div class="card-body pt-0">${table(
          ['Número', 'Motivo', 'Origen', 'Fecha', ''],
          rows.map((o) => [
            `<span class="ff-monospace">${esc(o.phone ?? o.chat_id)}</span>`,
            esc(o.reason ?? ''),
            esc(o.source ?? ''),
            esc(fmtDate(o.created_at)),
            `<form method="post" action="/optouts/${esc(o.chat_id)}/delete"><button class="btn btn-soft-danger btn-sm" type="submit">Quitar</button></form>`,
          ]),
        )}</div></div>`;
      res.send(
        renderLayout('Lista de no enviar', req.user!, 'optouts', body, {
          subtitle: 'Números que nunca deben recibir mensajes. Se respetan en todos los envíos.',
        }),
      );
    }),
  );

  app.post(
    '/optouts',
    requireUser,
    requireSection('optouts'),
    ah(async (req: AuthedRequest, res) => {
      addOptout(String(req.body?.chat_id ?? ''), 'Agregado manualmente', 'panel');
      res.redirect('/optouts');
    }),
  );

  app.post(
    '/optouts/:chat/delete',
    requireUser,
    requireSection('optouts'),
    ah(async (req: AuthedRequest, res) => {
      removeOptout(decodeURIComponent(String(req.params.chat)));
      res.redirect('/optouts');
    }),
  );

  // ── Conversaciones (inbox) ───────────────────────────────────────────────────

  /** Total de no leídos del alcance del usuario (badge del menú). */
  const inboxUnreadBadges = (user: UserRow): Record<string, number> => {
    const scope = sessionScopeFor(user);
    const clauses: string[] = [INBOX_WHERE];
    const params: unknown[] = [];
    if (scope !== null) {
      const ids = scope.length ? scope.map(() => '?').join(',') : 'NULL';
      clauses.push(`session_id IN (${ids})`);
      params.push(...scope);
    }
    if (!esamEsAdmin(user)) {
      clauses.push('assigned_agent_id = ?');
      params.push(user.id);
    }
    const row = get<{ c: number }>(
      `SELECT COALESCE(SUM(unread_count), 0) c FROM conversations WHERE ${clauses.join(' AND ')}`,
      ...params,
    );
    const total = Number(row?.c ?? 0);
    return total > 0 ? { '/conversations': total } : {};
  };

  // Shell HTML del inbox (3 columnas). Los datos y la interacción los maneja
  // public/app.js contra las rutas JSON /inbox/*.
  const renderInboxShell = (user: UserRow, activeChat: string): string => {
    const picker = sessionPickerFor(user);
    // Número (sesión) con el que ingresó el usuario, visible en la cabecera.
    const session = sessionForUser(user);
    const sessionPhone = session ? (session.phone ?? session.expected_phone ?? null) : null;
    const sessionBadge = sessionPhone
      ? `<span class="cl-session" title="Número de WhatsApp de esta cuenta"><span class="ri-whatsapp-line"></span> ${esc(sessionPhone)}</span>`
      : '';
    return `<div class="inbox contact-hidden" id="inbox" data-active="${esc(activeChat)}" data-session="${esc(session?.id ?? '')}">
      <button type="button" class="list-rail" id="list-rail" title="Mostrar conversaciones">
        <span class="ri-chat-smile-2-line"></span>
        <span class="rail-label">Chats</span>
      </button>
      <aside class="chatlist">
        <div class="chatlist-head">
          <div class="cl-title"><h6>Conversaciones</h6>${picker}</div>
          ${sessionBadge}
        </div>
        <div class="cl-tabs" id="chat-tabs">
          <button type="button" class="cl-tab active" data-tab="individual">
            <span class="ri-user-line"></span> Números
            <span class="cl-tab-count" data-count="individual">0</span>
          </button>
          <button type="button" class="cl-tab" data-tab="group">
            <span class="ri-group-line"></span> Grupos
            <span class="cl-tab-count" data-count="group">0</span>
          </button>
        </div>
        <label class="chatlist-search" for="chat-search">
          <span class="ri-search-line"></span>
          <input type="search" id="chat-search" placeholder="Buscar conversación…" autocomplete="off" />
          <button type="button" class="cl-clear" id="chat-clear" hidden aria-label="Limpiar"><span class="ri-close-line"></span></button>
        </label>
        <div class="chatlist-items" id="chatlist-items"></div>
      </aside>
      <section class="chat-col" id="chat-pane"></section>
      <aside class="contact-panel d-none" id="contact-pane"></aside>
    </div>`;
  };

  app.get(
    '/conversations',
    requireUser,
    requireSection('conversations'),
    ah(async (req: AuthedRequest, res) => {
      const body = renderInboxShell(req.user!, '');
      res.send(
        renderLayout('Conversaciones', req.user!, 'conversations', body, {
          subtitle: 'Bandeja unificada: leé y respondé los chats de WhatsApp en tiempo real.',
          badges: inboxUnreadBadges(req.user!),
          activeHref: '/conversations',
        }),
      );
    }),
  );

  // Elige qué sesión/número ve un administrador que no tiene número propio.
  app.post(
    '/conversations/session',
    requireUser,
    requireSection('conversations'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      if (esamEsAdmin(user) && (user.esam_numero ?? '').trim() === '') {
        const id = String(req.body?.session_id ?? '');
        if (manager.byId(id)) setConfig(`view_session:${user.id}`, id);
      }
      res.redirect('/conversations');
    },
  );

  app.get(
    '/conversations/:chat',
    requireUser,
    requireSection('conversations'),
    ah(async (req: AuthedRequest, res) => {
      const body = renderInboxShell(req.user!, String(req.params.chat));
      res.send(
        renderLayout('Conversaciones', req.user!, 'conversations', body, {
          subtitle: 'Bandeja unificada: leé y respondé los chats de WhatsApp en tiempo real.',
          badges: inboxUnreadBadges(req.user!),
          activeHref: '/conversations',
        }),
      );
    }),
  );

  // ── Notas internas (todas las notas + etiquetas) ────────────────────────────
  app.get(
    '/notes',
    requireUser,
    requireSection('conversations'),
    (_req: AuthedRequest, res) => {
      res.send(
        renderLayout('Notas', _req.user!, 'conversations', renderNotesPage(), {
          subtitle: 'Lo que el equipo sabe de cada contacto y los seguimientos pendientes.',
          activeHref: '/notes',
        }),
      );
    },
  );

  // Sirve un adjunto (imagen/audio/video/documento) de un mensaje.
  app.get(
    '/media/:id',
    requireUser,
    requireSection('conversations'),
    ah(async (req: AuthedRequest, res) => {
      const msg = get<{ id: number; session_id: string | null; media_mime: string | null; media_filename: string | null }>(
        'SELECT id, session_id, media_mime, media_filename FROM messages WHERE id = ?',
        Number(req.params.id),
      );
      if (!msg) return res.status(404).end();
      // Solo media de las sesiones/números del usuario.
      const scope = sessionScopeFor(req.user!);
      if (scope !== null && !scope.includes(msg.session_id ?? '')) return res.status(403).end();

      // Si no está en disco se baja de WhatsApp (con tiempo máximo). Si ya no
      // existe se responde 404 al instante en las siguientes vistas.
      const file = await manager.ensureMedia(msg.id, { retry: req.query.retry === '1' });
      if (!file) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).json({ error: 'Archivo no disponible.' });
      }
      res.type(file.mime ?? msg.media_mime ?? 'application/octet-stream');
      if (msg.media_filename) {
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(msg.media_filename)}`);
      }
      // sendFile atiende peticiones parciales (Range): necesario para video/audio.
      res.sendFile(path.resolve(file.path), { maxAge: '7d', headers: { 'Cache-Control': 'private, max-age=604800' } });
    }),
  );

  // API JSON del inbox (la consume public/app.js).
  registerInboxRoutes(app, {
    manager,
    requireUser: (req, res, next) => requireUser(req as AuthedRequest, res, next),
    requireSection,
    rateLimit,
    resolveChatParam,
    upload: uploadSticker,
  });

  // ── Biblioteca de stickers ───────────────────────────────────────────────────
  app.get(
    '/stickers',
    requireUser,
    requireSection('stickers'),
    ah(async (req: AuthedRequest, res) => {
      const rows = listStickers();
      const body = `
        ${card(
          'Convertir imagen en sticker',
          `<form method="post" action="/stickers" enctype="multipart/form-data" class="row g-2 align-items-center">
            <div class="col-md-5"><input type="file" name="file" class="form-control" accept="image/*" required /></div>
            <div class="col-md-4"><input name="name" class="form-control" placeholder="Nombre" /></div>
            <div class="col-md-3"><button class="btn btn-success w-100" type="submit"><i class="ri-emotion-happy-line me-1"></i>Sticker</button></div>
          </form>`,
        )}
        <div class="card"><div class="card-body pt-0">${table(
          ['Sticker', 'Nombre', 'Tamaño', 'Activo', ''],
          rows.map((s) => [
            `<a href="/stickers/${s.id}/file" target="_blank"><img class="sticker-thumb" src="/stickers/${s.id}/file" alt="" /></a>`,
            esc(s.name),
            `${Math.round(s.size / 1024)} KB`,
            s.active ? '<span class="badge bg-success-subtle text-success">Sí</span>' : '<span class="badge bg-secondary-subtle text-secondary">No</span>',
            `<span class="d-flex gap-1"><form method="post" action="/stickers/${s.id}/toggle"><button class="btn btn-soft-secondary btn-sm" type="submit">${s.active ? 'Desactivar' : 'Activar'}</button></form>
              <form method="post" action="/stickers/${s.id}/delete"><button class="btn btn-soft-danger btn-sm" type="submit">Borrar</button></form></span>`,
          ]),
        )}</div></div>`;
      res.send(
        renderLayout('Stickers', req.user!, 'stickers', body, {
          subtitle: 'Convertí imágenes en stickers listos para enviar desde el chat.',
        }),
      );
    }),
  );

  app.get(
    '/stickers/:id/file',
    requireUser,
    requireSection('stickers'),
    (req: AuthedRequest, res) => {
      const row = getSticker(Number(req.params.id));
      if (!row || !fs.existsSync(row.media_path)) return res.status(404).end();
      res.type(row.media_mime).send(fs.readFileSync(row.media_path));
    },
  );

  app.post(
    '/stickers',
    requireUser,
    requireSection('stickers'),
    uploadSticker.single('file'),
    ah(async (req: AuthedRequest, res) => {
      const file = (req as AuthedRequest & { file?: { buffer: Buffer; originalname: string } }).file;
      if (!file) return res.redirect('/stickers');
      const name = String(req.body?.name ?? '').trim() || file.originalname.replace(/\.[^.]+$/, '');
      try {
        await makeSticker(file.buffer, name);
        audit('sticker.created', { name });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'No se pudo crear el sticker');
      }
      res.redirect('/stickers');
    }),
  );

  app.post(
    '/stickers/:id/toggle',
    requireUser,
    requireSection('stickers'),
    ah(async (req: AuthedRequest, res) => {
      toggleSticker(Number(req.params.id));
      res.redirect('/stickers');
    }),
  );

  app.post(
    '/stickers/:id/delete',
    requireUser,
    requireSection('stickers'),
    ah(async (req: AuthedRequest, res) => {
      deleteSticker(Number(req.params.id));
      audit('sticker.deleted', { sticker_id: Number(req.params.id) });
      res.redirect('/stickers');
    }),
  );


  // ── Monitoreo ────────────────────────────────────────────────────────────────

  app.get(
    '/monitoring',
    requireUser,
    requireSection('monitoring'),
    ah(async (req: AuthedRequest, res) => {
      const sessions = manager.list();
      const q = (k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : '');
      const active = {
        from: q('from'),
        to: q('to'),
        day: q('day'),
        programa: q('programa'),
        account: q('account'),
        area: q('area'),
        tipo: q('tipo'),
      };
      const data = monitoringData(
        {
          from: active.from || undefined,
          to: active.to || undefined,
          day: active.day || undefined,
          programa: active.programa || undefined,
          account: active.account || undefined,
          area: active.area || undefined,
          tipo: active.tipo || undefined,
        },
        14,
      );

      const option = (value: string, label: string, selected: boolean) =>
        `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
      const tipoTotal = (t: string) => data.byTipo.find((x) => x.tipo === t)?.total ?? 0;
      const masivos = (m: Record<string, number>) => (m.participantes ?? 0) + (m.grupo ?? 0);

      const filtersForm = `<form method="get" action="/monitoring" class="card toolbar mb-3">
        <div class="card-body">
          <div class="toolbar-row">
            <div class="toolbar-field" style="flex:0 1 150px"><label>Desde</label><input type="date" name="from" value="${esc(active.from || data.from)}" class="form-control form-control-sm"></div>
            <div class="toolbar-field" style="flex:0 1 150px"><label>Hasta</label><input type="date" name="to" value="${esc(active.to || data.to)}" class="form-control form-control-sm"></div>
            <div class="toolbar-field" style="flex:0 1 160px"><label>Día o mes</label><input type="text" name="day" value="${esc(active.day)}" placeholder="2026-10-04 o 2026-10" class="form-control form-control-sm" title="Filtrar un día (YYYY-MM-DD) o un mes (YYYY-MM)"></div>
            <div class="toolbar-field" style="flex:1 1 200px"><label>Programa</label><select name="programa" class="form-select form-select-sm">
              ${option('', 'Todos los programas', !active.programa)}${data.options.programas.map((p) => option(p, p, active.programa === p)).join('')}
            </select></div>
            <div class="toolbar-field" style="flex:1 1 170px"><label>Usuario</label><select name="account" class="form-select form-select-sm">
              ${option('', 'Todos', !active.account)}${data.options.users.map((u) => option(u.id, u.name, active.account === u.id)).join('')}
            </select></div>
            <div class="toolbar-field" style="flex:1 1 150px"><label>Área</label><select name="area" class="form-select form-select-sm">
              ${option('', 'Todas', !active.area)}${data.options.areas.map((a) => option(a, a, active.area === a)).join('')}
            </select></div>
            <div class="toolbar-field" style="flex:1 1 140px"><label>Tipo</label><select name="tipo" class="form-select form-select-sm">
              ${option('', 'Todos', !active.tipo)}${data.options.tipos.map((t) => option(t.id, t.label, active.tipo === t.id)).join('')}
            </select></div>
            <div class="toolbar-actions">
              <button class="btn btn-primary btn-sm" type="submit"><i class="ri-filter-3-line me-1"></i>Filtrar</button>
              <a class="btn btn-soft-secondary btn-sm" href="/monitoring">Limpiar</a>
            </div>
          </div>
        </div>
      </form>`;

      const analysisTable = (title: string, rows: string[][], first: string) =>
        `<div class="card mb-3"><div class="card-header"><h5 class="card-title mb-0">${esc(title)}</h5></div>
          <div class="card-body pt-0">${
            rows.length
              ? table([first, 'Total', 'Masivos', 'Contable', 'Notas', 'Bandeja'], rows)
              : emptyState('ri-filter-off-line', 'Sin resultados', 'No hay envíos con los filtros seleccionados.')
          }</div></div>`;

      const programRows = data.byPrograma.map((p) => [
        esc(p.programa),
        `<b>${p.total}</b>`,
        String(masivos(p.byTipo)),
        String(p.byTipo.cobranza ?? 0),
        String(p.byTipo.notas ?? 0),
        String(p.byTipo.inbox ?? 0),
      ]);
      const userRows = data.byUser.map((u) => [
        esc(u.name),
        `<b>${u.total}</b>`,
        String(masivos(u.byTipo)),
        String(u.byTipo.cobranza ?? 0),
        String(u.byTipo.notas ?? 0),
        String(u.byTipo.inbox ?? 0),
      ]);

      // Tabla de actividad por usuario (seguimiento y control de mensajes).
      const activityTableHtml = `<div class="card mb-3" id="activity-card"
          data-activity-url="/api/activity"
          data-activity-from="${esc(data.from)}" data-activity-to="${esc(data.to)}"
          data-activity-account="${esc(active.account)}" data-activity-area="${esc(active.area)}">
        <div class="card-header d-flex align-items-center">
          <h5 class="card-title mb-0 flex-grow-1">Actividad por usuario</h5>
          <span class="text-muted fs-12 me-2" id="activity-updated"></span>
          <button type="button" class="btn btn-soft-secondary btn-sm" id="activity-refresh"><i class="ri-refresh-line me-1"></i>Actualizar</button>
        </div>
        <div class="card-body pt-0" id="activity-body">
          <div class="text-muted text-center py-3">Cargando…</div>
        </div>
      </div>`;

      const body = `
        ${filtersForm}
        ${sectionHead('ri-dashboard-3-line', 'Resumen de actividad', `Envíos, respuestas y resultados del ${esc(data.from)} al ${esc(data.to)}.`)}
        ${activityTableHtml}
        <div class="row g-3 mb-3">
          <div class="col-xl-4 col-md-6">${stat('Cronogramas', data.totals.cronogramas, 'primary', 'ri-send-plane-2-line', 'envíos planificados')}</div>
          <div class="col-xl-4 col-md-6">${stat('Bandeja ESAM', data.totals.esam, 'info', 'ri-chat-3-line', 'desde el inbox')}</div>
          <div class="col-xl-4 col-md-6">${stat('Cobranzas', tipoTotal('cobranza'), 'warning', 'ri-hand-coin-line', 'avisos de pago')}</div>
          <div class="col-xl-4 col-md-6">${stat('Avisos de notas', tipoTotal('notas'), 'success', 'ri-award-line', 'notas cargadas')}</div>
          <div class="col-xl-4 col-md-6">${stat('Fallidos', data.totals.failed, 'danger', 'ri-error-warning-line', 'sin entrega')}</div>
          <div class="col-xl-4 col-md-6">${stat('Recibidos', data.totals.received, 'primary', 'ri-inbox-archive-line', 'mensajes entrantes')}</div>
        </div>

        ${sectionHead('ri-line-chart-line', 'Gráficos', 'Distribución por usuario, origen, programa y evolución diaria.')}
        <div class="row g-3 mb-3">
          <div class="col-xl-8">
            <div class="card h-100"><div class="card-header"><h5 class="card-title mb-0">Mensajes enviados por usuario</h5></div>
              <div class="card-body"><div id="chartUsuarios"></div></div></div>
          </div>
          <div class="col-xl-4">
            <div class="card h-100"><div class="card-header"><h5 class="card-title mb-0">Por origen</h5></div>
              <div class="card-body"><div id="chartTipo"></div></div></div>
          </div>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-xl-7">
            <div class="card h-100"><div class="card-header"><h5 class="card-title mb-0">Mensajes por programa</h5></div>
              <div class="card-body"><div id="chartPrograma"></div></div></div>
          </div>
          <div class="col-xl-5">
            <div class="card h-100"><div class="card-header"><h5 class="card-title mb-0">Evolución (${esc(data.from)} → ${esc(data.to)})</h5></div>
              <div class="card-body"><div id="chartDia"></div></div></div>
          </div>
        </div>

        ${sectionHead('ri-table-line', 'Seguimiento detallado', 'Desglose de envíos por programa y por usuario.')}
        ${analysisTable('Seguimiento por programa', programRows, 'Programa')}
        ${analysisTable('Seguimiento por usuario', userRows, 'Usuario')}

        ${sectionHead('ri-hardware-line', 'Cuentas del gateway', 'Sesiones de WhatsApp y su estado de conexión.')}
        <div class="card"><div class="card-header"><h5 class="card-title mb-0">Cuentas</h5></div>
          <div class="card-body pt-0">${table(
            ['Nombre', 'Área', 'Número', 'Estado', 'Esperado'],
            sessions.map((s) => [esc(s.owner_name ?? s.name), esc(s.area ?? '—'), `<span class="ff-monospace">${esc(s.phone ?? '—')}</span>`, statusBadge(s.status), `<span class="ff-monospace">${esc(s.expected_phone ?? '—')}</span>`]),
          )}</div>
        </div>

        <script src="/assets/libs/apexcharts/apexcharts.min.js"></script>
        <script>
        (function () {
          var d = ${JSON.stringify(data)};
          if (!window.ApexCharts) return;
          var fam = getComputedStyle(document.body).fontFamily || 'inherit';
          function base(type, extra) { return Object.assign({ chart: { type: type, height: 320, fontFamily: fam, toolbar: { show: false } }, dataLabels: { enabled: false } }, extra || {}); }

          new ApexCharts(document.querySelector('#chartUsuarios'), base('bar', {
            series: [{ name: 'Mensajes', data: d.byUser.map(function (u) { return u.total; }) }],
            xaxis: { categories: d.byUser.map(function (u) { return u.name; }) },
            plotOptions: { bar: { horizontal: true, borderRadius: 4 } },
            colors: ['#0a6a90'], dataLabels: { enabled: true }
          })).render();

          new ApexCharts(document.querySelector('#chartTipo'), base('donut', {
            series: d.byTipo.map(function (t) { return t.total; }),
            labels: d.byTipo.map(function (t) { return t.label + ' (' + t.total + ')'; }),
            legend: { position: 'bottom' },
            colors: ['#0a6a90', '#128c7e', '#405189', '#f7b84b', '#f06548', '#878a99', '#b54708']
          })).render();

          new ApexCharts(document.querySelector('#chartPrograma'), base('bar', {
            series: [{ name: 'Mensajes', data: d.byPrograma.map(function (p) { return p.total; }) }],
            xaxis: { categories: d.byPrograma.map(function (p) { return p.programa; }), labels: { rotate: -35, trim: true } },
            colors: ['#128c7e'], dataLabels: { enabled: true }
          })).render();

          new ApexCharts(document.querySelector('#chartDia'), base('line', {
            series: [
              { name: 'Cronogramas', data: d.byDay.map(function (x) { return x.cronogramas; }) },
              { name: 'Bandeja ESAM', data: d.byDay.map(function (x) { return x.esam; }) }
            ],
            xaxis: { categories: d.byDay.map(function (x) { return x.day; }), labels: { rotate: -30, style: { fontSize: '10px' } } },
            colors: ['#0a6a90', '#128c7e'], stroke: { curve: 'smooth', width: 3 }, markers: { size: 4 }
          })).render();
        })();
        </script>`;
      res.send(
        renderLayout('Monitoreo', req.user!, 'monitoring', body, {
          subtitle: 'Seguimiento de envíos por fecha, programa, usuario, área y origen.',
          actions: `<a class="btn btn-soft-primary btn-sm" href="/reports"><i class="ri-bar-chart-box-line me-1"></i>Reportes</a>`,
        }),
      );
    }),
  );

  // ── Reportes ─────────────────────────────────────────────────────────────────

  app.get(
    '/reports',
    requireUser,
    requireSection('reports'),
    ah(async (req: AuthedRequest, res) => {
      const d = reportsData(30, 14);
      const rate = d.totals.enviados > 0 ? Math.round((d.totals.entregados / d.totals.enviados) * 100) : 0;
      const rateInsight =
        d.totals.enviados === 0
          ? insight('info', 'Todavía no hay envíos registrados en los últimos 30 días. Los reportes se llenan a medida que se ejecutan los lotes.')
          : rate >= 90
            ? insight('good', `Entregabilidad del ${rate}%: el canal entrega con normalidad sobre ${d.totals.enviados} envíos.`)
            : rate >= 75
              ? insight('info', `Entregabilidad del ${rate}%: dentro del rango esperado. Vigilá los fallidos si la tendencia sube.`)
              : insight('warn', `Entregabilidad del ${rate}%: por debajo del objetivo. Revisá la lista negra y la salud de la sesión en Anti-Baneo.`);
      const statusTotal = d.byStatus.reduce((a, r) => a + r.total, 0) || 1;
      const statusTable = table(
        ['Estado', 'Cantidad', 'Participación'],
        d.byStatus.map((r) => {
          const pct = Math.round((r.total / statusTotal) * 100);
          return [
            statusBadge(r.status),
            `<b>${r.total}</b>`,
            `<div class="d-flex align-items-center gap-2"><div class="progress progress-sm flex-grow-1" style="max-width:150px"><div class="progress-bar" style="width:${pct}%"></div></div><span class="text-muted fs-12">${pct}%</span></div>`,
          ];
        }),
      );

      const activityFrom = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      const activityTo = new Date().toISOString().slice(0, 10);
      const activityTableHtml = `<div class="card mb-3" id="activity-card"
          data-activity-url="/api/activity"
          data-activity-from="${activityFrom}" data-activity-to="${activityTo}"
          data-activity-account="" data-activity-area="">
        <div class="card-header d-flex align-items-center">
          <h5 class="card-title mb-0 flex-grow-1">Actividad por usuario</h5>
          <span class="text-muted fs-12 me-2" id="activity-updated"></span>
          <button type="button" class="btn btn-soft-secondary btn-sm" id="activity-refresh"><i class="ri-refresh-line me-1"></i>Actualizar</button>
        </div>
        <div class="card-body pt-0" id="activity-body">
          <div class="text-muted text-center py-3">Cargando…</div>
        </div>
      </div>`;

      const body = `
        ${rateInsight}

        ${sectionHead('ri-dashboard-3-line', 'Resumen del período', 'Totales consolidados de los últimos 30 días.')}
        ${activityTableHtml}
        <div class="row g-3 mb-3">
          <div class="col-xl-4 col-md-6">${stat('Enviados', d.totals.enviados, 'primary', 'ri-send-plane-2-line', 'últimos 30 días')}</div>
          <div class="col-xl-4 col-md-6">${stat('Entregados', d.totals.entregados, 'success', 'ri-check-double-line', `${rate}% de los enviados`)}</div>
          <div class="col-xl-4 col-md-6">${stat('Leídos', d.totals.leidos, 'info', 'ri-eye-line')}</div>
          <div class="col-xl-4 col-md-6">${stat('Fallidos', d.totals.fallidos, 'danger', 'ri-error-warning-line')}</div>
          <div class="col-xl-4 col-md-6">${stat('Recibidos', d.totals.recibidos, 'warning', 'ri-inbox-archive-line')}</div>
          <div class="col-xl-4 col-md-6">${stat('Entregabilidad', rate + '%', 'success', 'ri-line-chart-line', 'entregados / enviados')}</div>
        </div>

        ${sectionHead('ri-line-chart-line', 'Tendencias y distribución', 'Cómo se comportan los envíos a lo largo del período.')}
        <div class="row g-3 mb-3">
          <div class="col-xl-4"><div class="card h-100"><div class="card-header"><h5 class="card-title mb-0">Destinatarios por estado</h5></div>
            <div class="card-body"><div id="rStatus"></div></div></div></div>
          <div class="col-xl-8"><div class="card h-100"><div class="card-header"><h5 class="card-title mb-0">Envíos y recibidos por día</h5></div>
            <div class="card-body"><div id="rDia"></div></div></div></div>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-xl-6"><div class="card h-100"><div class="card-header"><h5 class="card-title mb-0">Envíos por tipo</h5></div>
            <div class="card-body"><div id="rTipo"></div></div></div></div>
          <div class="col-xl-6"><div class="card h-100"><div class="card-header"><h5 class="card-title mb-0">Por programa (enviados / fallidos)</h5></div>
            <div class="card-body"><div id="rPrograma"></div></div></div></div>
        </div>

        ${sectionHead('ri-list-check-2', 'Detalle por estado', 'Cantidad y peso de cada estado sobre el total.')}
        <div class="card">
          <div class="card-body pt-0">${
            d.byStatus.length
              ? statusTable
              : emptyState('ri-filter-off-line', 'Sin envíos en el período', 'Cuando se ejecuten lotes vas a ver acá el desglose por estado.')
          }</div>
        </div>

        <script src="/assets/libs/apexcharts/apexcharts.min.js"></script>
        <script>
        (function () {
          var d = ${JSON.stringify(d)};
          if (!window.ApexCharts) return;
          var fam = getComputedStyle(document.body).fontFamily || 'inherit';
          function base(type, extra) { return Object.assign({ chart: { type: type, height: 320, fontFamily: fam, toolbar: { show: false } }, dataLabels: { enabled: false } }, extra || {}); }

          new ApexCharts(document.querySelector('#rStatus'), base('donut', {
            series: d.byStatus.map(function (x) { return x.total; }),
            labels: d.byStatus.map(function (x) { return x.status + ' (' + x.total + ')'; }),
            legend: { position: 'bottom' }, colors: ['#0ab39c', '#f06548', '#f7b84b', '#878a99']
          })).render();

          new ApexCharts(document.querySelector('#rDia'), base('bar', {
            series: [
              { name: 'Enviados', data: d.byDay.map(function (x) { return x.enviados; }) },
              { name: 'Recibidos', data: d.byDay.map(function (x) { return x.recibidos; }) }
            ],
            xaxis: { categories: d.byDay.map(function (x) { return x.day; }), labels: { rotate: -30, style: { fontSize: '10px' } } },
            colors: ['#0a6a90', '#128c7e'], plotOptions: { bar: { borderRadius: 3, columnWidth: '55%' } }
          })).render();

          new ApexCharts(document.querySelector('#rTipo'), base('bar', {
            series: [{ name: 'Enviados', data: d.byTipo.map(function (x) { return x.enviados; }) }],
            xaxis: { categories: d.byTipo.map(function (x) { return x.label; }) },
            colors: ['#405189'], plotOptions: { bar: { horizontal: true, borderRadius: 4 } }, dataLabels: { enabled: true }
          })).render();

          new ApexCharts(document.querySelector('#rPrograma'), base('bar', {
            series: [
              { name: 'Enviados', data: d.byPrograma.map(function (x) { return x.enviados; }) },
              { name: 'Fallidos', data: d.byPrograma.map(function (x) { return x.fallidos; }) }
            ],
            xaxis: { categories: d.byPrograma.map(function (x) { return x.programa; }), labels: { rotate: -35, trim: true } },
            colors: ['#0a6a90', '#f06548'], plotOptions: { bar: { borderRadius: 3 } }
          })).render();
        })();
        </script>`;
      res.send(
        renderLayout('Reportes', req.user!, 'reports', body, {
          subtitle: 'Entrega, lectura y actividad de los últimos 30 días.',
          actions: `<a class="btn btn-soft-secondary btn-sm" href="/reports"><i class="ri-refresh-line me-1"></i>Actualizar</a>
            <a class="btn btn-soft-primary btn-sm" href="/monitoring"><i class="ri-radar-line me-1"></i>Monitoreo</a>`,
        }),
      );
    }),
  );

  // ── Políticas (anti-baneo) ───────────────────────────────────────────────────

  app.get(
    '/policies',
    requireUser,
    requireSection('policies'),
    ah(async (req: AuthedRequest, res) => {
      const p = config.pacing;
      const row = (label: string, value: string) =>
        `<div class="d-flex justify-content-between border-bottom py-2"><span class="text-muted">${esc(label)}</span><b>${value}</b></div>`;
      const body = card(
        'Motor anti-baneo',
        `${row('Activo', p.enabled ? '<span class="badge bg-success-subtle text-success">Sí</span>' : '<span class="badge bg-danger-subtle text-danger">No</span>')}
         ${row('Espera aleatoria', `${p.delayMin}–${p.delayMax} s`)}
         ${row('Ventana', `${esc(p.windowStart)}–${esc(p.windowEnd)}`)}
         ${row('Días', esc(p.windowDays.join(', ')))}
         ${row('Enfriamiento entre programas', `${p.programCooldownMinutes} min`)}
         <p class="text-muted mb-0 mt-3">Se configura con variables de entorno (PACING_*) en <span class="ff-monospace">.env</span>.</p>`,
      );
      res.send(
        renderLayout('Políticas', req.user!, 'policies', body, {
          subtitle: 'Reglas anti-baneo que regulan el ritmo y las ventanas de envío.',
        }),
      );
    }),
  );

  // ── Auditoría ────────────────────────────────────────────────────────────────

  app.get(
    '/audit',
    requireUser,
    requireSection('audit'),
    ah(async (req: AuthedRequest, res) => {
      const rows = all<any>('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200');
      const body = `<div class="card"><div class="card-body pt-0">${table(
        ['Acción', 'Contexto', 'Fecha'],
        rows.map((r) => [`<b>${esc(r.action)}</b>`, `<span class="ff-monospace text-muted">${esc(r.context ?? '')}</span>`, esc(fmtDate(r.created_at))]),
      )}</div></div>`;
      res.send(
        renderLayout('Auditoría', req.user!, 'audit', body, {
          subtitle: 'Registro cronológico de las acciones realizadas en el panel.',
        }),
      );
    }),
  );

  // ── Usuarios ─────────────────────────────────────────────────────────────────

  app.get(
    '/users',
    requireUser,
    requireSection('users'),
    ah(async (req: AuthedRequest, res) => {
      const rows = listUsers();
      const admins = rows.filter((u) => esamEsAdmin(u)).length;
      const authorized = rows.filter((u) => u.esam_autorizado).length;
      const withNumber = rows.filter((u) => (u.esam_numero ?? '').trim() !== '').length;
      const body = `
        ${sectionHead('ri-team-line', 'Equipo con acceso', 'Cuentas del panel, su rol de cronogramas y su nivel de autorización.')}
        <div class="row g-3 mb-3">
          <div class="col-xl-3 col-md-6">${stat('Usuarios', rows.length, 'primary', 'ri-team-line', 'cuentas registradas')}</div>
          <div class="col-xl-3 col-md-6">${stat('Administradores', admins, 'info', 'ri-admin-line', 'acceso total')}</div>
          <div class="col-xl-3 col-md-6">${stat('Autorizados', authorized, 'success', 'ri-checkbox-circle-line', 'pueden ingresar al panel')}</div>
          <div class="col-xl-3 col-md-6">${stat('Con número', withNumber, 'warning', 'ri-whatsapp-line', 'sesión vinculada')}</div>
        </div>
        <div class="card"><div class="card-body pt-0">${
          rows.length
            ? table(
                ['Usuario', 'Nombre de acceso', 'Rol', 'Origen', 'Área', 'Autorizado', 'Ingresos'],
                rows.map((u, i) => {
                  const roles = esamRoles(u);
                  const rolCell = roles.length
                    ? roles.map((r) => `<span class="badge bg-primary-subtle text-primary me-1">${esc(r)}</span>`).join('')
                    : esamEsAdmin(u)
                      ? '<span class="badge bg-success-subtle text-success">Administrador</span>'
                      : '<span class="text-muted">—</span>';
                  return [
                    `<div class="user-cell">
                       <span class="avatar-xs rounded-circle av-${i % 8}">${esc(initials(u.name ?? u.username))}</span>
                       <div class="min-w-0">
                         <div class="user-name">${esc(u.name ?? '—')}</div>
                         <div class="user-mail">${esc(u.email ?? '—')}</div>
                       </div>
                     </div>`,
                    `<span class="ff-monospace">${esc(u.username ?? '—')}</span>`,
                    rolCell,
                    `<span class="badge bg-secondary-subtle text-secondary">${esc(u.source)}</span>`,
                    esc(u.esam_area ?? '—'),
                    u.esam_autorizado
                      ? '<span class="badge bg-success-subtle text-success"><i class="ri-check-line me-1"></i>Sí</span>'
                      : '<span class="badge bg-secondary-subtle text-secondary">No</span>',
                    `<span class="ff-monospace">${u.login_count}</span>`,
                  ];
                }),
              )
            : emptyState('ri-team-line', 'Todavía no hay usuarios', 'Las cuentas aparecen al iniciar sesión o al sincronizar desde cronogramas.')
        }</div></div>`;
      res.send(
        renderLayout('Usuarios', req.user!, 'users', body, {
          subtitle: 'Cuentas con acceso al panel, su rol de cronogramas, su área y su último ingreso.',
        }),
      );
    }),
  );

  registerAntiBanRoutes(app, {
    requireUser,
    requireSection,
    sessions: () => manager.list(),
    runner,
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.warn({ err: err.message, url: req.originalUrl }, 'Error en el panel');
    res.status(500).send(renderPlain('Error', err.message));
  });

  return app;
}

function flash(req: Request): string | undefined {
  const url = req.originalUrl;
  const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  const params = new URLSearchParams(q);
  return params.get('ok') ?? undefined;
}

export { esamEsAdmin, esamRoles, fs };
