import { esc } from './layout.js';
import { statusBadge } from './views.js';
import type { LineIssue } from '../core/line-health.js';
import type { LineVerdict, VerdictCheck } from '../core/line-verdict.js';

/**
 * Consistencia de líneas (Configuración): problemas entre cuentas y líneas de
 * WhatsApp, con su explicación y la reparación de un clic cuando es segura.
 */

const SEVERITY: Record<LineIssue['severity'], { label: string; tone: string; icon: string }> = {
  alta: { label: 'Grave', tone: 'danger', icon: 'ri-error-warning-line' },
  media: { label: 'Atención', tone: 'warn', icon: 'ri-alert-line' },
  baja: { label: 'Aviso', tone: 'info', icon: 'ri-information-line' },
};

function lineRow(l: LineIssue['lines'][number]): string {
  return `<tr>
    <td><b>${esc(l.name)}</b><small class="lh-id">${esc(l.id.slice(0, 8))}</small></td>
    <td>${esc(l.owner ?? '—')}${l.ownerUid ? `<small class="lh-id">cuenta ${esc(l.ownerUid)}</small>` : ''}</td>
    <td class="ff-monospace">${esc(l.expected ?? '—')}</td>
    <td class="ff-monospace">${esc(l.phone ?? '—')}</td>
    <td>${statusBadge(l.status)}</td>
  </tr>`;
}

/** Tarjeta resumen para la página de Conexión. */
export function linesHealthCard(issues: LineIssue[]): string {
  const graves = issues.filter((i) => i.severity === 'alta').length;
  const medias = issues.filter((i) => i.severity === 'media').length;
  const tone = graves ? 'danger' : medias ? 'warning' : 'success';
  const text = graves || medias
    ? `${graves ? `${graves} grave${graves === 1 ? '' : 's'}` : ''}${graves && medias ? ' y ' : ''}${medias ? `${medias} para revisar` : ''}`
    : 'Cuentas y líneas en orden';
  return `<a class="lh-card lh-${tone}" href="/settings/lines">
    <span class="lh-card-ic ri-git-merge-line" aria-hidden="true"></span>
    <span class="lh-card-txt"><b>Consistencia de líneas</b><small>${esc(text)}</small></span>
    <span class="ri-arrow-right-s-line" aria-hidden="true"></span>
  </a>`;
}

export function linesHealthPage(issues: LineIssue[], flash: { ok?: string; error?: string }): string {
  const count = (s: LineIssue['severity']) => issues.filter((i) => i.severity === s).length;
  const banner = flash.ok
    ? `<div class="alert alert-success d-flex gap-2"><i class="ri-checkbox-circle-line"></i><div>${esc(flash.ok)}</div></div>`
    : flash.error
      ? `<div class="alert alert-danger d-flex gap-2"><i class="ri-error-warning-line"></i><div>${esc(flash.error)}</div></div>`
      : '';
  const resumen = `<div class="lh-sum">
    <div class="lh-sum-i is-danger"><b>${count('alta')}</b><span>graves</span></div>
    <div class="lh-sum-i is-warn"><b>${count('media')}</b><span>para revisar</span></div>
    <div class="lh-sum-i is-info"><b>${count('baja')}</b><span>avisos</span></div>
  </div>`;
  const intro = `<p class="lh-intro">Cada usuario de cronogramas envía <b>solo desde la línea de su número</b>. Si la relación entre cuentas y líneas se desordena
    (una cuenta con dos líneas, la línea de otra área asociada, un número esperado distinto), un envío puede bloquearse o salir desde un número que no corresponde.
    Acá se ve qué está mal y, cuando es seguro, se repara con un clic. Se revisa sola cada hora y avisa en la campana.</p>`;

  if (!issues.length) {
    return `<div class="lines-health">${banner}${intro}
      <div class="lh-ok"><span class="ri-shield-check-line" aria-hidden="true"></span><h5>Todo en orden</h5>
      <p>Cada cuenta tiene una sola línea, con el número registrado en cronogramas.</p></div></div>`;
  }

  const cards = issues.map((i) => {
    const sev = SEVERITY[i.severity];
    const fixes = i.fixes.map((f) => `<form method="post" action="/settings/lines/fix" class="lh-fix js-once"
        onsubmit="return confirm(${esc(JSON.stringify(f.explain + '\n\n¿Aplicar este cambio?'))})">
        <input type="hidden" name="action" value="${esc(f.action)}" />
        <input type="hidden" name="session" value="${esc(f.sessionId)}" />
        ${f.uid ? `<input type="hidden" name="uid" value="${esc(f.uid)}" />` : ''}
        <button type="submit" class="btn btn-sm btn-primary"><i class="ri-tools-line me-1"></i>${esc(f.label)}</button>
      </form>`).join('');
    return `<article class="lh-issue is-${sev.tone}">
      <header class="lh-issue-h">
        <span class="lh-sev"><i class="${sev.icon}"></i> ${sev.label}</span>
        <h6>${esc(i.title)}</h6>
      </header>
      <p class="lh-detail">${esc(i.detail)}</p>
      ${i.user ? `<p class="lh-user"><i class="ri-user-line"></i> ${esc(i.user.name)} · número en cronogramas: <span class="ff-monospace">${esc(i.user.numero ?? '—')}</span></p>` : ''}
      ${i.lines.length ? `<div class="table-responsive"><table class="table table-sm align-middle mb-2 lh-table">
        <thead><tr><th>Línea</th><th>Dueño</th><th>Espera</th><th>Vinculado</th><th>Estado</th></tr></thead>
        <tbody>${i.lines.map(lineRow).join('')}</tbody></table></div>` : ''}
      ${fixes ? `<div class="lh-fixes">${fixes}</div>` : ''}
      ${i.hint ? `<p class="lh-hint"><i class="ri-lightbulb-line"></i> ${esc(i.hint)}</p>` : ''}
    </article>`;
  }).join('');

  return `<div class="lines-health">${banner}${intro}${resumen}<div class="lh-list">${cards}</div></div>`;
}

const VERDICT_ICON: Record<LineVerdict['level'], string> = { green: 'ri-shield-check-line', yellow: 'ri-alert-line', red: 'ri-forbid-line' };
const CHECK_VIEW: Record<VerdictCheck['status'], [string, string]> = {
  ok: ['ri-checkbox-circle-fill', 'En orden'],
  warn: ['ri-error-warning-fill', 'Atención'],
  bad: ['ri-close-circle-fill', 'Problema'],
  info: ['ri-information-fill', 'Sin datos suficientes'],
};

/** Semáforo del número para Conexión: «¿está sano para enviar?» y por qué. */
export function lineVerdictCard(v: LineVerdict): string {
  const s = v.stats;
  const fig = (label: string, value: string) => `<div class="lv-fig"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const checks = v.checks.map((c) => {
    const [icon, label] = CHECK_VIEW[c.status];
    const open = c.status === 'warn' || c.status === 'bad';
    return `<details class="lv-check is-${c.status}"${open ? ' open' : ''}>
      <summary>
        <i class="${icon}" aria-label="${esc(label)}"></i>
        <span class="lv-check-l">${esc(c.label)}</span>
        <span class="lv-check-v">${esc(c.value)}</span>
      </summary>
      <div class="lv-check-b">
        <p><b>Qué mide:</b> ${esc(c.why)}</p>
        <p><b>Cuándo cambia de color:</b> ${esc(c.rule)}</p>
        ${c.fix ? `<p class="lv-check-fix"><i class="ri-tools-line"></i> <b>Cómo solucionarlo:</b> ${esc(c.fix)}</p>` : ''}
      </div>
    </details>`;
  }).join('');
  return `<section class="lv-card lv-${v.level}" aria-label="Salud del número">
    <div class="lv-top">
      <div class="lv-light" aria-hidden="true"><span class="lv-r"></span><span class="lv-y"></span><span class="lv-g"></span></div>
      <div class="lv-main">
        <h6><i class="${VERDICT_ICON[v.level]}"></i> ${esc(v.title)}</h6>
        <ul class="lv-reasons">${v.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        ${v.action ? `<p class="lv-action"><i class="ri-lightbulb-line"></i> ${esc(v.action)}</p>` : ''}
      </div>
      <div class="lv-figs">
        ${fig('enviados por el sistema 24 h', String(s.sent24h))}
        ${fig('entrega', s.deliveryRate === null ? '—' : `${Math.round(s.deliveryRate * 100)}%`)}
        ${fig('bloqueos 24 h', String(s.blocked24h))}
        ${fig('cupo hoy', s.dailyLimit ? `${s.dailyUsed}/${s.dailyLimit}` : '—')}
      </div>
    </div>
    <div class="lv-why">
      <h6>Por qué este color</h6>
      <p class="lv-legend"><span class="is-g">Verde</span> todo en orden · <span class="is-y">Amarillo</span> se puede enviar, con cuidado · <span class="is-r">Rojo</span> no se crean envíos masivos hasta resolverlo.
        ${s.phone24h ? ` Los ${s.phone24h} mensajes que escribiste hoy desde el teléfono o WhatsApp Web <b>no cuentan</b> para el semáforo ni para el cupo.` : ' Lo que escribís desde el teléfono o WhatsApp Web no cuenta para el semáforo ni para el cupo.'}</p>
      <div class="lv-checks">${checks}</div>
    </div>
  </section>`;
}

/** Problemas frecuentes de la conexión y del envío, con qué hacer (Conexión). */
export function connectionHelp(): string {
  const faq: Array<[string, string, string]> = [
    ['ri-qr-code-line', 'No aparece el QR o la línea quedó trabada', 'Tocá «Reconectar». Si no aparece en un minuto, usá «Empezar de cero (QR nuevo)» y escaneá desde WhatsApp › Dispositivos vinculados. No se borran conversaciones ni notas.'],
    ['ri-refresh-line', 'Las conversaciones no se actualizan', 'Revisá que el teléfono del número tenga internet. Después tocá «Reconectar»: no hace falta volver a escanear.'],
    ['ri-time-line', 'Los contactos ven «Esperando el mensaje»', 'Es un problema de cifrado entre los teléfonos. Usá «Reparar cifrado»; si sigue, «Empezar de cero (QR nuevo)».'],
    ['ri-lock-unlock-line', 'Aviso de «mensajes sin descifrar»', 'Algunos mensajes que llegaron no se pudieron leer. Abrí WhatsApp en el teléfono con internet para que se sincronice; si se repite seguido, volvé a vincular el número.'],
    ['ri-traffic-light-line', 'El semáforo está en amarillo o rojo', 'Abrí cada punto de «Por qué este color»: dice qué se midió, el límite y cómo solucionarlo. Lo que escribís desde el teléfono o WhatsApp Web no cuenta.'],
    ['ri-lock-line', 'La línea está en cuarentena', 'Se activa cuando varios envíos seguidos fallan. Los masivos quedan en pausa hasta que el Super Admin la libere (Anti-Baneo › detalle de la línea). Revisá en Lotes el error de los envíos que fallaron.'],
    ['ri-battery-low-line', 'Se agotó el cupo de hoy', 'Los envíos pendientes salen solos mañana (el cupo se renueva a las 00:00, hora de Bolivia). Repartí los envíos grandes en varios días.'],
  ];
  const tips = [
    'Enviá solo a quienes esperan el mensaje (participantes, inscritos, prospectos que dejaron su número).',
    'En el primer renglón, decí quién escribe y por qué (programa o área).',
    'Revisá la lista antes de enviar: con código de país (591), sin repetidos y sin quienes pidieron la baja.',
    'Mantené el teléfono del número con internet; si se apaga mucho tiempo, la línea se desconecta.',
    'Con un número nuevo, dejá que el calentamiento suba el cupo de a poco.',
  ];
  return `<section class="cx-help">
    <div class="cx-help-col">
      <h6><i class="ri-question-answer-line"></i> Problemas frecuentes y cómo resolverlos</h6>
      ${faq.map(([icon, q, a]) => `<details class="cx-faq"><summary><i class="${icon}"></i><span>${esc(q)}</span></summary><p>${esc(a)}</p></details>`).join('')}
    </div>
    <div class="cx-help-col cx-tips">
      <h6><i class="ri-shield-star-line"></i> Buenas prácticas para no perder el número</h6>
      <ul>${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>
  </section>`;
}

/** Líneas del gateway con su semáforo y acceso al detalle (solo administración). */
export function linesOverview(rows: Array<{ id: string; name: string; phone: string | null; status: string; verdict: LineVerdict; principal: boolean }>): string {
  const dot: Record<LineVerdict['level'], string> = { green: 'Sana', yellow: 'Con cuidado', red: 'No conviene enviar' };
  return `<div class="card"><div class="card-body py-1">${rows
    .map((r, i) => `<a class="cx-line${i === rows.length - 1 ? '' : ' border-bottom'}" href="/anti-ban/line/${encodeURIComponent(r.id)}">
      <span class="cx-line-dot lv-${r.verdict.level}" aria-hidden="true"></span>
      <span class="cx-line-main"><span><b>${esc(r.name)}</b>${r.principal ? ' <span class="badge bg-primary-subtle text-primary ms-1">Principal</span>' : ''}</span>
        <small><span class="ff-monospace">${esc(r.phone ?? '—')}</span> · ${esc(r.verdict.level === 'green' ? dot.green : r.verdict.reasons[0] ?? dot[r.verdict.level])}</small></span>
      <span class="cx-line-state">${statusBadge(r.status)}<span class="cx-line-lv lv-t-${r.verdict.level}">${dot[r.verdict.level]}</span></span>
      <i class="ri-arrow-right-s-line text-muted" aria-hidden="true"></i>
    </a>`)
    .join('')}</div></div>`;
}
