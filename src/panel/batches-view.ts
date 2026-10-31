import { esc } from './layout.js';
import { emptyState, statusBadge } from './views.js';
import { fmtMinutes } from '../core/followup.js';
import {
  COBRANZA_TIPOS,
  REPLY_KIND_LABEL,
  REPLY_WINDOW_HOURS,
  summarizeEngagement,
  type EngagementSummary,
  type ItemEngagement,
  type ReplyKind,
} from '../core/batch-engagement.js';

/**
 * Vistas de Lotes: lista compacta (agrupada por día, con filtros y progreso en
 * vivo) y detalle completo de un envío (quién, desde qué línea, qué mensaje,
 * tiempos, ritmo y el resultado de cada destinatario).
 */

export interface BatchListRow {
  id: number;
  name: string | null;
  status: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  meta: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  scheduled_at: string | null;
  session_id: string;
  line_owner?: string | null;
  line_name?: string | null;
  line_phone?: string | null;
  requester_name?: string | null;
}

export function safeMeta(raw: string | null | undefined): Record<string, any> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/** Día local (YYYY-MM-DD) del servidor, el mismo criterio que `fmtDate`. */
export function localDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('sv-SE');
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export function dayLabel(day: string): string {
  const today = localDay(new Date().toISOString());
  const yesterday = localDay(new Date(Date.now() - 86_400_000).toISOString());
  if (day === today) return 'Hoy';
  if (day === yesterday) return 'Ayer';
  const [y, m, d] = day.split('-').map(Number);
  const txt = new Date(y, m - 1, d).toLocaleDateString('es-BO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

/** Duración legible: «45 s», «12 min», «2 h 05 min». */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min${s % 60 ? ` ${String(s % 60).padStart(2, '0')} s` : ''}`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')} min`;
}

/** Origen del lote (panel, cronogramas, recordatorio automático, CSV). */
export function batchOrigin(meta: Record<string, any>): string {
  if (meta.origen === 'recordatorio_automatico') return 'Recordatorio automático';
  if (meta.origen_sistema === 'cronogramas' || meta.source === 'integration') return 'Cronogramas';
  if (meta.source === 'csv') return 'Importación CSV';
  return 'Panel';
}

const TIPOS: Record<string, string> = {
  participantes: 'Participantes', grupo: 'Grupo', grupos: 'Grupos', prospectos: 'Prospectos', cuotas: 'Cuotas',
  recordatorio: 'Recordatorio', academico: 'Académico', contable: 'Contable',
};
export function batchType(meta: Record<string, any>): string {
  const t = String(meta.tipo ?? meta.category ?? '');
  return t ? TIPOS[t] ?? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

/** Grupo de filtro de un estado (para los chips de la lista). */
function filterGroup(b: BatchListRow): string {
  if (b.status === 'running' || b.status === 'paused') return 'activos';
  if (b.status === 'scheduled' || b.status === 'awaiting_confirmation') return 'programados';
  if (b.status === 'cancelled') return 'cancelados';
  return 'terminados';
}

function progressOf(b: BatchListRow): number {
  return b.total > 0 ? Math.round(((b.sent + b.failed + b.skipped) / b.total) * 100) : 0;
}

/** Resumen corto de lectura y respuestas para la lista de lotes. */
function engLine(e: EngagementSummary | undefined): string {
  if (!e?.sent) return '';
  return `<div class="bt-eng" title="Leídos y respuestas (primeras ${REPLY_WINDOW_HOURS} h)">
    <span><i class="ri-check-double-line"></i>${e.tracked ? `${e.readRate ?? 0}% leídos` : 'sin acuses'}</span>
    <span${e.replied ? ' class="has"' : ''}><i class="ri-reply-line"></i>${e.replied} respondi${e.replied === 1 ? 'ó' : 'eron'}</span>
  </div>`;
}

export function batchesPage(
  rows: BatchListRow[],
  today: { batches: number; sent: number; failed: number; active: number },
  eng: Map<number, EngagementSummary> = new Map(),
): string {
  if (rows.length === 0) {
    return `<div class="card"><div class="card-body">${emptyState(
      'ri-send-plane-line',
      'Todavía no hay lotes',
      'Los envíos masivos (desde cronogramas, CSV o el panel) aparecen acá con su progreso en vivo.',
      '<a class="btn btn-primary btn-sm" href="/import"><i class="ri-upload-2-line me-1"></i>Importar CSV</a>',
    )}</div></div>`;
  }

  const counts: Record<string, number> = { todos: rows.length, activos: 0, programados: 0, terminados: 0, fallos: 0, cancelados: 0 };
  for (const b of rows) {
    counts[filterGroup(b)]++;
    if (b.failed > 0) counts.fallos++;
  }
  const lines = [...new Map(rows.map((b) => [b.session_id, `${b.line_phone ?? '—'} · ${b.line_owner ?? b.line_name ?? ''}`])).entries()];

  const kpi = (icon: string, tone: string, label: string, value: number | string, sub = '') =>
    `<div class="bt-kpi is-${tone}"><span class="bt-kpi-ic ${icon}" aria-hidden="true"></span>
       <div><div class="bt-kpi-v">${value}</div><div class="bt-kpi-l">${esc(label)}</div>${sub ? `<div class="bt-kpi-s">${esc(sub)}</div>` : ''}</div></div>`;

  const chip = (key: string, label: string, icon: string) =>
    `<button type="button" class="bt-chip${key === 'todos' ? ' on' : ''}" data-filter="${key}"${counts[key] ? '' : ' disabled'}>
       <span class="${icon}" aria-hidden="true"></span>${esc(label)}<b>${counts[key]}</b></button>`;

  // Filas agrupadas por día (ya vienen de la más nueva a la más vieja).
  const byDay = new Map<string, BatchListRow[]>();
  for (const b of rows) {
    const day = localDay(b.created_at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(b);
  }

  const row = (b: BatchListRow) => {
    const meta = safeMeta(b.meta);
    const pct = progressOf(b);
    const programa = meta.programa ? String(meta.programa) : '';
    const tipo = batchType(meta);
    const pide = meta.solicitado_por ?? b.requester_name ?? null;
    const origen = batchOrigin(meta);
    const search = [b.id, b.name, programa, tipo, pide, origen, b.line_phone, b.line_owner, b.line_name].filter(Boolean).join(' ').toLowerCase();
    const paused = b.status === 'paused' && meta.anti_ban_pause ? `<div class="bt-warn" title="${esc(meta.anti_ban_pause)}"><i class="ri-shield-star-line"></i> Pausado por el anti-baneo</div>` : '';
    const sched = b.scheduled_at && !String(b.scheduled_at).startsWith('9999') && (b.status === 'scheduled' || b.status === 'awaiting_confirmation')
      ? `<div class="bt-sched"><i class="ri-calendar-schedule-line"></i> Para ${esc(new Date(b.scheduled_at).toLocaleString('es-BO', { dateStyle: 'short', timeStyle: 'short' }))}</div>`
      : '';
    const live = ['running', 'scheduled', 'paused', 'awaiting_confirmation'].includes(b.status) ? '1' : '0';
    return `<div class="bt-row" data-batch="${b.id}" data-live="${live}" data-group="${filterGroup(b)}" data-failed="${b.failed > 0 ? 1 : 0}" data-line="${esc(b.session_id)}" data-search="${esc(search)}">
      <div class="bt-time"><b>${esc(fmtTime(b.created_at))}</b><span>#${b.id}</span></div>
      <div class="bt-main">
        <a class="bt-name" href="/batches/${b.id}" title="${esc(b.name ?? 'Lote')}">${esc(b.name ?? 'Lote')}</a>
        <div class="bt-tags">
          ${programa ? `<span class="bt-tag"><i class="ri-graduation-cap-line"></i>${esc(programa)}</span>` : ''}
          ${tipo ? `<span class="bt-tag is-type">${esc(tipo)}</span>` : ''}
          <span class="bt-tag is-origin">${esc(origen)}</span>
        </div>
        ${paused}${sched}
      </div>
      <div class="bt-who">
        <div class="bt-line" title="Línea que envía"><i class="ri-whatsapp-line"></i><span class="ff-monospace">${esc(b.line_phone ?? '—')}</span></div>
        <div class="bt-person" title="Dueño de la línea · quién pidió el envío">${esc(b.line_owner ?? b.line_name ?? '—')}${pide && pide !== b.line_owner ? ` <span>· pidió ${esc(String(pide))}</span>` : ''}</div>
      </div>
      <div class="bt-prog">
        <div class="bt-prog-top"><span><b data-f="sent">${b.sent}</b> / <span data-f="total">${b.total}</span> enviados</span><span class="bt-pct">${pct}%</span></div>
        <div class="progress progress-sm"><div class="progress-bar ${b.failed ? 'bg-warning' : 'bg-success'}" style="width:${pct}%"></div></div>
        <div class="bt-prog-sub">${b.failed ? `<span class="text-danger"><b data-f="failed">${b.failed}</b> fallidos</span>` : '<span data-f="failed" hidden>0</span>'}${b.skipped ? `<span class="text-warning">${b.skipped} omitidos</span>` : ''}</div>
        ${engLine(eng.get(b.id))}
      </div>
      <div class="bt-state">${statusBadge(b.status)}</div>
      <div class="bt-act">
        <a class="btn btn-soft-primary btn-sm" href="/batches/${b.id}"><i class="ri-eye-line me-1"></i>Detalle</a>
        ${b.failed > 0 ? `<form method="post" action="/batches/${b.id}/retry"><button class="btn btn-soft-warning btn-sm" type="submit" title="Reintentar los fallidos"><i class="ri-refresh-line"></i></button></form>` : ''}
      </div>
    </div>`;
  };

  const groups = [...byDay.entries()]
    .map(([day, list]) => {
      const enviados = list.reduce((s, b) => s + b.sent, 0);
      const total = list.reduce((s, b) => s + b.total, 0);
      return `<section class="bt-day" data-day="${day}">
        <h6 class="bt-day-h"><span>${esc(dayLabel(day))}</span><small>${list.length} lote${list.length === 1 ? '' : 's'} · ${enviados} de ${total} mensajes enviados</small></h6>
        <div class="bt-rows">${list.map(row).join('')}</div>
      </section>`;
    })
    .join('');

  return `<div class="batches-page" id="batches-page">
    <div class="bt-kpis">
      ${kpi('ri-stack-line', 'brand', 'Lotes de hoy', today.batches)}
      ${kpi('ri-send-plane-2-line', 'ok', 'Mensajes enviados hoy', today.sent)}
      ${kpi('ri-loader-4-line', 'warn', 'En curso o en pausa', today.active)}
      ${kpi('ri-error-warning-line', 'danger', 'Fallidos hoy', today.failed)}
    </div>
    <div class="bt-toolbar">
      <div class="bt-chips" role="tablist" aria-label="Estado">
        ${chip('todos', 'Todos', 'ri-apps-2-line')}
        ${chip('activos', 'En curso', 'ri-loader-4-line')}
        ${chip('programados', 'Programados', 'ri-calendar-schedule-line')}
        ${chip('terminados', 'Terminados', 'ri-checkbox-circle-line')}
        ${chip('fallos', 'Con fallos', 'ri-error-warning-line')}
        ${chip('cancelados', 'Cancelados', 'ri-close-circle-line')}
      </div>
      <div class="bt-filters">
        <label class="bt-search"><i class="ri-search-line" aria-hidden="true"></i>
          <input type="search" id="bt-q" placeholder="Buscar lote, programa, línea o quién pidió…" aria-label="Buscar lotes" autocomplete="off" /></label>
        ${lines.length > 1
          ? `<select id="bt-line" class="form-select form-select-sm" aria-label="Línea"><option value="">Todas las líneas</option>${lines
              .map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`)
              .join('')}</select>`
          : ''}
      </div>
    </div>
    <div class="bt-head" aria-hidden="true"><span>Hora</span><span>Lote</span><span>Línea · solicitante</span><span>Progreso</span><span>Estado</span><span></span></div>
    <div id="bt-list">${groups}</div>
    <div class="bt-empty" id="bt-empty" hidden><i class="ri-filter-off-line"></i> No hay lotes con estos filtros.</div>
    <p class="bt-foot">Se muestran los últimos ${rows.length} lotes. El progreso de los que están en curso se actualiza solo.</p>
  </div>
  <script>
  (function () {
    var root = document.getElementById('batches-page');
    if (!root) return;
    var st = { f: 'todos', q: '', line: '' };
    function apply() {
      var shown = 0;
      root.querySelectorAll('.bt-day').forEach(function (day) {
        var n = 0;
        day.querySelectorAll('.bt-row').forEach(function (r) {
          var ok = (st.f === 'todos' || (st.f === 'fallos' ? r.dataset.failed === '1' : r.dataset.group === st.f)) &&
            (!st.q || r.dataset.search.indexOf(st.q) !== -1) && (!st.line || r.dataset.line === st.line);
          r.hidden = !ok;
          if (ok) n++;
        });
        day.hidden = n === 0;
        shown += n;
      });
      document.getElementById('bt-empty').hidden = shown > 0;
    }
    root.querySelectorAll('.bt-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        st.f = b.dataset.filter;
        root.querySelectorAll('.bt-chip').forEach(function (x) { x.classList.toggle('on', x === b); });
        apply();
      });
    });
    var q = document.getElementById('bt-q');
    if (q) q.addEventListener('input', function () { st.q = q.value.trim().toLowerCase(); apply(); });
    var line = document.getElementById('bt-line');
    if (line) line.addEventListener('change', function () { st.line = line.value; apply(); });
  })();
  </script>`;
}

export interface BatchItemRow {
  id: number;
  chat_id: string;
  contact_name: string | null;
  body: string | null;
  content_type: string | null;
  media_path: string | null;
  media_mime: string | null;
  external_ref: string | null;
  status: string;
  error: string | null;
  message_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface BatchDetailRow extends BatchListRow {
  line_status?: string | null;
}

const ITEM_GROUPS: Array<[string, string, string]> = [
  ['todos', 'Todos', 'ri-apps-2-line'],
  ['sent', 'Enviados', 'ri-checkbox-circle-line'],
  ['failed', 'Fallidos', 'ri-error-warning-line'],
  ['pending', 'Pendientes', 'ri-time-line'],
  ['skipped', 'Omitidos', 'ri-skip-forward-line'],
  ['cancelled', 'Cancelados', 'ri-close-circle-line'],
];

const ENG_GROUPS: Array<[string, string, string]> = [
  ['read', 'Leyeron', 'ri-check-double-line'],
  ['unread', 'No leyeron', 'ri-eye-off-line'],
  ['replied', 'Respondieron', 'ri-reply-line'],
];

const MEDIA_LABEL: Record<string, string> = { image: 'Imagen', video: 'Video', audio: 'Audio', document: 'Documento', sticker: 'Sticker' };

/** Detalle completo de un lote. */
const ACK_VIEW: Record<string, [string, string, string]> = {
  sent: ['ri-check-line', 'is-sent', 'Enviado'],
  delivered: ['ri-check-double-line', 'is-delivered', 'Entregado'],
  read: ['ri-check-double-line', 'is-read', 'Leído'],
};

const KIND_ICON: Record<ReplyKind, string> = {
  pagado: 'ri-money-dollar-circle-line',
  comprobante: 'ri-bill-line',
  no_puede: 'ri-time-line',
  consulta: 'ri-question-line',
  baja: 'ri-forbid-line',
  otro: 'ri-chat-1-line',
};

/** Tarjeta «Lectura y respuestas» del detalle del lote. */
function engagementCard(sum: EngagementSummary, cobranza: boolean): string {
  if (!sum.sent) return '';
  const bar = (label: string, n: number, pct: number | null, tone: string, filter: string | null) =>
    `<div class="bd-funnel-row is-${tone}">
      <span class="bd-funnel-l">${filter ? `<button type="button" class="bd-link" data-goto="${filter}">${esc(label)}</button>` : esc(label)}</span>
      <div class="bd-funnel-bar"><span style="width:${pct ?? 0}%"></span></div>
      <span class="bd-funnel-v"><b>${n}</b> <small>${pct ?? 0}%</small></span>
    </div>`;
  const unread = sum.tracked - sum.read;
  const untracked = sum.sent - sum.tracked;
  const kinds = cobranza
    ? (Object.keys(sum.kinds) as ReplyKind[])
        .filter((k) => sum.kinds[k] > 0)
        .map((k) => `<li class="k-${k}"><i class="${KIND_ICON[k]}"></i><span>${esc(REPLY_KIND_LABEL[k])}</span><b>${sum.kinds[k]}</b></li>`)
        .join('')
    : '';
  return `<div class="bd-card bd-eng">
    <div class="bd-card-h"><span class="ri-eye-line" aria-hidden="true"></span><h6>Lectura y respuestas</h6>
      <span class="bd-pill" title="Se cuenta la primera respuesta dentro de las ${REPLY_WINDOW_HOURS} h del envío">respuestas en ${REPLY_WINDOW_HOURS} h</span></div>
    <div class="bd-eng-grid">
      <div class="bd-funnel">
        ${bar('Enviados', sum.sent, 100, 'brand', null)}
        ${bar('Entregados', sum.delivered, sum.deliveredRate, 'ok', null)}
        ${bar('Leídos', sum.read, sum.readRate, 'info', 'read')}
        ${bar('Respondieron', sum.replied, sum.replyRate, 'warn', 'replied')}
      </div>
      <div class="bd-eng-side">
        <div class="bd-eng-fig"><b>${sum.medianReplyMinutes === null ? '—' : esc(fmtMinutes(sum.medianReplyMinutes))}</b><span>tardan en responder (mediana)</span></div>
        ${unread > 0
          ? `<p class="bd-eng-hint"><i class="ri-lightbulb-line"></i> <b>${unread}</b> persona${unread === 1 ? '' : 's'} no ${unread === 1 ? 'leyó' : 'leyeron'} todavía. <button type="button" class="bd-link" data-goto="unread">Ver quiénes</button> para volver a escribirles.</p>`
          : sum.tracked
            ? '<p class="bd-eng-hint"><i class="ri-checkbox-circle-line"></i> Todos los que recibieron el mensaje lo leyeron.</p>'
            : ''}
        ${untracked > 0
          ? `<p class="bd-eng-note"><i class="ri-information-line"></i> ${untracked} envío${untracked === 1 ? '' : 's'} sin acuse registrado: no ${untracked === 1 ? 'entra' : 'entran'} en el porcentaje de entregados y leídos.</p>`
          : ''}
      </div>
    </div>
    ${kinds ? `<div class="bd-kinds"><h6>Qué respondieron</h6><ul>${kinds}</ul>
      <p class="bd-eng-note"><i class="ri-task-line"></i> «Ya pagó», comprobantes y «no puede pagar» crean una tarea en Notas para quien pidió el envío.</p></div>` : ''}
  </div>`;
}

export function batchDetailPage(
  b: BatchDetailRow,
  items: BatchItemRow[],
  extra: { truncated: boolean; engagement?: Map<number, ItemEngagement> },
): string {
  const eng = extra.engagement ?? new Map<number, ItemEngagement>();
  const meta = safeMeta(b.meta);
  const pct = progressOf(b);
  const pending = Math.max(0, b.total - b.sent - b.failed - b.skipped);
  const tipo = batchType(meta);
  const origen = batchOrigin(meta);
  const pide = meta.solicitado_por ?? b.requester_name ?? null;

  // Tiempos reales: del primer al último mensaje enviado.
  const sentTimes = items
    .filter((i) => i.status === 'sent' && i.updated_at)
    .map((i) => new Date(i.updated_at!).getTime())
    .sort((x, y) => x - y);
  const first = sentTimes[0];
  const last = sentTimes[sentTimes.length - 1];
  const started = b.started_at ? new Date(b.started_at).getTime() : first;
  const ended = b.finished_at ? new Date(b.finished_at).getTime() : undefined;
  const pace = sentTimes.length > 1 ? (last - first) / (sentTimes.length - 1) : null;

  const counts: Record<string, number> = { todos: items.length };
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
  const engTokens = (e: ItemEngagement | undefined): string[] => {
    if (!e?.sentAt) return [];
    if (e.reply) return ['read', 'replied'];
    if (e.ack === 'read') return ['read'];
    return e.ack === 'unknown' ? [] : ['unread'];
  };
  for (const it of items) for (const t of engTokens(eng.get(it.id))) counts[t] = (counts[t] ?? 0) + 1;
  const summary = summarizeEngagement(eng.values());
  const cobranza = COBRANZA_TIPOS.has(String(meta.tipo ?? ''));

  // Mensaje: único para todos o personalizado.
  const bodies = new Map<string, number>();
  for (const it of items) bodies.set(it.body ?? '', (bodies.get(it.body ?? '') ?? 0) + 1);
  const sample = items.find((i) => i.body) ?? items[0];
  const media = items.find((i) => i.media_path || (i.content_type && i.content_type !== 'text'));
  const mediaName = media?.media_path ? String(media.media_path).split(/[\\/]/).pop() : null;
  const sampleWho = sample ? sample.contact_name ?? String(sample.chat_id ?? '').replace(/@.*$/, '') : '';
  const mensaje = `<div class="bd-card">
      <div class="bd-card-h"><span class="ri-chat-3-line" aria-hidden="true"></span><h6>Mensaje enviado</h6>
        <span class="bd-pill">${bodies.size <= 1 ? 'Igual para todos' : `Personalizado · ${bodies.size} variantes`}</span></div>
      <div class="bd-bubble-wrap">
        ${bodies.size > 1 ? `<div class="bd-sample">Ejemplo: ${esc(sampleWho)}</div>` : ''}
        ${media
          ? `<div class="bd-media"><span class="ri-attachment-2" aria-hidden="true"></span>${esc(MEDIA_LABEL[media.content_type ?? ''] ?? 'Adjunto')}${mediaName ? ` · <span class="ff-monospace">${esc(mediaName)}</span>` : ''}${media.media_mime ? ` <span class="text-muted">(${esc(media.media_mime)})</span>` : ''}</div>`
          : ''}
        <div class="bd-bubble">${sample?.body ? esc(sample.body) : '<i>(sin texto: solo adjunto)</i>'}</div>
      </div>
    </div>`;

  const kv = (k: string, v: string) => `<div class="bd-kv"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  const fecha = (iso: string | null | undefined) =>
    iso ? esc(new Date(iso).toLocaleString('es-BO', { dateStyle: 'medium', timeStyle: 'short' })) : '—';
  const duracion = started && ended
    ? esc(fmtDuration(ended - started))
    : b.status === 'running' && started
      ? 'En curso · ' + esc(fmtDuration(Date.now() - started))
      : '—';
  const ficha = `<div class="bd-card">
      <div class="bd-card-h"><span class="ri-file-list-3-line" aria-hidden="true"></span><h6>Ficha del envío</h6></div>
      <dl class="bd-kvs">
        ${kv('Pedido por', pide ? `<b>${esc(String(pide))}</b>` : '—')}
        ${kv('Línea que envía', `<span class="ff-monospace">${esc(b.line_phone ?? '—')}</span> · ${esc(b.line_owner ?? b.line_name ?? '—')} ${statusBadge(b.line_status ?? null)}`)}
        ${kv('Origen', esc(origen) + (meta.area ? ` · área ${esc(String(meta.area))}` : ''))}
        ${meta.programa ? kv('Programa', esc(String(meta.programa)) + (meta.gestion ? ` · gestión ${esc(String(meta.gestion))}` : '')) : ''}
        ${tipo ? kv('Tipo', esc(tipo) + (meta.modo ? ` · ${esc(String(meta.modo))}` : '')) : ''}
        ${kv('Creado', fecha(b.created_at))}
        ${b.scheduled_at && !String(b.scheduled_at).startsWith('9999') ? kv('Programado para', fecha(b.scheduled_at)) : ''}
        ${kv('Inició', fecha(b.started_at))}
        ${kv('Terminó', fecha(b.finished_at))}
        ${kv('Duración', duracion)}
        ${kv('Primer mensaje', first ? esc(fmtTime(new Date(first).toISOString())) : '—')}
        ${kv('Último mensaje', last ? esc(fmtTime(new Date(last).toISOString())) : '—')}
        ${kv('Ritmo real', pace !== null ? `<b>${esc(fmtDuration(pace))}</b> por mensaje (promedio)` : '—')}
        ${meta.confirm_group
          ? kv('Confirmación', `<a href="/batches/confirm/${encodeURIComponent(meta.confirm_group)}">${b.status === 'awaiting_confirmation' ? 'Esperando confirmación →' : 'Ver programación →'}</a>`)
          : ''}
      </dl>
    </div>`;

  // Motivos de fallo agrupados.
  const errors = new Map<string, number>();
  for (const it of items) {
    if (it.status !== 'failed') continue;
    const key = it.error || 'Sin detalle';
    errors.set(key, (errors.get(key) ?? 0) + 1);
  }
  const fallos = errors.size
    ? `<div class="bd-card bd-errors">
        <div class="bd-card-h"><span class="ri-error-warning-line" aria-hidden="true"></span><h6>Motivos de fallo</h6></div>
        <ul>${[...errors.entries()].sort((x, y) => y[1] - x[1]).map(([e, n]) => `<li><b>${n}</b><span>${esc(e)}</span></li>`).join('')}</ul>
      </div>`
    : '';

  const kpi = (label: string, field: string, value: number, tone: string) =>
    `<div class="bd-kpi is-${tone}"><div class="bd-kpi-v" data-f="${field}">${value}</div><div class="bd-kpi-l">${esc(label)}</div></div>`;

  const itemRow = (it: BatchItemRow, n: number) => {
    const phone = String(it.chat_id ?? '').replace(/@.*$/, '');
    const isGroup = String(it.chat_id ?? '').endsWith('@g.us');
    const body = it.body ?? '';
    const short = body.length > 90 ? body.slice(0, 90) + '…' : body;
    const when = it.status === 'sent' && it.updated_at ? fmtTime(it.updated_at) : '—';
    const e = eng.get(it.id);
    const r = e?.reply ?? null;
    const search = `${it.contact_name ?? ''} ${phone} ${body} ${it.error ?? ''} ${r?.body ?? ''}`.toLowerCase();
    const ack = e?.ack && ACK_VIEW[e.ack] ? ACK_VIEW[r && e.ack !== 'read' ? 'read' : e.ack] : null;
    const replyText = r ? (r.body?.trim() ? r.body.trim() : r.contentType === 'text' ? '(sin texto)' : `(${MEDIA_LABEL[r.contentType] ?? 'adjunto'})`) : '';
    const lectura = `${ack ? `<span class="bd-ack ${ack[1]}"><i class="${ack[0]}"></i>${ack[2]}</span>` : ''}${r
      ? `<a class="bd-reply k-${r.kind}" href="/conversations/${encodeURIComponent(it.chat_id)}" title="Abrir la conversación">
          ${cobranza ? `<span class="bd-reply-k"><i class="${KIND_ICON[r.kind]}"></i>${esc(REPLY_KIND_LABEL[r.kind])}</span>` : ''}
          <span class="bd-reply-t">${esc(replyText.length > 120 ? replyText.slice(0, 120) + '…' : replyText)}</span>
          <small>respondió a los ${esc(fmtMinutes(r.minutes))}</small></a>`
      : ''}`;
    const msg = body.length > 90
      ? `<details><summary>${esc(short)}</summary><div class="bd-full">${esc(body)}</div></details>`
      : `<span>${esc(short || '—')}</span>`;
    return `<tr data-st="${esc(it.status)}" data-eng="${engTokens(e).join(' ')}" data-search="${esc(search)}">
      <td class="text-muted">${n}</td>
      <td><div class="bd-dest">${esc(it.contact_name ?? (isGroup ? 'Grupo' : '—'))}</div>
        <a class="bd-phone ff-monospace" href="/conversations/${encodeURIComponent(it.chat_id)}" title="Abrir la conversación">${isGroup ? '<i class="ri-group-line"></i> ' : ''}${esc(phone)}</a></td>
      <td>${statusBadge(it.status)}</td>
      <td class="text-nowrap">${esc(when)}</td>
      <td class="bd-read">${lectura || '<span class="text-muted">—</span>'}</td>
      <td class="bd-msg">${msg}</td>
      <td class="bd-err">${it.error ? esc(it.error) : ''}${it.external_ref ? `<div class="bd-ref" title="Referencia de origen">${esc(it.external_ref)}</div>` : ''}</td>
    </tr>`;
  };

  const chips = ITEM_GROUPS.filter(([k]) => k === 'todos' || counts[k])
    .map(([k, l, i]) => `<button type="button" class="bt-chip${k === 'todos' ? ' on' : ''}" data-st="${k}"><span class="${i}" aria-hidden="true"></span>${esc(l)}<b>${counts[k] ?? 0}</b></button>`)
    .join('') +
    ENG_GROUPS.filter(([k]) => counts[k])
      .map(([k, l, i]) => `<button type="button" class="bt-chip is-eng" data-st="${k}"><span class="${i}" aria-hidden="true"></span>${esc(l)}<b>${counts[k]}</b></button>`)
      .join('');

  return `<div class="batch-detail" id="batch-detail" data-batch="${b.id}">
    <div class="bd-head">
      <a class="bd-back" href="/batches" title="Volver a Lotes" aria-label="Volver a Lotes"><i class="ri-arrow-left-line"></i></a>
      <div class="bd-title">
        <h4>#${b.id} · ${esc(b.name ?? 'Lote')}</h4>
        <div class="bt-tags">
          ${meta.programa ? `<span class="bt-tag"><i class="ri-graduation-cap-line"></i>${esc(String(meta.programa))}</span>` : ''}
          ${tipo ? `<span class="bt-tag is-type">${esc(tipo)}</span>` : ''}
          <span class="bt-tag is-origin">${esc(origen)}</span>
        </div>
      </div>
      <div class="bd-status">${statusBadge(b.status)}</div>
    </div>

    ${b.status === 'paused' && meta.anti_ban_pause
      ? `<div class="alert alert-warning d-flex gap-2 align-items-start" role="status"><i class="ri-shield-star-line fs-5"></i><div><b>Pausado por el anti-baneo.</b> ${esc(meta.anti_ban_pause)}</div></div>`
      : ''}

    <div class="bd-kpis">
      ${kpi('Total', 'total', b.total, 'brand')}
      ${kpi('Enviados', 'sent', b.sent, 'ok')}
      ${kpi('Fallidos', 'failed', b.failed, 'danger')}
      ${kpi('Omitidos', 'skipped', b.skipped, 'warn')}
      ${kpi('Pendientes', 'pending', pending, 'mute')}
      <div class="bd-progress">
        <div class="bd-progress-top"><span>Progreso</span><b>${pct}%</b></div>
        <div class="progress"><div class="progress-bar ${b.failed ? 'bg-warning' : 'bg-success'}" style="width:${pct}%"></div></div>
      </div>
    </div>

    <div class="bd-actions">
      <form method="post" action="/batches/${b.id}/pause"><button class="btn btn-soft-warning btn-sm" type="submit"><i class="ri-pause-line me-1"></i>Pausar</button></form>
      <form method="post" action="/batches/${b.id}/resume"><button class="btn btn-soft-success btn-sm" type="submit"><i class="ri-play-line me-1"></i>Reanudar</button></form>
      <form method="post" action="/batches/${b.id}/cancel" onsubmit="return confirm('¿Cancelar los mensajes pendientes de este lote? Lo ya enviado no se deshace.')"><button class="btn btn-soft-danger btn-sm" type="submit"><i class="ri-close-line me-1"></i>Cancelar</button></form>
      ${b.failed > 0 ? `<form method="post" action="/batches/${b.id}/retry"><button class="btn btn-soft-primary btn-sm" type="submit"><i class="ri-refresh-line me-1"></i>Reintentar fallidos (${b.failed})</button></form>` : ''}
      <form method="post" action="/batches/${b.id}/schedule" class="bd-schedule">
        <input type="datetime-local" name="scheduled_at" class="form-control form-control-sm" aria-label="Programar para" />
        <button class="btn btn-soft-secondary btn-sm" type="submit"><i class="ri-calendar-schedule-line me-1"></i>Programar</button>
      </form>
    </div>

    ${engagementCard(summary, cobranza)}

    <div class="bd-grid">
      ${ficha}
      <div class="bd-col">${mensaje}${fallos}</div>
    </div>

    <div class="bd-card bd-items">
      <div class="bd-card-h"><span class="ri-group-line" aria-hidden="true"></span><h6>Destinatarios</h6>
        <span class="bd-pill">${items.length}${extra.truncated ? ' (primeros)' : ''}</span></div>
      <div class="bd-items-bar">
        <div class="bt-chips">${chips}</div>
        <label class="bt-search"><i class="ri-search-line" aria-hidden="true"></i><input type="search" id="bd-q" placeholder="Buscar nombre, número, mensaje o error…" aria-label="Buscar destinatarios" autocomplete="off" /></label>
      </div>
      <div class="table-responsive">
        <table class="table table-hover align-middle mb-0 bd-table">
          <thead class="table-light"><tr><th>#</th><th>Destinatario</th><th>Estado</th><th>Hora</th><th>Lectura · respuesta</th><th>Mensaje</th><th>Detalle</th></tr></thead>
          <tbody>${items.map((it, i) => itemRow(it, i + 1)).join('')}</tbody>
        </table>
      </div>
      <div class="bt-empty" id="bd-empty" hidden><i class="ri-filter-off-line"></i> Ningún destinatario con estos filtros.</div>
    </div>
  </div>
  <script>
  (function () {
    var root = document.getElementById('batch-detail');
    if (!root) return;
    var st = { s: 'todos', q: '' };
    function apply() {
      var n = 0;
      root.querySelectorAll('.bd-table tbody tr').forEach(function (r) {
        var ok = (st.s === 'todos' || r.dataset.st === st.s || (' ' + (r.dataset.eng || '') + ' ').indexOf(' ' + st.s + ' ') !== -1) &&
          (!st.q || r.dataset.search.indexOf(st.q) !== -1);
        r.hidden = !ok;
        if (ok) n++;
      });
      document.getElementById('bd-empty').hidden = n > 0;
    }
    root.querySelectorAll('.bd-items .bt-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        st.s = b.dataset.st;
        root.querySelectorAll('.bd-items .bt-chip').forEach(function (x) { x.classList.toggle('on', x === b); });
        apply();
      });
    });
    var q = document.getElementById('bd-q');
    q.addEventListener('input', function () { st.q = q.value.trim().toLowerCase(); apply(); });
    root.querySelectorAll('[data-goto]').forEach(function (b) {
      b.addEventListener('click', function () {
        var chip = root.querySelector('.bd-items .bt-chip[data-st="' + b.dataset.goto + '"]');
        if (!chip) return;
        chip.click();
        root.querySelector('.bd-items').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  })();
  </script>`;
}
