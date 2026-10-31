import { esc } from './layout.js';
import { statusBadge } from './views.js';
import type { LineIssue } from '../core/line-health.js';

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
