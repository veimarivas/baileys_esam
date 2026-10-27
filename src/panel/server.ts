import path from 'node:path';
import fs from 'node:fs';
import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { all, get, run } from '../db/index.js';
import { logger } from '../logger.js';
import { SessionManager } from '../baileys/manager.js';
import { batchList, card, connectionCard, connectionDiagnosis, emptyState, fmtDate, initials, insight, kvList, safeJson, sectionHead, stat, statusBadge, table, type ConnectionDiagnosis } from './views.js';
import { countNewContactsToday, getPolicy, limitState } from '../core/anti-ban.js';
import { cancelGroup, canDecide, confirmGroup, getGroup, pendingGroupsFor, type ConfirmGroup } from '../core/batch-confirm.js';
import { nowIso } from '../util/async.js';
import { esc, renderLayout, renderLogin, renderPlain } from './layout.js';
import { sessionCookieHeader, sessionStore, clearCookieHeader } from '../auth/sessions.js';
import { verifySsoToken, safeNext } from '../auth/sso.js';
import { unreadCount } from '../core/notifications.js';
import {
  esamAreaLabel,
  esamSupervisaArea,
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
  reportsScopeFor,
  sessionScopeFor,
  upsertUser,
  usernameAvailableFor,
  verifyPassword,
  type UserRow,
} from '../auth/users.js';
import { listOptouts, addOptout, removeOptout } from '../core/optout.js';
import { audit } from '../core/webhooks.js';
import { getConfig, setConfig } from '../core/config-store.js';
import { monitoringData, activityData } from '../core/monitoring.js';
import { attentionData, deliveryStats, notesFollowup, pendingReplies, previousPeriod, protectionStats, resolvePeriod, sessionActivity, userPerformance, userReportDetail } from '../core/followup.js';
import { getHealth } from '../core/health.js';
import { systemHealth } from '../core/system-health.js';
import { lastUseByUser } from '../core/user-activity.js';
import { renderMonitoring, renderReportUser, renderReports, reportsCsv, type MonitoringTab, type ReportsTab } from './followup-views.js';
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
import { registerAdminRoutes } from './admin-views.js';
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
export function renderNotesPage(): string {
  return `<div class="notes-page" id="notes-page">
    <div class="np-stats" id="np-stats" role="tablist" aria-label="Estado del seguimiento"></div>

    <div class="np-layout">
      <section class="np-main" aria-label="Notas">
        <div class="np-toolbar">
          <div class="np-view" role="group" aria-label="Vista">
            <button type="button" class="np-view-btn on" data-view="list" aria-pressed="true"><span class="ri-list-check-2"></span> Lista</button>
            <button type="button" class="np-view-btn" data-view="board" aria-pressed="false"><span class="ri-kanban-view"></span> Pipeline</button>
          </div>
          <label class="notes-search"><span class="ri-search-line" aria-hidden="true"></span>
            <input type="search" id="notes-search" placeholder="Buscar en las notas, por contacto o número…" autocomplete="off" aria-label="Buscar notas" /></label>
          <select id="notes-order" class="form-select form-select-sm" aria-label="Orden">
            <option value="due">Por fecha de seguimiento</option>
            <option value="created">Más recientes primero</option>
          </select>
          <label class="np-mine"><input type="checkbox" class="form-check-input" id="notes-mine" /> Registradas por mí</label>
          <label class="np-mine"><input type="checkbox" class="form-check-input" id="notes-assigned" /> Asignadas a mí</label>
          <button type="button" id="notes-trash" class="np-trash-btn" aria-pressed="false" title="Notas eliminadas (se pueden restaurar)">
            <span class="ri-delete-bin-6-line" aria-hidden="true"></span> Papelera <span class="np-trash-count"></span></button>
        </div>
        <div id="np-areas" class="np-areas" role="tablist" aria-label="Área"></div>
        <div id="np-active" class="np-active"></div>
        <div id="notes-list" class="np-list" aria-live="polite"></div>
        <div id="np-board" class="np-board" hidden aria-live="polite"></div>
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
        <div class="np-side-card" id="plantillas">
          <div class="np-side-head">
            <h6><span class="ri-file-list-3-line" aria-hidden="true"></span> Plantillas de tareas</h6>
          </div>
          <div id="np-templates" class="np-templates"></div>
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
  // Archivos del chat (imagen, video, audio, documento): WhatsApp admite bastante
  // más que un sticker, así que el inbox tiene su propio tope.
  const uploadInbox = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });
  // Estáticos: Velzon vive en public/assets; los propios (app.css/js) en public/.
  app.use('/assets', express.static(path.resolve('public', 'assets')));
  app.use(express.static(path.resolve('public'), { index: false }));

  // Estado del proceso para el gestor de procesos y el monitoreo. Ruta pública a
  // propósito (no expone datos de conversaciones ni rutas de archivos).
  app.get('/healthz', (_req, res) => {
    res.json(systemHealth(manager.list()));
  });

  type AuthedRequest = Request & { user?: UserRow };

  /**
   * Token de la sesión: la cookie del navegador o, para la app móvil, el header
   * `Authorization: Bearer <token>` (mismo valor firmado que la cookie).
   */
  const sessionToken = (req: Request): string | undefined => {
    const auth = req.headers.authorization;
    if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    return cookie(req, config.sessionCookie);
  };

  const currentUser = (req: Request): UserRow | undefined => {
    const id = sessionStore.userId(sessionToken(req));
    return id ? findById(id) : undefined;
  };

  /** Pedido de la app (o de una llamada JSON): se responde JSON, nunca una redirección. */
  const wantsJson = (req: Request): boolean =>
    !!req.headers.authorization ||
    /application\/json/i.test(String(req.headers.accept ?? '')) ||
    /^\/(api|inbox|notifications)\//.test(req.path) ||
    /^\/notes\/(all|tags|assignees|templates|my-day)/.test(req.path);

  const requireUser = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const user = currentUser(req);
    if (!user) {
      if (wantsJson(req)) return res.status(401).json({ error: 'Tu sesión venció. Volvé a ingresar.', code: 'unauthenticated' });
      return res.redirect('/login');
    }
    req.user = user;
    next();
  };

  const requireSection = (section: string) => (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !esamPuede(req.user, section)) {
      if (wantsJson(req)) return res.status(403).json({ error: 'No tenés permiso para esta sección.', code: 'forbidden' });
      return res.status(403).send(renderPlain('Acceso denegado', 'No tenés permiso para acceder a esta sección.'));
    }
    // Sin número vinculado, el usuario solo puede usar Conexión.
    if (section !== 'settings' && !isConnected(req.user)) {
      if (wantsJson(req)) {
        return res.status(409).json({ error: 'Tu número de WhatsApp no está vinculado. Vinculalo en Conexión.', code: 'not_connected' });
      }
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
        // Privados (p. ej. recordatorios con el texto de la nota): solo a sus destinatarios.
        if (event.payload?.private) {
          const to = event.payload.userIds;
          if (Array.isArray(to) && to.includes(req.user!.id)) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
          }
          return;
        }
        const sid = event.payload?.sessionId;
        if (scope !== null && typeof sid === 'string' && !scope.includes(sid)) return;
        // Eventos de varias líneas (notas de una persona): solo si alguna es suya,
        // y sin revelar los chats de líneas ajenas.
        const sids = event.payload?.sessionIds;
        const uids = event.payload?.userIds;
        const forMe = Array.isArray(uids) && uids.includes(req.user!.id);
        let payload = event.payload;
        if (scope !== null && Array.isArray(sids)) {
          if (!forMe && !sids.some((s) => scope.includes(String(s)))) return;
          const chats = Array.isArray(payload.chats) ? (payload.chats as Array<{ sessionId: string }>) : [];
          payload = {
            ...payload,
            sessionIds: sids.filter((s) => scope.includes(String(s))),
            chats: chats.filter((c) => scope.includes(c.sessionId)),
          };
        }
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`);
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

  /** Diagnóstico completo de una línea (conexión, credenciales, anti-baneo). */
  const diagnosisFor = async (session: SessionRow): Promise<ConnectionDiagnosis> => {
    const d = await manager.diagnose(session.id);
    let antiBan: ConnectionDiagnosis['antiBan'] = null;
    try {
      const policy = getPolicy(session.id);
      const lim = limitState(session.id, policy, session);
      antiBan = {
        pace: `${lim.delayMin}–${lim.delayMax} s por mensaje`,
        hourly: lim.hourlyLimit,
        daily: lim.dailyLimit,
        sentToday: lim.dailyUsed,
        newContactsToday: countNewContactsToday(session.id),
        newContactsLimit: policy.new_contacts_daily_limit,
        warmupDay: lim.enabled ? lim.day : null,
      };
    } catch {
      antiBan = null;
    }
    const pausedBatches = all<{ id: number; name: string; meta: string | null }>(
      "SELECT id, name, meta FROM batches WHERE session_id = ? AND status = 'paused' ORDER BY id DESC LIMIT 10",
      session.id,
    ).map((b) => {
      let reason: string | null = null;
      try {
        reason = (JSON.parse(b.meta ?? '{}') as { anti_ban_pause?: string }).anti_ban_pause ?? null;
      } catch {
        reason = null;
      }
      return { id: b.id, name: b.name, reason };
    });
    return { ...d, antiBan, pausedBatches };
  };

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
      const diagnosis = session ? connectionDiagnosis(await diagnosisFor(session)) : '';
      const admin = esamEsAdmin(req.user!);
      const body = `<div class="row g-3">
        <div class="col-lg-7">${connectionCard(session, session?.owner_name ?? undefined)}</div>
        <div class="col-lg-5">${diagnosis}</div>
      </div>
      ${admin ? `<div class="row g-3 mt-0"><div class="col-lg-5">${gatewayCard}</div></div>` : ''}
      ${admin ? sessionsCard : ''}`;
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
      let code: string | null = null;
      let failure: string | null = null;
      try {
        code = await manager.qr(session.id);
      } catch (err) {
        failure = (err as Error).message;
      }
      const fresh = manager.byId(session.id)!;
      const connected = fresh.status === 'ready';
      // Sin QR y sin conexión: se explica por qué y qué hacer.
      let reason: { title: string; detail: string; action: string } | null = null;
      if (!connected && !code) {
        const d = await manager.diagnose(session.id);
        if (!d.auth.ok) {
          reason = {
            title: 'El servicio no puede escribir las credenciales',
            detail: d.auth.error ?? '',
            action: `En el servidor: sudo chown -R www-data:www-data ${d.auth.path.replace(/[\\/][^\\/]+$/, '')} y volvé a intentar.`,
          };
        } else if (d.disconnect) {
          reason = { title: d.disconnect.title, detail: d.disconnect.detail, action: d.disconnect.action };
        } else {
          reason = {
            title: 'WhatsApp todavía no envió el QR',
            detail: failure ?? 'La conexión con WhatsApp está tardando.',
            action: 'Esperá unos segundos y volvé a pulsar «Mostrar QR». Si sigue sin aparecer, usá «Empezar de cero (QR nuevo)».',
          };
        }
      }
      res.json({ connected, phone: fresh.phone, qrCode: code, reason });
    }),
  );

  // Regenera las claves de cifrado por contacto sin desvincular («Esperando el mensaje»).
  app.post(
    '/settings/repair',
    requireUser,
    requireSection('settings'),
    ah(async (req: AuthedRequest, res) => {
      const session = sessionForUser(req.user!) ?? (esamEsAdmin(req.user!) ? manager.primary() : undefined);
      if (!session) return res.redirect('/settings');
      try {
        const n = await manager.repairEncryption(session.id);
        audit('session.repair', { session_id: session.id, by: req.user!.id, removed: n });
        res.redirect(
          '/settings?ok=' +
            encodeURIComponent(`Cifrado reparado (${n} claves regeneradas). Los próximos mensajes negocian claves nuevas con cada contacto: enviá uno de prueba.`),
        );
      } catch (err) {
        res.redirect('/settings?ok=' + encodeURIComponent('No se pudo reparar: ' + (err as Error).message));
      }
    }),
  );

  // Empezar de cero: borra credenciales (aunque estén trabadas) y deja listo para un QR nuevo.
  app.post(
    '/settings/reset',
    requireUser,
    requireSection('settings'),
    ah(async (req: AuthedRequest, res) => {
      const session = sessionForUser(req.user!) ?? (esamEsAdmin(req.user!) ? manager.primary() : undefined);
      if (!session) return res.redirect('/settings');
      await manager.logout(session.id);
      run('UPDATE sessions SET disconnect_info = NULL WHERE id = ?', session.id);
      audit('session.reset', { session_id: session.id, by: req.user!.id });
      res.redirect('/settings?ok=' + encodeURIComponent('Listo para vincular de nuevo: pulsá «Mostrar QR» y escanealo desde WhatsApp › Dispositivos vinculados.'));
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

  // Reabre la conexión con WhatsApp sin desvincular (no requiere QR).
  app.post(
    '/settings/reconnect',
    requireUser,
    requireSection('settings'),
    ah(async (req: AuthedRequest, res) => {
      const session = sessionForUser(req.user!) ?? (esamEsAdmin(req.user!) ? manager.primary() : undefined);
      if (!session) return res.redirect('/settings');
      await manager.reconnect(session.id);
      audit('session.reconnect', { session_id: session.id, by: req.user!.id });
      res.redirect('/settings?ok=' + encodeURIComponent('Reconectando con WhatsApp… en unos segundos llegan los mensajes pendientes.'));
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

  // ── Envíos programados que esperan confirmación ─────────────────────────────
  // Abierta a cualquier usuario: decide el dueño de la línea que envía o el Super Admin.
  const confirmPage = (user: UserRow, g: ConfirmGroup, flashMsg: string | null): string => {
    const decide = canDecide(user, g);
    const when = g.scheduledAt
      ? new Date(g.scheduledAt).toLocaleString('es-BO', { dateStyle: 'full', timeStyle: 'short' })
      : 'apenas se confirme';
    const stateBadge = {
      pending: '<span class="badge bg-warning-subtle text-warning fs-12">Esperando confirmación</span>',
      confirmed: '<span class="badge bg-success-subtle text-success fs-12">Confirmado</span>',
      cancelled: '<span class="badge bg-danger-subtle text-danger fs-12">Cancelado: no se envía</span>',
      mixed: '<span class="badge bg-info-subtle text-info fs-12">Parcial</span>',
    }[g.status];
    const rows = g.batches
      .map((b) => `<tr><td>#${b.id}</td><td>${esc(b.name)}</td><td class="text-end">${b.total}</td><td>${statusBadge(b.status)}</td></tr>`)
      .join('');
    return `<div class="row justify-content-center"><div class="col-xl-8">
      ${flashMsg ? `<div class="alert alert-info">${esc(flashMsg)}</div>` : ''}
      <div class="card">
        <div class="card-header d-flex align-items-center gap-2 flex-wrap">
          <i class="ri-calendar-schedule-line fs-20 text-primary"></i>
          <h5 class="card-title mb-0 flex-grow-1">Envío programado</h5>${stateBadge}
        </div>
        <div class="card-body">
          <div class="row g-3 mb-3">
            <div class="col-sm-4"><div class="text-muted fs-12">Mensajes</div><div class="fs-4 fw-bold">${g.total}</div></div>
            <div class="col-sm-4"><div class="text-muted fs-12">Desde la línea</div><div class="fw-semibold">${esc(g.sessionLabel)}</div></div>
            <div class="col-sm-4"><div class="text-muted fs-12">Cuándo</div><div class="fw-semibold">${esc(when)}</div></div>
          </div>
          ${g.status === 'pending'
            ? insight('warn', 'Este envío <b>no sale hasta que lo confirmes</b>. Si nadie lo confirma en 20 horas, se cancela solo. Revisá la lista antes de confirmar.')
            : ''}
          <div class="table-responsive"><table class="table table-sm align-middle mb-3">
            <thead><tr><th>Lote</th><th>Nombre</th><th class="text-end">Mensajes</th><th>Estado</th></tr></thead>
            <tbody>${rows}</tbody></table></div>
          ${g.status === 'pending' && decide
            ? `<div class="d-flex flex-wrap gap-2">
                 <form method="post" action="/batches/confirm/${encodeURIComponent(g.group)}" class="js-once"
                       onsubmit="return confirm('¿Confirmás el envío de ${g.total} mensaje(s) desde ${esc(g.sessionLabel).replace(/'/g, '')}?')">
                   <input type="hidden" name="action" value="confirm" />
                   <button class="btn btn-success" type="submit"><i class="ri-check-line me-1"></i>Sí, enviar</button>
                 </form>
                 <form method="post" action="/batches/confirm/${encodeURIComponent(g.group)}" class="js-once">
                   <input type="hidden" name="action" value="cancel" />
                   <button class="btn btn-outline-danger" type="submit"><i class="ri-close-line me-1"></i>No enviar (cancelar)</button>
                 </form>
               </div>`
            : g.status === 'pending'
              ? insight('info', 'Solo el dueño de la línea o el Super Admin puede confirmar este envío.')
              : ''}
        </div>
      </div></div></div>`;
  };

  app.get(
    '/batches/confirm/:group',
    requireUser,
    requireSection('conversations'),
    ah(async (req: AuthedRequest, res) => {
      const g = getGroup(String(req.params.group));
      if (!g) return res.status(404).send(renderPlain('Envío no encontrado', '<p>La programación no existe o ya se eliminó.</p>'));
      const msg = typeof req.query.ok === 'string' ? req.query.ok : null;
      res.send(renderLayout('Confirmar envío programado', req.user!, 'batches', confirmPage(req.user!, g, msg), { activeHref: '/batches' }));
    }),
  );

  app.post(
    '/batches/confirm/:group',
    requireUser,
    requireSection('conversations'),
    ah(async (req: AuthedRequest, res) => {
      const group = String(req.params.group);
      const g = getGroup(group);
      if (!g) return res.redirect('/conversations');
      if (!canDecide(req.user!, g)) return res.status(403).send(renderPlain('Sin permiso', '<p>Solo el dueño de la línea o el Super Admin puede decidir este envío.</p>'));
      const action = String(req.body?.action ?? '');
      let msg: string;
      if (action === 'confirm') {
        const n = confirmGroup(group, req.user!);
        msg = n ? `Confirmado: ${n} lote(s) programado(s). Se envían a la hora indicada con el ritmo anti-baneo.` : 'No había lotes pendientes de confirmar.';
      } else {
        const n = cancelGroup(group, req.user!);
        msg = n ? `Cancelado: ${n} lote(s) no se enviarán.` : 'No había lotes pendientes.';
      }
      res.redirect(`/batches/confirm/${encodeURIComponent(group)}?ok=${encodeURIComponent(msg)}`);
    }),
  );

  /** Nombre de quien pidió cada lote (meta.account = id de cronogramas → usuario del panel). */
  const withRequester = <T extends { meta?: string | null }>(rows: T[]): Array<T & { requester_name: string | null }> =>
    rows.map((r) => {
      const meta = r.meta ? (safeJson(r.meta) as Record<string, unknown>) : {};
      const acc = meta?.account ? String(meta.account) : null;
      const u = acc ? get<{ name: string | null; username: string | null }>('SELECT name, username FROM users WHERE source_uid = ?', acc) : undefined;
      return { ...r, requester_name: (meta?.solicitado_por as string) ?? u?.name ?? u?.username ?? (meta?.source === 'panel' ? 'Panel' : null) };
    });

  // Botón de emergencia: cancela todo envío masivo en curso, programado, en pausa o por confirmar.
  app.post(
    '/batches/stop-all',
    requireUser,
    requireSection('batches'),
    ah(async (req: AuthedRequest, res) => {
      const n = run(
        `UPDATE batches SET status = 'cancelled', updated_at = ?
          WHERE status IN ('running', 'scheduled', 'paused', 'awaiting_confirmation')`,
        nowIso(),
      ).changes;
      audit('batch.stop_all', { by: req.user!.id, batches: n });
      logger.warn({ by: req.user!.id, batches: n }, 'Se detuvieron todos los envíos masivos');
      res.redirect('/batches');
    }),
  );

  // ── App móvil (Flutter) ──────────────────────────────────────────────────────
  // Autenticación por token (Bearer) y versiones JSON de lo que el panel hace
  // con formularios. El resto de la app usa las mismas rutas JSON del panel
  // (/inbox/*, /notes/*, /notifications, /events, /media/:id).

  const mobileUser = (user: UserRow) => {
    const session = sessionForUser(user);
    return {
      user: {
        id: user.id,
        name: user.name ?? user.username,
        username: user.username,
        email: user.email,
        area: user.esam_area,
        area_label: esamAreaLabel(user),
        admin: esamEsAdmin(user),
      },
      session: session
        ? { id: session.id, name: session.name, status: session.status, phone: session.phone ?? session.expected_phone ?? null, connected: session.status === 'ready' }
        : null,
    };
  };

  const loginLimiter = rateLimit(10, 60_000);

  app.post('/api/mobile/login', loginLimiter, (req, res) => {
    const login = String(req.body?.login ?? '').trim();
    const password = String(req.body?.password ?? '');
    const user = findByLogin(login);
    if (!user || !verifyPassword(user, password)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }
    if (user.source === 'cronogramas' && !user.esam_autorizado) {
      return res.status(403).json({ error: 'Tu cuenta no tiene permiso para acceder a Seguimiento ESAM.' });
    }
    ensureUserSession(user);
    const { cookie: token, expiresAt } = sessionStore.create(user.id);
    registerLogin(user.id, req.ip ?? null);
    audit('mobile.login', { user_id: user.id, device: String(req.body?.device ?? '').slice(0, 80) || null });
    res.json({ token, expires_at: expiresAt.toISOString(), ...mobileUser(user) });
  });

  app.post('/api/mobile/logout', (req, res) => {
    sessionStore.destroy(sessionToken(req));
    res.json({ ok: true });
  });

  app.get('/api/mobile/me', requireUser, (req: AuthedRequest, res) => {
    res.json({ ...mobileUser(req.user!), unread_notifications: unreadCount(req.user!.id) });
  });

  // Conexión: diagnóstico completo (estado, último cierre explicado, anti-baneo).
  app.get(
    '/api/mobile/connection',
    requireUser,
    requireSection('settings'),
    ah(async (req: AuthedRequest, res) => {
      const session = sessionForUser(req.user!) ?? (esamEsAdmin(req.user!) ? manager.primary() : undefined);
      if (!session) return res.json({ session: null, diagnosis: null });
      res.json({
        session: { id: session.id, name: session.name, status: session.status, phone: session.phone ?? session.expected_phone ?? null },
        diagnosis: await diagnosisFor(session),
      });
    }),
  );

  for (const action of ['reconnect', 'repair', 'reset'] as const) {
    app.post(
      `/api/mobile/connection/${action}`,
      requireUser,
      requireSection('settings'),
      ah(async (req: AuthedRequest, res) => {
        const session = sessionForUser(req.user!) ?? (esamEsAdmin(req.user!) ? manager.primary() : undefined);
        if (!session) return res.status(404).json({ error: 'No tenés una línea de WhatsApp.' });
        try {
          if (action === 'reconnect') {
            await manager.reconnect(session.id);
            res.json({ ok: true, message: 'Reconectando con WhatsApp…' });
          } else if (action === 'repair') {
            const n = await manager.repairEncryption(session.id);
            res.json({ ok: true, message: `Cifrado reparado (${n} claves regeneradas).` });
          } else {
            await manager.logout(session.id);
            run('UPDATE sessions SET disconnect_info = NULL WHERE id = ?', session.id);
            res.json({ ok: true, message: 'Listo para vincular de nuevo: mostrá el QR y escanealo.' });
          }
          audit(`session.${action}`, { session_id: session.id, by: req.user!.id, via: 'mobile' });
        } catch (err) {
          res.status(500).json({ error: (err as Error).message });
        }
      }),
    );
  }

  // Envíos programados que esperan confirmación (para la app).
  app.get('/api/mobile/confirmations', requireUser, (req: AuthedRequest, res) => {
    res.json({ groups: pendingGroupsFor(req.user!) });
  });

  app.post('/api/mobile/confirmations/:group', requireUser, (req: AuthedRequest, res) => {
    const group = String(req.params.group);
    const g = getGroup(group);
    if (!g) return res.status(404).json({ error: 'Programación no encontrada.' });
    if (!canDecide(req.user!, g)) return res.status(403).json({ error: 'Solo el dueño de la línea o el Super Admin puede decidir.' });
    const confirm = String(req.body?.action ?? '') === 'confirm';
    const n = confirm ? confirmGroup(group, req.user!) : cancelGroup(group, req.user!);
    res.json({ ok: true, batches: n, group: getGroup(group) });
  });

  // ── Lotes ────────────────────────────────────────────────────────────────────

  app.get(
    '/batches',
    requireUser,
    requireSection('batches'),
    ah(async (req: AuthedRequest, res) => {
      const rows = withRequester(
        all<any>(
          `SELECT b.*, s.owner_name AS line_owner, s.name AS line_name, COALESCE(s.phone, s.expected_phone) AS line_phone
             FROM batches b LEFT JOIN sessions s ON s.id = b.session_id ORDER BY b.id DESC LIMIT 100`,
        ),
      );
      const pending = pendingGroupsFor(req.user!);
      const pendingCard = pending.length
        ? `<div class="alert alert-warning d-flex flex-column gap-1">
             <div class="fw-semibold"><i class="ri-calendar-schedule-line me-1"></i>${pending.length} envío(s) programado(s) esperando confirmación</div>
             ${pending
               .map((g) => `<a href="/batches/confirm/${encodeURIComponent(g.group)}">${g.total} mensaje(s) · ${esc(g.sessionLabel)} → Revisar y decidir</a>`)
               .join('')}
           </div>`
        : '';
      const active = all<{ c: number }>("SELECT COUNT(*) AS c FROM batches WHERE status IN ('running','scheduled','paused')")[0]?.c ?? 0;
      const stopAll = active
        ? `<form method="post" action="/batches/stop-all" class="mb-3 js-once"
                 onsubmit="return confirm('Se cancelan TODOS los envíos masivos en curso, programados y en pausa (${active}). Los mensajes ya enviados no se pueden deshacer. ¿Continuar?')">
             <button class="btn btn-danger btn-sm" type="submit"><i class="ri-stop-circle-line me-1"></i>Detener todos los envíos masivos (${active})</button>
           </form>`
        : '';
      const body = pendingCard + stopAll + batchList(rows);
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
      const raw = get<any>(
        `SELECT b.*, s.owner_name AS line_owner, s.name AS line_name, s.status AS line_status,
                COALESCE(s.phone, s.expected_phone) AS line_phone, s.expected_phone AS line_expected
           FROM batches b LEFT JOIN sessions s ON s.id = b.session_id WHERE b.id = ?`,
        Number(req.params.id),
      );
      if (!raw) return res.status(404).send(renderPlain('Lote', 'No encontrado'));
      const b = withRequester([raw])[0];
      const items = all<any>('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY id LIMIT 500', b.id);
      const meta = safeJson(b.meta ?? '{}') as any;
      const progress = b.total > 0 ? Math.round(((b.sent + b.failed + b.skipped) / b.total) * 100) : 0;
      const origen = meta.origen === 'recordatorio_automatico'
        ? 'Recordatorio automático de cronogramas'
        : meta.origen_sistema === 'cronogramas' || meta.source === 'integration'
          ? 'Cronogramas'
          : meta.source === 'csv' ? 'Importación CSV' : 'Panel';
      const ficha = kvList([
        ['Línea que envía', `<span class="ff-monospace">${esc(b.line_phone ?? '—')}</span> · ${esc(b.line_owner ?? b.line_name ?? '—')} ${statusBadge(b.line_status)}`],
        ['Pedido por', esc(b.requester_name ?? '—')],
        ['Origen', esc(origen)],
        ['Programa', esc(meta.programa ?? '—')],
        ['Tipo', esc(meta.tipo ?? meta.category ?? '—') + (meta.modo ? ` · ${esc(meta.modo)}` : '')],
        ['Creado', esc(fmtDate(b.created_at))],
        ['Inició', b.started_at ? esc(fmtDate(b.started_at)) : '—'],
        ['Terminó', b.finished_at ? esc(fmtDate(b.finished_at)) : '—'],
        ...(b.scheduled_at && !String(b.scheduled_at).startsWith('9999') ? [['Programado para', esc(fmtDate(b.scheduled_at))] as [string, string]] : []),
        ...(meta.confirm_group
          ? [['Confirmación', `<a href="/batches/confirm/${encodeURIComponent(meta.confirm_group)}">${b.status === 'awaiting_confirmation' ? 'Esperando confirmación →' : 'Ver programación →'}</a>`] as [string, string]]
          : []),
      ]);
      const body = `
        <div class="card" data-batch="${b.id}">
          <div class="card-header d-flex align-items-center gap-2">
            <h5 class="card-title mb-0 flex-grow-1">#${b.id} · ${esc(b.name ?? 'Lote')}</h5>${statusBadge(b.status)}
          </div>
          <div class="card-body">
            <div class="mb-3">${ficha}</div>
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
          ['#', 'Destinatario', 'Número', 'Mensaje', 'Estado', 'Enviado', 'Detalle'],
          items.map((it) => [
            String(it.id),
            esc(it.contact_name ?? '—'),
            `<span class="ff-monospace">${esc(String(it.chat_id ?? '').replace(/@.*$/, ''))}</span>`,
            `<span class="text-muted" title="${esc(it.body ?? '')}">${esc((it.body ?? '').slice(0, 80))}${(it.body ?? '').length > 80 ? '…' : ''}</span>`,
            statusBadge(it.status),
            it.status === 'sent' && it.updated_at ? `<span class="text-muted">${esc(fmtDate(it.updated_at))}</span>` : '—',
            `<span class="text-muted">${esc((it.error ?? '').slice(0, 80))}</span>`,
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

  // /templates: ver admin-views.ts

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
            <span class="cl-tab-ic ri-user-line" aria-hidden="true"></span><span class="cl-tab-label">Números</span>
            <span class="cl-tab-count" data-count="individual" hidden>0</span>
          </button>
          <button type="button" class="cl-tab" data-tab="group">
            <span class="cl-tab-ic ri-group-line" aria-hidden="true"></span><span class="cl-tab-label">Grupos</span>
            <span class="cl-tab-count" data-count="group" hidden>0</span>
          </button>
          <button type="button" class="cl-tab" data-tab="team">
            <span class="cl-tab-ic ri-team-line" aria-hidden="true"></span><span class="cl-tab-label">Equipo</span>
            <span class="cl-tab-count" data-count="team" hidden>0</span>
          </button>
          <button type="button" class="cl-tab" data-tab="contacts" title="Personas registradas por cronogramas, tengan o no historial">
            <span class="cl-tab-ic ri-contacts-book-2-line" aria-hidden="true"></span><span class="cl-tab-label">Contactos</span>
            <span class="cl-tab-count" data-count="contacts" hidden>0</span>
          </button>
        </div>
        <label class="chatlist-search" for="chat-search">
          <span class="ri-search-line"></span>
          <input type="search" id="chat-search" placeholder="Buscar nombre, número o programa…" autocomplete="off" />
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
        renderLayout('Notas y tareas', _req.user!, 'conversations', renderNotesPage(), {
          subtitle: esamEsAdmin(_req.user!)
            ? 'Notas, tareas y derivaciones de todo el equipo, en lista o en pipeline por etapas.'
            : esamSupervisaArea(_req.user!) === 'marketing'
              ? 'Tus notas y el seguimiento de todo Marketing (prospectos de cada asesor), en lista o en pipeline.'
              : 'Tus notas, tareas y lo que te derivaron, en lista o en pipeline por etapas.',
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
    upload: uploadInbox,
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


  // ── Seguimiento (monitoreo) y reportes ───────────────────────────────────────

  /**
   * Sesiones visibles para el usuario y la seleccionada en `?session=`.
   * En Reportes (`allAdminLines`) el Super Admin ve todas las líneas; Monitoreo
   * mantiene el alcance personal de `sessionScopeFor`.
   */
  const followupScope = (req: AuthedRequest, allAdminLines = false) => {
    const sessionIds = allAdminLines ? reportsScopeFor(req.user!) : sessionScopeFor(req.user!);
    const visible = manager.list().filter((s) => sessionIds === null || sessionIds.includes(s.id));
    const requested = typeof req.query.session === 'string' ? req.query.session : '';
    const selected = visible.some((s) => s.id === requested) ? requested : '';
    return { scope: { sessionIds, sessionId: selected || null }, visible, selected };
  };
  const qstr = (req: AuthedRequest, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : '');

  app.get(
    '/monitoring',
    requireUser,
    requireSection('monitoring'),
    ah(async (req: AuthedRequest, res) => {
      const { scope, visible, selected } = followupScope(req);
      const period = resolvePeriod({ period: qstr(req, 'period'), from: qstr(req, 'from'), to: qstr(req, 'to') }, 'today');
      const activity = sessionActivity(scope);
      const shown = selected ? visible.filter((s) => s.id === selected) : visible;
      const tab = (['pendientes', 'actividad', 'numeros'] as MonitoringTab[]).includes(qstr(req, 'tab') as MonitoringTab)
        ? (qstr(req, 'tab') as MonitoringTab)
        : 'pendientes';
      const body = renderMonitoring({
        tab,
        period,
        selectedSession: selected,
        sessions: shown.map((row) => ({
          row,
          health: getHealth(row.id),
          activity: activity.get(row.id),
          decrypt: manager.decryptStats(row.id),
        })),
        attention: attentionData(scope, period),
        pending: pendingReplies(scope, { maxAgeDays: 7, limit: 60 }),
        notes: notesFollowup(scope, period),
      });
      res.send(
        renderLayout('Seguimiento', req.user!, 'monitoring', body, {
          subtitle: 'Conversaciones pendientes, tiempos de respuesta y seguimientos del día.',
          actions: `<a class="btn btn-soft-primary btn-sm" href="/reports"><i class="ri-bar-chart-box-line me-1"></i>Reportes</a>`,
        }),
      );
    }),
  );

  const buildReports = (req: AuthedRequest) => {
    const { scope, visible, selected } = followupScope(req, true);
    const period = resolvePeriod({ period: qstr(req, 'period'), from: qstr(req, 'from'), to: qstr(req, 'to') }, '30d');
    const filters = { programa: qstr(req, 'programa'), account: qstr(req, 'account'), area: qstr(req, 'area'), tipo: qstr(req, 'tipo') };
    const attention = attentionData(scope, period);
    const previous = previousPeriod(period);
    const tab = (['atencion', 'equipo', 'seguimiento', 'envios'] as ReportsTab[]).includes(qstr(req, 'tab') as ReportsTab)
      ? (qstr(req, 'tab') as ReportsTab)
      : 'atencion';
    const sends = monitoringData(
      {
        from: period.from,
        to: period.to,
        programa: filters.programa || undefined,
        account: filters.account || undefined,
        area: filters.area || undefined,
        tipo: filters.tipo || undefined,
      },
      Math.min(period.days, 31),
    );
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ period: period.preset, from: period.from, to: period.to, session: selected, ...filters })) {
      if (v) params.set(k, v);
    }
    const team = new Map(listUsers().map((u) => [u.id, u]));
    return {
      tab,
      period,
      previous,
      sessions: visible,
      selectedSession: selected,
      attention,
      prevAttention: attentionData(scope, previous),
      delivery: deliveryStats(scope, period),
      prevDelivery: deliveryStats(scope, previous),
      protection: protectionStats(scope, period),
      notes: notesFollowup(scope, period),
      users: userPerformance(scope, period, attention),
      team,
      lastUse: lastUseByUser([...team.values()]),
      sends,
      filters,
      exportHref: `/reports/export.csv?${params.toString()}`,
    };
  };

  app.get(
    '/reports',
    requireUser,
    requireSection('reports'),
    ah(async (req: AuthedRequest, res) => {
      const view = buildReports(req);
      res.send(
        renderLayout('Reportes', req.user!, 'reports', renderReports(view), {
          subtitle: `Atención, seguimiento y envíos · ${view.period.label}`,
          actions: `<a class="btn btn-soft-primary btn-sm" href="/monitoring"><i class="ri-pulse-line me-1"></i>Seguimiento</a>`,
        }),
      );
    }),
  );

  app.get(
    '/reports/export.csv',
    requireUser,
    requireSection('reports'),
    ah(async (req: AuthedRequest, res) => {
      const view = buildReports(req);
      res.setHeader('Content-Disposition', `attachment; filename="reporte-${view.period.from}_${view.period.to}.csv"`);
      res.type('text/csv; charset=utf-8').send(reportsCsv(view));
    }),
  );

  app.get(
    '/reports/users/:id',
    requireUser,
    requireSection('reports'),
    ah(async (req: AuthedRequest, res) => {
      const id = Number(req.params.id);
      const target = Number.isInteger(id) ? listUsers().find((u) => u.id === id) : undefined;
      if (!target) {
        return res.status(404).send(
          renderLayout('Usuario no encontrado', req.user!, 'reports', emptyState('ri-user-search-line', 'Usuario no encontrado', 'La cuenta pudo haberse eliminado o el enlace no es válido.'), {
            subtitle: 'Ficha de seguimiento',
            actions: '<a class="btn btn-soft-secondary btn-sm" href="/reports?tab=equipo"><i class="ri-arrow-left-line me-1"></i>Volver a Equipo</a>',
          }),
        );
      }
      const { scope, visible, selected } = followupScope(req, true);
      const period = resolvePeriod({ period: qstr(req, 'period'), from: qstr(req, 'from'), to: qstr(req, 'to') }, '30d');
      const filters = {
        programa: qstr(req, 'programa'),
        account: qstr(req, 'account'),
        area: qstr(req, 'area'),
        tipo: qstr(req, 'tipo'),
      };
      const attention = attentionData(scope, period);
      const performance = userPerformance(scope, period, attention).find((u) => u.id === id);
      const lastUse = lastUseByUser([target]).get(target.id) ?? null;
      const detail = userReportDetail(
        scope,
        period,
        { id: target.id, name: target.name, username: target.username, source_uid: target.source_uid },
        attention,
        performance,
      );
      const back = new URLSearchParams({ tab: 'equipo' });
      if (period.preset) back.set('period', period.preset);
      if (period.preset === 'custom') {
        back.set('from', period.from);
        back.set('to', period.to);
      }
      if (selected) back.set('session', selected);
      for (const [key, value] of Object.entries(filters)) if (value) back.set(key, value);
      const body = renderReportUser({
        user: target,
        detail,
        period,
        sessions: visible,
        selectedSession: selected,
        lastUse,
        filters,
      });
      const name = target.name ?? target.username ?? `Usuario ${target.id}`;
      return res.send(
        renderLayout(`Ficha de ${name}`, req.user!, 'reports', body, {
          subtitle: `Seguimiento individual · ${period.label}`,
          actions: `<a class="btn btn-soft-secondary btn-sm" href="${esc(`/reports?${back.toString()}`)}"><i class="ri-arrow-left-line me-1"></i>Volver a Equipo</a>`,
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

  // /audit, /users y /templates: admin-views.ts
  registerAdminRoutes(app, { requireUser, requireSection, sessions: () => manager.list() });

  registerAntiBanRoutes(app, {
    requireUser,
    requireSection,
    sessions: () => manager.list(),
    runner,
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const uploadError = err instanceof multer.MulterError;
    const tooLarge = uploadError && err.code === 'LIMIT_FILE_SIZE';
    const status = tooLarge ? 413 : uploadError ? 400 : 500;
    const message = tooLarge
      ? 'El archivo es demasiado grande (máximo 64 MB).'
      : uploadError
        ? `No se pudo leer el archivo: ${err.message}`
        : err.message;
    logger.warn({ err: err.message, code: uploadError ? err.code : undefined, url: req.originalUrl }, 'Error en el panel');
    // Las rutas del panel esperan JSON: si devolviéramos HTML, el cliente solo
    // mostraría «Error al enviar» sin decir qué pasó.
    if (wantsJson(req)) return res.status(status).json({ error: message });
    res.status(status).send(renderPlain('Error', message));
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
