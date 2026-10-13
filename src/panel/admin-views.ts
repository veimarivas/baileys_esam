import type express from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { all, get } from '../db/index.js';
import { esc, renderLayout } from './layout.js';
import { emptyState, fmtDate, initials } from './views.js';
import { esamEsAdmin, esamRoles, listUsers, type UserRow } from '../auth/users.js';
import { audit } from '../core/webhooks.js';
import {
  createTemplate,
  deleteTemplate,
  extractVariables,
  getTemplate,
  isLastActiveOfCategory,
  listTemplates,
  setTemplateActive,
  templateVariables,
  updateTemplate,
  type TemplateRow,
} from '../core/templates.js';
import type { SessionRow } from '../types.js';

/**
 * Vistas de administración: Auditoría (bitácora legible y filtrable), Usuarios
 * (equipo, acceso y actividad) y Plantillas (textos de envío con editor y
 * vista previa). Comparten los componentes `.ab-*` del panel.
 */

type Ctx = {
  requireUser: RequestHandler;
  requireSection: (section: string) => RequestHandler;
  sessions: () => SessionRow[];
};

function q(req: Request, key: string): string {
  const v = req.query[key];
  return typeof v === 'string' ? v.trim() : '';
}

function digits(v: string | null | undefined): string {
  return (v ?? '').replace(/\D+/g, '');
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return 'Nunca';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `hace ${d} día${d === 1 ? '' : 's'}`;
  const m = Math.round(d / 30);
  return `hace ${m} mes${m === 1 ? '' : 'es'}`;
}

function kpi(icon: string, tone: string, label: string, value: string | number, sub: string, href?: string): string {
  const inner = `<span class="ab-kpi-ic ab-${tone}"><i class="${icon}"></i></span>
    <span class="ab-kpi-body"><span class="ab-kpi-label">${esc(label)}</span><span class="ab-kpi-value">${esc(value)}</span><span class="ab-kpi-sub">${sub}</span></span>`;
  return href ? `<a class="ab-kpi" href="${href}">${inner}</a>` : `<div class="ab-kpi">${inner}</div>`;
}

function sessionName(s: SessionRow | undefined, id: string): string {
  return s ? s.owner_name ?? s.name : id.slice(0, 8);
}

// ══ Auditoría ══════════════════════════════════════════════════════════════════

interface AuditRow {
  id: number;
  action: string;
  context: string | null;
  created_at: string;
}

const AUDIT_CATS: Array<{ id: string; label: string; icon: string; match: (a: string) => boolean }> = [
  { id: 'conexiones', label: 'Conexiones', icon: 'ri-smartphone-line', match: (a) => a.startsWith('session.') && a !== 'session.rotated' },
  { id: 'lotes', label: 'Lotes', icon: 'ri-stack-line', match: (a) => a.startsWith('batch.') },
  { id: 'anti-baneo', label: 'Anti-baneo', icon: 'ri-shield-star-line', match: (a) => a.startsWith('anti_ban.') || a === 'session.rotated' },
  { id: 'lista-negra', label: 'Lista negra', icon: 'ri-forbidden-2-line', match: (a) => a.startsWith('blacklist.') },
  { id: 'cuentas', label: 'Cuentas', icon: 'ri-user-settings-line', match: (a) => a.startsWith('account.') || a.startsWith('user.') },
  { id: 'contenido', label: 'Contenido', icon: 'ri-file-text-line', match: (a) => /^(template|sticker|history|autoreply|quick_reply)\./.test(a) },
];

/** SQL de la categoría (mismo criterio que `match`). */
const CAT_SQL: Record<string, string> = {
  conexiones: "(action LIKE 'session.%' AND action <> 'session.rotated')",
  lotes: "action LIKE 'batch.%'",
  'anti-baneo': "(action LIKE 'anti!_ban.%' ESCAPE '!' OR action = 'session.rotated')",
  'lista-negra': "action LIKE 'blacklist.%'",
  cuentas: "(action LIKE 'account.%' OR action LIKE 'user.%')",
  contenido:
    "(action LIKE 'template.%' OR action LIKE 'sticker.%' OR action LIKE 'history.%' OR action LIKE 'autoreply.%' OR action LIKE 'quick!_reply.%' ESCAPE '!')",
};

const ACTION_LABELS: Record<string, string> = {
  'session.created': 'Línea creada',
  'session.ready': 'Línea conectada',
  'session.reconnect': 'Reconexión solicitada',
  'session.logout': 'Línea desvinculada',
  'session.deleted': 'Línea eliminada',
  'session.rotated': 'Lotes movidos a otra línea',
  'batch.created': 'Lote creado',
  'batch.done': 'Lote completado',
  'batch.paused': 'Lote pausado por el motor',
  'batch.cancelled': 'Lote cancelado',
  'batch.resumed': 'Lote reanudado',
  'anti_ban.policy_updated': 'Política anti-baneo actualizada',
  'anti_ban.policy_cleared': 'Línea vuelve a la política global',
  'anti_ban.quarantine': 'Cuarentena',
  'anti_ban.trust_reset': 'Calentamiento reiniciado',
  'anti_ban.rotate': 'Rotación manual de lotes',
  'blacklist.added': 'Número agregado a la lista negra',
  'blacklist.imported': 'Lista negra importada',
  'blacklist.removed': 'Número quitado de la lista negra',
  'account.panel_user_upserted': 'Cuenta sincronizada desde cronogramas',
  'history.synced': 'Historial sincronizado',
  'template.created': 'Plantilla creada',
  'template.updated': 'Plantilla editada',
  'template.toggled': 'Plantilla activada o desactivada',
  'template.deleted': 'Plantilla eliminada',
  'sticker.created': 'Sticker agregado',
  'sticker.deleted': 'Sticker eliminado',
};

const CONTEXT_LABELS: Record<string, string> = {
  session_id: 'Línea',
  phone: 'Número',
  by: 'Por',
  user_id: 'Usuario',
  batch_id: 'Lote',
  reason: 'Motivo',
  count: 'Cantidad',
  batches: 'Lotes',
  moved: 'Lotes movidos',
  from: 'Desde',
  to: 'Hacia',
  scope: 'Alcance',
  profile: 'Perfil',
  chat_id: 'Número',
  name: 'Nombre',
  total: 'Total',
  quarantine: 'Cuarentena',
  template_id: 'Plantilla',
  active: 'Activa',
};

function auditCat(action: string) {
  return AUDIT_CATS.find((c) => c.match(action));
}

function parseCtx(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { valor: v };
  } catch {
    return { valor: raw };
  }
}

function ctxValue(key: string, value: unknown, maps: { sessions: Map<string, SessionRow>; users: Map<number, UserRow> }): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if ((key === 'session_id' || key === 'from' || key === 'to') && typeof value === 'string') {
    return esc(sessionName(maps.sessions.get(value), value));
  }
  if ((key === 'by' || key === 'user_id') && Number.isFinite(Number(value))) {
    const u = maps.users.get(Number(value));
    return esc(u?.name ?? u?.username ?? `#${value}`);
  }
  if (key === 'batch_id') return `<a href="/batches/${encodeURIComponent(String(value))}">#${esc(value)}</a>`;
  if (key === 'template_id' || key === 'from') {
    if (key === 'template_id' || Number.isFinite(Number(value))) return `<a href="/templates?edit=${encodeURIComponent(String(value))}#tpl-editor">#${esc(value)}</a>`;
  }
  if (key === 'chat_id' || key === 'phone') return esc(String(value).replace(/@.*$/, ''));
  if (typeof value === 'object') return esc(JSON.stringify(value));
  return esc(String(value));
}

function auditFilters(req: Request) {
  const cat = AUDIT_CATS.some((c) => c.id === q(req, 'cat')) ? q(req, 'cat') : '';
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q(req, 'from')) ? q(req, 'from') : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q(req, 'to')) ? q(req, 'to') : '';
  return { cat, text: q(req, 'q').slice(0, 100), from, to, auto: q(req, 'auto') === '1', before: Number(q(req, 'before')) || 0 };
}

type AuditFilters = ReturnType<typeof auditFilters>;

/** WHERE de la auditoría. `withCat=false` sirve para contar por categoría. */
function auditWhere(f: AuditFilters, withCat = true): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (withCat && f.cat) where.push(CAT_SQL[f.cat]);
  // Las reconexiones automáticas (session.ready) son la mayoría: ocultas salvo que se pidan.
  if (!f.auto) where.push("action <> 'session.ready'");
  if (f.text) {
    where.push('(action LIKE ? OR COALESCE(context, \'\') LIKE ?)');
    params.push(`%${f.text}%`, `%${f.text}%`);
  }
  if (f.from) {
    where.push('created_at >= ?');
    params.push(new Date(`${f.from}T00:00:00`).toISOString());
  }
  if (f.to) {
    where.push('created_at < ?');
    const end = new Date(`${f.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    params.push(end.toISOString());
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function auditQuery(f: AuditFilters, extra = ''): string {
  const p = new URLSearchParams();
  if (f.cat) p.set('cat', f.cat);
  if (f.text) p.set('q', f.text);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.auto) p.set('auto', '1');
  const s = p.toString();
  return s ? `?${s}${extra ? `&${extra}` : ''}` : extra ? `?${extra}` : '';
}

const AUDIT_PAGE = 60;

function renderAudit(f: AuditFilters, maps: { sessions: Map<string, SessionRow>; users: Map<number, UserRow> }): string {
  const w = auditWhere(f);
  const pageWhere = f.before ? `${w.sql ? `${w.sql} AND` : 'WHERE'} id < ?` : w.sql;
  const rows = all<AuditRow>(
    `SELECT * FROM audit_logs ${pageWhere} ORDER BY id DESC LIMIT ${AUDIT_PAGE + 1}`,
    ...w.params,
    ...(f.before ? [f.before] : []),
  );
  const hasMore = rows.length > AUDIT_PAGE;
  const page = rows.slice(0, AUDIT_PAGE);

  // Conteos por categoría con el resto de filtros.
  const base = auditWhere(f, false);
  const total = get<{ c: number }>(`SELECT COUNT(*) AS c FROM audit_logs ${base.sql}`, ...base.params)?.c ?? 0;
  const counts = Object.fromEntries(
    AUDIT_CATS.map((c) => {
      const cw = auditWhere({ ...f, cat: c.id }, true);
      return [c.id, get<{ c: number }>(`SELECT COUNT(*) AS c FROM audit_logs ${cw.sql}`, ...cw.params)?.c ?? 0];
    }),
  ) as Record<string, number>;
  const autoCount = get<{ c: number }>("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'session.ready'")?.c ?? 0;
  const last24 = get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM audit_logs WHERE created_at >= ? AND action <> 'session.ready'",
    new Date(Date.now() - 86_400_000).toISOString(),
  )?.c ?? 0;
  const pauses7 = get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM audit_logs WHERE created_at >= ? AND (action = 'batch.paused' OR action = 'anti_ban.quarantine')",
    new Date(Date.now() - 7 * 86_400_000).toISOString(),
  )?.c ?? 0;

  const chip = (id: string, label: string, n: number, icon = '') =>
    `<a class="ab-filter ${f.cat === id ? 'on' : ''}" href="/audit${auditQuery({ ...f, cat: id, before: 0 })}">${icon ? `<i class="${icon}"></i>` : ''}${esc(label)} <span>${n}</span></a>`;

  // Agrupa repeticiones seguidas (misma acción y contexto) y separa por día.
  type Group = { row: AuditRow; count: number; firstAt: string };
  const groups: Group[] = [];
  for (const r of page) {
    const prev = groups[groups.length - 1];
    if (prev && prev.row.action === r.action && prev.row.context === r.context && prev.row.created_at.slice(0, 10) === r.created_at.slice(0, 10)) {
      prev.count++;
      prev.firstAt = r.created_at;
    } else groups.push({ row: r, count: 1, firstAt: r.created_at });
  }
  let lastDay = '';
  const items = groups
    .map((g) => {
      const r = g.row;
      const d = new Date(r.created_at);
      const day = d.toLocaleDateString('es-BO', { weekday: 'long', day: 'numeric', month: 'long' });
      const header = day !== lastDay ? `<li class="adm-day">${esc(day)}</li>` : '';
      lastDay = day;
      const cat = auditCat(r.action);
      const ctx = parseCtx(r.context);
      const keys = Object.keys(ctx);
      const chips = keys
        .slice(0, 6)
        .map((k) => `<span class="adm-kv"><b>${esc(CONTEXT_LABELS[k] ?? k)}</b>${ctxValue(k, ctx[k], maps)}</span>`)
        .join('');
      const label = ACTION_LABELS[r.action] ?? r.action;
      const quarantineOff = r.action === 'anti_ban.quarantine' && ctx.quarantine === false;
      const title =
        quarantineOff ? 'Cuarentena liberada' : r.action === 'template.toggled' ? (ctx.active ? 'Plantilla activada' : 'Plantilla desactivada') : label;
      const time = d.toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' });
      const span =
        g.count > 1 ? `${new Date(g.firstAt).toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' })}–${time}` : time;
      return `${header}<li class="ab-log-item">
        <span class="ab-log-ic ab-${quarantineOff ? 'ok' : cat?.id === 'anti-baneo' ? 'warn' : cat?.id === 'lista-negra' ? 'danger' : 'info'}"><i class="${cat?.icon ?? 'ri-record-circle-line'}"></i></span>
        <div class="ab-log-body">
          <div class="ab-log-title">${esc(title)}${g.count > 1 ? ` <span class="adm-times">×${g.count}</span>` : ''}</div>
          ${chips ? `<div class="adm-kvs">${chips}</div>` : ''}
          ${keys.length ? `<details class="adm-raw"><summary>Datos técnicos</summary><code>${esc(r.action)}</code> <code>${esc(r.context ?? '')}</code></details>` : ''}
        </div>
        <time class="ab-log-time" datetime="${esc(r.created_at)}" title="${esc(fmtDate(r.created_at))}">${esc(span)}</time>
      </li>`;
    })
    .join('');

  const list = page.length
    ? `<ol class="ab-log adm-log">${items}</ol>
       ${hasMore ? `<div class="adm-more"><a class="btn btn-light btn-sm" href="/audit${auditQuery(f, `before=${page[page.length - 1].id}`)}"><i class="ri-arrow-down-line me-1"></i>Ver más antiguos</a></div>` : ''}`
    : emptyState('ri-history-line', 'Sin registros', 'No hay acciones con los filtros elegidos.');

  return `<div class="ab-page adm-page">
    <div class="ab-kpis adm-kpis-3">
      ${kpi('ri-history-line', 'info', 'Acciones registradas', total, f.auto ? 'con reconexiones automáticas' : 'sin reconexiones automáticas')}
      ${kpi('ri-time-line', 'mute', 'Últimas 24 h', last24, 'acciones del equipo y del sistema')}
      ${kpi('ri-alarm-warning-line', pauses7 ? 'warn' : 'ok', 'Frenos anti-baneo', pauses7, 'pausas y cuarentenas en 7 días', '/audit?cat=anti-baneo')}
    </div>
    <div class="card ab-card"><div class="card-body">
      <form method="get" action="/audit" class="adm-toolbar">
        ${f.cat ? `<input type="hidden" name="cat" value="${esc(f.cat)}"/>` : ''}
        <label class="ab-search"><i class="ri-search-line"></i><input type="search" name="q" value="${esc(f.text)}" placeholder="Buscar acción, número, motivo…" aria-label="Buscar en la auditoría"/></label>
        <label class="adm-date"><span>Desde</span><input type="date" name="from" value="${esc(f.from)}" class="form-control form-control-sm"/></label>
        <label class="adm-date"><span>Hasta</span><input type="date" name="to" value="${esc(f.to)}" class="form-control form-control-sm"/></label>
        <label class="adm-check"><input type="checkbox" class="form-check-input" name="auto" value="1" ${f.auto ? 'checked' : ''}/> Incluir reconexiones automáticas <span class="text-muted">(${autoCount})</span></label>
        <button class="btn btn-primary btn-sm" type="submit"><i class="ri-filter-3-line me-1"></i>Filtrar</button>
        <a class="btn btn-light btn-sm" href="/audit">Limpiar</a>
      </form>
      <div class="ab-filters adm-cats">
        ${chip('', 'Todas', total)}
        ${AUDIT_CATS.map((c) => chip(c.id, c.label, counts[c.id] ?? 0, c.icon)).join('')}
      </div>
      ${list}
    </div></div>
  </div>`;
}

// ══ Usuarios ═══════════════════════════════════════════════════════════════════

const SESSION_STATUS: Record<string, { label: string; tone: string }> = {
  ready: { label: 'Conectada', tone: 'ok' },
  qr: { label: 'Esperando QR', tone: 'warn' },
  connecting: { label: 'Conectando', tone: 'warn' },
  disconnected: { label: 'Desconectada', tone: 'danger' },
  blocked: { label: 'Bloqueada', tone: 'danger' },
  created: { label: 'Sin vincular', tone: 'mute' },
};

const INACTIVE_DAYS = 30;

function renderUsers(req: Request, sessions: SessionRow[]): string {
  const users = listUsers();
  const text = q(req, 'q').toLowerCase();
  const filter = q(req, 'f');
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const responses = new Map(
    all<{ uid: number; c: number; chats: number }>(
      `SELECT sender_uid AS uid, COUNT(*) AS c, COUNT(DISTINCT chat_id) AS chats FROM messages
        WHERE direction = 'out' AND sender_uid IS NOT NULL AND occurred_at >= ? GROUP BY sender_uid`,
      since,
    ).map((r) => [r.uid, r]),
  );
  const notes = new Map(
    all<{ uid: number; c: number }>(
      'SELECT user_id AS uid, COUNT(*) AS c FROM contact_notes WHERE user_id IS NOT NULL AND created_at >= ? AND deleted_at IS NULL GROUP BY user_id',
      since,
    ).map((r) => [r.uid, r.c]),
  );
  const lineOf = (u: UserRow) => {
    const num = digits(u.esam_numero);
    if (!num) return null;
    const matches = sessions.filter((s) => digits(s.expected_phone) === num || digits(s.phone) === num);
    return { num, session: matches.find((s) => s.status === 'ready') ?? matches[0] ?? null };
  };
  const isInactive = (u: UserRow) => !u.last_login_at || Date.now() - Date.parse(u.last_login_at) > INACTIVE_DAYS * 86_400_000;

  const rows = users.filter((u) => {
    if (text && ![u.name, u.username, u.email, u.esam_area].some((v) => (v ?? '').toLowerCase().includes(text))) return false;
    const line = lineOf(u);
    if (filter === 'admins' && !esamEsAdmin(u)) return false;
    if (filter === 'inactivos' && !isInactive(u)) return false;
    if (filter === 'sin-linea' && line?.session?.status === 'ready') return false;
    if (filter === 'sin-autorizar' && u.esam_autorizado) return false;
    return true;
  });

  const admins = users.filter((u) => esamEsAdmin(u)).length;
  const active = users.filter((u) => !isInactive(u)).length;
  const connected = users.filter((u) => lineOf(u)?.session?.status === 'ready').length;
  const noLine = users.filter((u) => u.source !== 'local' && lineOf(u)?.session?.status !== 'ready').length;
  const unauthorized = users.filter((u) => !u.esam_autorizado).length;
  const chip = (id: string, label: string, n: number) =>
    `<a class="ab-filter ${filter === id ? 'on' : ''}" href="/users${id || text ? `?${new URLSearchParams({ ...(id ? { f: id } : {}), ...(text ? { q: text } : {}) })}` : ''}">${esc(label)} <span>${n}</span></a>`;

  const table = rows.length
    ? `<div class="table-responsive"><table class="table table-hover align-middle mb-0 ab-table adm-users">
        <thead><tr><th>Persona</th><th>Rol</th><th>Línea de WhatsApp</th><th>Último ingreso</th><th>Actividad 30 días</th><th>Acceso</th></tr></thead>
        <tbody>${rows
          .map((u, i) => {
            const roles = esamRoles(u);
            const roleCell = roles.length
              ? roles.map((r) => `<span class="ab-pill ab-info">${esc(r)}</span>`).join(' ')
              : esamEsAdmin(u)
                ? '<span class="ab-pill ab-ok">Administrador</span>'
                : '<span class="text-muted">—</span>';
            const line = lineOf(u);
            const st = line?.session ? SESSION_STATUS[line.session.status] ?? { label: line.session.status, tone: 'mute' } : null;
            const lineCell =
              u.source === 'local' && !line
                ? '<span class="text-muted">Cuenta de servicio</span>'
                : !line
                  ? '<span class="ab-pill ab-mute">Sin número asignado</span>'
                  : `<div class="adm-line"><span class="ab-mono">+${esc(line.num)}</span>
                     ${st ? `<span class="ab-pill ab-${st.tone}"><span class="ab-dot"></span>${esc(st.label)}</span>` : '<span class="ab-pill ab-warn">Línea no creada</span>'}</div>`;
            const r = responses.get(u.id);
            const n = notes.get(u.id) ?? 0;
            const inactive = isInactive(u);
            return `<tr>
              <td><div class="user-cell">
                <span class="avatar-xs rounded-circle av-${i % 8}">${esc(initials(u.name ?? u.username))}</span>
                <div class="min-w-0"><div class="user-name">${esc(u.name ?? '—')}</div>
                  <div class="user-mail">${esc(u.username ?? '')}${u.email ? ` · ${esc(u.email)}` : ''}</div></div>
              </div></td>
              <td>${roleCell}${u.esam_area ? `<div class="adm-sub">${esc(u.esam_area)}</div>` : ''}</td>
              <td>${lineCell}</td>
              <td><span title="${esc(fmtDate(u.last_login_at))}" class="${inactive ? 'ab-t-warn' : ''}">${esc(relTime(u.last_login_at))}</span>
                <div class="adm-sub">${u.login_count} ingreso${u.login_count === 1 ? '' : 's'}</div></td>
              <td>${r || n ? `<b>${r?.c ?? 0}</b> respuestas · ${r?.chats ?? 0} chats<div class="adm-sub">${n} nota${n === 1 ? '' : 's'} registrada${n === 1 ? '' : 's'}</div>` : '<span class="text-muted">Sin actividad</span>'}</td>
              <td>${u.esam_autorizado ? '<span class="ab-pill ab-ok"><i class="ri-check-line"></i>Autorizado</span>' : '<span class="ab-pill ab-danger">Sin autorizar</span>'}
                <div class="adm-sub">${esc(u.source === 'local' ? 'Local' : u.source === 'cronogramas' ? 'Cronogramas' : u.source)}</div></td>
            </tr>`;
          })
          .join('')}</tbody></table></div>`
    : emptyState('ri-user-search-line', 'Sin coincidencias', 'Probá con otro nombre o quitá el filtro.');

  return `<div class="ab-page adm-page">
    <div class="ab-kpis">
      ${kpi('ri-team-line', 'info', 'Usuarios', users.length, `${admins} administrador${admins === 1 ? '' : 'es'}`)}
      ${kpi('ri-login-circle-line', 'ok', 'Activos', active, `ingresaron en ${INACTIVE_DAYS} días`)}
      ${kpi('ri-whatsapp-line', connected ? 'ok' : 'warn', 'Con línea conectada', connected, 'atienden por WhatsApp')}
      ${kpi('ri-link-unlink', noLine ? 'warn' : 'mute', 'Sin línea activa', noLine, 'sin vincular o caída', '/users?f=sin-linea')}
      ${kpi('ri-user-forbid-line', unauthorized ? 'danger' : 'mute', 'Sin autorizar', unauthorized, 'no pueden ingresar', unauthorized ? '/users?f=sin-autorizar' : undefined)}
    </div>
    <div class="card ab-card"><div class="card-body">
      <div class="ab-bl-toolbar">
        <form method="get" action="/users" class="ab-search" role="search">
          ${filter ? `<input type="hidden" name="f" value="${esc(filter)}"/>` : ''}
          <i class="ri-search-line"></i><input type="search" name="q" value="${esc(q(req, 'q'))}" placeholder="Buscar por nombre, usuario, correo o área…" aria-label="Buscar usuarios"/>
        </form>
        <div class="ab-filters">
          ${chip('', 'Todos', users.length)}
          ${chip('admins', 'Administradores', admins)}
          ${chip('inactivos', 'Inactivos', users.length - active)}
          ${chip('sin-linea', 'Sin línea activa', noLine)}
          ${unauthorized ? chip('sin-autorizar', 'Sin autorizar', unauthorized) : ''}
        </div>
      </div>
      ${table}
      <p class="adm-foot"><i class="ri-information-line"></i>Las cuentas, los roles y los números se sincronizan desde cronogramas al iniciar sesión: los cambios se hacen allí. Para vincular un número, la persona escanea el QR en <a href="/settings">Conexión</a>.</p>
    </div></div>
  </div>`;
}

// ══ Plantillas ═════════════════════════════════════════════════════════════════

/** Vista previa con el formato de WhatsApp: *negrita*, _cursiva_, ~tachado~, variables y variantes. */
export function waPreview(body: string): string {
  return esc(body)
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, '<span class="tpl-var">$1</span>')
    .replace(/\{([^{}]*\|[^{}]*)\}/g, (_m, g: string) => `<span class="tpl-spin" title="Se elige una al azar">${g.split('|').join('<i>|</i>')}</span>`)
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>')
    .replace(/~([^~\n]+)~/g, '<s>$1</s>')
    .replace(/\n/g, '<br>');
}

function catLabel(c: string): string {
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : 'General';
}

function templateCard(t: TemplateRow, editingId: number): string {
  const vars = templateVariables(t);
  const spins = (t.body.match(/\{[^{}]*\|[^{}]*\}/g) ?? []).length;
  return `<article class="tpl-card ${t.active ? '' : 'is-off'} ${editingId === t.id ? 'is-editing' : ''}">
    <header class="tpl-card-head">
      <div class="min-w-0">
        <div class="tpl-card-name">${esc(t.name)} <span class="tpl-id" title="Número para usar como template_id en la integración">#${t.id}</span></div>
        <div class="tpl-card-meta"><span class="ab-pill ab-info">${esc(catLabel(t.category))}</span>
          ${t.active ? '<span class="ab-pill ab-ok">Activa</span>' : '<span class="ab-pill ab-mute">Inactiva</span>'}
          <span class="adm-sub">Editada ${esc(relTime(t.updated_at))}</span></div>
      </div>
    </header>
    <div class="tpl-bubble">${waPreview(t.body)}</div>
    <div class="tpl-card-info">
      ${vars.length ? `<span><i class="ri-braces-line"></i>${vars.length} variable${vars.length === 1 ? '' : 's'}</span>` : '<span><i class="ri-braces-line"></i>Sin variables</span>'}
      <span class="${spins ? '' : 'ab-t-warn'}" title="Variantes {a|b}: evitan enviar exactamente el mismo texto a todos"><i class="ri-shuffle-line"></i>${spins ? `${spins} variante${spins === 1 ? '' : 's'}` : 'Sin variantes'}</span>
      <span><i class="ri-text"></i>${t.body.length} caracteres</span>
    </div>
    <footer class="tpl-card-actions">
      <a class="btn btn-sm btn-soft-primary" href="/templates?edit=${t.id}#tpl-editor"><i class="ri-pencil-line me-1"></i>Editar</a>
      <form method="post" action="/templates/${t.id}/duplicate"><button class="btn btn-sm btn-light" type="submit"><i class="ri-file-copy-line me-1"></i>Duplicar</button></form>
      <form method="post" action="/templates/${t.id}/toggle" ${t.active ? `data-confirm="¿Desactivar «${esc(t.name)}»? Los envíos dejarán de usarla."` : ''}>
        <button class="btn btn-sm btn-light" type="submit">${t.active ? '<i class="ri-pause-line me-1"></i>Desactivar' : '<i class="ri-play-line me-1"></i>Activar'}</button></form>
      <form method="post" action="/templates/${t.id}/delete" class="ms-auto" data-confirm="¿Eliminar «${esc(t.name)}»? No se puede deshacer.">
        <button class="btn btn-sm btn-soft-danger" type="submit" title="Eliminar"><i class="ri-delete-bin-6-line"></i></button></form>
    </footer>
  </article>`;
}

function renderTemplates(req: Request): string {
  const all = listTemplates();
  const cat = q(req, 'cat');
  const text = q(req, 'q').toLowerCase();
  const editId = Number(q(req, 'edit')) || 0;
  const editing = editId ? getTemplate(editId) : undefined;
  const cats = [...new Set(all.map((t) => t.category))].sort();
  const rows = all.filter(
    (t) => (!cat || t.category === cat) && (!text || t.name.toLowerCase().includes(text) || t.body.toLowerCase().includes(text)),
  );
  const chip = (value: string, label: string, n: number) =>
    `<a class="ab-filter ${cat === value ? 'on' : ''}" href="/templates${value ? `?cat=${encodeURIComponent(value)}` : ''}">${esc(label)} <span>${n}</span></a>`;
  const noSpin = all.filter((t) => t.active && !/\{[^{}]*\|[^{}]*\}/.test(t.body)).length;

  const t = editing;
  const body = t?.body ?? '';
  const editor = `<div class="card ab-card" id="tpl-editor"><div class="card-body">
    <div class="ab-card-title"><h5>${t ? `Editar «${esc(t.name)}»` : 'Nueva plantilla'}</h5>
      <span>${t ? `Plantilla #${t.id} · ${t.active ? 'activa' : 'inactiva'}` : 'Un texto reutilizable para lotes e integraciones.'}</span></div>
    <form method="post" action="${t ? `/templates/${t.id}` : '/templates'}" class="ab-stack" data-tpl-editor>
      <div class="adm-grid-2">
        <div class="ab-field"><label class="form-label">Nombre</label><input name="name" class="form-control" maxlength="80" required value="${esc(t?.name ?? '')}" placeholder="Ej.: Recordatorio de cuota"/></div>
        <div class="ab-field"><label class="form-label">Categoría</label>
          <input name="category" class="form-control" list="tpl-cats" maxlength="40" required value="${esc(t?.category ?? 'general')}"/>
          <datalist id="tpl-cats">${[...new Set(['cobranza', 'academico', 'general', ...cats])].map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist></div>
      </div>
      <div class="ab-field"><label class="form-label">Texto</label>
        <textarea name="body" class="form-control tpl-body" rows="9" maxlength="4000" required placeholder="Sr(a). *{{ nombre_completo }}*, {le recordamos|le informamos} que…">${esc(body)}</textarea>
        <div class="tpl-help">
          <span><code>{{ variable }}</code> se reemplaza con los datos</span>
          <span><code>{hola|buenas tardes}</code> elige una variante al azar</span>
          <span><code>*negrita*</code> <code>_cursiva_</code> <code>~tachado~</code></span>
        </div>
      </div>
      <div class="tpl-preview-wrap">
        <div class="ab-mini-label">Vista previa <span class="tpl-count" data-tpl-count>${body.length} caracteres</span></div>
        <div class="tpl-phone"><div class="tpl-bubble" data-tpl-preview>${body ? waPreview(body) : '<span class="text-muted">Escribí el texto para ver cómo llega.</span>'}</div></div>
        <div class="tpl-vars" data-tpl-vars>${extractVariables(body).map((v) => `<span class="tpl-var">${esc(v)}</span>`).join('')}</div>
        <div class="ab-note ab-warn tpl-spin-hint" data-tpl-spinhint ${body && !/\{[^{}]*\|[^{}]*\}/.test(body) ? '' : 'hidden'}><i class="ri-shuffle-line"></i>Sin variantes: si se envía a muchos números, sumá al menos una <code>{opción|otra}</code> para que no todos reciban el mismo texto.</div>
      </div>
      <div class="d-flex gap-2 justify-content-end">
        ${t ? '<a class="btn btn-light" href="/templates">Cancelar</a>' : ''}
        <button class="btn btn-primary" type="submit"><i class="ri-save-3-line me-1"></i>${t ? 'Guardar cambios' : 'Crear plantilla'}</button>
      </div>
    </form>
  </div></div>`;

  return `<div class="ab-page adm-page">
    <div class="ab-kpis adm-kpis-3">
      ${kpi('ri-file-text-line', 'info', 'Plantillas', all.length, `${all.filter((x) => x.active).length} activas`)}
      ${kpi('ri-folders-line', 'mute', 'Categorías', cats.length, esc(cats.map(catLabel).join(' · ') || '—'))}
      ${kpi('ri-shuffle-line', noSpin ? 'warn' : 'ok', 'Sin variantes', noSpin, noSpin ? 'activas con texto idéntico para todos' : 'todas varían el texto')}
    </div>
    <div class="ab-policy-layout tpl-layout">
      <div class="card ab-card"><div class="card-body">
        <div class="ab-bl-toolbar">
          <form method="get" action="/templates" class="ab-search" role="search">
            ${cat ? `<input type="hidden" name="cat" value="${esc(cat)}"/>` : ''}
            <i class="ri-search-line"></i><input type="search" name="q" value="${esc(q(req, 'q'))}" placeholder="Buscar en nombre o texto…" aria-label="Buscar plantillas"/>
          </form>
          <div class="ab-filters">${chip('', 'Todas', all.length)}${cats.map((c) => chip(c, catLabel(c), all.filter((x) => x.category === c).length)).join('')}</div>
        </div>
        ${rows.length ? `<div class="tpl-list">${rows.map((x) => templateCard(x, editId)).join('')}</div>` : emptyState('ri-file-search-line', all.length ? 'Sin coincidencias' : 'Todavía no hay plantillas', all.length ? 'Probá con otra búsqueda o categoría.' : 'Creá la primera con el formulario.')}
      </div></div>
      <aside class="ab-aside">${editor}</aside>
    </div>
  </div>`;
}

// ══ Rutas ══════════════════════════════════════════════════════════════════════

export function registerAdminRoutes(app: express.Express, ctx: Ctx): void {
  const authed = (req: Request) => (req as Request & { user: UserRow }).user;
  const flash = (req: Request) => (typeof req.query.ok === 'string' ? req.query.ok : undefined);
  const maps = () => ({
    sessions: new Map(ctx.sessions().map((s) => [s.id, s])),
    users: new Map(listUsers().map((u) => [u.id, u])),
  });

  // Auditoría
  app.get('/audit', ctx.requireUser, ctx.requireSection('audit'), (req: Request, res: Response) => {
    const f = auditFilters(req);
    res.send(
      renderLayout('Auditoría', authed(req), 'audit', renderAudit(f, maps()), {
        subtitle: 'Qué pasó, cuándo y quién: conexiones, lotes, anti-baneo, lista negra y cuentas.',
        actions: `<a class="btn btn-soft-secondary btn-sm" href="/audit/export.csv${auditQuery(f)}"><i class="ri-download-2-line me-1"></i>Exportar CSV</a>`,
      }),
    );
  });

  app.get('/audit/export.csv', ctx.requireUser, ctx.requireSection('audit'), (req: Request, res: Response) => {
    const f = auditFilters(req);
    const w = auditWhere(f);
    const rows = all<AuditRow>(`SELECT * FROM audit_logs ${w.sql} ORDER BY id DESC LIMIT 10000`, ...w.params);
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['fecha,categoria,accion,descripcion,contexto']
      .concat(rows.map((r) => [fmtDate(r.created_at), auditCat(r.action)?.label ?? 'Otros', r.action, ACTION_LABELS[r.action] ?? '', r.context ?? ''].map(cell).join(',')))
      .join('\r\n');
    res.setHeader('Content-Disposition', 'attachment; filename="auditoria.csv"');
    res.type('text/csv; charset=utf-8').send('﻿' + csv);
  });

  // Usuarios
  app.get('/users', ctx.requireUser, ctx.requireSection('users'), (req: Request, res: Response) => {
    res.send(
      renderLayout('Usuarios', authed(req), 'users', renderUsers(req, ctx.sessions()), {
        subtitle: 'Quién tiene acceso, con qué rol, si su número de WhatsApp está conectado y cuánto atendió.',
      }),
    );
  });

  // Plantillas
  const tplGuard = [ctx.requireUser, ctx.requireSection('templates')];
  const back = (msg: string, extra = '') => `/templates?ok=${encodeURIComponent(msg)}${extra}`;
  const readForm = (req: Request) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return {
      name: String(b.name ?? '').trim().slice(0, 80),
      category: String(b.category ?? '').trim().toLowerCase().slice(0, 40) || 'general',
      body: String(b.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 4000),
    };
  };

  app.get('/templates', ...tplGuard, (req: Request, res: Response) => {
    res.send(
      renderLayout('Plantillas', authed(req), 'templates', renderTemplates(req), {
        subtitle: 'Textos reutilizables con variables y variantes para lotes e integraciones.',
        flash: flash(req),
        activeHref: '/templates',
      }),
    );
  });

  app.post('/templates', ...tplGuard, (req: Request, res: Response) => {
    const f = readForm(req);
    if (!f.name || !f.body) {
      res.redirect(back('Completá el nombre y el texto.'));
      return;
    }
    const id = createTemplate(f.name, f.category, f.body);
    audit('template.created', { template_id: id, name: f.name });
    res.redirect(back(`Plantilla «${f.name}» creada (#${id}).`));
  });

  app.post('/templates/:id', ...tplGuard, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const current = getTemplate(id);
    const f = readForm(req);
    if (!current) {
      res.redirect(back('Esa plantilla ya no existe.'));
      return;
    }
    if (!f.name || !f.body) {
      res.redirect(back('Completá el nombre y el texto.', `&edit=${id}#tpl-editor`));
      return;
    }
    // Cambiar de categoría a la única activa deja a la categoría anterior sin plantilla.
    if (f.category !== current.category && isLastActiveOfCategory(id)) {
      res.redirect(back(`Es la única plantilla activa de «${catLabel(current.category)}»: creá otra antes de cambiarle la categoría.`, `&edit=${id}#tpl-editor`));
      return;
    }
    updateTemplate(id, f.name, f.category, f.body);
    audit('template.updated', { template_id: id, name: f.name });
    res.redirect(back(`Plantilla «${f.name}» guardada.`));
  });

  app.post('/templates/:id/toggle', ...tplGuard, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getTemplate(id);
    if (!t) {
      res.redirect(back('Esa plantilla ya no existe.'));
      return;
    }
    if (t.active && isLastActiveOfCategory(id)) {
      res.redirect(back(`«${t.name}» es la única activa de «${catLabel(t.category)}»: los envíos de esa categoría fallarían. Activá otra primero.`));
      return;
    }
    setTemplateActive(id, !t.active);
    audit('template.toggled', { template_id: id, name: t.name, active: !t.active });
    res.redirect(back(t.active ? `«${t.name}» desactivada.` : `«${t.name}» activada.`));
  });

  app.post('/templates/:id/duplicate', ...tplGuard, (req: Request, res: Response) => {
    const t = getTemplate(Number(req.params.id));
    if (!t) {
      res.redirect(back('Esa plantilla ya no existe.'));
      return;
    }
    // La copia nace inactiva: no compite con la original hasta revisarla.
    const id = createTemplate(`${t.name} (copia)`.slice(0, 80), t.category, t.body, false);
    audit('template.created', { template_id: id, name: `${t.name} (copia)`, from: t.id });
    res.redirect(`/templates?ok=${encodeURIComponent('Copia creada (inactiva): revisala y activala.')}&edit=${id}#tpl-editor`);
  });

  app.post('/templates/:id/delete', ...tplGuard, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const t = getTemplate(id);
    if (!t) {
      res.redirect(back('Esa plantilla ya no existe.'));
      return;
    }
    if (isLastActiveOfCategory(id)) {
      res.redirect(back(`«${t.name}» es la única activa de «${catLabel(t.category)}»: no se puede eliminar sin otra que la reemplace.`));
      return;
    }
    deleteTemplate(id);
    audit('template.deleted', { template_id: id, name: t.name });
    res.redirect(back(`«${t.name}» eliminada.`));
  });
}
