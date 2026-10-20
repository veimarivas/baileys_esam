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
import { TIPO_LABELS, type MonitoringData } from '../core/monitoring.js';
import type { GlobalNote } from '../core/contacts.js';
import type { HealthRow } from '../core/health.js';
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
            r.key === 'phone' ? `<i class="ri-smartphone-line me-1 text-muted"></i>${esc(r.name)}` : esc(r.name),
            `<b>${r.responses}</b>`,
            String(r.chats),
            esc(fmtMinutes(r.avgFirstResponseMin)),
          ]),
        )
      : emptyState('ri-chat-off-line', 'Sin respuestas en el período', 'Todavía no se respondió ningún mensaje.');
    content = `<div class="fu-split">
      <div>${chartCard('fuHours', singleDay ? 'Mensajes por hora' : 'Mensajes por hora del día', singleDay ? 'Recibidos y enviados en cada hora del día seleccionado' : 'Suma del período por hora: muestra las horas de más demanda')}</div>
      <div>${panel('Respuestas por persona', respondersTable)}</div>
    </div>
    <div class="card ab-card" id="activity-card"
        data-activity-url="/api/activity"
        data-activity-from="${esc(v.period.from)}" data-activity-to="${esc(v.period.to)}"
        data-activity-account="" data-activity-area="">
      <div class="card-header d-flex align-items-center">
        <h5 class="card-title mb-0 flex-grow-1">Envíos por usuario <span class="fu-sub">· cronogramas y panel</span></h5>
        <span class="text-muted fs-12 me-2" id="activity-updated"></span>
        <button type="button" class="btn btn-soft-secondary btn-sm" id="activity-refresh"><i class="ri-refresh-line me-1"></i>Actualizar</button>
      </div>
      <div class="card-body pt-0" id="activity-body"><div class="text-muted text-center py-3">Cargando…</div></div>
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

export type ReportsTab = 'atencion' | 'equipo' | 'seguimiento' | 'envios';

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
  protection: ProtectionStats;
  filters: { programa: string; account: string; area: string; tipo: string };
  exportHref: string;
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
    const rows = [
      ...v.users.map((u) => {
        const member = v.team.get(u.id);
        const use = v.lastUse.get(u.id);
        const area = member ? esamAreaLabel(member) : null;
        const sub = [
          area,
          use ? `Última actividad ${relTime(use.at)}` : 'Sin actividad registrada',
        ].filter(Boolean).join(' · ');
        return [
          `<div class="team-person">
            <span class="avatar-xs rounded-circle av-${u.id % 8}">${esc(initials(u.name))}</span>
            <div class="min-w-0"><a class="team-link" href="${esc(detailHref(u.id))}">${esc(u.name)}</a>
              <div class="adm-sub">${esc(sub)}</div></div>
          </div>`,
          `<b class="team-metric">${u.responses}</b>`,
          `<span class="team-metric">${u.chats}</span>`,
          `<span class="team-muted">${esc(fmtMinutes(u.avgFirstResponseMin))}</span>`,
          `<b>${u.notesCreated}</b> <span class="team-muted">creadas</span>
            <div class="adm-sub">${u.notesResolved} resueltas</div>`,
          u.notesOverdue ? `<span class="ab-pill ab-danger"><i class="ri-alarm-warning-line"></i>${u.notesOverdue}</span>` : '<span class="team-muted">0</span>',
          `<a class="btn btn-soft-secondary btn-sm team-open" href="${esc(detailHref(u.id))}" title="Ver ficha y seguimiento">Ver ficha <i class="ri-arrow-right-line"></i></a>`,
        ];
      }),
      ...a.responders
        .filter((r) => r.key === 'phone')
        .map((r) => [
          `<div class="team-person"><span class="team-phone"><i class="ri-smartphone-line"></i></span>
            <div class="min-w-0"><span class="team-link is-muted">${esc(r.name)}</span>
              <div class="adm-sub">Sin cuenta del panel · respuestas desde el teléfono</div></div></div>`,
          `<b class="team-metric">${r.responses}</b>`,
          `<span class="team-metric">${r.chats}</span>`,
          `<span class="team-muted">${esc(fmtMinutes(r.avgFirstResponseMin))}</span>`,
          '<span class="team-muted">—</span>',
          '<span class="team-muted">—</span>',
          '<span class="adm-sub">No disponible</span>',
        ]),
    ];
    const teamTable = `<div class="table-responsive"><table class="table table-hover align-middle mb-0 ab-table team-table">
      <thead class="table-light"><tr><th>Persona</th><th>Respuestas</th><th>Chats</th><th>1.ª respuesta</th><th>Notas del período</th><th>Notas vencidas</th><th><span class="visually-hidden">Acciones</span></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
    const top = [...v.users].sort((x, y) => y.responses - x.responses)[0];
    content = `<div class="ab-kpis adm-kpis-3">
      ${kpi('ri-team-line', 'info', 'Personas con actividad', v.users.filter((u) => u.responses || u.notesCreated).length, 'respondieron o registraron notas')}
      ${kpi('ri-medal-line', 'ok', 'Más respuestas', top && top.responses ? esc(top.name) : '—', top && top.responses ? `${top.responses} respuestas · ${top.chats} chats` : 'sin respuestas en el período')}
      ${kpi('ri-alarm-warning-line', v.users.some((u) => u.notesOverdue) ? 'danger' : 'ok', 'Tareas vencidas', v.users.reduce((acc, u) => acc + u.notesOverdue, 0), 'de las personas del equipo')}
    </div>
    ${panel(
      'Desempeño por persona',
      rows.length
        ? teamTable
        : emptyState('ri-user-search-line', 'Sin actividad del equipo', 'No hubo respuestas ni notas en el período.'),
      `<a class="btn btn-soft-secondary btn-sm" href="${esc(v.exportHref)}"><i class="ri-download-2-line me-1"></i>CSV</a>`,
    )}`;
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
  } else {
    const pr = v.protection;
    const pd = v.prevDelivery;
    const maxSkip = Math.max(1, ...pr.skipped.map((x) => x.count));
    const sendTable = (title: string, rows: Array<{ name: string; total: number; byTipo: Record<string, number> }>) =>
      panel(
        title,
        rows.length
          ? table(['', 'Total', 'Masivos', 'Contable', 'Notas', 'Bandeja'], rows.map((r) => [
              esc(r.name),
              `<b>${r.total}</b>`,
              String((r.byTipo.participantes ?? 0) + (r.byTipo.grupo ?? 0)),
              String(r.byTipo.cobranza ?? 0),
              String(r.byTipo.notas ?? 0),
              String(r.byTipo.inbox ?? 0),
            ]))
          : emptyState('ri-filter-off-line', 'Sin envíos', 'No hay envíos con los filtros seleccionados.'),
      );
    content = `${compare}<div class="ab-kpis">
      ${kpi('ri-send-plane-2-line', 'info', 'Enviados', d.sent, 'panel, lotes y cronogramas', delta(d.sent, pd.sent, 'up'))}
      ${kpi('ri-check-double-line', d.rate != null && d.sent >= 5 && d.rate < 85 ? 'warn' : 'ok', 'Entregabilidad', d.rate == null || d.sent < 5 ? '—' : `${d.rate}%`, d.sent < 5 ? 'pocos envíos para medir' : `${d.delivered} entregados`, d.sent >= 5 && pd.sent >= 5 ? delta(d.rate, pd.rate, 'up', 'pts') : '')}
      ${kpi('ri-eye-line', 'info', 'Leídos', d.readRate == null || d.sent < 5 ? '—' : `${d.readRate}%`, `${d.read} mensajes`)}
      ${kpi('ri-error-warning-line', d.failed + s.totals.failed ? 'danger' : 'ok', 'Fallidos', d.failed + s.totals.failed, 'sin entrega')}
      ${kpi('ri-shield-check-line', pr.skippedTotal ? 'warn' : 'mute', 'Frenados', pr.skippedTotal, `por protección · ${pr.pausedBatches} lote(s) pausados`)}
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
      <div>${sendTable('Envíos por programa', s.byPrograma.map((p) => ({ name: p.programa, total: p.total, byTipo: p.byTipo })))}</div>
      <div>${sendTable('Envíos por usuario', s.byUser.map((u) => ({ name: u.name, total: u.total, byTipo: u.byTipo })))}</div>
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
      ], v.tab, keep)}
      <a class="btn btn-soft-secondary btn-sm" href="${esc(v.exportHref)}"><i class="ri-download-2-line me-1"></i>Exportar CSV</a>
    </div>
    ${content}
  </div>`;
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
  const kpis = `<div class="ab-kpis ur-kpis">
    ${kpi('ri-chat-check-line', 'info', 'Respuestas', p.responses, `${p.chats} chat${p.chats === 1 ? '' : 's'} atendido${p.chats === 1 ? '' : 's'}`)}
    ${kpi('ri-speed-up-line', responseTone, '1.ª respuesta', fmtMinutes(p.avgFirstResponseMin), `${d.within15} en ≤ 15 min · ${d.within60} en ≤ 1 h`)}
    ${kpi('ri-send-plane-2-line', 'info', 'Envíos', d.sends.total, `${d.sends.panel} bandeja · ${d.sends.batch} lotes`)}
    ${kpi('ri-sticky-note-add-line', 'info', 'Notas creadas', p.notesCreated, `${p.notesResolved} resueltas por la persona`)}
    ${kpi('ri-check-double-line', 'ok', 'Notas resueltas', p.notesResolved, 'marcadas como resueltas en el período')}
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

  const loginRel = u.last_login_at ? relTime(u.last_login_at) : 'Nunca';
  const loginDetail = u.last_login_at
    ? `${fmtDate(u.last_login_at)} · ${u.login_count} ingreso${u.login_count === 1 ? '' : 's'}`
    : 'Sin ingresos registrados';
  const hero = `<div class="card ab-card ur-hero">
    <div class="ur-hero-main">
      <span class="avatar-xl rounded-circle av-${u.id % 8} ur-avatar">${esc(initials(name))}</span>
      <div class="ur-identity">
        <div class="ur-eyebrow">Ficha del equipo</div>
        <h2 class="ur-name">${esc(name)}</h2>
        <div class="ur-meta">${[u.username, u.email].filter(Boolean).map((x) => esc(x)).join(' · ') || 'Cuenta del panel'}</div>
        <div class="ur-chips">${roleChips}${lineChip}${accessChip}</div>
      </div>
    </div>
    <div class="ur-hero-side">
      <div class="ur-fact"><span>Último ingreso</span><b>${esc(loginRel)}</b>
        <small>${esc(loginDetail)}</small></div>
      <div class="ur-fact"><span>Última actividad</span><b>${esc(v.lastUse ? relTime(v.lastUse.at) : 'Sin actividad')}</b>
        <small>${esc(v.lastUse ? `${v.lastUse.label} · ${fmtDate(v.lastUse.at)}` : 'Todavía no envió mensajes, lotes ni notas')}</small></div>
    </div>
  </div>`;

  const chartSub = d.byDay.length < v.period.days
    ? `Últimos ${d.byDay.length} días del período · ${esc(v.period.label)}`
    : `Respuestas y envíos por día · ${esc(v.period.label)}`;
  return `<div class="ab-page fu-page ur-page">
    ${periodBar(`/reports/users/${u.id}`, v.period, v.sessions, v.selectedSession, 'equipo', '', v.filters)}
    ${hero}
    ${kpis}
    <div class="ur-layout">
      ${panel('Actividad diaria', `<div id="urDaily" class="ur-chart" role="img" aria-label="Respuestas y envíos por día"></div><p class="fu-chart-sub mb-0">${chartSub}</p>`)}
      ${panel('Seguimiento asignado', taskList)}
    </div>
    <div class="fu-split fu-split-even">
      ${panel('Contactos atendidos', chats)}
      ${panel('Actividad reciente', recent)}
    </div>
    ${dataScript({ kind: 'user', daily: d.byDay })}${APEX}
  </div>`;
}

/** CSV del período: desempeño por usuario y serie diaria. */
export function reportsCsv(v: Pick<ReportsView, 'period' | 'attention' | 'users'>): string {
  const q = (x: unknown) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const lines: string[] = [];
  lines.push(q(`Reporte ${v.period.from} a ${v.period.to}`));
  lines.push('');
  lines.push(['Usuario', 'Respuestas', 'Chats atendidos', 'Tiempo prom. 1a respuesta (min)', 'Notas registradas', 'Notas resueltas', 'Notas vencidas'].map(q).join(','));
  for (const u of v.users) {
    lines.push([u.name, u.responses, u.chats, u.avgFirstResponseMin ?? '', u.notesCreated, u.notesResolved, u.notesOverdue].map(q).join(','));
  }
  for (const r of v.attention.responders.filter((x) => x.key === 'phone')) {
    lines.push([r.name, r.responses, r.chats, r.avgFirstResponseMin ?? '', '', '', ''].map(q).join(','));
  }
  lines.push('');
  lines.push(['Día', 'Recibidos', 'Enviados', 'Mediana 1a respuesta (min)'].map(q).join(','));
  for (const d of v.attention.byDay) lines.push([d.day, d.received, d.sent, d.medianMin ?? ''].map(q).join(','));
  return '\uFEFF' + lines.join('\r\n');
}
