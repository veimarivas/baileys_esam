import { esc } from './layout.js';
import type { SessionRow, BatchRow } from '../types.js';

const STAT_ICONS: Record<string, string> = {
  primary: 'ri-bar-chart-2-line',
  success: 'ri-checkbox-circle-line',
  danger: 'ri-error-warning-line',
  warning: 'ri-time-line',
  info: 'ri-information-line',
  secondary: 'ri-more-line',
};

export function stat(k: string, v: unknown, color = 'primary', icon?: string, sub?: string): string {
  const ico = icon ?? STAT_ICONS[color] ?? STAT_ICONS.primary;
  return `<div class="card card-height-100 stat-card">
    <div class="card-body">
      <div class="d-flex align-items-start gap-3">
        <span class="stat-ico bg-${color}-subtle text-${color}"><i class="${ico}"></i></span>
        <div class="flex-grow-1 min-w-0">
          <p class="stat-label mb-0">${esc(k)}</p>
          <div class="stat-value">${v}</div>
          ${sub ? `<p class="stat-sub">${esc(sub)}</p>` : ''}
        </div>
      </div>
    </div>
  </div>`;
}

/** Encabezado de sección: estructura la página sin anidar tarjetas. */
export function sectionHead(icon: string, title: string, desc?: string, action?: string): string {
  return `<div class="section-head">
    <span class="section-head-ico"><i class="${icon}"></i></span>
    <div class="section-head-body">
      <h5>${esc(title)}</h5>
      ${desc ? `<p>${esc(desc)}</p>` : ''}
    </div>
    ${action ? `<div class="section-head-action">${action}</div>` : ''}
  </div>`;
}

/** Lista de pares etiqueta/valor (datos de configuración y estado). */
export function kvList(rows: Array<[string, string]>): string {
  const body = rows
    .map(([k, v]) => `<div class="kv-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`)
    .join('');
  return `<dl class="kv-list">${body}</dl>`;
}

/** Aviso contextual breve (no es una alerta de error; guía al usuario). */
export function insight(kind: 'good' | 'warn' | 'info', text: string): string {
  const icons = { good: 'ri-checkbox-circle-line', warn: 'ri-alert-line', info: 'ri-lightbulb-line' };
  return `<div class="insight is-${kind}">
    <span class="insight-ico"><i class="${icons[kind]}"></i></span>
    <p>${esc(text)}</p>
  </div>`;
}

export function badge(text: string, kind: 'success' | 'danger' | 'warning' | 'secondary' | 'info' = 'secondary'): string {
  return `<span class="badge bg-${kind}-subtle text-${kind}">${esc(text)}</span>`;
}

/** Estado vacío didáctico: enseña qué hacer en lugar de decir "nada aquí". */
export function emptyState(icon: string, title: string, text: string, action = ''): string {
  return `<div class="empty-state">
    <span class="empty-ico"><i class="${icon}"></i></span>
    <h6>${esc(title)}</h6>
    <p>${esc(text)}</p>
    ${action ? `<div class="empty-action mt-3">${action}</div>` : ''}
  </div>`;
}

export function statusBadge(status: string | null | undefined): string {
  const s = status ?? 'created';
  const kind =
    s === 'ready' || s === 'done' || s === 'sent' || s === 'delivered' || s === 'read'
      ? 'success'
      : s === 'disconnected' || s === 'blocked' || s === 'failed' || s === 'cancelled'
        ? 'danger'
        : s === 'qr' || s === 'paused' || s === 'scheduled' || s === 'pending' || s === 'connecting'
          ? 'warning'
          : 'secondary';
  const label: Record<string, string> = {
    created: 'Creada', connecting: 'Conectando', qr: 'Esperando QR', ready: 'Conectada',
    disconnected: 'Desconectada', blocked: 'Bloqueada', running: 'En curso', done: 'Completado',
    paused: 'Pausado', cancelled: 'Cancelado', scheduled: 'Programado', pending: 'Pendiente',
    sent: 'Enviado', failed: 'Fallido', skipped: 'Omitido', delivered: 'Entregado', read: 'Leído',
  };
  return `<span class="badge badge-status bg-${kind}-subtle text-${kind}"><span class="badge-dot"></span>${esc(label[s] ?? s)}</span>`;
}

function initials(name: string | null | undefined): string {
  return (name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

/** Modal de confirmación para desvincular el número (acción que exige volver a escanear el QR). */
function unlinkModal(session: SessionRow): string {
  return `<div class="modal fade" id="unlink-modal" tabindex="-1" aria-labelledby="unlink-modal-title" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered">
      <form class="modal-content js-once" method="post" action="/settings/logout">
        <div class="modal-header border-0 pb-0">
          <h5 class="modal-title d-flex align-items-center gap-2" id="unlink-modal-title">
            <span class="unlink-ico"><i class="ri-error-warning-line"></i></span>¿Desvincular este número?
          </h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button>
        </div>
        <div class="modal-body">
          <div class="unlink-target">
            <i class="ri-whatsapp-line"></i>
            <span class="ff-monospace">${esc(session.phone ?? '—')}</span>
            <span class="text-muted">· sesión ${esc(session.name)}</span>
          </div>
          <ul class="unlink-list">
            <li>El panel deja de recibir y enviar mensajes de este número hasta que lo vuelvas a vincular.</li>
            <li>Los lotes y envíos automáticos de este número no se podrán enviar mientras tanto.</li>
            <li>Para volver a conectar hay que <b>escanear el QR</b> con el teléfono.</li>
            <li>Las conversaciones y notas guardadas <b>no se borran</b>.</li>
          </ul>
          <p class="unlink-hint mb-0"><i class="ri-lightbulb-line me-1"></i>Si el problema es que las conversaciones no se actualizan, cancelá y usá <b>Reconectar</b>.</p>
        </div>
        <div class="modal-footer border-0 pt-0">
          <button type="button" class="btn btn-light" data-bs-dismiss="modal" autofocus>Cancelar</button>
          <button type="submit" class="btn btn-danger"><i class="ri-logout-box-r-line me-1"></i>Sí, desvincular</button>
        </div>
      </form>
    </div>
  </div>`;
}

/** Tarjeta de conexión con QR/pairing (o creación de la primera sesión). */
export function connectionCard(session: SessionRow | undefined, subtitle?: string): string {
  if (!session) {
    return `
    <div class="card">
      <div class="card-header"><h5 class="card-title mb-0">Conexión</h5></div>
      <div class="card-body">
        ${insight('info', 'Todavía no hay ninguna sesión creada. Creá la sesión principal para vincular el número de WhatsApp de la institución.')}
        <form method="post" action="/settings/create" class="row g-2 align-items-end">
          <div class="col-md-7">
            <label class="form-label">Nombre de la sesión</label>
            <input name="name" class="form-control" value="esam-principal" required />
          </div>
          <div class="col-md-5">
            <button class="btn btn-primary w-100" type="submit"><i class="ri-add-line me-1"></i>Crear sesión</button>
          </div>
        </form>
      </div>
    </div>`;
  }
  const connected = session.status === 'ready';
  const statusPanel = connected
    ? `<div class="conn-status is-on">
         <span class="conn-ico"><i class="ri-whatsapp-line"></i></span>
         <div class="conn-body">
           <div class="conn-title">Número vinculado</div>
           <div class="conn-sub"><span class="ff-monospace">${esc(session.phone ?? '—')}</span> · Sesión <span class="ff-monospace">${esc(session.name)}</span></div>
         </div>
       </div>`
    : `<div class="conn-status is-off">
         <span class="conn-ico"><i class="ri-link-m"></i></span>
         <div class="conn-body">
           <div class="conn-title">Esperando vinculación</div>
           <div class="conn-sub">Mostrá el código QR o generá un código de vinculación para conectar este número.</div>
         </div>
       </div>`;

  const actions = connected
    ? `<div class="conn-actions">
         <form method="post" action="/settings/reconnect" class="js-once">
           <button class="btn btn-soft-primary" type="submit" title="Reabre la conexión con WhatsApp sin desvincular el número">
             <i class="ri-refresh-line me-1"></i>Reconectar</button>
         </form>
         <button class="btn btn-soft-danger" type="button" data-bs-toggle="modal" data-bs-target="#unlink-modal">
           <i class="ri-logout-box-r-line me-1"></i>Desvincular</button>
       </div>
       <p class="form-text mt-2 mb-0"><i class="ri-information-line me-1"></i>Si las conversaciones no se actualizan, probá primero <b>Reconectar</b>: no hace falta volver a escanear el QR.</p>
       ${unlinkModal(session)}`
    : `<div class="conn-actions">
         <button class="btn btn-primary" id="btn-start" type="button"><i class="ri-qr-code-line me-1"></i>Mostrar QR</button>
         <form method="post" action="/settings/pairing" class="d-flex gap-2 flex-grow-1 flex-sm-grow-0">
           <input name="phone_number" class="form-control" placeholder="591XXXXXXXX" style="min-width:150px" />
           <button class="btn btn-soft-primary" type="submit"><i class="ri-key-2-line me-1"></i>Código</button>
         </form>
       </div>
       <div id="qr-box" class="text-center" data-session="${esc(session.id)}"><span class="text-muted">Pulsá “Mostrar QR” para vincular el número.</span></div>`;

  return `
  <div class="card">
    <div class="card-header d-flex align-items-center justify-content-between">
      <h5 class="card-title mb-0">Conexión${subtitle ? ` · ${esc(subtitle)}` : ''}</h5>
      ${statusBadge(session.status)}
    </div>
    <div class="card-body conn-hero">
      ${statusPanel}
      ${actions}
    </div>
  </div>`;
}

/** Lista de lotes en tarjetas con barra de progreso. */
export function batchList(rows: BatchRow[]): string {
  if (rows.length === 0) {
    return `<div class="card"><div class="card-body">${emptyState(
      'ri-send-plane-line',
      'Todavía no hay lotes',
      'Importá un CSV para crear tu primer envío. Vas a poder seguir el progreso en vivo desde acá.',
      '<a class="btn btn-primary btn-sm" href="/import"><i class="ri-upload-2-line me-1"></i>Importar CSV</a>',
    )}</div></div>`;
  }
  return `<div class="row g-3">${rows
    .map((b) => {
      const progress = b.total > 0 ? Math.round(((b.sent + b.failed + b.skipped) / b.total) * 100) : 0;
      const meta = b.meta ? safeJson(b.meta) : {};
      const programa = (meta as any)?.programa ? String((meta as any).programa) : '';
      return `<div class="col-xxl-4 col-md-6" data-batch="${b.id}">
        <div class="card card-hover card-height-100">
          <div class="card-header d-flex align-items-center gap-2">
            <span class="batch-ico"><i class="ri-send-plane-fill"></i></span>
            <div class="flex-grow-1 min-w-0">
              <h6 class="card-title mb-0 text-truncate">#${b.id} · ${esc(b.name ?? 'Lote')}</h6>
              ${programa ? `<p class="batch-sub mb-0 text-truncate"><i class="ri-graduation-cap-line me-1"></i>${esc(programa)}</p>` : ''}
            </div>
            ${statusBadge(b.status)}
          </div>
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-baseline mb-2">
              <span class="stat-label">Progreso</span>
              <span class="fw-bold">${progress}%</span>
            </div>
            <div class="progress progress-sm mb-3"><div class="progress-bar bg-success" style="width:${progress}%"></div></div>
            ${b.status === 'paused' && (meta as any)?.anti_ban_pause
              ? `<p class="small text-warning mb-2" title="${esc((meta as any).anti_ban_pause)}"><i class="ri-shield-star-line me-1"></i>Pausado por el anti-baneo: ${esc((meta as any).anti_ban_pause)}</p>`
              : ''}
            <div class="batch-stats">
              <div><span>Total</span><b data-f="total">${b.total}</b></div>
              <div><span>Enviados</span><b class="text-success" data-f="sent">${b.sent}</b></div>
              <div><span>Fallidos</span><b class="text-danger" data-f="failed">${b.failed}</b></div>
            </div>
            <div class="d-flex gap-2 mt-3">
              <a class="btn btn-soft-primary btn-sm flex-grow-1" href="/batches/${b.id}">Ver detalle</a>
              ${b.failed > 0 ? `<form method="post" action="/batches/${b.id}/retry"><button class="btn btn-soft-warning btn-sm" type="submit">Reintentar</button></form>` : ''}
            </div>
          </div>
        </div>
      </div>`;
    })
    .join('')}</div>`;
}

/** Tabla Bootstrap con filas ya-renderizadas. */
export function table(columns: string[], rows: string[][]): string {
  return `<div class="table-responsive">
    <table class="table table-hover align-middle mb-0">
      <thead class="table-light"><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
  </div>`;
}

/** Envuelve contenido en una tarjeta con título. */
export function card(title: string, body: string, extra = ''): string {
  return `<div class="card">
    <div class="card-header d-flex align-items-center"><h5 class="card-title mb-0">${esc(title)}</h5>${extra}</div>
    <div class="card-body">${body}</div>
  </div>`;
}

export function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-BO', { dateStyle: 'short', timeStyle: 'short' });
}

export { initials };
