import { esc } from './layout.js';
import { emptyState, fmtDate, initials, statusBadge, table } from './views.js';
import { esamAreaLabel, esamRoles, type UserRow } from '../auth/users.js';
import type { UserActivity } from '../core/user-activity.js';
import {
  fmtMinutes,
  PERIOD_LABELS,
  type AttentionData,
  type DeliveryStats,
  type NotesFollowup,
  type PendingReply,
  type Period,
  type PeriodPreset,
  type ProtectionStats,
  type SessionActivity,
  type UserPerformance,
  type UserReportDetail,
} from '../core/followup.js';
import { TIPO_LABELS, type ActivityBatch, type ActivityData, type ActivityRow, type MonitoringData } from '../core/monitoring.js';
import type { GlobalNote } from '../core/contacts.js';
import type { HealthRow } from '../core/health.js';
import type { MassActivity } from '../core/mass-activity.js';
import type { SessionRow } from '../types.js';

/**
 * Vistas de /monitoring (seguimiento del día) y /reports (análisis del período).
 * Ambas se organizan en pestañas (`?tab=`); los gráficos los dibuja
 * `initFollowupCharts()` en public/app.js a partir del JSON de `#fu-data`
 * (solo existen los de la pestaña abierta).
 */

export interface SessionCard {
  row: SessionRow;
  health?: HealthRow;
  activity?: SessionActivity;
  decrypt: { count: number; fromPhone: number };
}

// ── Piezas comunes ────────────────────────────────────────────────────────────

const PRESETS: PeriodPreset[] = ['today', 'yesterday', '7d', '30d', 'month'];

function sessionLabel(s: SessionRow): string {
  return s.owner_name ?? s.phone ?? s.expected_phone ?? s.name;
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return 'recién';
  return `hace ${fmtMinutes(min)}`;
}

/** Aviso con HTML propio (todo texto dinámico se escapa al armarlo). */
function insight(kind: 'good' | 'warn' | 'info', html: string): string {
  const icons = { good: 'ri-checkbox-circle-line', warn: 'ri-alert-line', info: 'ri-lightbulb-line' };
  return `<div class="insight is-${kind}" role="${kind === 'warn' ? 'alert' : 'status'}">
    <span class="insight-ico"><i class="${icons[kind]}"></i></span>
    <p>${html}</p>
  </div>`;
}

function pct(part: number, total: number): string {
  return total ? `${Math.round((part / total) * 100)}%` : '—';
}

/** Parámetros que se conservan al cambiar de pestaña o de período. */
function keepQuery(params: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  return p.toString();
}

/** Barra de período: atajos + rango libre + número (si hay varios) + filtros extra. */
function periodBar(
  action: string,
  period: Period,
  sessions: SessionRow[],
  selected: string,
  tab: string,
  extra = '',
  keepExtra: Record<string, string> = {},
): string {
  const chips = PRESETS.map((p) => {
    const qs = keepQuery({ period: p, session: selected, tab, ...keepExtra });
    return `<a class="fu-chip${period.preset === p ? ' on' : ''}" href="${action}?${qs}" aria-current="${period.preset === p}">${esc(PERIOD_LABELS[p])}</a>`;
  }).join('');
  const hiddenKeep = Object.entries(keepExtra)
    .filter(([k, v]) => v && !['period', 'from', 'to', 'tab', 'session'].includes(k))
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}" />`)
    .join('');
  const sessionSelect =
    sessions.length > 1
      ? `<div class="toolbar-field" style="flex:1 1 190px"><label>Número</label>
          <select name="session" class="form-select form-select-sm">
            <option value="">Todos los números</option>
            ${sessions.map((s) => `<option value="${esc(s.id)}"${selected === s.id ? ' selected' : ''}>${esc(sessionLabel(s))}${s.phone ? ` · ${esc(s.phone)}` : ''}</option>`).join('')}
          </select></div>`
      : '';
  return `<form method="get" action="${action}" class="card toolbar fu-toolbar mb-0">
    <div class="card-body">
      <div class="fu-presets" role="group" aria-label="Período">${chips}</div>
      <div class="toolbar-row">
        <input type="hidden" name="period" value="custom" />
        <input type="hidden" name="tab" value="${esc(tab)}" />
        <div class="toolbar-field" style="flex:0 1 150px"><label>Desde</label><input type="date" name="from" value="${esc(period.from)}" class="form-control form-control-sm"></div>
        <div class="toolbar-field" style="flex:0 1 150px"><label>Hasta</label><input type="date" name="to" value="${esc(period.to)}" class="form-control form-control-sm"></div>
        ${sessionSelect}
        ${extra}
        ${hiddenKeep}
        <div class="toolbar-actions">
          <button class="btn btn-primary btn-sm" type="submit"><i class="ri-filter-3-line me-1"></i>Aplicar</button>
          <a class="btn btn-soft-secondary btn-sm" href="${action}?${keepQuery({ tab, ...keepExtra })}">Limpiar</a>
        </div>
      </div>
    </div>
  </form>`;
}

/** Pestañas que conservan período, número y filtros. */
function tabsNav(action: string, tabs: Array<{ id: string; label: string; icon: string; badge?: number }>, current: string, keep: Record<string, string>): string {
  return `<nav class="ab-tabs" aria-label="Secciones">${tabs
    .map((t) => {
      const on = t.id === current;
      return `<a class="ab-tab ${on ? 'on' : ''}" href="${action}?${keepQuery({ ...keep, tab: t.id })}" ${on ? 'aria-current="page"' : ''}>
        <i class="${t.icon}"></i>${esc(t.label)}${t.badge ? ` <span class="ab-tab-badge">${t.badge}</span>` : ''}</a>`;
    })
    .join('')}</nav>`;
}

/** Variación frente al período anterior. `better`: si subir es bueno o malo. */
function delta(cur: number | null, prev: number | null, better: 'up' | 'down', unit: '%' | 'pts' | 'min' = '%'): string {
  if (cur === null || prev === null) return '';
  if (unit === '%') {
    if (!prev) return cur ? '<span class="fu-delta fu-delta-new">nuevo</span>' : '';
    const change = Math.round(((cur - prev) / prev) * 100);
    if (!change) return '<span class="fu-delta">= anterior</span>';
    const good = (change > 0) === (better === 'up');
    return `<span class="fu-delta ${good ? 'is-good' : 'is-bad'}">${change > 0 ? '▲' : '▼'} ${Math.abs(change)}%</span>`;
  }
  const diff = Math.round(cur - prev);
  if (!diff) return '<span class="fu-delta">= anterior</span>';
  const good = (diff > 0) === (better === 'up');
  const suffix = unit === 'pts' ? ' pts' : ' min';
  return `<span class="fu-delta ${good ? 'is-good' : 'is-bad'}">${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)}${suffix}</span>`;
}

function kpi(icon: string, tone: string, label: string, value: string | number, sub: string, deltaHtml = ''): string {
  return `<div class="ab-kpi">
    <span class="ab-kpi-ic ab-${tone}"><i class="${icon}"></i></span>
    <span class="ab-kpi-body"><span class="ab-kpi-label">${esc(label)}</span>
      <span class="ab-kpi-value">${esc(value)}${deltaHtml ? ` ${deltaHtml}` : ''}</span>
      <span class="ab-kpi-sub">${sub}</span></span>
  </div>`;
}

/** Píldora del tiempo de espera: verde ≤ 15 min, ámbar ≤ 1 h, rojo más. */
function waitPill(minutes: number): string {
  const tone = minutes <= 15 ? 'ok' : minutes <= 60 ? 'warn' : 'late';
  const icon = tone === 'late' ? 'ri-alarm-warning-line' : 'ri-time-line';
  return `<span class="fu-wait fu-wait-${tone}"><i class="${icon}" aria-hidden="true"></i>${esc(fmtMinutes(minutes))}</span>`;
}

function noteItem(n: GlobalNote, tone: 'overdue' | 'today'): string {
  const name = n.contact_name || n.contact_phone || n.chat_id.split('@')[0];
  return `<li class="fu-note fu-note-${tone}">
    <a href="/conversations/${encodeURIComponent(n.chat_id)}" class="fu-note-contact">${esc(name)}</a>
    <span class="fu-note-text">${esc((n.note_text ?? '[nota de voz]').slice(0, 140))}</span>
    <span class="fu-note-meta">${tone === 'overdue' ? `Vencía ${esc(n.due_at ?? '')}` : 'Para hoy'} · ${esc(n.author_name ?? 'Equipo')}</span>
  </li>`;
}

function dataScript(payload: unknown): string {
  // `<` escapado: el JSON va dentro de un <script> y no debe poder cerrarlo.
  return `<script type="application/json" id="fu-data">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>`;
}

function chartCard(id: string, title: string, sub: string, cls = ''): string {
  return `<div class="card h-100 fu-chart ${cls}">
    <div class="card-header"><h5 class="card-title mb-0">${esc(title)}</h5><p class="fu-chart-sub mb-0">${esc(sub)}</p></div>
    <div class="card-body"><div id="${id}" class="fu-chart-box" role="img" aria-label="${esc(title)}"></div></div>
  </div>`;
}

function panel(title: string, body: string, extra = ''): string {
  return `<div class="card h-100 ab-card"><div class="card-header d-flex align-items-center gap-2"><h5 class="card-title mb-0 flex-grow-1">${esc(title)}</h5>${extra}</div><div class="card-body pt-0">${body}</div></div>`;
}

const APEX = '<script src="/assets/libs/apexcharts/apexcharts.min.js"></script>';

// ── Envíos por usuario (seguimiento y reportes) ──────────────────────────────

const INT = new Intl.NumberFormat('es-BO');

function num(value: number): string {
  return INT.format(value);
}

/** Día y hora local de un lote (`AAAA-MM-DD`, `HH:MM`). */
function batchWhen(b: ActivityBatch): string {
  const [y, m, d] = b.day.split('-').map(Number);
  const label = new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('es-BO', { day: '2-digit', month: 'short' });
  return `${label.replace('.', '')} · ${b.time}`;
}

function originLabel(b: ActivityBatch): string {
  return b.cronograma ? 'Cronogramas' : 'Lotes del panel';
}

/** Bloque compacto de cifras: ocupa poco alto y se lee de un vistazo. */
function actMetric(icon: string, label: string, value: string, sub: string, tone = 'info'): string {
  return `<div class="act-metric act-${tone}">
    <span class="act-metric-ico"><i class="${icon}" aria-hidden="true"></i></span>
    <span class="act-metric-body">
      <span class="act-metric-label">${esc(label)}</span>
      <b class="act-metric-value">${value}</b>
      <small>${sub}</small>
    </span>
  </div>`;
}

function actSummary(a: ActivityData): string {
  const t = a.totals;
  return `<div class="act-metrics">
    ${actMetric('ri-send-plane-2-line', 'Mensajes enviados', num(t.total), `${t.users} persona${t.users === 1 ? '' : 's'} · ${num(t.batches)} lote${t.batches === 1 ? '' : 's'}`, 'brand')}
    ${actMetric('ri-calendar-schedule-line', 'Cronogramas', num(t.cronogramas), `${num(t.cronBatches)} lote${t.cronBatches === 1 ? '' : 's'} del sistema`, 'ok')}
    ${actMetric('ri-stack-line', 'Lotes del panel', num(t.lotes), `${num(t.panelBatches)} lote${t.panelBatches === 1 ? '' : 's'} pedidos`, 'info')}
    ${actMetric('ri-inbox-unarchive-line', 'Bandeja', num(t.bandeja), 'mensajes escritos a mano', 'mute')}
    ${actMetric('ri-scales-3-line', 'Mensajes por lote', t.batches ? num(t.avgPerBatch) : '—', t.batches ? `lote más grande: ${num(t.maxBatch)}` : 'sin lotes en el período', 'warn')}
  </div>`;
}

function actLots(row: ActivityRow): string {
  if (!row.recent.length) return '<p class="act-empty-line">Sin lotes en el período.</p>';
  return `<ul class="act-lots">${row.recent
    .map(
      (b) => `<li class="act-lot">
        <span class="act-lot-time">${esc(batchWhen(b))}</span>
        <span class="act-lot-main">
          <a href="/batches/${b.id}">${esc(b.name)}</a>
          <small>${esc(originLabel(b))}${b.programa ? ` · ${esc(b.programa)}` : b.tipo ? ` · ${esc(TIPO_LABELS[b.tipo] ?? b.tipo)}` : ''}</small>
        </span>
        <span class="act-lot-num"><b>${num(b.total)}</b><small>mensajes</small></span>
        <span class="act-lot-res">
          <span class="is-ok">${num(b.sent)} enviados</span>
          ${b.failed ? `<span class="is-bad">${num(b.failed)} fallidos</span>` : ''}
        </span>
      </li>`,
    )
    .join('')}</ul>`;
}

function actDays(row: ActivityRow): string {
  if (!row.byDay.length) return '<p class="act-empty-line">Sin actividad diaria en el período.</p>';
  const days = row.byDay.slice(-10);
  const max = Math.max(1, ...days.map((d) => d.cronogramas + d.lotes + d.bandeja));
  return `<ul class="act-days">${days
    .map((d) => {
      const total = d.cronogramas + d.lotes + d.bandeja;
      const pctOf = (v: number) => Math.round((v / max) * 100);
      const [y, m, dd] = d.day.split('-').map(Number);
      const label = new Date(y, (m || 1) - 1, dd || 1).toLocaleDateString('es-BO', { day: '2-digit', month: '2-digit' });
      return `<li>
        <span class="act-day-label">${esc(label)}</span>
        <span class="act-day-bar" title="${esc(`${d.cronogramas} cronogramas · ${d.lotes} lotes · ${d.bandeja} bandeja`)}">
          ${d.cronogramas ? `<i class="is-cron" style="width:${pctOf(d.cronogramas)}%"></i>` : ''}
          ${d.lotes ? `<i class="is-lote" style="width:${pctOf(d.lotes)}%"></i>` : ''}
          ${d.bandeja ? `<i class="is-band" style="width:${pctOf(d.bandeja)}%"></i>` : ''}
        </span>
        <b>${num(total)}</b>
      </li>`;
    })
    .join('')}</ul>
    <p class="act-legend"><span class="is-cron"></span>Cronogramas <span class="is-lote"></span>Lotes <span class="is-band"></span>Bandeja</p>`;
}

/**
 * Tabla de envíos por usuario con desglose real: cronogramas, lotes del panel,
 * bandeja, participación, promedio por lote y detalle expandible por persona.
 */
function activitySection(a: ActivityData, opts: { detailHref?: (row: ActivityRow) => string | null; id?: string } = {}): string {
  if (!a.rows.length) {
    return `<div class="card ab-card act-card" id="${esc(opts.id ?? 'activity-card')}">
      <div class="card-header act-head">
        <div class="act-head-title">
          <h5 class="card-title mb-0">Envíos por usuario</h5>
          <p class="fu-chart-sub mb-0">Cronogramas, lotes pedidos desde el panel y mensajes de la bandeja.</p>
        </div>
      </div>
      <div class="card-body pt-0">
        ${emptyState('ri-user-search-line', 'Sin envíos en el período', 'No hay mensajes de cronogramas, lotes ni bandeja con los filtros actuales. Probá ampliar el período o quitar filtros.')}
      </div>
    </div>`;
  }
  const total = Math.max(1, a.totals.total);
  const stamp = new Date().toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' });
  const rows = a.rows
    .map((row, i) => {
      const share = Math.round((row.total / total) * 100);
      const href = opts.detailHref?.(row) ?? null;
      const detailId = `act-d-${opts.id ?? 'm'}-${i}`;
      return `<tr class="act-row" data-name="${esc(row.name.toLowerCase())}" data-total="${row.total}" data-cronogramas="${row.cronogramas}" data-lotes="${row.lotes}" data-bandeja="${row.bandeja}" data-batches="${row.batches}" data-area="${esc(row.area ?? row.apartado)}">
        <td class="act-person">
          <span class="act-avatar av-${(row.userId ?? i) % 8}">${esc(initials(row.name))}</span>
          <span class="act-person-main">
            <span class="act-person-name">${esc(row.name)}</span>
            <span class="act-person-sub">${esc([row.area || row.apartado, row.phone].filter(Boolean).join(' · ') || 'Sin apartado')}</span>
          </span>
        </td>
        <td class="act-num">
          <b>${num(row.cronogramas)}</b>
          <small>${num(row.cronBatches)} lote${row.cronBatches === 1 ? '' : 's'}</small>
        </td>
        <td class="act-num">
          <b>${num(row.lotes)}</b>
          <small>${num(row.panelBatches)} lote${row.panelBatches === 1 ? '' : 's'}</small>
        </td>
        <td class="act-num">
          <b>${num(row.bandeja)}</b>
          <small>directos</small>
        </td>
        <td class="act-num act-total">
          <b>${num(row.total)}</b>
          <span class="act-share" title="${share}% de los envíos"><span style="width:${share}%"></span></span>
          <small>${share}%</small>
        </td>
        <td class="act-num">
          <b>${num(row.avgPerBatch)}</b>
          <small>máx. ${num(row.maxBatch)}</small>
        </td>
        <td class="act-when">
          <span title="${esc(row.lastAt ?? '')}">${esc(relTime(row.lastAt))}</span>
          <small>${row.daysActive} día${row.daysActive === 1 ? '' : 's'} activo${row.daysActive === 1 ? '' : 's'}</small>
        </td>
        <td class="act-open">
          <button type="button" class="btn btn-light btn-sm act-toggle" aria-expanded="false" aria-controls="${detailId}" title="Ver lotes y actividad diaria">
            <i class="ri-arrow-down-s-line" aria-hidden="true"></i><span class="visually-hidden">Detalle de ${esc(row.name)}</span>
          </button>
        </td>
      </tr>
      <tr class="act-detail" id="${detailId}" hidden>
        <td colspan="8">
          <div class="act-detail-grid">
            <div class="act-detail-lots">
              <h6><i class="ri-stack-line" aria-hidden="true"></i>Lotes recientes</h6>
              ${actLots(row)}
            </div>
            <div class="act-detail-days">
              <h6><i class="ri-bar-chart-2-line" aria-hidden="true"></i>Actividad por día</h6>
              ${actDays(row)}
              ${href ? `<a class="btn btn-soft-primary btn-sm mt-2" href="${esc(href)}"><i class="ri-user-line me-1"></i>Ficha completa de ${esc(row.name)}</a>` : ''}
            </div>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  return `<div class="card ab-card act-card" id="${esc(opts.id ?? 'activity-card')}">
    <div class="card-header act-head">
      <div class="act-head-title">
        <h5 class="card-title mb-0">Envíos por usuario</h5>
        <p class="fu-chart-sub mb-0">Cronogramas, lotes pedidos desde el panel y mensajes de la bandeja. Abrí una fila para ver sus lotes.</p>
      </div>
      <div class="act-tools">
        <button type="button" class="btn btn-soft-secondary btn-sm" id="act-refresh"><i class="ri-refresh-line me-1"></i>Actualizar</button>
        <label class="act-search">
          <i class="ri-search-line" aria-hidden="true"></i>
          <input type="search" id="act-search" placeholder="Buscar persona…" autocomplete="off" aria-label="Buscar persona" />
        </label>
        <select class="form-select form-select-sm" id="act-sort" aria-label="Ordenar por">
          <option value="total">Más mensajes</option>
          <option value="cronogramas">Más cronogramas</option>
          <option value="lotes">Más lotes del panel</option>
          <option value="batches">Más lotes</option>
          <option value="bandeja">Más bandeja</option>
          <option value="name">Nombre</option>
        </select>
        <span class="fu-updated">Actualizado ${esc(stamp)}</span>
      </div>
    </div>
    <div class="card-body pt-0">
      ${actSummary(a)}
      <div class="act-table-wrap table-responsive">
        <table class="table table-hover align-middle mb-0 ab-table act-table">
          <thead class="table-light">
            <tr>
              <th>Usuario</th>
              <th class="text-end">Cronogramas <small>mensajes · lotes</small></th>
              <th class="text-end">Lotes del panel <small>mensajes · lotes</small></th>
              <th class="text-end">Bandeja <small>directos</small></th>
              <th class="text-end">Total <small>participación</small></th>
              <th class="text-end">Msj. por lote <small>promedio · máx.</small></th>
              <th class="text-end">Último envío</th>
              <th><span class="visually-hidden">Detalle</span></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr class="table-light act-total-row">
              <th>Total · ${a.totals.users} persona${a.totals.users === 1 ? '' : 's'}</th>
              <th class="text-end">${num(a.totals.cronogramas)}<small>${num(a.totals.cronBatches)} lotes</small></th>
              <th class="text-end">${num(a.totals.lotes)}<small>${num(a.totals.panelBatches)} lotes</small></th>
              <th class="text-end">${num(a.totals.bandeja)}<small>directos</small></th>
              <th class="text-end">${num(a.totals.total)}<small>100%</small></th>
              <th class="text-end">${num(a.totals.avgPerBatch)}<small>máx. ${num(a.totals.maxBatch)}</small></th>
              <th></th>
              <th></th>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="act-empty-line" id="act-empty" hidden><i class="ri-filter-off-line me-1"></i>Ninguna persona coincide con la búsqueda.</p>
      <p class="act-hint"><i class="ri-information-line" aria-hidden="true"></i> «Cronogramas» son los envíos de lotes de la integración; «Lotes del panel» los pedidos desde esta plataforma; «Bandeja» los mensajes escritos a mano en una conversación.</p>
    </div>
  </div>`;
}

// ── /monitoring ───────────────────────────────────────────────────────────────

export type MonitoringTab = 'pendientes' | 'actividad' | 'numeros';

export interface MonitoringView {
  tab: MonitoringTab;
  period: Period;
  sessions: SessionCard[];
  selectedSession: string;
  attention: AttentionData;
  pending: { total: number; rows: PendingReply[] };
  notes: NotesFollowup;
  activity: ActivityData;
}

export function renderMonitoring(v: MonitoringView): string {
  const a = v.attention;
  const keep = { period: v.period.preset, from: v.period.preset === 'custom' ? v.period.from : '', to: v.period.preset === 'custom' ? v.period.to : '', session: v.selectedSession };

  // Alertas: números desconectados o "sordos" (conectados sin recibir nada).
  const alerts: string[] = [];
  // Solo cuentan los números que estuvieron vinculados (tienen teléfono) y se
  // cayeron; los que nunca se vincularon (esperando QR) no son una alerta.
  const down = v.sessions.filter((s) => s.row.status !== 'ready' && s.row.phone);
  if (down.length) {
    const names = [...new Set(down.map((s) => `<b>${esc(sessionLabel(s.row))}</b>`))].join(', ');
    alerts.push(
      insight('warn', `${down.length === 1 ? 'El número' : 'Los números'} ${names} ${down.length === 1 ? 'no está conectado' : 'no están conectados'}: no se reciben ni envían mensajes. Revisá <a href="/settings">Conexión</a>.`),
    );
  }
  for (const s of v.sessions) {
    const label = esc(sessionLabel(s.row));
    if (s.row.status !== 'ready') continue;
    const last = s.activity?.lastInboundAt ? Date.parse(s.activity.lastInboundAt) : 0;
    const hour = new Date().getHours();
    if (last && Date.now() - last > 3 * 3_600_000 && hour >= 9 && hour <= 20) {
      alerts.push(
        insight('warn', `<b>${label}</b> no recibe mensajes desde ${esc(relTime(s.activity?.lastInboundAt))}. Si debería tener movimiento, usá <b>Reconectar</b> en <a href="/settings">Conexión</a>.`),
      );
    }
    if (s.decrypt.fromPhone >= 5) {
      alerts.push(insight('warn', `<b>${label}</b>: ${s.decrypt.fromPhone} mensajes del propio teléfono sin descifrar en 24 h. Si los enviados desde el celular no aparecen, hay que volver a vincular.`));
    }
  }

  const kpis = `<div class="ab-kpis ab-kpis-6">
    ${kpi('ri-chat-history-line', v.pending.total ? 'danger' : 'ok', 'Esperando respuesta', v.pending.total, 'chats sin responder · 7 días')}
    ${kpi('ri-timer-flash-line', 'info', '1.ª respuesta', fmtMinutes(a.medianMin), `mediana · ${a.answered} de ${a.episodes} turnos`)}
    ${kpi('ri-speed-up-line', a.episodes && a.within60 / a.episodes < 0.7 ? 'warn' : 'ok', 'En ≤ 1 hora', pct(a.within60, a.episodes), `${a.within15} en ≤ 15 min`)}
    ${kpi('ri-inbox-archive-line', 'info', 'Recibidos', a.received, `de ${a.receivedChats} contactos`)}
    ${kpi('ri-customer-service-2-line', 'info', 'Chats atendidos', a.attendedChats, `${a.sent.panel} panel · ${a.sent.phone} teléfono`)}
    ${kpi('ri-alarm-warning-line', v.notes.stats.overdue ? 'danger' : 'ok', 'Tareas vencidas', v.notes.stats.overdue, `${v.notes.stats.today} para hoy`)}
  </div>`;

  const multi = v.sessions.length > 1;
  let content = '';
  if (v.tab === 'pendientes') {
    const pendingTable = v.pending.rows.length
      ? table(
          ['Contacto', 'Esperando', 'Último mensaje', ''],
          v.pending.rows.map((r) => [
            `<a class="fu-contact" href="/conversations/${encodeURIComponent(r.chatId)}">${esc(r.name || r.phone || r.chatId)}</a>
             <div class="fu-sub">${r.name && r.phone ? `<span class="ff-monospace">${esc(r.phone)}</span>` : ''}${multi ? `${r.name && r.phone ? ' · ' : ''}${esc(r.sessionLabel)}` : ''}</div>
             ${r.openNotes ? `<span class="ab-pill ab-info fu-mini" title="Notas y tareas pendientes de la persona"><i class="ri-sticky-note-line"></i>${r.openNotes} nota${r.openNotes === 1 ? '' : 's'}</span>` : ''}`,
            `${waitPill(r.waitingMinutes)}${r.unread ? ` <span class="ab-pill ab-danger fu-mini" title="Mensajes sin leer">${r.unread} sin leer</span>` : ''}
             <div class="fu-sub">desde ${esc(new Date(r.waitingSince).toLocaleString('es-BO', { dateStyle: 'short', timeStyle: 'short' }))}</div>`,
            `<span class="fu-last" title="${esc(r.lastText ?? '')}">${esc((r.lastText ?? '—').slice(0, 90))}</span>`,
            `<a class="btn btn-sm btn-soft-primary text-nowrap" href="/conversations/${encodeURIComponent(r.chatId)}">Responder</a>`,
          ]),
        )
      : emptyState('ri-checkbox-circle-line', 'Nadie está esperando respuesta', 'Todos los chats con actividad en los últimos 7 días tienen respuesta.');
    const notesBody =
      v.notes.overdue.length || v.notes.today.length
        ? `<ul class="fu-notes">${v.notes.overdue.map((n) => noteItem(n, 'overdue')).join('')}${v.notes.today.map((n) => noteItem(n, 'today')).join('')}</ul>`
        : emptyState('ri-calendar-check-line', 'Sin tareas para hoy', 'No hay notas vencidas ni con fecha de hoy.');
    content = `<div class="fu-split">
      <div class="fu-pending">${panel(
        'Esperando respuesta',
        `${pendingTable}${v.pending.total > v.pending.rows.length ? `<p class="fu-sub mt-2 mb-0">Se muestran los ${v.pending.rows.length} que más esperan.</p>` : ''}`,
        `<span class="ab-pill ${v.pending.total ? 'ab-danger' : 'ab-ok'}">${v.pending.total}</span>`,
      )}</div>
      <div>${panel('Tareas de hoy y vencidas', notesBody, '<a class="btn btn-soft-primary btn-sm" href="/notes">Ver todas</a>')}</div>
    </div>`;
  } else if (v.tab === 'actividad') {
    const singleDay = v.period.days === 1;
    const respondersTable = a.responders.length
      ? table(
          ['Quién respondió', 'Respuestas', 'Chats', 'Tiempo prom.'],
          a.responders.map((r) => [
            /^\d+$/.test(r.key)
              ? `<a class="fu-contact" href="/reports/users/${r.key}?${keepQuery({ ...keep, tab: 'equipo' })}" title="Ver ficha y envíos de esta persona">${esc(r.name)}</a>`
              : `<i class="ri-smartphone-line me-1 text-muted"></i>${esc(r.name)}`,
            `<b>${r.responses}</b>`,
            String(r.chats),
            esc(fmtMinutes(r.avgFirstResponseMin)),
          ]),
        )
      : emptyState('ri-chat-off-line', 'Sin respuestas en el período', 'Todavía no se respondió ningún mensaje.');
    const detailHref = (row: ActivityRow) =>
      row.userId == null
        ? null
        : `/reports/users/${row.userId}?${keepQuery({
            period: v.period.preset,
            from: v.period.preset === 'custom' ? v.period.from : '',
            to: v.period.preset === 'custom' ? v.period.to : '',
            session: v.selectedSession,
            tab: 'equipo',
          })}`;
    content = `${activitySection(v.activity, { detailHref })}
    <div class="fu-split">
      <div>${chartCard('fuHours', singleDay ? 'Mensajes por hora' : 'Mensajes por hora del día', singleDay ? 'Recibidos y enviados en cada hora del día seleccionado' : 'Suma del período por hora: muestra las horas de más demanda')}</div>
      <div>${panel('Respuestas por persona', respondersTable)}</div>
    </div>
    ${dataScript({ kind: 'monitoring', hours: a.byHour })}${APEX}`;
  } else {
    content = v.sessions.length
      ? `<div class="fu-lines">${v.sessions
          .map((s) => {
            const h = s.health?.health ?? 'green';
            const tone = h === 'red' ? 'danger' : h === 'yellow' ? 'warn' : 'ok';
            return `<article class="fu-line">
              <header><span class="ab-session-ic"><i class="ri-whatsapp-line"></i></span>
                <div class="min-w-0 flex-grow-1"><div class="ab-session-name">${esc(sessionLabel(s.row))}</div>
                  <div class="ab-session-phone">${esc(s.row.phone ?? s.row.expected_phone ?? '—')} · ${esc(s.row.name)}</div></div>
                ${statusBadge(s.row.status)}</header>
              <dl class="ab-figures">
                <div><dt>Salud</dt><dd><span class="ab-pill ab-${tone}"><span class="ab-dot"></span>${h === 'red' ? 'En riesgo' : h === 'yellow' ? 'Atención' : 'Saludable'}</span></dd></div>
                <div><dt>Último entrante</dt><dd class="fu-small">${esc(relTime(s.activity?.lastInboundAt))}</dd></div>
                <div><dt>Último saliente</dt><dd class="fu-small">${esc(relTime(s.activity?.lastOutboundAt))}</dd></div>
                <div><dt>Recibidos hoy</dt><dd>${s.activity?.receivedToday ?? 0}</dd></div>
                <div><dt>Enviados hoy</dt><dd>${s.activity?.sentToday ?? 0}</dd></div>
                <div><dt>Sin descifrar 24 h</dt><dd class="${s.decrypt.count ? 'ab-t-warn' : ''}">${s.decrypt.count}</dd></div>
              </dl>
              <footer><a class="btn btn-sm btn-light" href="/anti-ban?tab=monitoreo"><i class="ri-shield-star-line me-1"></i>Anti-baneo</a>
                <a class="btn btn-sm btn-light" href="/settings"><i class="ri-link me-1"></i>Conexión</a></footer>
            </article>`;
          })
          .join('')}</div>`
      : emptyState('ri-smartphone-line', 'Sin números', 'Vinculá un número en Conexión.');
  }

  return `<div class="ab-page fu-page" data-autorefresh="60">
    ${periodBar('/monitoring', v.period, v.sessions.map((s) => s.row), v.selectedSession, v.tab)}
    ${alerts.join('')}
    ${kpis}
    <div class="fu-tabs-row">
      ${tabsNav('/monitoring', [
        { id: 'pendientes', label: 'Pendientes', icon: 'ri-chat-history-line', badge: v.pending.total },
        { id: 'actividad', label: 'Actividad', icon: 'ri-bar-chart-2-line' },
        { id: 'numeros', label: 'Números', icon: 'ri-smartphone-line', badge: down.length },
      ], v.tab, keep)}
      <span class="fu-updated" id="fu-updated" title="La página se actualiza sola cada minuto"></span>
    </div>
    ${content}
  </div>`;
}

// ── /reports ──────────────────────────────────────────────────────────────────

export type ReportsTab = 'atencion' | 'equipo' | 'seguimiento' | 'envios' | 'masivos';

export interface ReportsView {
  tab: ReportsTab;
  period: Period;
  previous: Period;
  sessions: SessionRow[];
  selectedSession: string;
  attention: AttentionData;
  prevAttention: AttentionData;
  delivery: DeliveryStats;
  prevDelivery: DeliveryStats;
  notes: NotesFollowup;
  users: UserPerformance[];
  team: Map<number, UserRow>;
  lastUse: Map<number, UserActivity>;
  sends: MonitoringData;
  /** Envíos por usuario (cronogramas, lotes y bandeja) para la pestaña Equipo. */
  activity: ActivityData;
  protection: ProtectionStats;
  filters: { programa: string; account: string; area: string; tipo: string };
  exportHref: string;
  /** Pestaña «Envíos masivos»: solo se calcula cuando está abierta. */
  mass?: MassActivity;
  massExportHref?: string;
}

export function renderReports(v: ReportsView): string {
  const a = v.attention;
  const pa = v.prevAttention;
  const d = v.delivery;
  const s = v.sends;
  const unanswered = Math.max(0, a.episodes - a.answered);
  const prevUnanswered = Math.max(0, pa.episodes - pa.answered);
  const share = (x: AttentionData) => (x.episodes ? Math.round((x.within60 / x.episodes) * 100) : null);
  const option = (value: string, label: string, selected: boolean) =>
    `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const extra = `
    <div class="toolbar-field" style="flex:1 1 180px"><label>Programa</label><select name="programa" class="form-select form-select-sm">
      ${option('', 'Todos', !v.filters.programa)}${s.options.programas.map((p) => option(p, p, v.filters.programa === p)).join('')}</select></div>
    <div class="toolbar-field" style="flex:1 1 160px"><label>Usuario (envíos)</label><select name="account" class="form-select form-select-sm">
      ${option('', 'Todos', !v.filters.account)}${s.options.users.map((u) => option(u.id, u.name, v.filters.account === u.id)).join('')}</select></div>
    <div class="toolbar-field" style="flex:1 1 140px"><label>Área</label><select name="area" class="form-select form-select-sm">
      ${option('', 'Todas', !v.filters.area)}${s.options.areas.map((x) => option(x, x, v.filters.area === x)).join('')}</select></div>
    <div class="toolbar-field" style="flex:1 1 150px"><label>Tipo</label><select name="tipo" class="form-select form-select-sm">
      ${option('', 'Todos', !v.filters.tipo)}${s.options.tipos.map((t) => option(t.id, t.label, v.filters.tipo === t.id)).join('')}</select></div>`;
  const keep = {
    period: v.period.preset,
    from: v.period.preset === 'custom' ? v.period.from : '',
    to: v.period.preset === 'custom' ? v.period.to : '',
    session: v.selectedSession,
    ...v.filters,
  };

  // Lectura rápida del período (siempre visible).
  const notes: string[] = [];
  if (a.episodes) {
    const sh = share(a)!;
    notes.push(
      sh >= 80
        ? insight('good', `El <b>${sh}%</b> de los contactos recibió respuesta en menos de 1 hora (mediana ${esc(fmtMinutes(a.medianMin))}).`)
        : insight('warn', `Solo el <b>${sh}%</b> de los contactos recibió respuesta en menos de 1 hora y <b>${unanswered}</b> turnos quedaron sin responder. Revisá los pendientes en <a href="/monitoring">Seguimiento</a>.`),
    );
  }
  if (d.rate != null && d.sent >= 20) {
    notes.push(
      d.rate >= 90
        ? insight('good', `Entregabilidad del <b>${d.rate}%</b> sobre ${d.sent} mensajes enviados.`)
        : insight('warn', `Entregabilidad del <b>${d.rate}%</b>: por debajo del objetivo (90 %). Revisá la lista y la salud del número en <a href="/anti-ban">Anti-Baneo</a>.`),
    );
  }

  const compare = `<p class="fu-compare"><i class="ri-arrow-left-right-line"></i>Comparado con el período anterior: ${esc(v.previous.label)}</p>`;
  let content = '';

  if (v.tab === 'atencion') {
    content = `${compare}<div class="ab-kpis ab-kpis-6">
      ${kpi('ri-inbox-archive-line', 'info', 'Recibidos', a.received, `de ${a.receivedChats} contactos`, delta(a.received, pa.received, 'up'))}
      ${kpi('ri-customer-service-2-line', 'info', 'Chats atendidos', a.attendedChats, `${a.sent.panel + a.sent.phone} respuestas manuales`, delta(a.attendedChats, pa.attendedChats, 'up'))}
      ${kpi('ri-user-add-line', 'ok', 'Contactos nuevos', a.newChats, 'primer mensaje en el período', delta(a.newChats, pa.newChats, 'up'))}
      ${kpi('ri-timer-flash-line', 'info', '1.ª respuesta', fmtMinutes(a.medianMin), `mediana · promedio ${fmtMinutes(a.avgMin)}`, delta(a.medianMin, pa.medianMin, 'down', 'min'))}
      ${kpi('ri-speed-up-line', share(a) !== null && share(a)! < 70 ? 'warn' : 'ok', 'En ≤ 1 hora', pct(a.within60, a.episodes), `${a.within15} en ≤ 15 min`, delta(share(a), share(pa), 'up', 'pts'))}
      ${kpi('ri-chat-off-line', unanswered ? 'danger' : 'ok', 'Sin respuesta', unanswered, `de ${a.episodes} turnos`, delta(unanswered, prevUnanswered, 'down'))}
    </div>
    <div class="fu-split fu-split-even">
      <div>${chartCard('fuDaily', 'Recibidos y enviados por día', 'Volumen diario de mensajes')}</div>
      <div>${chartCard('fuResponse', 'Mediana de primera respuesta por día', 'Minutos hasta la primera respuesta manual')}</div>
    </div>
    ${dataScript({ kind: 'reports', daily: a.byDay, tipos: [], programas: [] })}${APEX}`;
  } else if (v.tab === 'equipo') {
    const detailHref = (id: number) => `/reports/users/${id}?${keepQuery({ ...keep, tab: 'equipo' })}`;
    const activityByUid = new Map(v.activity.rows.map((r) => [r.uid, r]));
    const activityByUser = new Map<number, ActivityRow>();
    const usedUids = new Set<string>();
    for (const member of v.team.values()) {
      for (const key of [String(member.id), member.source_uid ? String(member.source_uid) : null]) {
        if (!key) continue;
        const row = activityByUid.get(key);
        if (row) {
          activityByUser.set(member.id, row);
          usedUids.add(row.uid);
          break;
        }
      }
    }
    const zero: ActivityRow = {
      uid: '', userId: null, name: '', phone: null, area: null, apartado: '',
      cronogramas: 0, lotes: 0, bandeja: 0, panel: 0, total: 0, batches: 0, cronBatches: 0, panelBatches: 0,
      batchMessages: 0, avgPerBatch: 0, maxBatch: 0, daysActive: 0, lastAt: null, byDay: [], recent: [],
    };
    const sendCells = (s: ActivityRow, share: number): string[] => [
      `<span class="team-num"><b>${num(s.cronogramas)}</b><small>${num(s.cronBatches)} lote${s.cronBatches === 1 ? '' : 's'}</small></span>`,
      `<span class="team-num"><b>${num(s.lotes)}</b><small>${num(s.panelBatches)} lote${s.panelBatches === 1 ? '' : 's'}</small></span>`,
      `<span class="team-num"><b>${num(s.bandeja)}</b><small>directos</small></span>`,
      `<span class="team-num team-total"><b>${num(s.total)}</b><span class="act-share"><span style="width:${share}%"></span></span><small>${share}%</small></span>`,
      `<span class="team-num"><b>${num(s.batches)}</b><small>${s.daysActive} día${s.daysActive === 1 ? '' : 's'}</small></span>`,
      `<span class="team-num"><b>${num(s.avgPerBatch)}</b><small>máx. ${num(s.maxBatch)}</small></span>`,
    ];
    const attrs = (name: string, s: ActivityRow, responses: number) =>
      `data-name="${esc(name.toLowerCase())}" data-area="${esc(s.area ?? s.apartado)}" data-total="${s.total}" data-cronogramas="${s.cronogramas}" data-lotes="${s.lotes}" data-bandeja="${s.bandeja}" data-batches="${s.batches}" data-responses="${responses}"`;
    const shareOf = (s: ActivityRow) => (v.activity.totals.total ? Math.round((s.total / v.activity.totals.total) * 100) : 0);

    const personRow = (u: UserPerformance, member?: UserRow) => {
      const use = v.lastUse.get(u.id);
      const area = member ? esamAreaLabel(member) : null;
      const s = activityByUser.get(u.id) ?? zero;
      const sub = [
        area,
        use ? `Última actividad ${relTime(use.at)}` : 'Sin actividad registrada',
      ].filter(Boolean).join(' · ');
      return {
        html: `<tr ${attrs(u.name, s, u.responses)}>
          <td><div class="team-person">
            <span class="avatar-xs rounded-circle av-${u.id % 8}">${esc(initials(u.name))}</span>
            <div class="min-w-0"><a class="team-link" href="${esc(detailHref(u.id))}">${esc(u.name)}</a>
              <div class="adm-sub">${esc(sub)}</div></div>
          </div></td>
          ${sendCells(s, shareOf(s)).map((c) => `<td class="text-end">${c}</td>`).join('')}
          <td class="text-end"><span class="team-num"><b>${num(u.responses)}</b><small>${num(u.chats)} chat${u.chats === 1 ? '' : 's'}</small></span></td>
          <td class="text-end"><span class="team-num"><b>${esc(fmtMinutes(u.avgFirstResponseMin))}</b></span></td>
          <td class="text-end"><span class="team-num"><b>${num(u.notesCreated)}</b><small>${num(u.notesResolved)} resueltas</small></span></td>
          <td class="text-end">${u.notesOverdue ? `<span class="ab-pill ab-danger"><i class="ri-alarm-warning-line"></i>${num(u.notesOverdue)}</span>` : '<span class="team-muted">0</span>'}</td>
          <td class="text-end"><a class="btn btn-soft-secondary btn-sm team-open" href="${esc(detailHref(u.id))}" title="Ver ficha y seguimiento">Ficha <i class="ri-arrow-right-line"></i></a></td>
        </tr>`,
        total: s.total,
        responses: u.responses,
      };
    };

    const activeIds = new Set(v.users.map((u) => u.id));
    const inactive = [...v.team.values()]
      .filter((m) => !activeIds.has(m.id))
      .map((member) =>
        personRow(
          {
            id: member.id,
            name: member.name ?? member.username ?? `Usuario ${member.id}`,
            responses: 0,
            chats: 0,
            avgFirstResponseMin: null,
            notesCreated: 0,
            notesResolved: 0,
            notesOverdue: 0,
          },
          member,
        ),
      );
    const rows = [...v.users.map((u) => personRow(u, v.team.get(u.id))), ...inactive];

    // Personas que enviaron pero no tienen cuenta del panel (p. ej. cuenta histórica).
    for (const s of v.activity.rows.filter((r) => !usedUids.has(r.uid))) {
      rows.push({
        html: `<tr ${attrs(s.name, s, 0)}>
          <td><div class="team-person">
            <span class="team-phone"><i class="ri-user-shared-line"></i></span>
            <div class="min-w-0"><span class="team-link is-muted">${esc(s.name)}</span>
              <div class="adm-sub">${esc([s.area, s.phone, 'Sin cuenta del panel'].filter(Boolean).join(' · '))}</div></div>
          </div></td>
          ${sendCells(s, shareOf(s)).map((c) => `<td class="text-end">${c}</td>`).join('')}
          <td class="text-end"><span class="team-muted">—</span></td>
          <td class="text-end"><span class="team-muted">—</span></td>
          <td class="text-end"><span class="team-muted">—</span></td>
          <td class="text-end"><span class="team-muted">—</span></td>
          <td class="text-end"><span class="adm-sub">Sin ficha</span></td>
        </tr>`,
        total: s.total,
        responses: 0,
      });
    }

    // Respuestas hechas desde el teléfono, sin usuario del panel.
    for (const r of a.responders.filter((x) => x.key === 'phone')) {
      rows.push({
        html: `<tr ${attrs(r.name, zero, r.responses)}>
          <td><div class="team-person"><span class="team-phone"><i class="ri-smartphone-line"></i></span>
            <div class="min-w-0"><span class="team-link is-muted">${esc(r.name)}</span>
              <div class="adm-sub">Sin cuenta del panel · respuestas desde el teléfono</div></div></div></td>
          ${sendCells(zero, 0).map((c) => `<td class="text-end">${c}</td>`).join('')}
          <td class="text-end"><span class="team-num"><b>${num(r.responses)}</b><small>${num(r.chats)} chat${r.chats === 1 ? '' : 's'}</small></span></td>
          <td class="text-end"><span class="team-num"><b>${esc(fmtMinutes(r.avgFirstResponseMin))}</b></span></td>
          <td class="text-end"><span class="team-muted">—</span></td>
          <td class="text-end"><span class="team-muted">—</span></td>
          <td class="text-end"><span class="adm-sub">No disponible</span></td>
        </tr>`,
        total: 0,
        responses: r.responses,
      });
    }

    rows.sort((x, y) => y.total - x.total || y.responses - x.responses);
    const teamTable = `<div class="table-responsive team-scroll">
      <table class="table table-hover align-middle mb-0 ab-table team-table team-table-rich">
        <thead class="table-light">
          <tr class="team-groups">
            <th rowspan="2">Persona</th>
            <th colspan="4" class="text-center">Mensajes enviados</th>
            <th colspan="2" class="text-center">Lotes</th>
            <th colspan="2" class="text-center">Atención</th>
            <th colspan="2" class="text-center">Notas</th>
            <th rowspan="2"><span class="visually-hidden">Acciones</span></th>
          </tr>
          <tr class="team-cols">
            <th class="text-end">Cronogramas</th>
            <th class="text-end">Lotes panel</th>
            <th class="text-end">Bandeja</th>
            <th class="text-end">Total</th>
            <th class="text-end">Cant.</th>
            <th class="text-end">Msj/lote</th>
            <th class="text-end">Respuestas</th>
            <th class="text-end">1.ª resp.</th>
            <th class="text-end">Creadas</th>
            <th class="text-end">Vencidas</th>
          </tr>
        </thead>
        <tbody>${rows.map((r) => r.html).join('')}</tbody>
      </table>
    </div>`;

    const activePeople = new Set<string>();
    for (const u of v.users) if (u.responses || u.notesCreated || u.notesResolved) activePeople.add(`u:${u.id}`);
    for (const r of v.activity.rows) activePeople.add(r.userId != null ? `u:${r.userId}` : `a:${r.uid}`);
    const topSender = [...v.activity.rows].sort((x, y) => y.total - x.total)[0];
    const topPerson = [...v.users].sort((x, y) => y.responses - x.responses)[0];
    const overdue = v.users.reduce((acc, u) => acc + u.notesOverdue, 0);
    content = `<div class="ab-kpis ab-kpis-6">
      ${kpi('ri-team-line', 'info', 'Personas con actividad', activePeople.size, `${v.team.size} cuentas en el equipo · ${num(v.activity.totals.users)} con envíos`)}
      ${kpi('ri-send-plane-2-line', 'ok', 'Mensajes enviados', num(v.activity.totals.total), `${num(v.activity.totals.cronogramas)} cronogramas · ${num(v.activity.totals.lotes)} lotes panel · ${num(v.activity.totals.bandeja)} bandeja`)}
      ${kpi('ri-stack-line', 'info', 'Lotes enviados', num(v.activity.totals.batches), `${num(v.activity.totals.avgPerBatch)} mensajes por lote en promedio`)}
      ${kpi('ri-medal-line', 'ok', 'Más envíos', topSender ? esc(topSender.name) : '—', topSender && topSender.total ? `${num(topSender.total)} mensajes · ${num(topSender.batches)} lotes` : 'sin envíos en el período')}
      ${kpi('ri-chat-check-line', 'info', 'Más respuestas', topPerson && topPerson.responses ? esc(topPerson.name) : '—', topPerson && topPerson.responses ? `${num(topPerson.responses)} respuestas · ${num(topPerson.chats)} chats` : 'sin respuestas en el período')}
      ${kpi('ri-alarm-warning-line', overdue ? 'danger' : 'ok', 'Tareas vencidas', num(overdue), 'de las personas del equipo')}
    </div>
    <div class="card ab-card team-card" id="team-card">
      <div class="card-header team-head">
        <div class="team-head-title">
          <h5 class="card-title mb-0">Desempeño y envíos por persona</h5>
          <p class="fu-chart-sub mb-0">Una sola lectura por persona: lo que envió (cronogramas, lotes y bandeja), cuánto trabajó en atención y cómo va con sus notas.</p>
        </div>
        <div class="team-tools">
          <button type="button" class="btn btn-soft-secondary btn-sm" id="team-refresh"><i class="ri-refresh-line me-1"></i>Actualizar</button>
          <label class="act-search">
            <i class="ri-search-line" aria-hidden="true"></i>
            <input type="search" id="team-search" placeholder="Buscar persona…" autocomplete="off" aria-label="Buscar persona" />
          </label>
          <select class="form-select form-select-sm" id="team-sort" aria-label="Ordenar por">
            <option value="total">Más envíos</option>
            <option value="cronogramas">Más cronogramas</option>
            <option value="lotes">Más lotes de panel</option>
            <option value="batches">Más lotes</option>
            <option value="responses">Más respuestas</option>
            <option value="name">Nombre</option>
          </select>
          <a class="btn btn-soft-secondary btn-sm" href="${esc(v.exportHref)}"><i class="ri-download-2-line me-1"></i>CSV</a>
        </div>
      </div>
      <div class="card-body pt-0">
        ${rows.length ? teamTable : emptyState('ri-user-search-line', 'Sin actividad del equipo', 'No hubo respuestas, envíos ni notas en el período.')}
        <div class="act-empty-line" id="team-empty" hidden><i class="ri-filter-off-line me-1"></i>Ninguna persona coincide con la búsqueda.</div>
        <p class="act-hint"><i class="ri-information-line" aria-hidden="true"></i> «Cronogramas» suma los envíos de la integración; «Lotes panel» los pedidos desde el panel; «Bandeja» los mensajes manuales. «Msj/lote» es el promedio de destinatarios por lote.</p>
      </div>
    </div>`;
  } else if (v.tab === 'seguimiento') {
    const created = v.notes.createdInPeriod;
    const resolved = v.notes.resolvedInPeriod;
    content = `<div class="ab-kpis">
      ${kpi('ri-sticky-note-add-line', 'info', 'Notas registradas', created, 'en el período')}
      ${kpi('ri-check-double-line', 'ok', 'Tareas resueltas', resolved, created ? `${pct(resolved, created)} de lo registrado` : 'en el período')}
      ${kpi('ri-time-line', 'info', 'Pendientes', v.notes.stats.pending, `${v.notes.stats.week} en los próximos 7 días`)}
      ${kpi('ri-pushpin-2-line', 'warn', 'Importantes', v.notes.stats.pinned ?? 0, 'fijadas en el chat')}
      ${kpi('ri-alarm-warning-line', v.notes.stats.overdue ? 'danger' : 'ok', 'Vencidas', v.notes.stats.overdue, 'necesitan atención')}
    </div>
    <div class="fu-split fu-split-even">
      ${panel(
        'Vencidas',
        v.notes.overdue.length ? `<ul class="fu-notes">${v.notes.overdue.map((n) => noteItem(n, 'overdue')).join('')}</ul>` : emptyState('ri-checkbox-circle-line', 'Nada vencido', 'Todas las tareas con fecha están al día.'),
        '<a class="btn btn-soft-primary btn-sm" href="/notes?status=overdue">Ver en Notas</a>',
      )}
      ${panel(
        'Para hoy',
        v.notes.today.length ? `<ul class="fu-notes">${v.notes.today.map((n) => noteItem(n, 'today')).join('')}</ul>` : emptyState('ri-calendar-check-line', 'Sin tareas para hoy', 'No hay tareas con fecha de hoy.'),
      )}
    </div>`;
  } else if (v.tab === 'masivos') {
    content = massTab(v.mass, v.period);
  } else {
    const pr = v.protection;
    const pd = v.prevDelivery;
    const maxSkip = Math.max(1, ...pr.skipped.map((x) => x.count));
    const sendTable = (
      title: string,
      rows: Array<{ name: string; total: number; byTipo: Record<string, number>; batches: number; avgPerBatch: number; maxBatch: number; href?: string }>,
      sub: string,
    ) =>
      panel(
        title,
        `${rows.length
          ? table(['', 'Total', 'Masivos', 'Contable', 'Notas', 'Bandeja', 'Lotes', 'Msj/lote'], rows.map((r) => [
              r.href ? `<a class="fu-contact" href="${esc(r.href)}">${esc(r.name)}</a>` : esc(r.name),
              `<b>${num(r.total)}</b>`,
              num((r.byTipo.participantes ?? 0) + (r.byTipo.grupo ?? 0)),
              num(r.byTipo.cobranza ?? 0),
              num(r.byTipo.notas ?? 0),
              num(r.byTipo.inbox ?? 0),
              `<span class="team-num"><b>${num(r.batches)}</b><small>lotes</small></span>`,
              `<span class="team-num"><b>${num(r.avgPerBatch)}</b><small>máx. ${num(r.maxBatch)}</small></span>`,
            ]))
          : emptyState('ri-filter-off-line', 'Sin envíos', 'No hay envíos con los filtros seleccionados.')}
        <p class="fu-sub mb-0 mt-2">${esc(sub)}</p>`,
      );
    const inboxSent = s.byUser.reduce((acc, u) => acc + (u.byTipo.inbox ?? 0), 0);
    const batchSent = Math.max(0, s.totals.cronogramas + s.totals.esam - inboxSent);
    const batchesTotal = s.byUser.reduce((acc, u) => acc + u.batches, 0);
    const batchTotal = s.byUser.reduce((acc, u) => acc + u.batchMessages, 0);
    const avgBatch = batchesTotal ? Math.round(batchTotal / batchesTotal) : 0;
    const lotKpiSub = batchesTotal ? `${num(batchesTotal)} lotes · ${num(avgBatch)} msj/lote` : 'sin lotes en el período';
    content = `${compare}<div class="ab-kpis ab-kpis-6">
      ${kpi('ri-send-plane-2-line', 'info', 'Enviados', num(d.sent), 'panel, lotes y cronogramas', delta(d.sent, pd.sent, 'up'))}
      ${kpi('ri-stack-line', 'ok', 'Mensajes de lotes', num(batchSent), lotKpiSub)}
      ${kpi('ri-scales-3-line', 'info', 'Por lote', batchesTotal ? num(avgBatch) : '—', `máx. ${num(Math.max(0, ...s.byUser.map((u) => u.maxBatch)))} en un lote`)}
      ${kpi('ri-check-double-line', d.rate != null && d.sent >= 5 && d.rate < 85 ? 'warn' : 'ok', 'Entregabilidad', d.rate == null || d.sent < 5 ? '—' : `${d.rate}%`, d.sent < 5 ? 'pocos envíos para medir' : `${num(d.delivered)} entregados`, d.sent >= 5 && pd.sent >= 5 ? delta(d.rate, pd.rate, 'up', 'pts') : '')}
      ${kpi('ri-error-warning-line', d.failed + s.totals.failed ? 'danger' : 'ok', 'Fallidos', num(d.failed + s.totals.failed), 'sin entrega')}
      ${kpi('ri-shield-check-line', pr.skippedTotal ? 'warn' : 'mute', 'Frenados', num(pr.skippedTotal), `por protección · ${pr.pausedBatches} lote(s) pausados`)}
    </div>
    <div class="fu-split fu-split-even">
      <div>${chartCard('fuTipo', 'Envíos por origen', 'Lotes y cronogramas según el tipo de envío')}</div>
      <div>${chartCard('fuPrograma', 'Envíos por programa', 'Los 10 programas con más envíos')}</div>
    </div>
    ${panel(
      'Protección anti-baneo en el período',
      `<div class="fu-protect">
        <div class="fu-protect-figs">
          <div><span>${pr.skippedTotal}</span>destinatarios omitidos</div>
          <div><span>${pr.pausedBatches}</span>lotes pausados</div>
          <div class="${pr.blocks ? 'ab-t-danger' : ''}"><span>${pr.blocks}</span>bloqueos</div>
          <div class="${pr.optouts ? 'ab-t-warn' : ''}"><span>${pr.optouts}</span>pedidos de baja</div>
        </div>
        ${
          pr.skipped.length
            ? `<ul class="fu-bars">${pr.skipped
                .map((x) => `<li><span class="fu-bars-label">${esc(x.label)}</span><span class="fu-bars-track"><span style="width:${Math.round((x.count / maxSkip) * 100)}%"></span></span><b>${x.count}</b></li>`)
                .join('')}</ul>`
            : '<p class="fu-sub mb-0">Ningún destinatario omitido: los lotes del período no tocaron ningún límite de protección.</p>'
        }
      </div>`,
      '<a class="btn btn-soft-primary btn-sm" href="/anti-ban?tab=politicas">Políticas</a>',
    )}
    <div class="fu-split fu-split-even">
      <div>${sendTable('Envíos por programa', s.byPrograma.map((p) => ({ name: p.programa, total: p.total, byTipo: p.byTipo, batches: p.batches, avgPerBatch: p.avgPerBatch, maxBatch: p.maxBatch })), 'Programas con más envíos del período. Los lotes agrupan todos los destinatarios de un mismo pedido.')}</div>
      <div>${sendTable('Envíos por usuario', s.byUser.map((u) => ({
        name: u.name,
        total: u.total,
        byTipo: u.byTipo,
        batches: u.batches,
        avgPerBatch: u.avgPerBatch,
        maxBatch: u.maxBatch,
        href: /^\d+$/.test(u.id) ? `/reports/users/${u.id}?${keepQuery({ ...keep, tab: 'equipo' })}` : undefined,
      })), 'Quién envió cada mensaje y cuántos destinatarios tuvo por lote. Abrí una persona para ver su ficha.')}</div>
    </div>
    ${dataScript({
      kind: 'reports',
      daily: [],
      tipos: s.byTipo.map((t) => ({ label: t.label ?? TIPO_LABELS[t.tipo] ?? t.tipo, total: t.total })),
      programas: s.byPrograma.slice(0, 10).map((p) => ({ label: p.programa, total: p.total })),
    })}${APEX}`;
  }

  return `<div class="ab-page fu-page">
    ${periodBar('/reports', v.period, v.sessions, v.selectedSession, v.tab, extra)}
    ${notes.join('')}
    <div class="fu-tabs-row">
      ${tabsNav('/reports', [
        { id: 'atencion', label: 'Atención', icon: 'ri-customer-service-2-line' },
        { id: 'equipo', label: 'Equipo', icon: 'ri-team-line' },
        { id: 'seguimiento', label: 'Notas y tareas', icon: 'ri-sticky-note-line', badge: v.notes.stats.overdue },
        { id: 'envios', label: 'Envíos', icon: 'ri-send-plane-2-line' },
        { id: 'masivos', label: 'Envíos masivos', icon: 'ri-mail-send-line' },
      ], v.tab, keep)}
      <a class="btn btn-soft-secondary btn-sm" href="${esc(v.tab === 'masivos' && v.massExportHref ? v.massExportHref : v.exportHref)}"><i class="ri-download-2-line me-1"></i>Exportar CSV</a>
    </div>
    ${content}
  </div>`;
}

// ── Envíos masivos: quién envía, cuántas veces por día y cuántos mensajes ─────

const MASS_TIPOS: Record<string, string> = {
  participantes: 'Participantes', grupo: 'Grupo', grupos: 'Grupos', prospectos: 'Prospectos', cuotas: 'Cuotas', cobranza: 'Cobranza',
  recordatorio: 'Recordatorio', academico: 'Académico', contable: 'Contable',
};
const MASS_AREAS: Record<string, string> = {
  academico: 'Académico', contabilidad: 'Contabilidad', marketing: 'Marketing', admin: 'Administración', consulta: 'Consulta', general: 'General',
};

function massDayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - date.getTime()) / 86_400_000);
  const txt = date.toLocaleDateString('es-BO', { weekday: 'long', day: 'numeric', month: 'long' });
  const cap = txt.charAt(0).toUpperCase() + txt.slice(1);
  return diff === 0 ? `Hoy · ${cap}` : diff === 1 ? `Ayer · ${cap}` : cap;
}

function massDuration(ms: number | null): string {
  if (ms == null) return '—';
  const min = Math.round(ms / 60000);
  if (min < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

function massTab(a: MassActivity | undefined, period: Period): string {
  if (!a || !a.batches.length) {
    return panel('Envíos masivos', emptyState('ri-mail-send-line', 'Sin envíos masivos en el período', `No se pidieron lotes entre ${period.from} y ${period.to} en las líneas que podés ver.`));
  }
  const t = a.totals;
  const fmtDay = (day: string | null) => (day ? massDayLabel(day) : '—');
  const shortDay = (day: string) => {
    const [y, m, d] = day.split('-').map(Number);
    return `${new Date(y, m - 1, d).toLocaleDateString('es-BO', { weekday: 'short' }).replace('.', '')} ${d}/${m}`;
  };
  const area = (x: string | null) => (x ? MASS_AREAS[x] ?? x : '');
  const rate = t.messages ? Math.round((t.sent / t.messages) * 100) : 0;

  const kpis = `<div class="ab-kpis">
    ${kpi('ri-stack-line', 'info', 'Lotes enviados', t.batches, `en ${t.daysActive} día${t.daysActive === 1 ? '' : 's'} con envíos`)}
    ${kpi('ri-mail-send-line', 'ok', 'Mensajes', t.messages, `${t.sent} enviados (${rate}%) · ${t.failed} fallidos`)}
    ${kpi('ri-team-line', 'info', 'Personas que enviaron', t.requesters, `${t.daysActive ? (Math.round((t.batches / t.daysActive) * 10) / 10) : 0} lotes por día en promedio`)}
    ${kpi('ri-fire-line', 'warn', 'Día con más envíos', t.busiestDay ? `${t.busiestDay.batches} lotes` : '—', t.busiestDay ? `${esc(fmtDay(t.busiestDay.day))} · ${t.busiestDay.messages} mensajes` : '')}
  </div>`;

  // Resumen por persona.
  const people = a.requesters.map((r) => `<tr data-person="${esc(r.key)}">
      <td><div class="ma-person"><span class="ma-av">${esc(initials(r.name))}</span><div class="min-w-0"><b>${esc(r.name)}</b>${r.area ? `<small>${esc(area(r.area))}</small>` : ''}</div></div></td>
      <td><b class="ma-big">${r.batches}</b>${r.cancelled ? `<small class="text-danger d-block">${r.cancelled} cancelado${r.cancelled === 1 ? '' : 's'}</small>` : ''}</td>
      <td>${r.daysActive}</td>
      <td><b>${r.avgPerDay}</b><small class="d-block">máx. ${r.maxPerDay}${r.maxDay ? ` (${esc(shortDay(r.maxDay))})` : ''}</small></td>
      <td><b>${r.messages}</b><small class="d-block"><span class="text-success">${r.sent} enviados</span>${r.failed ? ` · <span class="text-danger">${r.failed} fallidos</span>` : ''}</small></td>
      <td><b>${r.avgPerBatch}</b><small class="d-block">máx. ${r.maxPerBatch}</small></td>
      <td class="ma-lines">${r.lines.map((l) => `<span>${esc(l)}</span>`).join('') || '—'}</td>
      <td class="text-nowrap">${r.lastAt ? esc(fmtDate(r.lastAt)) : '—'}</td>
      <td><button type="button" class="btn btn-soft-primary btn-sm ma-see" data-person="${esc(r.key)}" title="Ver sus lotes en el registro"><i class="ri-list-check-2"></i></button></td>
    </tr>`).join('');
  const summary = panel(
    'Quién envía mensajes masivos',
    `<div class="table-responsive"><table class="table table-hover align-middle mb-0 ab-table ma-table">
      <thead class="table-light"><tr><th>Persona</th><th>Lotes</th><th>Días con envíos</th><th>Lotes por día</th><th>Mensajes</th><th>Mensajes por lote</th><th>Líneas usadas</th><th>Último envío</th><th><span class="visually-hidden">Ver</span></th></tr></thead>
      <tbody>${people}</tbody></table></div>`,
  );

  // Calendario: lotes por persona y día (días con actividad, el más reciente primero).
  const days = a.days.slice(0, 31);
  const maxCell = Math.max(1, ...a.requesters.flatMap((r) => days.map((d) => r.byDay[d]?.batches ?? 0)));
  const dayHead = (d: string) => {
    const [y, m, dd] = d.split('-').map(Number);
    const date = new Date(y, m - 1, dd);
    return `<th class="ma-dh" title="${esc(massDayLabel(d))}"><span>${esc(date.toLocaleDateString('es-BO', { weekday: 'short' }).replace('.', ''))}</span>${dd}/${m}</th>`;
  };
  const calendar = panel(
    'Envíos por persona y día',
    `<p class="fu-sub">Cantidad de lotes que pidió cada persona por día (al pasar el cursor: mensajes de esos lotes). ${a.days.length > 31 ? 'Se muestran los 31 días con envíos más recientes.' : ''}</p>
     <div class="table-responsive"><table class="table table-sm align-middle mb-0 ma-cal">
      <thead><tr><th class="ma-cal-p">Persona</th>${days.map(dayHead).join('')}<th>Total</th></tr></thead>
      <tbody>${a.requesters.map((r) => `<tr data-person="${esc(r.key)}"><th class="ma-cal-p">${esc(r.name)}</th>${days.map((d) => {
        const c = r.byDay[d];
        if (!c) return '<td class="ma-c0">·</td>';
        const lvl = Math.min(4, Math.ceil((c.batches / maxCell) * 4));
        return `<td class="ma-c ma-l${lvl}" title="${esc(`${r.name} · ${massDayLabel(d)}: ${c.batches} lote${c.batches === 1 ? '' : 's'}, ${c.messages} mensajes`)}">${c.batches}<small>${c.messages}</small></td>`;
      }).join('')}<td class="ma-tot">${r.batches}</td></tr>`).join('')}</tbody>
     </table></div>`,
  );

  // Registro detallado, agrupado por día.
  const byDay = new Map<string, typeof a.batches>();
  for (const b of a.batches) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day)!.push(b);
  }
  const log = [...byDay.entries()].map(([day, list]) => {
    const who = new Set(list.map((b) => b.requesterKey)).size;
    return `<section class="ma-day" data-day="${day}">
      <h6 class="ma-day-h">${esc(massDayLabel(day))}<small data-sum>${list.length} lote${list.length === 1 ? '' : 's'} · ${list.reduce((s, b) => s + b.total, 0)} mensajes · ${who} persona${who === 1 ? '' : 's'}</small></h6>
      <div class="table-responsive"><table class="table table-hover align-middle mb-0 ma-log">
        <tbody>${list.map((b) => `<tr data-person="${esc(b.requesterKey)}">
          <td class="ma-t">${esc(b.time)}</td>
          <td class="ma-who"><b>${esc(b.requesterName)}</b><small>${esc(b.linePhone ?? '—')}${b.lineOwner ? ` · ${esc(b.lineOwner)}` : ''}</small></td>
          <td class="ma-lote"><a href="/batches/${b.id}">#${b.id} · ${esc(b.name)}</a><small>${[b.programa, b.tipo ? MASS_TIPOS[b.tipo] ?? b.tipo : null, b.origen].filter(Boolean).map((x) => esc(String(x))).join(' · ')}</small></td>
          <td class="ma-n"><b>${b.total}</b><small>mensajes</small></td>
          <td class="ma-res"><span class="text-success">${b.sent} enviados</span>${b.failed ? `<span class="text-danger">${b.failed} fallidos</span>` : ''}${b.skipped ? `<span class="text-warning">${b.skipped} omitidos</span>` : ''}</td>
          <td class="ma-dur">${esc(massDuration(b.durationMs))}</td>
          <td>${statusBadge(b.status)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>`;
  }).join('');
  const options = a.requesters.map((r) => `<option value="${esc(r.key)}">${esc(r.name)} (${r.batches})</option>`).join('');
  const registro = panel(
    'Registro de actividad',
    `<p class="fu-sub">Cada lote con la hora, quién lo pidió, la línea, el programa y cómo terminó. Abrí el lote para ver a cada destinatario.</p>
     <div class="ma-log-wrap">${log}</div>
     <div class="ma-empty" hidden><i class="ri-filter-off-line"></i> Esta persona no tiene lotes en el período.</div>`,
    `<select class="form-select form-select-sm ma-filter" aria-label="Filtrar por persona"><option value="">Todas las personas</option>${options}</select>`,
  );

  return `<div class="mass-activity" id="mass-activity">
    ${kpis}
    ${summary}
    <div class="mt-3">${calendar}</div>
    <div class="mt-3" id="ma-registro">${registro}</div>
  </div>
  <script>
  (function () {
    var root = document.getElementById('mass-activity');
    if (!root) return;
    var sel = root.querySelector('.ma-filter');
    function apply(key) {
      var shown = 0;
      root.querySelectorAll('.ma-day').forEach(function (day) {
        var n = 0, msgs = 0;
        day.querySelectorAll('tr[data-person]').forEach(function (tr) {
          var ok = !key || tr.dataset.person === key;
          tr.hidden = !ok;
          if (ok) { n++; msgs += Number((tr.querySelector('.ma-n b') || {}).textContent || 0); }
        });
        day.hidden = n === 0;
        shown += n;
      });
      root.querySelectorAll('.ma-table tbody tr, .ma-cal tbody tr').forEach(function (tr) {
        tr.classList.toggle('ma-on', !!key && tr.dataset.person === key);
      });
      root.querySelector('.ma-empty').hidden = shown > 0;
    }
    sel.addEventListener('change', function () { apply(sel.value); });
    root.querySelectorAll('.ma-see').forEach(function (b) {
      b.addEventListener('click', function () {
        sel.value = b.dataset.person;
        apply(sel.value);
        document.getElementById('ma-registro').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  })();
  </script>`;
}

// ── Ficha individual ─────────────────────────────────────────────────────────

export interface ReportUserView {
  user: UserRow;
  detail: UserReportDetail;
  period: Period;
  sessions: SessionRow[];
  selectedSession: string;
  lastUse: UserActivity | null;
  filters: { programa: string; account: string; area: string; tipo: string };
}

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D+/g, '');
}

function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Ficha de seguimiento individual, con el mismo período y filtros de Reportes. */
export function renderReportUser(v: ReportUserView): string {
  const u = v.user;
  const d = v.detail;
  const p = d.performance;
  const name = u.name ?? u.username ?? `Usuario ${u.id}`;
  const area = esamAreaLabel(u);
  const roles = esamRoles(u);
  const line = (() => {
    const num = digits(u.esam_numero);
    if (!num) return undefined;
    const matches = v.sessions.filter((s) => digits(s.expected_phone) === num || digits(s.phone) === num);
    return matches.find((s) => s.status === 'ready') ?? matches[0];
  })();

  const roleChips = (roles.length ? roles : [area])
    .map((r) => `<span class="ur-chip"><i class="ri-shield-user-line" aria-hidden="true"></i>${esc(r)}</span>`)
    .join('');
  const lineChip = line
    ? `<span class="ur-chip"><i class="ri-whatsapp-line" aria-hidden="true"></i>${esc(line.phone ?? line.expected_phone ?? line.name)} ${statusBadge(line.status)}</span>`
    : `<span class="ur-chip is-muted"><i class="ri-link-unlink" aria-hidden="true"></i>${u.esam_numero ? `+${esc(digits(u.esam_numero))} · sin línea activa` : 'Sin línea asignada'}</span>`;
  const accessChip = u.esam_autorizado
    ? '<span class="ur-chip is-ok"><i class="ri-check-line" aria-hidden="true"></i>Acceso autorizado</span>'
    : '<span class="ur-chip is-danger"><i class="ri-close-line" aria-hidden="true"></i>Sin autorizar</span>';

  const overdue = d.assigned.counts.overdue;
  const responseTone = p.avgFirstResponseMin == null ? 'mute' : p.avgFirstResponseMin > 60 ? 'warn' : 'ok';
  const s = d.sends;
  const kpis = `<div class="ab-kpis ur-kpis">
    ${kpi('ri-send-plane-2-line', 'info', 'Mensajes enviados', num(s.total), `${num(s.cronogramas)} cronogramas · ${num(s.lotes)} lotes panel · ${num(s.panel)} bandeja`)}
    ${kpi('ri-calendar-schedule-line', 'ok', 'Desde cronogramas', num(s.cronogramas), `${num(s.cronBatches)} lote${s.cronBatches === 1 ? '' : 's'} del sistema`)}
    ${kpi('ri-stack-line', 'info', 'Lotes enviados', num(s.batches), `${num(s.avgPerBatch)} msj/lote · máx. ${num(s.maxBatch)}`)}
    ${kpi('ri-chat-check-line', 'info', 'Respuestas', p.responses, `${p.chats} chat${p.chats === 1 ? '' : 's'} atendido${p.chats === 1 ? '' : 's'}`)}
    ${kpi('ri-speed-up-line', responseTone, '1.ª respuesta', fmtMinutes(p.avgFirstResponseMin), `${d.within15} en ≤ 15 min · ${d.within60} en ≤ 1 h`)}
    ${kpi('ri-alarm-warning-line', overdue ? 'danger' : 'ok', 'Tareas vencidas', overdue, `${d.assigned.counts.today} para hoy · ${d.assigned.counts.pending} abiertas`)}
  </div>`;

  const today = todayYmd();
  const seen = new Set<number>();
  const tasks = [...d.assigned.overdue, ...d.assigned.today, ...d.assigned.pending]
    .filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
    .slice(0, 7);
  const taskList = tasks.length
    ? `<div class="ur-task-counts">
        <span class="is-late">${overdue} vencida${overdue === 1 ? '' : 's'}</span>
        <span>${d.assigned.counts.today} para hoy</span>
        <span>${d.assigned.counts.pending} abierta${d.assigned.counts.pending === 1 ? '' : 's'}</span>
      </div>
      <ul class="ur-tasks">${tasks
        .map((n) => {
          const tone = n.due_at && n.due_at < today ? 'late' : n.due_at === today ? 'today' : 'pending';
          const due = n.due_at ? `${n.due_at.split('-').reverse().join('/')}${n.due_time ? ` · ${n.due_time}` : ''}` : 'Sin fecha';
          return `<li class="ur-task is-${tone}">
            <span class="ur-task-dot" aria-hidden="true"></span>
            <div class="ur-task-main">
              <a class="ur-task-text" href="/notes?nota=${n.id}">${esc((n.note_text ?? '[nota de voz]').slice(0, 120))}</a>
              <div class="ur-task-meta">
                <a href="/conversations/${encodeURIComponent(n.chat_id)}">${esc(n.contact_name ?? n.contact_phone ?? n.chat_id.split('@')[0])}</a>
                <span>${esc(due)}</span>
              </div>
            </div>
          </li>`;
        })
        .join('')}</ul>`
    : emptyState('ri-checkbox-circle-line', 'Sin tareas asignadas', 'Esta persona no tiene tareas pendientes en las líneas visibles.');

  const chatRows = d.topChats.map((c) => [
    `<a class="fu-contact" href="/conversations/${encodeURIComponent(c.chatId)}">${esc(c.name)}</a>
      <div class="adm-sub">${esc(c.phone ? `+${c.phone}` : c.chatId.split('@')[0])}</div>`,
    `<b class="team-metric">${c.sent}</b>`,
    `<span class="team-muted" title="${esc(fmtDate(c.lastAt))}">${esc(relTime(c.lastAt))}</span>`,
  ]);
  const chats = chatRows.length
    ? table(['Contacto', 'Mensajes', 'Último envío'], chatRows)
    : emptyState('ri-chat-3-line', 'Sin conversaciones atendidas', 'No escribió mensajes en chats individuales durante el período.');

  const icons: Record<string, string> = { message: 'ri-chat-1-line', note: 'ri-sticky-note-line' };
  const recent = d.recent.length
    ? `<ul class="ur-activity">${d.recent
        .map(
          (a) => `<li class="ur-act is-${a.kind}">
            <span class="ur-act-ico"><i class="${icons[a.kind] ?? 'ri-history-line'}" aria-hidden="true"></i></span>
            <div class="ur-act-main">
              ${a.href ? `<a href="${esc(a.href)}">${esc(a.label)}</a>` : `<span>${esc(a.label)}</span>`}
              ${a.detail ? `<p>${esc(a.detail)}</p>` : ''}
            </div>
            <span class="ur-act-time" title="${esc(fmtDate(a.at))}">${esc(relTime(a.at))}</span>
          </li>`,
        )
        .join('')}</ul>`
    : emptyState('ri-history-line', 'Sin actividad reciente', 'No hay mensajes ni notas de esta persona en el período.');

  // Origen de los envíos: misma persona, tres canales distintos.
  const originTotal = Math.max(1, s.total);
  const origins: Array<{ label: string; value: number; cls: string; hint: string }> = [
    { label: 'Cronogramas', value: s.cronogramas, cls: 'is-cron', hint: `${num(s.cronBatches)} lotes del sistema` },
    { label: 'Lotes del panel', value: s.lotes, cls: 'is-lote', hint: `${num(s.panelBatches)} lotes pedidos aquí` },
    { label: 'Bandeja', value: s.panel, cls: 'is-band', hint: 'mensajes escritos a mano' },
  ];
  const originBody = s.total
    ? `<ul class="ur-origin">${origins
        .map(
          (o) => `<li>
            <span class="ur-origin-label"><span class="ur-origin-dot ${o.cls}"></span>${esc(o.label)}<small>${esc(o.hint)}</small></span>
            <span class="ur-origin-track"><span class="${o.cls}" style="width:${Math.round((o.value / originTotal) * 100)}%"></span></span>
            <b>${num(o.value)}</b>
            <small>${Math.round((o.value / originTotal) * 100)}%</small>
          </li>`,
        )
        .join('')}</ul>
      <div class="ur-origin-facts">
        <span><b>${num(s.batches)}</b> lotes en el período</span>
        <span><b>${num(s.avgPerBatch)}</b> destinatarios por lote</span>
        <span><b>${num(s.maxBatch)}</b> en el lote más grande</span>
      </div>`
    : emptyState('ri-send-plane-2-line', 'Sin envíos en el período', 'No hay mensajes de cronogramas, lotes ni bandeja con el período y filtros elegidos.');

  const sendBatchLabel = (b: (typeof d.sends.list)[number]) =>
    `${b.day.split('-').reverse().join('/')} · ${b.time} · ${b.cronograma ? 'Cronogramas' : 'Panel'}`;
  const lotRows = d.sends.list.slice(0, 8).map((b) => [
    `<a class="fu-contact" href="/batches/${b.id}">#${b.id} · ${esc(b.name)}</a>
      <div class="adm-sub">${esc(sendBatchLabel(b))}</div>`,
    esc(b.programa ?? (b.tipo ? TIPO_LABELS[b.tipo] ?? b.tipo : '—')),
    `<span class="team-num"><b>${num(b.total)}</b><small>${num(b.sent)} enviados${b.failed ? ` · ${num(b.failed)} fallidos` : ''}</small></span>`,
    statusBadge(b.status),
  ]);
  const lotsBody = lotRows.length
    ? table(['Lote', 'Programa / tipo', 'Mensajes', 'Estado'], lotRows)
    : emptyState('ri-stack-line', 'Sin lotes en el período', 'Esta persona no pidió lotes ni envió desde cronogramas con estos filtros.');
  const moreLots = d.sends.list.length > 8 ? `<p class="fu-sub mb-0 mt-2">Se muestran los 8 lotes más recientes de ${num(d.sends.batches)}.</p>` : '';

  const loginRel = u.last_login_at ? relTime(u.last_login_at) : 'Nunca';
  const loginDetail = u.last_login_at
    ? `${fmtDate(u.last_login_at)} · ${u.login_count} ingreso${u.login_count === 1 ? '' : 's'}`
    : 'Sin ingresos registrados';
  const hero = `<div class="card ab-card ur-hero">
    <div class="ur-hero-main">
      <span class="avatar-xl rounded-circle av-${u.id % 8} ur-avatar">${esc(initials(name))}</span>
      <div class="ur-identity">
        <h2 class="ur-name">${esc(name)}</h2>
        <div class="ur-meta">${[u.username, u.email].filter(Boolean).map((x) => esc(x)).join(' · ') || 'Cuenta del panel'}</div>
        <div class="ur-chips">${roleChips}${lineChip}${accessChip}</div>
      </div>
    </div>
    <div class="ur-hero-side">
      <div class="ur-fact">
        <span class="ur-fact-label"><i class="ri-login-circle-line" aria-hidden="true"></i>Último ingreso</span>
        <b>${esc(loginRel)}</b>
        <small>${esc(loginDetail)}</small>
      </div>
      <div class="ur-fact">
        <span class="ur-fact-label"><i class="ri-pulse-line" aria-hidden="true"></i>Última actividad</span>
        <b>${esc(v.lastUse ? relTime(v.lastUse.at) : 'Sin actividad')}</b>
        <small>${esc(v.lastUse ? `${v.lastUse.label} · ${fmtDate(v.lastUse.at)}` : 'Todavía no envió mensajes, lotes ni notas')}</small>
      </div>
      <div class="ur-fact">
        <span class="ur-fact-label"><i class="ri-sticky-note-line" aria-hidden="true"></i>Notas</span>
        <b>${num(p.notesCreated)} creadas</b>
        <small>${num(p.notesResolved)} resueltas · ${num(p.notesOverdue)} vencidas</small>
      </div>
    </div>
  </div>`;

  const chartSub = d.byDay.length < v.period.days
    ? `Últimos ${d.byDay.length} días del período · ${esc(v.period.label)}`
    : `Respuestas, cronogramas y panel por día · ${esc(v.period.label)}`;
  return `<div class="ab-page fu-page ur-page">
    ${periodBar(`/reports/users/${u.id}`, v.period, v.sessions, v.selectedSession, 'equipo', '', v.filters)}
    ${hero}
    ${kpis}
    <div class="ur-layout">
      ${panel('Actividad diaria', `<div id="urDaily" class="ur-chart" role="img" aria-label="Respuestas, cronogramas y panel por día"></div><p class="fu-chart-sub mb-0">${chartSub}</p>`)}
      ${panel('Seguimiento asignado', taskList)}
    </div>
    <div class="fu-split fu-split-even">
      ${panel('Origen de los envíos', originBody)}
      ${panel('Lotes enviados', `${lotsBody}${moreLots}`, `<a class="btn btn-soft-secondary btn-sm" href="/reports?tab=masivos">Ver masivos</a>`)}
    </div>
    <div class="fu-split fu-split-even">
      ${panel('Contactos atendidos', chats)}
      ${panel('Actividad reciente', recent)}
    </div>
    ${dataScript({ kind: 'user', daily: d.byDay })}${APEX}
  </div>`;
}

/** CSV del período: desempeño por usuario, envíos y serie diaria. */
export function reportsCsv(v: Pick<ReportsView, 'period' | 'attention' | 'users' | 'team' | 'activity'>): string {
  const q = (x: unknown) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const lines: string[] = [];
  const byUid = new Map(v.activity.rows.map((r) => [r.uid, r]));
  const sendsOf = (id: number) => {
    const member = v.team.get(id);
    for (const key of [String(id), member?.source_uid ? String(member.source_uid) : null]) {
      if (!key) continue;
      const row = byUid.get(key);
      if (row) return row;
    }
    return undefined;
  };
  lines.push(q(`Reporte ${v.period.from} a ${v.period.to}`));
  lines.push('');
  lines.push(
    ['Usuario', 'Respuestas', 'Chats atendidos', 'Tiempo prom. 1a respuesta (min)', 'Notas registradas', 'Notas resueltas', 'Notas vencidas',
      'Mensajes enviados', 'Cronogramas', 'Lotes del panel', 'Bandeja', 'Lotes', 'Mensajes por lote (prom.)', 'Lote más grande']
      .map(q).join(','),
  );
  for (const u of v.users) {
    const s = sendsOf(u.id);
    lines.push(
      [u.name, u.responses, u.chats, u.avgFirstResponseMin ?? '', u.notesCreated, u.notesResolved, u.notesOverdue,
        s?.total ?? 0, s?.cronogramas ?? 0, s?.lotes ?? 0, s?.bandeja ?? 0, s?.batches ?? 0, s?.avgPerBatch ?? 0, s?.maxBatch ?? 0]
        .map(q).join(','),
    );
  }
  for (const r of v.attention.responders.filter((x) => x.key === 'phone')) {
    lines.push([r.name, r.responses, r.chats, r.avgFirstResponseMin ?? '', '', '', '', '', '', '', '', '', '', ''].map(q).join(','));
  }
  lines.push('');
  lines.push(['Día', 'Recibidos', 'Enviados', 'Mediana 1a respuesta (min)'].map(q).join(','));
  for (const d of v.attention.byDay) lines.push([d.day, d.received, d.sent, d.medianMin ?? ''].map(q).join(','));
  lines.push('');
  lines.push(['Usuario', 'Cronogramas', 'Lotes del panel', 'Bandeja', 'Total', 'Lotes', 'Mensajes por lote (prom.)', 'Lote más grande', 'Último envío'].map(q).join(','));
  for (const s of v.activity.rows) {
    lines.push([s.name, s.cronogramas, s.lotes, s.bandeja, s.total, s.batches, s.avgPerBatch, s.maxBatch, s.lastAt ?? ''].map(q).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}
