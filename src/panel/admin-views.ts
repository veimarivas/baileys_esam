import type express from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { all, get } from '../db/index.js';
import { esc } from './layout.js';
import { emptyState, fmtDate, initials } from './views.js';
import { auditUrl, positiveInt, templatesUrl, type AuditCatSlug } from './urls.js';
import { resolvePanelRange } from './period-filter.js';
import { setFlash } from './flash.js';
import { pageHtml, sendPage } from './page.js';
import {
  LOCAL_CARGOS,
  LOCAL_CARGOS_POR_AREA,
  createLocalUser,
  esamAreaName,
  esamAreas,
  esamEsAdmin,
  esamRoles,
  findById,
  findByLogin,
  listUsers,
  updateManagedUser,
  type UserRow,
} from '../auth/users.js';
import { createSede, deleteSede, getSede, listSedes, renameSede } from '../core/sedes.js';
import {
  createBusinessUnit,
  deleteBusinessUnit,
  getBusinessUnit,
  listBusinessUnits,
  updateBusinessUnit,
  type BusinessUnitRow,
} from '../core/business-units.js';
import { lastUseByUser } from '../core/user-activity.js';
import { lineVerdict, type VerdictLevel } from '../core/line-verdict.js';
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
    if (key === 'template_id' || Number.isFinite(Number(value))) return `<a href="${templatesUrl({ id: Number(value) })}#tpl-editor">#${esc(value)}</a>`;
  }
  if (key === 'chat_id' || key === 'phone') return esc(String(value).replace(/@.*$/, ''));
  if (typeof value === 'object') return esc(JSON.stringify(value));
  return esc(String(value));
}

function auditFilters(req: Request, catOverride?: string) {
  const rawCat = catOverride ?? q(req, 'cat');
  const cat = AUDIT_CATS.some((c) => c.id === rawCat) ? rawCat : '';
  const range = resolvePanelRange(q(req, 'period'), q(req, 'from'), q(req, 'to'));
  return {
    cat,
    text: q(req, 'q').slice(0, 100),
    period: range.period,
    from: range.from,
    to: range.to,
    fromIso: range.fromIso,
    toIso: range.toIso,
    label: range.label,
    auto: q(req, 'auto') === '1',
    before: Number(q(req, 'before')) || 0,
  };
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
  if (f.fromIso) {
    where.push('created_at >= ?');
    params.push(f.fromIso);
  }
  if (f.toIso) {
    where.push('created_at < ?');
    params.push(f.toIso);
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

  const linkTo = (opts: { cat?: string; period?: string; before?: number } = {}) => {
    const period = opts.period ?? f.period;
    return auditUrl({
      cat: ((opts.cat ?? f.cat) || undefined) as AuditCatSlug | undefined,
      q: f.text,
      period,
      from: period === 'custom' ? f.from : '',
      to: period === 'custom' ? f.to : '',
      auto: f.auto,
      before: opts.before,
    });
  };

  const chip = (id: string, label: string, n: number, icon = '') =>
    `<a class="ab-filter ${f.cat === id ? 'on' : ''}" href="${linkTo({ cat: id })}">${icon ? `<i class="${icon}"></i>` : ''}${esc(label)} <span>${n}</span></a>`;

  const periodTab = (key: string, label: string) =>
    `<a class="adm-scope-tab${f.period === key ? ' on' : ''}" href="${linkTo({ period: key })}">${esc(label)}</a>`;

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
      const day = d.toLocaleDateString('es-BO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
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
       ${hasMore ? `<div class="adm-more"><a class="btn btn-light btn-sm" href="${linkTo({ before: page[page.length - 1].id })}"><i class="ri-arrow-down-line me-1"></i>Ver más antiguos</a></div>` : ''}`
    : emptyState('ri-history-line', 'Sin registros', 'No hay acciones con los filtros elegidos.');

  return `<div class="ab-page adm-page">
    <div class="ab-kpis adm-kpis-3">
      ${kpi('ri-history-line', 'info', 'Acciones registradas', total, f.period === 'all' ? 'todo el historial' : f.label)}
      ${kpi('ri-time-line', 'mute', 'Últimas 24 h', last24, 'acciones del equipo y del sistema')}
      ${kpi('ri-alarm-warning-line', pauses7 ? 'warn' : 'ok', 'Frenos anti-baneo', pauses7, 'pausas y cuarentenas en 7 días', auditUrl({ cat: 'anti-baneo', period: 'month' }))}
    </div>
    <div class="adm-scope">
      <div class="adm-scope-main">
        <span class="adm-scope-label"><i class="ri-calendar-line" aria-hidden="true"></i>${esc(f.label)}</span>
        <nav class="adm-scope-tabs" aria-label="Período">
          ${periodTab('month', 'Este mes')}
          ${periodTab('prev', 'Mes anterior')}
          ${periodTab('quarter', 'Últimos 3 meses')}
          ${periodTab('year', 'Este año')}
          ${periodTab('all', 'Todo el historial')}
        </nav>
      </div>
    </div>
    <div class="card ab-card"><div class="card-body">
      <form method="get" action="/audit" class="adm-toolbar">
        ${f.cat ? `<input type="hidden" name="cat" value="${esc(f.cat)}"/>` : ''}
        <input type="hidden" name="period" value="custom"/>
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

/** Semáforo de salud de la línea, enlazado al detalle de Anti-Baneo. */
const USER_HEALTH: Record<VerdictLevel, { label: string; tone: string }> = {
  green: { label: 'Sana', tone: 'ok' },
  yellow: { label: 'Con cuidado', tone: 'warn' },
  red: { label: 'En riesgo', tone: 'danger' },
  off: { label: 'Sin conexión', tone: 'mute' },
};

const INACTIVE_DAYS = 30;

const USER_AREA_TABS: Array<{ key: string; label: string }> = [
  { key: 'admin', label: 'Administración' },
  { key: 'academico', label: 'Académico' },
  { key: 'contabilidad', label: 'Contabilidad' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'consulta', label: 'Consulta' },
];

/** Áreas de un usuario: su área de cronogramas + las áreas de sus roles. */
function userAreas(u: UserRow): string[] {
  const areas = new Set<string>();
  if (u.source === 'local' && esamEsAdmin(u)) areas.add('admin');
  if (u.esam_area) areas.add(String(u.esam_area).toLowerCase());
  for (const area of esamAreas(u)) areas.add(area);
  return [...areas];
}

/** Cuenta autenticada que ejecuta la acción (para auditoría). */
function usersUserId(req: Request): number | null {
  return (req as Request & { user?: UserRow }).user?.id ?? null;
}

/** Selector de sede para formularios de alta y edición (agrupado por unidad). */
function sedeSelect(selected: number | null, opts: { required?: boolean; emptyLabel?: string } = {}): string {
  const sedes = listSedes();
  const required = opts.required ?? false;
  if (!sedes.length) {
    return '<select class="form-select" disabled><option value="">Primero creá una sede</option></select>';
  }
  const empty = required ? '' : `<option value="">${esc(opts.emptyLabel ?? 'Sin sede')}</option>`;
  const groups = new Map<string, ReturnType<typeof listSedes>>();
  for (const s of sedes) {
    const key = s.business_unit_name ?? 'Sin unidad de negocio';
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const options = [...groups.entries()]
    .map(([unit, list]) => `<optgroup label="${esc(unit)}">${list
      .map((s) => `<option value="${s.id}"${s.id === selected ? ' selected' : ''}>${esc(s.name)}</option>`)
      .join('')}</optgroup>`)
    .join('');
  return `<select class="form-select" name="sede_id"${required ? ' required' : ''}>
    ${empty}${options}
  </select>`;
}

/** Selector de cargo para usuarios locales. */
function cargoSelect(selected: string | null, id = ''): string {
  return `<select class="form-select" name="cargo" required${id ? ` id="${esc(id)}"` : ''}>
    <option value="">Elegí un cargo</option>
    ${LOCAL_CARGOS.map((c) => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('')}
  </select>`;
}

function renderSedesPanel(sedes: ReturnType<typeof listSedes>, open: boolean): string {
  const units = listBusinessUnits();
  const list = sedes.length
    ? `<div class="adm-sede-list">${sedes.map((s) => `
        <div class="adm-sede-row">
          <form method="post" action="/sedes/${s.id}" class="adm-sede-name">
            <input class="form-control form-control-sm" name="name" value="${esc(s.name)}" maxlength="80" required aria-label="Nombre de la sede"/>
            <button class="btn btn-sm btn-light" type="submit" title="Guardar nombre"><i class="ri-save-3-line"></i></button>
          </form>
          <span class="adm-sede-count"><i class="ri-community-line"></i>${esc(s.business_unit_name ?? 'Sin unidad')}</span>
          <span class="adm-sede-count">${s.users} usuario${s.users === 1 ? '' : 's'}</span>
          <form method="post" action="/sedes/${s.id}/delete" ${s.users ? '' : `data-confirm="¿Eliminar la sede «${esc(s.name)}»?"`}>
            <button class="btn btn-sm btn-soft-danger" type="submit" ${s.users ? 'disabled' : ''} title="${s.users ? 'Tiene usuarios asignados' : 'Eliminar sede'}"><i class="ri-delete-bin-6-line"></i></button>
          </form>
        </div>`).join('')}</div>`
    : '<p class="adm-empty-note">Todavía no hay sedes. Creá la primera para poder asignar usuarios.</p>';
  return `<details class="adm-tool" id="sedes"${open || !sedes.length ? ' open' : ''}>
    <summary>
      <span class="adm-tool-ic"><i class="ri-building-2-line"></i></span>
      <span class="adm-tool-txt"><b>Sedes</b><small>Cada sede pertenece a una unidad de negocio.</small></span>
      <span class="adm-tool-count">${sedes.length}</span>
    </summary>
    <div class="adm-tool-body">
      ${list}
      <form method="post" action="/sedes" class="adm-inline-form">
        <input class="form-control" name="name" maxlength="80" required placeholder="Nombre de la nueva sede" aria-label="Nombre de la nueva sede"/>
        ${units.length
          ? `<select class="form-select" name="business_unit_id" required aria-label="Unidad de negocio">${units
              .map((u) => `<option value="${u.id}">${esc(u.name)}</option>`)
              .join('')}</select>`
          : ''}
        <button class="btn btn-soft-primary" type="submit"><i class="ri-add-line me-1"></i>Crear sede</button>
      </form>
      <p class="adm-foot"><i class="ri-information-line"></i>La jerarquía completa (unidades → sedes → usuarios) se administra en <a href="/unidades">Unidades de negocio</a>.</p>
    </div>
  </details>`;
}

function renderNewUserPanel(sedes: ReturnType<typeof listSedes>, open: boolean): string {
  const warning = sedes.length
    ? ''
    : '<div class="ab-note ab-warn"><i class="ri-alert-line"></i>Primero creá una sede: cada usuario local debe pertenecer a una.</div>';
  return `<details class="adm-tool" id="nuevo-usuario"${open ? ' open' : ''}>
    <summary>
      <span class="adm-tool-ic"><i class="ri-user-add-line"></i></span>
      <span class="adm-tool-txt"><b>Nuevo usuario local</b><small>Cuentas que no vienen del sistema de cronogramas.</small></span>
    </summary>
    <div class="adm-tool-body">
      ${warning}
      <form method="post" action="/users" class="ab-stack">
        <div class="adm-grid-2">
          <div class="ab-field"><label class="form-label" for="nu-name">Nombre completo</label>
            <input class="form-control" id="nu-name" name="name" maxlength="120" required placeholder="Ej.: Ana Pérez"/></div>
          <div class="ab-field"><label class="form-label" for="nu-user">Usuario</label>
            <input class="form-control" id="nu-user" name="username" maxlength="60" required autocomplete="off" placeholder="ana.perez"/></div>
        </div>
        <div class="adm-grid-2">
          <div class="ab-field"><label class="form-label" for="nu-ci">CI</label>
            <input class="form-control" id="nu-ci" name="ci" maxlength="20" required placeholder="1234567"/></div>
          <div class="ab-field"><label class="form-label" for="nu-phone">WhatsApp</label>
            <input class="form-control" id="nu-phone" name="numero" inputmode="numeric" required placeholder="59171234567"/></div>
        </div>
        <div class="adm-grid-2">
          <div class="ab-field"><label class="form-label" for="nu-email">Correo (opcional)</label>
            <input class="form-control" id="nu-email" name="email" type="email" maxlength="120" autocomplete="off" placeholder="ana@ejemplo.com"/></div>
          <div class="ab-field"><label class="form-label" for="nu-password">Contraseña</label>
            <input class="form-control" id="nu-password" name="password" type="password" minlength="6" required autocomplete="new-password" placeholder="Por defecto, el CI"/></div>
        </div>
        <div class="adm-grid-2">
          <div class="ab-field"><label class="form-label" for="nu-sede">Sede</label>${sedeSelect(null, { required: true })}</div>
          <div class="ab-field"><label class="form-label" for="nu-cargo">Cargo</label>${cargoSelect(null)}</div>
        </div>
        <div class="adm-grid-2">
          <div class="ab-field adm-check-field">
            <label class="form-check"><input class="form-check-input" type="checkbox" name="autorizado" value="1" checked/> <span class="form-check-label">Puede ingresar al panel</span></label>
          </div>
        </div>
        <div class="adm-form-actions">
          <span class="adm-foot"><i class="ri-information-line"></i>Los usuarios locales no se actualizan desde cronogramas; su cargo y sede se administran acá.</span>
          <button class="btn btn-primary" type="submit"><i class="ri-user-add-line me-1"></i>Crear usuario</button>
        </div>
      </form>
    </div>
  </details>`;
}

function renderUserEdit(u: UserRow): string {
  const isLocal = u.source === 'local';
  const isSuper = esamEsAdmin(u);
  const roles = esamRoles(u);
  const role = roles[0] ?? '';
  const roleField = isSuper
    ? `<div class="adm-readonly"><span class="ab-pill ab-ok"><i class="ri-shield-star-line"></i>Super Admin</span>
         <small>La cuenta principal mantiene acceso total al panel.</small></div>`
    : isLocal
      ? cargoSelect(role)
      : `<div class="adm-readonly">${roles.length ? roles.map((r) => `<span class="ab-pill ab-info">${esc(r)}</span>`).join(' ') : '<span class="text-muted">Sin cargo</span>'}
           <small>El cargo de las cuentas de cronogramas se actualiza al iniciar sesión desde ese sistema.</small></div>`;
  return `<div class="ab-page adm-page">
    <div class="adm-edit-layout">
      <div class="card ab-card"><div class="card-body">
        <div class="ab-card-title"><h5>${esc(u.name ?? u.username ?? 'Cuenta')}</h5>
          <span>${isLocal ? 'Cuenta local' : 'Cuenta de cronogramas'}${u.sede_id ? '' : ' · sin sede asignada'}</span></div>
        <form method="post" action="/users/${u.id}" class="ab-stack">
          <div class="adm-grid-2">
            <div class="ab-field"><label class="form-label" for="eu-name">Nombre completo</label>
              <input class="form-control" id="eu-name" name="name" maxlength="120" required value="${esc(u.name ?? '')}" ${isLocal ? '' : 'readonly'}/></div>
            <div class="ab-field"><label class="form-label" for="eu-user">Usuario</label>
              <input class="form-control" id="eu-user" name="username" maxlength="60" required value="${esc(u.username ?? '')}" ${isLocal ? '' : 'readonly'} autocomplete="off"/></div>
          </div>
          <div class="ab-field"><label class="form-label" for="eu-ci">CI</label>
            <input class="form-control" id="eu-ci" name="ci" maxlength="20" value="${esc(u.ci ?? '')}" ${isLocal ? '' : 'readonly'} placeholder="1234567" autocomplete="off"/></div>
          <div class="adm-grid-2">
            <div class="ab-field"><label class="form-label" for="eu-email">Correo</label>
              <input class="form-control" id="eu-email" name="email" type="email" maxlength="120" value="${esc(u.email ?? '')}" ${isLocal ? '' : 'readonly'} autocomplete="off"/></div>
            <div class="ab-field"><label class="form-label" for="eu-phone">WhatsApp</label>
              <input class="form-control" id="eu-phone" name="numero" inputmode="numeric" value="${esc(u.esam_numero ?? '')}" ${isLocal ? '' : 'readonly'} ${isLocal && !isSuper ? 'required' : ''}/></div>
          </div>
          <div class="adm-grid-2">
            <div class="ab-field"><label class="form-label" for="eu-password">Contraseña</label>
              <input class="form-control" id="eu-password" name="password" type="password" minlength="6" autocomplete="new-password" placeholder="${isLocal ? 'Dejar en blanco para no cambiarla' : 'Se administra desde cronogramas'}" ${isLocal || isSuper ? '' : 'disabled'}/></div>
            <div class="ab-field"><label class="form-label" for="eu-sede">Sede</label>${sedeSelect(u.sede_id, { emptyLabel: 'Sin sede', required: isLocal && !isSuper })}</div>
          </div>
          <div class="adm-grid-2">
            <div class="ab-field"><label class="form-label">Cargo</label>${roleField}</div>
            <div class="ab-field adm-check-field">
              <label class="form-check"><input class="form-check-input" type="checkbox" name="autorizado" value="1" ${u.esam_autorizado ? 'checked' : ''}/> <span class="form-check-label">Puede ingresar al panel</span></label>
            </div>
          </div>
          <div class="adm-form-actions">
            <a class="btn btn-light" href="/users">Cancelar</a>
            <button class="btn btn-primary" type="submit"><i class="ri-save-3-line me-1"></i>Guardar cambios</button>
          </div>
        </form>
      </div></div>
      <aside class="ab-aside">
        <div class="card ab-card"><div class="card-body">
          <div class="ab-card-title"><h5>Alcance de la cuenta</h5><span>Qué puede ver y administrar.</span></div>
          <ul class="adm-scope-list">
            <li><b>Super Admin:</b> todas las sedes, usuarios, líneas y reportes.</li>
            <li><b>Gerente General:</b> todas las líneas y conversaciones de su sede.</li>
            <li><b>Gerente de Marketing:</b> toda el área de Marketing de su sede.</li>
            <li><b>Supervisor de Marketing:</b> seguimiento de Marketing de su sede.</li>
            <li><b>Asesor de Marketing:</b> su propia línea y sus notas.</li>
          </ul>
          <p class="adm-foot"><i class="ri-information-line"></i>Las cuentas de cronogramas conservan el cargo que les asigna ese sistema; acá solo se ajustan la sede y la autorización.</p>
        </div></div>
      </aside>
    </div>
  </div>`;
}

function renderUsers(req: Request, sessions: SessionRow[]): string {
  const users = listUsers();
  const sedes = listSedes();
  const sedeMap = new Map(sedes.map((s) => [s.id, s.name]));
  const rawText = q(req, 'q');
  const text = rawText.toLowerCase();
  const filter = q(req, 'f');
  const area = q(req, 'area') || 'all';
  const sedeFilter = Number(q(req, 'sede')) || 0;
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
  const lastUse = lastUseByUser(users);
  // Una sola evaluación de salud por línea, aunque varios usuarios compartan el número.
  const verdictCache = new Map<string, ReturnType<typeof lineVerdict>>();
  const verdictOf = (session: SessionRow) => {
    let verdict = verdictCache.get(session.id);
    if (!verdict) {
      verdict = lineVerdict(session);
      verdictCache.set(session.id, verdict);
    }
    return verdict;
  };
  const lineOf = (u: UserRow) => {
    const num = digits(u.esam_numero);
    if (!num) return null;
    const matches = sessions.filter((s) => digits(s.expected_phone) === num || digits(s.phone) === num);
    return { num, session: matches.find((s) => s.status === 'ready') ?? matches[0] ?? null };
  };
  const isInactive = (u: UserRow) => !u.last_login_at || Date.now() - Date.parse(u.last_login_at) > INACTIVE_DAYS * 86_400_000;

  const areaCounts = new Map<string, number>();
  const sinArea = users.filter((u) => userAreas(u).length === 0).length;
  for (const u of users) {
    for (const a of userAreas(u)) areaCounts.set(a, (areaCounts.get(a) ?? 0) + 1);
  }

  const rows = users.filter((u) => {
    const sedeName = u.sede_id ? (sedeMap.get(u.sede_id) ?? '') : '';
    if (text && ![u.name, u.username, u.email, u.esam_area, sedeName].some((v) => (v ?? '').toLowerCase().includes(text))) return false;
    if (sedeFilter && u.sede_id !== sedeFilter) return false;
    if (area !== 'all') {
      const areas = userAreas(u);
      if (area === 'sin-area' ? areas.length > 0 : !areas.includes(area)) return false;
    }
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
  const noLine = users.filter((u) => (u.source !== 'local' || !!u.esam_numero) && lineOf(u)?.session?.status !== 'ready').length;
  const unauthorized = users.filter((u) => !u.esam_autorizado).length;
  const chip = (id: string, label: string, n: number) => {
    const params = new URLSearchParams();
    if (id) params.set('f', id);
    if (rawText) params.set('q', rawText);
    if (area !== 'all') params.set('area', area);
    if (sedeFilter) params.set('sede', String(sedeFilter));
    const query = params.toString();

    return `<a class="ab-filter ${filter === id ? 'on' : ''}" href="/users${query ? `?${query}` : ''}">${esc(label)} <span>${n}</span></a>`;
  };

  const areaHref = (key: string) => {
    const params = new URLSearchParams();
    if (key !== 'all') params.set('area', key);
    if (filter) params.set('f', filter);
    if (rawText) params.set('q', rawText);
    if (sedeFilter) params.set('sede', String(sedeFilter));
    const query = params.toString();

    return `/users${query ? `?${query}` : ''}`;
  };

  const areaTabs = [
    { key: 'all', label: 'Todas', count: users.length },
    ...USER_AREA_TABS.map((t) => ({ ...t, count: areaCounts.get(t.key) ?? 0 })),
    ...(sinArea ? [{ key: 'sin-area', label: 'Sin área', count: sinArea }] : []),
  ]
    .filter((t) => t.key !== 'sin-area' || t.count > 0)
    .map((t) => `<a class="ab-user-tab${area === t.key ? ' on' : ''}" href="${areaHref(t.key)}" role="tab" aria-selected="${area === t.key ? 'true' : 'false'}">
      <span>${esc(t.label)}</span><b>${t.count}</b></a>`)
    .join('');

  const table = rows.length
    ? `<div class="adm-table-wrap"><table class="table table-hover align-middle mb-0 ab-table adm-users">
        <thead><tr><th>Persona</th><th>Rol</th><th>Sede</th><th>Línea de WhatsApp</th><th>Último ingreso</th><th>Última actividad</th><th>Actividad 30 días</th><th>Acceso</th><th></th></tr></thead>
        <tbody>${rows
          .map((u, i) => {
            const roles = esamRoles(u);
            const roleCell = roles.length
              ? roles.map((r) => `<span class="ab-pill ab-info">${esc(r)}</span>`).join(' ')
              : esamEsAdmin(u)
                ? '<span class="ab-pill ab-ok">Super Admin</span>'
                : '<span class="text-muted">—</span>';
            const sedeCell = u.sede_id
              ? `<span class="adm-sub">${esc(sedeMap.get(u.sede_id) ?? 'Sede eliminada')}</span>`
              : '<span class="ab-pill ab-warn">Sin sede</span>';
            const line = lineOf(u);
            const st = line?.session ? SESSION_STATUS[line.session.status] ?? { label: line.session.status, tone: 'mute' } : null;
            const verdict = line?.session ? verdictOf(line.session) : null;
            const health = verdict ? USER_HEALTH[verdict.level] : null;
            const healthHref = line?.session ? `/anti-ban/line/${encodeURIComponent(line.session.id)}` : '';
            const healthReason = verdict?.reasons[0] || verdict?.title || '';
            const healthPill = health && healthHref
              ? `<a class="ab-pill ab-${health.tone} adm-health-pill" href="${healthHref}" title="${esc(healthReason)}"><span class="ab-dot"></span>${esc(health.label)}</a>`
              : '';
            const healthLine = health && healthHref
              ? `<a class="adm-health-reason" href="${healthHref}" title="${esc(healthReason)}">${esc(healthReason.length > 90 ? `${healthReason.slice(0, 90)}…` : healthReason)}</a>`
              : '';
            const lineCell =
              u.source === 'local' && !line
                ? '<span class="text-muted">Cuenta de servicio</span>'
                : !line
                  ? '<span class="ab-pill ab-mute">Sin número asignado</span>'
                  : `<div class="adm-line"><span class="ab-mono">+${esc(line.num)}</span>
                     ${st ? `<span class="ab-pill ab-${st.tone}"><span class="ab-dot"></span>${esc(st.label)}</span>` : '<span class="ab-pill ab-warn">Línea no creada</span>'}
                     ${healthPill}</div>${healthLine}`;
            const r = responses.get(u.id);
            const n = notes.get(u.id) ?? 0;
            const inactive = isInactive(u);
            const use = lastUse.get(u.id);
            const useIcon = use?.kind === 'batch' ? 'ri-send-plane-2-line' : use?.kind === 'note' ? 'ri-sticky-note-line' : 'ri-chat-1-line';
            return `<tr>
              <td data-label="Persona"><div class="user-cell">
                <span class="avatar-xs rounded-circle av-${i % 8}">${esc(initials(u.name ?? u.username))}</span>
                <div class="min-w-0"><div class="user-name"><a class="adm-user-link" href="/reports/users/${u.id}" title="Ver ficha y seguimiento">${esc(u.name ?? '—')}</a></div>
                  <div class="user-mail">${u.ci ? `CI ${esc(u.ci)} · ` : ''}${esc(u.username ?? '')}${u.email ? ` · ${esc(u.email)}` : ''}</div></div>
              </div></td>
              <td data-label="Rol">${roleCell}${u.esam_area ? `<div class="adm-sub">${esc(u.esam_area)}</div>` : ''}</td>
              <td data-label="Sede">${sedeCell}</td>
              <td data-label="Línea de WhatsApp">${lineCell}</td>
              <td data-label="Último ingreso"><span title="${esc(fmtDate(u.last_login_at))}" class="${inactive ? 'ab-t-warn' : ''}">${esc(relTime(u.last_login_at))}</span>
                <div class="adm-sub">${u.login_count} ingreso${u.login_count === 1 ? '' : 's'}</div></td>
              <td data-label="Última actividad">${use ? `<span class="adm-use" title="${esc(fmtDate(use.at))}"><i class="${useIcon}"></i>${esc(relTime(use.at))}</span>
                <div class="adm-sub">${esc(use.label)}</div>` : '<span class="text-muted">Sin actividad registrada</span>'}</td>
              <td data-label="Actividad 30 días">${r || n ? `<b>${r?.c ?? 0}</b> respuestas · ${r?.chats ?? 0} chats<div class="adm-sub">${n} nota${n === 1 ? '' : 's'} registrada${n === 1 ? '' : 's'}</div>` : '<span class="text-muted">Sin actividad</span>'}</td>
              <td data-label="Acceso">${u.esam_autorizado ? '<span class="ab-pill ab-ok"><i class="ri-check-line"></i>Autorizado</span>' : '<span class="ab-pill ab-danger">Sin autorizar</span>'}
                <div class="adm-sub">${esc(u.source === 'local' ? 'Local' : u.source === 'cronogramas' ? 'Cronogramas' : u.source)}</div></td>
              <td data-label="Editar"><a class="btn btn-sm btn-soft-secondary" href="/users/${u.id}" title="Editar cuenta, sede y cargo"><span class="ri-pencil-line"></span></a></td>
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
    <div class="adm-tools">
      ${renderSedesPanel(sedes, q(req, 'panel') === 'sedes')}
      ${renderNewUserPanel(sedes, q(req, 'panel') === 'nuevo')}
    </div>
    <div class="card ab-card"><div class="card-body">
      <div class="ab-user-tabs" role="tablist" aria-label="Filtrar usuarios por área">${areaTabs}</div>
      <div class="ab-bl-toolbar">
        <form method="get" action="/users" class="ab-search" role="search">
          ${filter ? `<input type="hidden" name="f" value="${esc(filter)}"/>` : ''}
          ${area !== 'all' ? `<input type="hidden" name="area" value="${esc(area)}"/>` : ''}
          <i class="ri-search-line"></i><input type="search" name="q" value="${esc(rawText)}" placeholder="Buscar por nombre, usuario, correo o área…" aria-label="Buscar usuarios"/>
          ${sedes.length ? `<select class="form-select adm-sede-filter" name="sede" aria-label="Filtrar por sede" onchange="this.form.submit()">
            <option value="">Todas las sedes</option>
            ${sedes.map((s) => `<option value="${s.id}"${sedeFilter === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>` : ''}
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
      <p class="adm-foot"><i class="ri-information-line"></i>Las cuentas de <b>cronogramas</b> actualizan su cargo al iniciar sesión desde ese sistema. Las <b>cuentas locales</b> se crean y administran acá con su sede y cargo. Para vincular un número, la persona escanea el QR en <a href="/settings">Conexión</a>.</p>
    </div></div>
  </div>`;
}

// ══ Unidades de negocio ═══════════════════════════════════════════════════════

/** Distintivo de la tarjeta: el código si lo tiene; si no, las iniciales. */
function unitMark(unit: { name: string; code: string | null }): string {
  return (unit.code ?? initials(unit.name)).slice(0, 8);
}

/** Campo de formulario con su mensaje de error para la validación en vivo. */
function field(opts: {
  id: string;
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  type?: string;
  rules?: string;
  list?: string;
  hint?: string;
  maxlength?: number;
  required?: boolean;
  autocomplete?: string;
  inputmode?: string;
  attrs?: string;
}): string {
  const attrs = [
    `class="form-control"`,
    `id="${esc(opts.id)}"`,
    `name="${esc(opts.name)}"`,
    `maxlength="${opts.maxlength ?? 120}"`,
    opts.required ? 'required' : '',
    opts.type ? `type="${esc(opts.type)}"` : '',
    opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : '',
    opts.autocomplete ? `autocomplete="${esc(opts.autocomplete)}"` : '',
    opts.inputmode ? `inputmode="${esc(opts.inputmode)}"` : '',
    opts.rules ? `data-v="${esc(opts.rules)}"` : '',
    opts.list ? `data-unique-list="${esc(opts.list)}"` : '',
    opts.attrs ?? '',
  ].filter(Boolean).join(' ');
  return `<div class="ab-field">
    <label class="form-label" for="${esc(opts.id)}">${esc(opts.label)}${opts.required ? ' <span class="ub-req">*</span>' : ''}</label>
    <input ${attrs} value="${esc(opts.value ?? '')}"/>
    ${opts.hint ? `<small class="ub-hint">${esc(opts.hint)}</small>` : ''}
    <small class="ub-error" data-error></small>
  </div>`;
}

function selectField(opts: {
  id: string;
  name: string;
  label: string;
  options: readonly string[];
  selected?: string;
  placeholder?: string;
  rules?: string;
  hint?: string;
  attrs?: string;
}): string {
  return `<div class="ab-field">
    <label class="form-label" for="${esc(opts.id)}">${esc(opts.label)} <span class="ub-req">*</span></label>
    <select class="form-select" id="${esc(opts.id)}" name="${esc(opts.name)}" required ${opts.attrs ?? ''}${opts.rules ? ` data-v="${esc(opts.rules)}"` : ''}>
      <option value="">${esc(opts.placeholder ?? 'Elegí una opción')}</option>
      ${opts.options.map((o) => `<option value="${esc(o)}"${o === opts.selected ? ' selected' : ''}>${esc(o)}</option>`).join('')}
    </select>
    ${opts.hint ? `<small class="ub-hint">${esc(opts.hint)}</small>` : ''}
    <small class="ub-error" data-error></small>
  </div>`;
}

/** Script compartido de modales, validación en vivo y área → cargo. */
function unitsScript(): string {
  return '<script src="/assets/js/unidades.js?v=1" defer></script>';
}

/** Botón que abre un modal. */
function openButton(selector: string, label: string, icon: string, cls = 'btn btn-primary btn-sm'): string {
  return `<button class="${cls}" type="button" data-ub-open="${esc(selector)}"><i class="${icon} me-1" aria-hidden="true"></i>${esc(label)}</button>`;
}

/** Modal de confirmación de borrado (el JS le pone la acción y el nombre). */
function deleteModal(id: string, title: string): string {
  return `<dialog class="ub-modal" id="${esc(id)}">
    <form method="post" action="" class="ub-modal-form">
      <header class="ub-modal-head">
        <div><h5>${esc(title)}</h5><p>Esta acción no se puede deshacer.</p></div>
        <button class="ub-modal-x" type="button" data-ub-close aria-label="Cerrar"><i class="ri-close-line"></i></button>
      </header>
      <div class="ub-modal-body">
        <p class="ub-modal-text">¿Eliminar <b data-name>este registro</b>?</p>
      </div>
      <footer class="ub-modal-foot">
        <button class="btn btn-soft-secondary" type="button" data-ub-close>Cancelar</button>
        <button class="btn btn-danger" type="submit"><i class="ri-delete-bin-6-line me-1"></i>Eliminar</button>
      </footer>
    </form>
  </dialog>`;
}

function renderBusinessUnitsPage(openModal = ''): string {
  const units = listBusinessUnits();
  const totalSedes = units.reduce((n, u) => n + u.sedes, 0);
  const totalUsers = units.reduce((n, u) => n + u.users, 0);
  const names = JSON.stringify(units.map((u) => u.name));

  const cards = units.map((u) => {
    const sedes = listSedes(u.id);
    const chips = sedes.length
      ? sedes.slice(0, 4).map((s) => `<span class="ub-chip"><i class="ri-building-2-line" aria-hidden="true"></i>${esc(s.name)}</span>`).join('')
      : '<span class="ub-muted">Todavía sin sedes</span>';
    const extra = sedes.length > 4 ? `<span class="ub-chip">+${sedes.length - 4} más</span>` : '';
    return `<article class="ub-card-wrap">
      <a class="ub-card" href="/unidades/${u.id}">
        <div class="ub-card-head">
          <span class="ub-code">${esc(unitMark(u))}</span>
          <span class="ub-card-title"><h5>${esc(u.name)}</h5><span>Unidad de negocio</span></span>
          <i class="ri-arrow-right-s-line ub-chevron" aria-hidden="true"></i>
        </div>
        <div class="ub-metrics">
          <div class="ub-metric"><b>${u.sedes}</b><span>sede${u.sedes === 1 ? '' : 's'}</span></div>
          <div class="ub-metric"><b>${u.users}</b><span>usuario${u.users === 1 ? '' : 's'}</span></div>
        </div>
        <div class="ub-chips">${chips}${extra}</div>
      </a>
      <div class="ub-card-actions">
        <button type="button" class="btn btn-sm btn-soft-secondary" title="Editar unidad"
          data-ub-edit-unit data-action="/unidades/${u.id}" data-name="${esc(u.name)}" data-code="${esc(u.code ?? '')}" data-self="${esc(u.name)}">
          <i class="ri-pencil-line" aria-hidden="true"></i></button>
        <button type="button" class="btn btn-sm btn-soft-danger" title="${u.sedes ? 'Tiene sedes: no se puede eliminar' : 'Eliminar unidad'}"
          ${u.sedes ? 'disabled' : ''} data-ub-delete data-action="/unidades/${u.id}/delete" data-name="${esc(u.name)}" data-kind="la unidad" data-target="#ub-unit-del">
          <i class="ri-delete-bin-6-line" aria-hidden="true"></i></button>
      </div>
    </article>`;
  }).join('');

  return `<div class="ab-page ub-page">
    <div class="ab-kpis adm-kpis-3">
      ${kpi('ri-community-line', 'info', 'Unidades de negocio', units.length, 'ESAM, DBS y más')}
      ${kpi('ri-building-2-line', 'ok', 'Sedes', totalSedes, 'con su equipo')}
      ${kpi('ri-user-3-line', 'mute', 'Usuarios', totalUsers, 'con número de acceso')}
    </div>
    ${units.length
      ? `<div class="ub-grid">${cards}</div>`
      : emptyState('ri-community-line', 'Todavía no hay unidades', 'Creá la primera unidad de negocio (por ejemplo ESAM) para ordenar sus sedes y usuarios.',
        openButton('#ub-unit-new', 'Crear unidad', 'ri-add-line'))}

    <dialog class="ub-modal" id="ub-unit-new"${openModal === 'unidad' ? ' data-auto-open' : ''}>
      <form method="post" action="/unidades" class="ub-modal-form" data-ub-validate data-existing-names='${esc(names)}' novalidate>
        <header class="ub-modal-head">
          <div><h5>Nueva unidad de negocio</h5><p>El primer nivel: adentro van las sedes y, en cada sede, los usuarios.</p></div>
          <button class="ub-modal-x" type="button" data-ub-close aria-label="Cerrar"><i class="ri-close-line"></i></button>
        </header>
        <div class="ub-modal-body ub-form-grid">
          ${field({ id: 'un-name', name: 'name', label: 'Nombre', placeholder: 'Ej.: ESAM', required: true, maxlength: 80, rules: 'required|min:2|max:80|unique', list: 'existingNames' })}
          ${field({ id: 'un-code', name: 'code', label: 'Código', placeholder: 'ESAM', maxlength: 8, rules: 'code', hint: 'Sigla que se muestra en la tarjeta (opcional).' })}
        </div>
        <footer class="ub-modal-foot">
          <button class="btn btn-soft-secondary" type="button" data-ub-close>Cancelar</button>
          <button class="btn btn-primary" type="submit"><i class="ri-add-line me-1"></i>Crear unidad</button>
        </footer>
      </form>
    </dialog>

    <dialog class="ub-modal" id="ub-unit-edit">
      <form method="post" action="" class="ub-modal-form" data-ub-validate data-existing-names='${esc(names)}' novalidate>
        <header class="ub-modal-head">
          <div><h5>Editar unidad de negocio</h5><p>El nombre y el código se actualizan al instante en las tarjetas.</p></div>
          <button class="ub-modal-x" type="button" data-ub-close aria-label="Cerrar"><i class="ri-close-line"></i></button>
        </header>
        <div class="ub-modal-body ub-form-grid">
          ${field({ id: 'ue-name', name: 'name', label: 'Nombre', required: true, maxlength: 80, rules: 'required|min:2|max:80|unique', list: 'existingNames' })}
          ${field({ id: 'ue-code', name: 'code', label: 'Código', maxlength: 8, rules: 'code' })}
        </div>
        <footer class="ub-modal-foot">
          <button class="btn btn-soft-secondary" type="button" data-ub-close>Cancelar</button>
          <button class="btn btn-primary" type="submit"><i class="ri-save-3-line me-1"></i>Guardar cambios</button>
        </footer>
      </form>
    </dialog>

    ${deleteModal('ub-unit-del', 'Eliminar unidad de negocio')}
    ${unitsScript()}
  </div>`;
}

function renderBusinessUnitPage(unit: BusinessUnitRow, openModal = ''): string {
  const sedes = listSedes(unit.id);
  const users = listUsers().filter((u) => u.sede_id && sedes.some((s) => s.id === u.sede_id));
  const conNumero = users.filter((u) => digits(u.esam_numero)).length;
  const names = JSON.stringify(sedes.map((s) => s.name));

  const sedeCards = sedes.map((s) => {
    const miembros = users.filter((u) => u.sede_id === s.id);
    const preview = miembros.slice(0, 3).map((u, i) => `<div class="ub-user ub-user-mini">
        <span class="avatar-xs rounded-circle av-${i % 8}">${esc(initials(u.name ?? u.username ?? '?'))}</span>
        <div class="ub-user-main"><b>${esc(u.name ?? u.username ?? '—')}</b><span>${esc(esamAreaName(u.esam_area))} · ${esc(esamRoles(u).join(' · ') || 'Sin cargo')}</span></div>
      </div>`).join('');
    const mas = miembros.length > 3 ? `<p class="ub-users-more">+${miembros.length - 3} más</p>` : '';
    return `<article class="ub-sede-card">
      <a class="ub-sede-link" href="/unidades/${unit.id}/sedes/${s.id}" aria-label="Ingresar a ${esc(s.name)}">
        <header class="ub-sede-head">
          <span class="ub-sede-ic"><i class="ri-building-2-line" aria-hidden="true"></i></span>
          <span class="ub-sede-title"><h6>${esc(s.name)}</h6><span>${miembros.length} usuario${miembros.length === 1 ? '' : 's'} · ${miembros.filter((u) => digits(u.esam_numero)).length} con número</span></span>
          <span class="ub-sede-count">${miembros.length}</span>
        </header>
        <div class="ub-users">${preview}${mas}${miembros.length === 0 ? '<p class="ub-users-empty"><i class="ri-user-search-line" aria-hidden="true"></i> Todavía no hay usuarios</p>' : ''}</div>
      </a>
      <footer class="ub-sede-foot">
        <a class="btn btn-sm btn-soft-primary" href="/unidades/${unit.id}/sedes/${s.id}"><i class="ri-login-box-line me-1"></i>Ingresar</a>
        <div class="ub-sede-tools">
          <button type="button" class="btn btn-sm btn-soft-secondary" title="Editar sede"
            data-ub-edit-sede data-action="/unidades/${unit.id}/sedes/${s.id}" data-name="${esc(s.name)}" data-self="${esc(s.name)}">
            <i class="ri-pencil-line" aria-hidden="true"></i></button>
          <button type="button" class="btn btn-sm btn-soft-danger" title="${miembros.length ? 'Tiene usuarios: no se puede eliminar' : 'Eliminar sede'}"
            ${miembros.length ? 'disabled' : ''} data-ub-delete data-action="/unidades/${unit.id}/sedes/${s.id}/delete" data-name="${esc(s.name)}" data-kind="la sede" data-target="#ub-sede-del">
            <i class="ri-delete-bin-6-line" aria-hidden="true"></i></button>
        </div>
      </footer>
    </article>`;
  }).join('');

  return `<div class="ab-page ub-page">
    <nav class="ub-breadcrumb" aria-label="Ruta">
      <a href="/unidades"><i class="ri-community-line" aria-hidden="true"></i> Unidades de negocio</a>
      <i class="ri-arrow-right-s-line" aria-hidden="true"></i>
      <span>${esc(unit.name)}</span>
    </nav>
    <section class="ub-hero">
      <span class="ub-code ub-code-lg">${esc(unitMark(unit))}</span>
      <div class="ub-hero-body">
        <h2>${esc(unit.name)}</h2>
        <p>${unit.sedes} sede${unit.sedes === 1 ? '' : 's'} · ${unit.users} usuario${unit.users === 1 ? '' : 's'} · ${conNumero} con número de acceso</p>
      </div>
      <div class="ub-hero-actions">
        ${openButton('#ub-sede-new', 'Nueva sede', 'ri-add-line')}
        <button type="button" class="btn btn-sm btn-soft-secondary" title="Editar unidad"
          data-ub-edit-unit data-action="/unidades/${unit.id}" data-name="${esc(unit.name)}" data-code="${esc(unit.code ?? '')}" data-self="${esc(unit.name)}">
          <i class="ri-pencil-line me-1"></i>Editar</button>
        ${unit.sedes === 0
          ? `<button type="button" class="btn btn-sm btn-soft-danger" data-ub-delete data-action="/unidades/${unit.id}/delete" data-name="${esc(unit.name)}" data-kind="la unidad" data-target="#ub-unit-del"><i class="ri-delete-bin-6-line me-1"></i>Eliminar</button>`
          : ''}
      </div>
    </section>
    ${sedes.length
      ? `<div class="ub-sede-grid">${sedeCards}</div>`
      : emptyState('ri-building-2-line', 'Esta unidad todavía no tiene sedes', 'Creá la primera sede para empezar a registrar usuarios con su número de acceso.',
        openButton('#ub-sede-new', 'Crear sede', 'ri-add-line'))}

    <dialog class="ub-modal" id="ub-sede-new"${openModal === 'sede' ? ' data-auto-open' : ''}>
      <form method="post" action="/unidades/${unit.id}/sedes" class="ub-modal-form" data-ub-validate data-existing-names='${esc(names)}' novalidate>
        <header class="ub-modal-head">
          <div><h5>Nueva sede de ${esc(unit.name)}</h5><p>Una sucursal o sede dentro de esta unidad de negocio.</p></div>
          <button class="ub-modal-x" type="button" data-ub-close aria-label="Cerrar"><i class="ri-close-line"></i></button>
        </header>
        <div class="ub-modal-body">
          ${field({ id: 'us-name', name: 'name', label: 'Nombre de la sede', placeholder: 'Ej.: ESAM Sucre Central', required: true, maxlength: 80, rules: 'required|min:2|max:80|unique', list: 'existingNames' })}
        </div>
        <footer class="ub-modal-foot">
          <button class="btn btn-soft-secondary" type="button" data-ub-close>Cancelar</button>
          <button class="btn btn-primary" type="submit"><i class="ri-add-line me-1"></i>Crear sede</button>
        </footer>
      </form>
    </dialog>

    <dialog class="ub-modal" id="ub-sede-edit">
      <form method="post" action="" class="ub-modal-form" data-ub-validate data-existing-names='${esc(names)}' novalidate>
        <header class="ub-modal-head">
          <div><h5>Editar sede</h5><p>El nombre se actualiza en las tarjetas y en la ficha de la sede.</p></div>
          <button class="ub-modal-x" type="button" data-ub-close aria-label="Cerrar"><i class="ri-close-line"></i></button>
        </header>
        <div class="ub-modal-body">
          ${field({ id: 'use-name', name: 'name', label: 'Nombre de la sede', required: true, maxlength: 80, rules: 'required|min:2|max:80|unique', list: 'existingNames' })}
        </div>
        <footer class="ub-modal-foot">
          <button class="btn btn-soft-secondary" type="button" data-ub-close>Cancelar</button>
          <button class="btn btn-primary" type="submit"><i class="ri-save-3-line me-1"></i>Guardar cambios</button>
        </footer>
      </form>
    </dialog>

    <dialog class="ub-modal" id="ub-unit-edit">
      <form method="post" action="" class="ub-modal-form" data-ub-validate novalidate>
        <header class="ub-modal-head">
          <div><h5>Editar unidad de negocio</h5><p>El nombre y el código se actualizan en las tarjetas.</p></div>
          <button class="ub-modal-x" type="button" data-ub-close aria-label="Cerrar"><i class="ri-close-line"></i></button>
        </header>
        <div class="ub-modal-body ub-form-grid">
          ${field({ id: 'ue2-name', name: 'name', label: 'Nombre', required: true, maxlength: 80, rules: 'required|min:2|max:80' })}
          ${field({ id: 'ue2-code', name: 'code', label: 'Código', maxlength: 8, rules: 'code' })}
        </div>
        <footer class="ub-modal-foot">
          <button class="btn btn-soft-secondary" type="button" data-ub-close>Cancelar</button>
          <button class="btn btn-primary" type="submit"><i class="ri-save-3-line me-1"></i>Guardar cambios</button>
        </footer>
      </form>
    </dialog>

    ${deleteModal('ub-sede-del', 'Eliminar sede')}
    ${deleteModal('ub-unit-del', 'Eliminar unidad de negocio')}
    ${unitsScript()}
  </div>`;
}

function renderSedePage(unit: BusinessUnitRow, sede: ReturnType<typeof getSede>, openModal = ''): string {
  if (!sede) return '';
  const allUsers = listUsers();
  const users = allUsers.filter((u) => u.sede_id === sede.id);
  const conNumero = users.filter((u) => digits(u.esam_numero)).length;
  const names = JSON.stringify(listSedes().map((s) => s.name));
  const areas = Object.keys(LOCAL_CARGOS_POR_AREA);
  const cargosJson = JSON.stringify(LOCAL_CARGOS_POR_AREA);
  const existingCi = JSON.stringify(allUsers.map((u) => u.ci).filter(Boolean));
  const existingPhones = JSON.stringify(allUsers.map((u) => digits(u.esam_numero)).filter(Boolean));
  const existingEmails = JSON.stringify(allUsers.map((u) => (u.email ?? '').toLowerCase()).filter(Boolean));

  const rows = users.length
    ? users.map((u, i) => {
        const roles = esamRoles(u);
        const num = digits(u.esam_numero);
        return `<tr>
          <td data-label="CI"><span class="ab-mono">${esc(u.ci ?? '—')}</span></td>
          <td data-label="Persona"><div class="user-cell">
            <span class="avatar-xs rounded-circle av-${i % 8}">${esc(initials(u.name ?? u.username ?? '?'))}</span>
            <div class="min-w-0"><div class="user-name">${esc(u.name ?? '—')}</div>
              <div class="user-mail">${esc(u.username ?? '')}${u.email ? ` · ${esc(u.email)}` : ''}</div></div>
          </div></td>
          <td data-label="WhatsApp">${num ? `<span class="ub-number"><i class="ri-whatsapp-line" aria-hidden="true"></i>+${esc(num)}</span>` : '<span class="ab-pill ab-warn">Sin número</span>'}</td>
          <td data-label="Correo">${u.email ? esc(u.email) : '<span class="text-muted">—</span>'}</td>
          <td data-label="Área"><span class="ab-pill ab-info">${esc(esamAreaName(u.esam_area))}</span></td>
          <td data-label="Cargo">${roles.length ? roles.map((r) => `<span class="ab-pill ab-mute">${esc(r)}</span>`).join(' ') : '<span class="text-muted">Sin cargo</span>'}</td>
          <td data-label="Acceso">${u.esam_autorizado ? '<span class="ab-pill ab-ok"><i class="ri-check-line"></i> Ingresa</span>' : '<span class="ab-pill ab-danger">Sin acceso</span>'}</td>
          <td data-label="Editar"><a class="btn btn-sm btn-soft-secondary" href="/users/${u.id}" title="Editar cuenta, CI, cargo y número"><span class="ri-pencil-line" aria-hidden="true"></span></a></td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="8"><div class="ub-empty-inline"><i class="ri-user-search-line" aria-hidden="true"></i> Todavía no hay usuarios en esta sede. Creá el primero con «Nuevo usuario».</div></td></tr>`;

  return `<div class="ab-page ub-page">
    <nav class="ub-breadcrumb" aria-label="Ruta">
      <a href="/unidades"><i class="ri-community-line" aria-hidden="true"></i> Unidades de negocio</a>
      <i class="ri-arrow-right-s-line" aria-hidden="true"></i>
      <a href="/unidades/${unit.id}">${esc(unit.name)}</a>
      <i class="ri-arrow-right-s-line" aria-hidden="true"></i>
      <span>${esc(sede.name)}</span>
    </nav>
    <section class="ub-hero">
      <span class="ub-code ub-code-lg"><i class="ri-building-2-line"></i></span>
      <div class="ub-hero-body">
        <h2>${esc(sede.name)}</h2>
        <p>${esc(unit.name)} · ${users.length} usuario${users.length === 1 ? '' : 's'} · ${conNumero} con número de acceso</p>
      </div>
      <div class="ub-hero-actions">
        ${openButton('#ub-user-new', 'Nuevo usuario', 'ri-user-add-line')}
        <button type="button" class="btn btn-sm btn-soft-secondary" title="Editar sede"
          data-ub-edit-sede data-action="/unidades/${unit.id}/sedes/${sede.id}" data-name="${esc(sede.name)}" data-self="${esc(sede.name)}">
          <i class="ri-pencil-line me-1"></i>Editar sede</button>
        ${users.length === 0
          ? `<button type="button" class="btn btn-sm btn-soft-danger" data-ub-delete data-action="/unidades/${unit.id}/sedes/${sede.id}/delete" data-name="${esc(sede.name)}" data-kind="la sede" data-target="#ub-sede-del"><i class="ri-delete-bin-6-line me-1"></i>Eliminar</button>`
          : ''}
      </div>
    </section>

    <div class="card ab-card"><div class="card-body">
      <div class="ab-card-title"><h5>Equipo de la sede</h5>
        <span>Cada persona ingresa al panel solo con el número de WhatsApp registrado acá.</span></div>
      <div class="adm-table-wrap"><table class="table table-hover align-middle mb-0 ab-table ub-users-table">
        <thead><tr><th>CI</th><th>Persona</th><th>WhatsApp</th><th>Correo</th><th>Área</th><th>Cargo</th><th>Acceso</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div></div>

    <dialog class="ub-modal ub-modal-wide" id="ub-user-new"${openModal === 'usuario' ? ' data-auto-open' : ''}>
      <form method="post" action="/unidades/${unit.id}/sedes/${sede.id}/usuarios" class="ub-modal-form" data-ub-validate
        data-existing-ci='${esc(existingCi)}' data-existing-phones='${esc(existingPhones)}' data-existing-emails='${esc(existingEmails)}' novalidate>
        <header class="ub-modal-head">
          <div><h5>Nuevo usuario en ${esc(sede.name)}</h5><p>El número de WhatsApp es la única llave de acceso de esta persona.</p></div>
          <button class="ub-modal-x" type="button" data-ub-close aria-label="Cerrar"><i class="ri-close-line"></i></button>
        </header>
        <div class="ub-modal-body ub-form-grid">
          ${field({ id: 'nu-ci', name: 'ci', label: 'CI', placeholder: 'Ej.: 1234567', required: true, maxlength: 20, rules: 'required|ci|unique', list: 'existingCi', inputmode: 'text' })}
          ${field({ id: 'nu-nombres', name: 'nombres', label: 'Nombres', placeholder: 'Ana María', required: true, maxlength: 60, rules: 'required|min:2|max:60' })}
          ${field({ id: 'nu-apellidos', name: 'apellidos', label: 'Apellidos', placeholder: 'Pérez Gómez', required: true, maxlength: 60, rules: 'required|min:2|max:60' })}
          ${field({ id: 'nu-numero', name: 'numero', label: 'WhatsApp', placeholder: '59171234567', required: true, maxlength: 20, rules: 'required|phone|unique-phone', list: 'existingPhones', inputmode: 'numeric' })}
          ${field({ id: 'nu-email', name: 'email', label: 'Correo', type: 'email', placeholder: 'ana@esam.edu.bo', maxlength: 120, rules: 'email|unique', list: 'existingEmails', autocomplete: 'off' })}
          <div class="ab-field">
            <label class="form-label" for="nu-area">Área <span class="ub-req">*</span></label>
            <select class="form-select" id="nu-area" name="area" required data-v="required" data-cargos-target="nu-cargo" data-cargos='${esc(cargosJson)}'>
              <option value="">Elegí el área</option>
              ${areas.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}
            </select>
            <small class="ub-error" data-error></small>
          </div>
          ${selectField({ id: 'nu-cargo', name: 'cargo', label: 'Cargo', options: LOCAL_CARGOS, placeholder: 'Primero elegí el área', rules: 'required', hint: 'Los cargos se filtran según el área.' })}
          ${field({ id: 'nu-password', name: 'password', label: 'Contraseña', type: 'password', placeholder: 'Por defecto, el CI', required: true, maxlength: 60, rules: 'required|min:6', autocomplete: 'new-password', hint: 'Por defecto se usa el CI; podés cambiarla.', attrs: 'data-from="nu-ci"' })}
        </div>
        <footer class="ub-modal-foot">
          <label class="form-check ub-modal-check"><input class="form-check-input" type="checkbox" name="autorizado" value="1" checked/> <span class="form-check-label">Puede ingresar al panel</span></label>
          <div class="ub-modal-buttons">
            <button class="btn btn-soft-secondary" type="button" data-ub-close>Cancelar</button>
            <button class="btn btn-primary" type="submit"><i class="ri-user-add-line me-1"></i>Crear usuario</button>
          </div>
        </footer>
      </form>
    </dialog>

    <dialog class="ub-modal" id="ub-sede-edit">
      <form method="post" action="" class="ub-modal-form" data-ub-validate data-existing-names='${esc(names)}' novalidate>
        <header class="ub-modal-head">
          <div><h5>Editar sede</h5><p>El nombre se actualiza en las tarjetas y en esta ficha.</p></div>
          <button class="ub-modal-x" type="button" data-ub-close aria-label="Cerrar"><i class="ri-close-line"></i></button>
        </header>
        <div class="ub-modal-body">
          ${field({ id: 'use-name', name: 'name', label: 'Nombre de la sede', required: true, maxlength: 80, rules: 'required|min:2|max:80|unique', list: 'existingNames' })}
        </div>
        <footer class="ub-modal-foot">
          <button class="btn btn-soft-secondary" type="button" data-ub-close>Cancelar</button>
          <button class="btn btn-primary" type="submit"><i class="ri-save-3-line me-1"></i>Guardar cambios</button>
        </footer>
      </form>
    </dialog>

    ${deleteModal('ub-sede-del', 'Eliminar sede')}
    ${unitsScript()}
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
      <a class="btn btn-sm btn-soft-primary tpl-card-edit" href="${templatesUrl({ id: t.id })}#tpl-editor" title="Editar mensaje" aria-label="Editar el mensaje de ${esc(t.name)}"><i class="ri-pencil-line"></i></a>
    </header>
    <div class="tpl-bubble">${waPreview(t.body)}</div>
    <div class="tpl-card-info">
      ${vars.length ? `<span><i class="ri-braces-line"></i>${vars.length} variable${vars.length === 1 ? '' : 's'}</span>` : '<span><i class="ri-braces-line"></i>Sin variables</span>'}
      <span class="${spins ? '' : 'ab-t-warn'}" title="Variantes {a|b}: evitan enviar exactamente el mismo texto a todos"><i class="ri-shuffle-line"></i>${spins ? `${spins} variante${spins === 1 ? '' : 's'}` : 'Sin variantes'}</span>
      <span><i class="ri-text"></i>${t.body.length} caracteres</span>
    </div>
    <footer class="tpl-card-actions">
      <a class="btn btn-sm btn-soft-primary" href="${templatesUrl({ id: t.id })}#tpl-editor"><i class="ri-pencil-line me-1"></i>Editar mensaje</a>
      <form method="post" action="/templates/${t.id}/duplicate"><button class="btn btn-sm btn-light" type="submit"><i class="ri-file-copy-line me-1"></i>Duplicar</button></form>
      <form method="post" action="/templates/${t.id}/toggle" ${t.active ? `data-confirm="¿Desactivar «${esc(t.name)}»? Los envíos dejarán de usarla."` : ''}>
        <button class="btn btn-sm btn-light" type="submit">${t.active ? '<i class="ri-pause-line me-1"></i>Desactivar' : '<i class="ri-play-line me-1"></i>Activar'}</button></form>
      <form method="post" action="/templates/${t.id}/delete" class="ms-auto" data-confirm="¿Eliminar «${esc(t.name)}»? No se puede deshacer.">
        <button class="btn btn-sm btn-soft-danger" type="submit" title="Eliminar"><i class="ri-delete-bin-6-line"></i></button></form>
    </footer>
  </article>`;
}

function renderTemplates(req: Request, editIdOverride = 0): string {
  const all = listTemplates();
  const cat = q(req, 'cat');
  const text = q(req, 'q').toLowerCase();
  const editId = editIdOverride || Number(q(req, 'edit')) || 0;
  const editing = editId ? getTemplate(editId) : undefined;
  const cats = [...new Set(all.map((t) => t.category))].sort();
  const rows = all.filter(
    (t) => (!cat || t.category === cat) && (!text || t.name.toLowerCase().includes(text) || t.body.toLowerCase().includes(text)),
  );
  const chip = (value: string, label: string, n: number) =>
    `<a class="ab-filter ${cat === value ? 'on' : ''}" href="${templatesUrl({ cat: value })}">${esc(label)} <span>${n}</span></a>`;
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
        ${t ? `<a class="btn btn-light" href="${templatesUrl({ cat })}">Cancelar</a>` : ''}
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
  const maps = () => ({
    sessions: new Map(ctx.sessions().map((s) => [s.id, s])),
    users: new Map(listUsers().map((u) => [u.id, u])),
  });

  // Auditoría
  const renderAuditPage = (req: Request, res: Response, cat?: string) => {
    const f = auditFilters(req, cat);
    sendPage(req, res, 'Auditoría', 'audit', renderAudit(f, maps()), {
      subtitle: 'Qué pasó, cuándo y quién: conexiones, lotes, anti-baneo, lista negra y cuentas.',
      actions: `<a class="btn btn-soft-secondary btn-sm" href="/audit/export.csv${auditQuery(f)}"><i class="ri-download-2-line me-1"></i>Exportar CSV</a>`,
    });
  };
  app.get('/audit', ctx.requireUser, ctx.requireSection('audit'), (req: Request, res: Response) => {
    renderAuditPage(req, res);
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

  app.get('/audit/:cat', ctx.requireUser, ctx.requireSection('audit'), (req: Request, res: Response) => {
    const cat = String(req.params.cat);
    if (!AUDIT_CATS.some((c) => c.id === cat)) {
      res.status(404).send(pageHtml(req, res, 'Categoría no encontrada', 'audit', emptyState('ri-question-line', 'Categoría no encontrada', 'La categoría de auditoría no existe.')));
      return;
    }
    renderAuditPage(req, res, cat);
  });

  // Usuarios y sedes
  const usersGuard = [ctx.requireUser, ctx.requireSection('users')];
  const backToUsers = (res: Response, msg: string, opts: { kind?: 'ok' | 'error'; panel?: string } = {}) => {
    setFlash(res, opts.kind ?? 'ok', msg);
    const panel = opts.panel ? `?panel=${encodeURIComponent(opts.panel)}` : '';
    return `/users${panel}`;
  };

  app.get('/users', ...usersGuard, (req: Request, res: Response) => {
    sendPage(req, res, 'Usuarios', 'users', renderUsers(req, ctx.sessions()), {
      subtitle: 'Quién tiene acceso, con qué rol, si su número de WhatsApp está conectado y cuánto atendió.',
    });
  });

  app.post('/sedes', ...usersGuard, (req: Request, res: Response) => {
    const name = String(req.body?.name ?? '').trim();
    const unitId = Number(req.body?.business_unit_id) || 0;
    try {
      const id = createSede(name, unitId || null);
      audit('user.sede_created', { sede_id: id, unit_id: unitId || null, name, by: usersUserId(req) });
      res.redirect(backToUsers(res, `Sede «${name}» creada.`));
    } catch (err) {
      res.redirect(backToUsers(res, (err as Error).message, { kind: 'error', panel: 'sedes' }));
    }
  });

  app.post('/sedes/:id', ...usersGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const name = String(req.body?.name ?? '').trim();
    try {
      if (!id) throw new Error('Sede no encontrada.');
      renameSede(id, name);
      audit('user.sede_renamed', { sede_id: id, name, by: usersUserId(req) });
      res.redirect(backToUsers(res, `Sede actualizada: «${name}».`));
    } catch (err) {
      res.redirect(backToUsers(res, (err as Error).message, { kind: 'error', panel: 'sedes' }));
    }
  });

  app.post('/sedes/:id/delete', ...usersGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    try {
      if (!id) throw new Error('Sede no encontrada.');
      deleteSede(id);
      audit('user.sede_deleted', { sede_id: id, by: usersUserId(req) });
      res.redirect(backToUsers(res, 'Sede eliminada.'));
    } catch (err) {
      res.redirect(backToUsers(res, (err as Error).message, { kind: 'error', panel: 'sedes' }));
    }
  });

  app.post('/users', ...usersGuard, (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cargo = String(b.cargo ?? '');
    try {
      if (!(LOCAL_CARGOS as readonly string[]).includes(cargo)) throw new Error('Elegí un cargo válido.');
      const user = createLocalUser({
        name: String(b.name ?? ''),
        ci: String(b.ci ?? ''),
        username: String(b.username ?? ''),
        email: String(b.email ?? ''),
        password: String(b.password ?? '').trim() || String(b.ci ?? '').trim(),
        numero: String(b.numero ?? ''),
        sedeId: Number(b.sede_id) || 0,
        roles: [cargo],
        autorizado: b.autorizado === '1',
      });
      audit('user.created', { user_id: user.id, name: user.name, sede_id: user.sede_id, roles: esamRoles(user), by: usersUserId(req) });
      res.redirect(backToUsers(res, `Usuario «${user.name ?? user.username}» creado.`));
    } catch (err) {
      res.redirect(backToUsers(res, (err as Error).message, { kind: 'error', panel: 'nuevo' }));
    }
  });

  app.get('/users/:id', ...usersGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const user = id ? findById(id) : undefined;
    if (!user) {
      res
        .status(404)
        .send(
          pageHtml(req, res, 'Usuario no encontrado', 'users', emptyState('ri-user-search-line', 'Usuario no encontrado', 'La cuenta no existe o se eliminó.'), {
            activeHref: '/users',
          }),
        );
      return;
    }
    sendPage(req, res, 'Editar usuario', 'users', renderUserEdit(user), {
      subtitle: `Sede, cargo y acceso de ${user.name ?? user.username ?? 'la cuenta'}.`,
      activeHref: '/users',
    });
  });

  app.post('/users/:id', ...usersGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const target = id ? findById(id) : undefined;
    if (!target) {
      res.redirect(backToUsers(res, 'Usuario no encontrado.', { kind: 'error' }));
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const me = usersUserId(req);
    const autorizado = b.autorizado === '1';
    const sedeId = Number(b.sede_id) || null;
    const isLocal = target.source === 'local';
    const isSuper = esamEsAdmin(target);
    try {
      if (me === target.id && !autorizado) throw new Error('No podés quitarte tu propio acceso al panel.');
      if (isLocal && !isSuper) {
        const cargo = String(b.cargo ?? '');
        if (!(LOCAL_CARGOS as readonly string[]).includes(cargo)) throw new Error('Elegí un cargo válido.');
        if (!String(b.numero ?? '').trim()) throw new Error('Escribí el número de WhatsApp.');
        updateManagedUser(target.id, {
          name: String(b.name ?? ''),
          ci: String(b.ci ?? ''),
          username: String(b.username ?? ''),
          email: String(b.email ?? ''),
          password: String(b.password ?? '') || null,
          numero: String(b.numero ?? ''),
          sedeId,
          roles: [cargo],
          autorizado,
        });
      } else {
        // Super Admin y cuentas de cronogramas: el rol no se toca desde acá.
        updateManagedUser(target.id, {
          sedeId,
          autorizado,
          preserveRoles: true,
          ...(isSuper
            ? {
                name: String(b.name ?? ''),
                username: String(b.username ?? ''),
                email: String(b.email ?? ''),
                password: String(b.password ?? '') || null,
                numero: String(b.numero ?? ''),
              }
            : {}),
        });
      }
      const updated = findById(target.id);
      audit('user.updated', {
        user_id: target.id,
        sede_id: updated?.sede_id ?? null,
        roles: updated ? esamRoles(updated) : [],
        by: me,
      });
      res.redirect(backToUsers(res, 'Cambios guardados.'));
    } catch (err) {
      res.redirect(backToUsers(res, (err as Error).message, { kind: 'error' }));
    }
  });

  // Unidades de negocio → sedes → usuarios
  const backToUnit = (res: Response, unitId: number, msg: string, opts: { kind?: 'ok' | 'error'; sede?: number } = {}) => {
    setFlash(res, opts.kind ?? 'ok', msg);
    return `/unidades/${unitId}${opts.sede ? `#sede-${opts.sede}` : ''}`;
  };
  const backToSede = (res: Response, unitId: number, sedeId: number, msg: string, kind: 'ok' | 'error' = 'ok', abrir = '') => {
    setFlash(res, kind, msg);
    return `/unidades/${unitId}/sedes/${sedeId}${abrir ? `?abrir=${encodeURIComponent(abrir)}` : ''}`;
  };

  /** Usuario de acceso generado desde el nombre (único): ana.perez, ana.perez2… */
  const slugUsername = (nombres: string, apellidos: string): string => {
    const base = `${nombres}.${apellidos}`
      .normalize('NFD')
      .replace(/\p{Mn}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '')
      .slice(0, 46) || 'usuario';
    let candidate = base;
    let n = 2;
    while (findByLogin(candidate)) {
      candidate = `${base}${n}`;
      n += 1;
    }
    return candidate;
  };

  app.get('/unidades', ...usersGuard, (req: Request, res: Response) => {
    sendPage(req, res, 'Unidades de negocio', 'users', renderBusinessUnitsPage(q(req, 'abrir')), {
      subtitle: 'Unidades de negocio → sedes → usuarios. El número de WhatsApp es el acceso de cada persona.',
      activeHref: '/unidades',
      actions: '<button class="btn btn-primary btn-sm" type="button" data-ub-open="#ub-unit-new"><i class="ri-add-line me-1"></i>Nueva unidad</button>',
    });
  });

  app.post('/unidades', ...usersGuard, (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? '').trim();
    try {
      const id = createBusinessUnit({ name, code: String(b.code ?? '') });
      audit('user.unit_created', { unit_id: id, name, by: usersUserId(req) });
      setFlash(res, 'ok', `Unidad «${name}» creada.`);
      res.redirect(`/unidades/${id}`);
    } catch (err) {
      setFlash(res, 'error', (err as Error).message);
      res.redirect('/unidades?abrir=unidad');
    }
  });

  app.get('/unidades/:id', ...usersGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const unit = id ? getBusinessUnit(id) : undefined;
    if (!unit) {
      res
        .status(404)
        .send(
          pageHtml(req, res, 'Unidad no encontrada', 'users', emptyState('ri-community-line', 'Unidad no encontrada', 'La unidad de negocio no existe o se eliminó.'), {
            activeHref: '/unidades',
          }),
        );
      return;
    }
    sendPage(req, res, unit.name, 'users', renderBusinessUnitPage(unit, q(req, 'abrir')), {
      subtitle: `Sedes y usuarios de ${unit.name}.`,
      activeHref: '/unidades',
    });
  });

  app.get('/unidades/:id/sedes/:sedeId', ...usersGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const sedeId = positiveInt(req.params.sedeId);
    const unit = id ? getBusinessUnit(id) : undefined;
    const sede = sedeId ? getSede(sedeId) : undefined;
    if (!unit || !sede || sede.business_unit_id !== unit.id) {
      res
        .status(404)
        .send(
          pageHtml(req, res, 'Sede no encontrada', 'users', emptyState('ri-building-2-line', 'Sede no encontrada', 'La sede no existe o no pertenece a esa unidad de negocio.'), {
            activeHref: '/unidades',
          }),
        );
      return;
    }
    sendPage(req, res, sede.name, 'users', renderSedePage(unit, sede, q(req, 'abrir')), {
      subtitle: `Equipo de ${sede.name} · ${unit.name}.`,
      activeHref: '/unidades',
    });
  });

  app.post('/unidades/:id', ...usersGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (!id) throw new Error('Unidad de negocio no encontrada.');
      const name = String(b.name ?? '').trim();
      updateBusinessUnit(id, { name, code: String(b.code ?? '') });
      audit('user.unit_updated', { unit_id: id, name, by: usersUserId(req) });
      res.redirect(backToUnit(res, id, 'Unidad actualizada.'));
    } catch (err) {
      setFlash(res, 'error', (err as Error).message);
      res.redirect(id ? `/unidades/${id}` : '/unidades');
    }
  });

  app.post('/unidades/:id/delete', ...usersGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    try {
      if (!id) throw new Error('Unidad de negocio no encontrada.');
      const unit = getBusinessUnit(id);
      deleteBusinessUnit(id);
      audit('user.unit_deleted', { unit_id: id, name: unit?.name ?? '', by: usersUserId(req) });
      setFlash(res, 'ok', 'Unidad eliminada.');
      res.redirect('/unidades');
    } catch (err) {
      setFlash(res, 'error', (err as Error).message);
      res.redirect(id ? `/unidades/${id}` : '/unidades');
    }
  });

  app.post('/unidades/:id/sedes', ...usersGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const unit = id ? getBusinessUnit(id) : undefined;
    if (!unit) {
      setFlash(res, 'error', 'Unidad de negocio no encontrada.');
      res.redirect('/unidades');
      return;
    }
    const name = String(req.body?.name ?? '').trim();
    try {
      const sedeId = createSede(name, unit.id);
      audit('user.sede_created', { sede_id: sedeId, unit_id: unit.id, name, by: usersUserId(req) });
      res.redirect(backToUnit(res, unit.id, `Sede «${name}» creada.`));
    } catch (err) {
      setFlash(res, 'error', (err as Error).message);
      res.redirect(`/unidades/${unit.id}?abrir=sede`);
    }
  });

  app.post('/unidades/:id/sedes/:sedeId', ...usersGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const sedeId = positiveInt(req.params.sedeId);
    const unit = id ? getBusinessUnit(id) : undefined;
    const sede = sedeId ? getSede(sedeId) : undefined;
    if (!unit || !sede || sede.business_unit_id !== unit.id) {
      setFlash(res, 'error', 'La sede no pertenece a esa unidad de negocio.');
      res.redirect(unit ? `/unidades/${unit.id}` : '/unidades');
      return;
    }
    const name = String(req.body?.name ?? '').trim();
    const volver = String(req.body?.volver ?? '');
    try {
      renameSede(sede.id, name);
      audit('user.sede_renamed', { sede_id: sede.id, unit_id: unit.id, name, by: usersUserId(req) });
      if (volver === 'sede') {
        res.redirect(backToSede(res, unit.id, sede.id, `Sede actualizada: «${name}».`));
      } else {
        res.redirect(backToUnit(res, unit.id, `Sede actualizada: «${name}».`, { sede: sede.id }));
      }
    } catch (err) {
      setFlash(res, 'error', (err as Error).message);
      res.redirect(`/unidades/${unit.id}`);
    }
  });

  app.post('/unidades/:id/sedes/:sedeId/delete', ...usersGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const sedeId = positiveInt(req.params.sedeId);
    const unit = id ? getBusinessUnit(id) : undefined;
    const sede = sedeId ? getSede(sedeId) : undefined;
    if (!unit || !sede || sede.business_unit_id !== unit.id) {
      setFlash(res, 'error', 'La sede no pertenece a esa unidad de negocio.');
      res.redirect(unit ? `/unidades/${unit.id}` : '/unidades');
      return;
    }
    try {
      deleteSede(sede.id);
      audit('user.sede_deleted', { sede_id: sede.id, unit_id: unit.id, by: usersUserId(req) });
      res.redirect(backToUnit(res, unit.id, 'Sede eliminada.'));
    } catch (err) {
      setFlash(res, 'error', (err as Error).message);
      res.redirect(`/unidades/${unit.id}`);
    }
  });

  app.post('/unidades/:id/sedes/:sedeId/usuarios', ...usersGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const sedeId = positiveInt(req.params.sedeId);
    const unit = id ? getBusinessUnit(id) : undefined;
    const sede = sedeId ? getSede(sedeId) : undefined;
    if (!unit || !sede || sede.business_unit_id !== unit.id) {
      setFlash(res, 'error', 'La sede no pertenece a esa unidad de negocio.');
      res.redirect(unit ? `/unidades/${unit.id}` : '/unidades');
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const nombres = String(b.nombres ?? '').trim();
    const apellidos = String(b.apellidos ?? '').trim();
    const area = String(b.area ?? '').trim();
    const cargo = String(b.cargo ?? '').trim();
    const ci = String(b.ci ?? '').trim();
    try {
      const cargos = LOCAL_CARGOS_POR_AREA[area] ?? [];
      if (!cargos.includes(cargo)) throw new Error('Elegí un cargo del área seleccionada.');
      const user = createLocalUser({
        name: `${nombres} ${apellidos}`,
        ci,
        username: slugUsername(nombres, apellidos),
        email: String(b.email ?? ''),
        // Por defecto la contraseña es el CI (se puede cambiar en el formulario).
        password: String(b.password ?? '').trim() || ci,
        numero: String(b.numero ?? ''),
        sedeId: sede.id,
        roles: [cargo],
        autorizado: b.autorizado === '1',
      });
      audit('user.created', {
        user_id: user.id,
        name: user.name,
        ci: user.ci,
        sede_id: sede.id,
        unit_id: unit.id,
        roles: esamRoles(user),
        area,
        by: usersUserId(req),
      });
      res.redirect(backToSede(res, unit.id, sede.id, `Usuario «${user.name ?? user.username}» creado.`));
    } catch (err) {
      res.redirect(backToSede(res, unit.id, sede.id, (err as Error).message, 'error', 'usuario'));
    }
  });

  // Plantillas

  const tplGuard = [ctx.requireUser, ctx.requireSection('templates')];
  const back = (res: Response, msg: string, opts: { edit?: number; kind?: 'ok' | 'error' } = {}) => {
    setFlash(res, opts.kind ?? 'ok', msg);
    return templatesUrl({ id: opts.edit });
  };
  const readForm = (req: Request) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return {
      name: String(b.name ?? '').trim().slice(0, 80),
      category: String(b.category ?? '').trim().toLowerCase().slice(0, 40) || 'general',
      body: String(b.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 4000),
    };
  };

  app.get('/templates', ...tplGuard, (req: Request, res: Response) => {
    sendPage(req, res, 'Plantillas', 'templates', renderTemplates(req, 0), {
      subtitle: 'Textos reutilizables con variables y variantes para lotes e integraciones.',
      activeHref: '/templates',
    });
  });

  app.get('/templates/:id', ...tplGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    if (!id || !getTemplate(id)) {
      res
        .status(404)
        .send(
          pageHtml(req, res, 'Plantilla no encontrada', 'templates', emptyState('ri-file-search-line', 'Plantilla no encontrada', 'La plantilla no existe o se eliminó.'), {
            activeHref: '/templates',
          }),
        );
      return;
    }
    const cat = q(req, 'cat');
    sendPage(req, res, 'Plantillas', 'templates', renderTemplates(req, id), {
      subtitle: `Editando la plantilla #${id}.`,
      activeHref: cat ? templatesUrl({ cat }) : '/templates',
    });
  });

  app.post('/templates', ...tplGuard, (req: Request, res: Response) => {
    const f = readForm(req);
    if (!f.name || !f.body) {
      res.redirect(back(res, 'Completá el nombre y el texto.', { kind: 'error' }));
      return;
    }
    const id = createTemplate(f.name, f.category, f.body);
    audit('template.created', { template_id: id, name: f.name });
    res.redirect(back(res, `Plantilla «${f.name}» creada (#${id}).`));
  });

  app.post('/templates/:id', ...tplGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const current = id ? getTemplate(id) : undefined;
    const f = readForm(req);
    if (!current || !id) {
      res.redirect(back(res, 'Esa plantilla ya no existe.', { kind: 'error' }));
      return;
    }
    if (!f.name || !f.body) {
      res.redirect(back(res, 'Completá el nombre y el texto.', { kind: 'error', edit: id }));
      return;
    }
    // Cambiar de categoría a la única activa deja a la categoría anterior sin plantilla.
    if (f.category !== current.category && isLastActiveOfCategory(id)) {
      res.redirect(back(res, `Es la única plantilla activa de «${catLabel(current.category)}»: creá otra antes de cambiarle la categoría.`, { kind: 'error', edit: id }));
      return;
    }
    updateTemplate(id, f.name, f.category, f.body);
    audit('template.updated', { template_id: id, name: f.name });
    res.redirect(back(res, `Plantilla «${f.name}» guardada.`, { edit: id }));
  });

  app.post('/templates/:id/toggle', ...tplGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const t = id ? getTemplate(id) : undefined;
    if (!t) {
      res.redirect(back(res, 'Esa plantilla ya no existe.', { kind: 'error' }));
      return;
    }
    if (t.active && isLastActiveOfCategory(t.id)) {
      res.redirect(back(res, `«${t.name}» es la única activa de «${catLabel(t.category)}»: los envíos de esa categoría fallarían. Activá otra primero.`, { kind: 'error' }));
      return;
    }
    setTemplateActive(t.id, !t.active);
    audit('template.toggled', { template_id: t.id, name: t.name, active: !t.active });
    res.redirect(back(res, t.active ? `«${t.name}» desactivada.` : `«${t.name}» activada.`));
  });

  app.post('/templates/:id/duplicate', ...tplGuard, (req: Request, res: Response) => {
    const sourceId = positiveInt(req.params.id);
    const t = sourceId ? getTemplate(sourceId) : undefined;
    if (!t) {
      res.redirect(back(res, 'Esa plantilla ya no existe.', { kind: 'error' }));
      return;
    }
    // La copia nace inactiva: no compite con la original hasta revisarla.
    const id = createTemplate(`${t.name} (copia)`.slice(0, 80), t.category, t.body, false);
    audit('template.created', { template_id: id, name: `${t.name} (copia)`, from: t.id });
    res.redirect(back(res, 'Copia creada (inactiva): revisala y activala.', { edit: id }));
  });

  app.post('/templates/:id/delete', ...tplGuard, (req: Request, res: Response) => {
    const id = positiveInt(req.params.id);
    const t = id ? getTemplate(id) : undefined;
    if (!t) {
      res.redirect(back(res, 'Esa plantilla ya no existe.', { kind: 'error' }));
      return;
    }
    if (isLastActiveOfCategory(t.id)) {
      res.redirect(back(res, `«${t.name}» es la única activa de «${catLabel(t.category)}»: no se puede eliminar sin otra que la reemplace.`, { kind: 'error' }));
      return;
    }
    deleteTemplate(t.id);
    audit('template.deleted', { template_id: t.id, name: t.name });
    res.redirect(back(res, `«${t.name}» eliminada.`));
  });
}


