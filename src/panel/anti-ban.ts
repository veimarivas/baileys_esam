import type express from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { get, run } from '../db/index.js';
import { esc, renderLayout } from './layout.js';
import { emptyState, fmtDate } from './views.js';
import type { UserRow } from '../auth/users.js';
import { audit } from '../core/webhooks.js';
import { getConfig } from '../core/config-store.js';
import { addOptout, listOptouts, normalizeChatId, removeOptout } from '../core/optout.js';
import {
  getPolicy,
  presetFor,
  resetTrust,
  RISK_PRESETS,
  upsertPolicy,
  type AntiBanPolicy,
  type RiskProfile,
} from '../core/anti-ban.js';
import { getHealth, listHealth, recomputeHealth, setQuarantine, type HealthRow } from '../core/health.js';
import { quarantineAndRotate, rotateBatches } from '../core/session-pool.js';
import {
  antiBanEvents,
  pausedBatches,
  replyRate7d,
  sessionUsage,
  trend7d,
  type AntiBanEvent,
  type TrendDay,
} from '../core/anti-ban-monitor.js';
import type { BatchRunner } from '../core/batches.js';
import type { SessionRow } from '../types.js';

/**
 * Panel anti-baneo: monitoreo de cada línea (uso del día contra sus límites,
 * ventana, semana y respuesta), políticas (global y por línea), lista negra y
 * bitácora de lo que hizo el motor.
 */

const DAY_LABELS: Array<[number, string]> = [
  [1, 'Lun'],
  [2, 'Mar'],
  [3, 'Mié'],
  [4, 'Jue'],
  [5, 'Vie'],
  [6, 'Sáb'],
  [7, 'Dom'],
];

const RISK_INFO: Record<RiskProfile, { title: string; text: string; icon: string }> = {
  low: { title: 'Conservador', text: 'Números nuevos o recién recuperados.', icon: 'ri-shield-check-line' },
  medium: { title: 'Balanceado', text: 'Números con historial y buena entrega.', icon: 'ri-scales-3-line' },
  high: { title: 'Agresivo', text: 'Solo números maduros y listas que responden.', icon: 'ri-flashlight-line' },
};

type Tab = 'monitoreo' | 'politicas' | 'lista-negra' | 'bitacora';
const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'monitoreo', label: 'Monitoreo', icon: 'ri-pulse-line' },
  { id: 'politicas', label: 'Políticas', icon: 'ri-shield-star-line' },
  { id: 'lista-negra', label: 'Lista negra', icon: 'ri-forbidden-2-line' },
  { id: 'bitacora', label: 'Bitácora', icon: 'ri-history-line' },
];

function s(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

function n(value: unknown, fallback: number): number {
  const x = parseInt(s(value), 10);
  return Number.isFinite(x) ? x : fallback;
}

function f(value: unknown, fallback: number): number {
  const x = parseFloat(s(value).replace(',', '.'));
  return Number.isFinite(x) ? x : fallback;
}

function bool(value: unknown): boolean {
  return ['1', 'true', 'on', 'yes'].includes(s(value).toLowerCase());
}

function days(value: unknown): number[] {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = arr.map((d) => parseInt(String(d), 10)).filter((d) => d >= 1 && d <= 7);
  return out.length ? out : [1, 2, 3, 4, 5, 6];
}

function profile(value: unknown, fallback: RiskProfile): RiskProfile {
  const v = s(value);
  return v === 'low' || v === 'medium' || v === 'high' ? v : fallback;
}

function tabOf(value: unknown): Tab {
  const v = s(value);
  return TABS.some((t) => t.id === v) ? (v as Tab) : 'monitoreo';
}

function pct(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

const HEALTH_INFO: Record<string, { tone: string; label: string }> = {
  green: { tone: 'ok', label: 'Saludable' },
  yellow: { tone: 'warn', label: 'Atención' },
  red: { tone: 'danger', label: 'En riesgo' },
};

function healthPill(health: string): string {
  const h = HEALTH_INFO[health] ?? HEALTH_INFO.green;
  return `<span class="ab-pill ab-${h.tone}"><span class="ab-dot"></span>${h.label}</span>`;
}

function sessionLabel(sess: SessionRow | undefined, id: string | null | undefined): string {
  if (!sess) return id ? id.slice(0, 8) : 'Sin línea';
  return sess.owner_name ?? sess.name;
}

/** Número de la línea y, si difiere del dueño, el nombre de la sesión (distingue dos sesiones del mismo dueño). */
function sessionPhone(sess: SessionRow): string {
  const p = sess.phone ?? sess.expected_phone;
  const phone = p ? `+${String(p).replace(/^\+/, '')}` : sess.id.slice(0, 8);
  return sess.owner_name && sess.name !== sess.owner_name ? `${phone} · ${sess.name}` : phone;
}

/** Medidor de uso contra un límite (0 = sin tope). */
function meter(label: string, used: number, limit: number, hint?: string): string {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const tone = limit <= 0 ? 'mute' : ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok';
  return `<div class="ab-meter" ${hint ? `title="${esc(hint)}"` : ''}>
    <div class="ab-meter-top"><span>${esc(label)}</span><b>${used}${limit > 0 ? ` <small>/ ${limit}</small>` : ' <small>· sin tope</small>'}</b></div>
    <div class="ab-meter-bar ab-${tone}"><span style="width:${Math.round(ratio * 100)}%"></span></div>
  </div>`;
}

/** Semana en barras: alto = enviados; parte llena = entregados; punto rojo = bloqueos/bajas. */
function trendBars(trend: TrendDay[]): string {
  const max = Math.max(1, ...trend.map((d) => d.sent));
  const dayName = (ymd: string) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-BO', { weekday: 'narrow' });
  };
  const total = trend.reduce((a, d) => a + d.sent, 0);
  if (!total) return '<div class="ab-trend-empty">Sin envíos en los últimos 7 días</div>';
  return `<div class="ab-trend" role="img" aria-label="Envíos de los últimos 7 días">${trend
    .map((d) => {
      const h = Math.round((d.sent / max) * 100);
      const okH = d.sent ? Math.round((d.delivered / d.sent) * 100) : 0;
      const tip = `${d.day}: ${d.sent} enviados · ${d.delivered} entregados · ${d.failed} fallidos${d.blocked ? ` · ${d.blocked} bloqueos/bajas` : ''}`;
      return `<div class="ab-trend-col" title="${esc(tip)}">
        <div class="ab-trend-track"><div class="ab-trend-bar" style="height:${Math.max(h, d.sent ? 4 : 0)}%"><span style="height:${okH}%"></span></div></div>
        ${d.blocked ? '<span class="ab-trend-flag" aria-hidden="true"></span>' : ''}
        <span class="ab-trend-day">${esc(dayName(d.day))}</span>
      </div>`;
    })
    .join('')}</div>`;
}

/**
 * Fallas de descifrado recientes (registradas por el manager). Muchas fallas
 * con mensajes del propio teléfono = los enviados desde el celular no llegan
 * al panel; si persisten tras reiniciar, hay que volver a vincular el número.
 */
function decryptWarning(sessionId: string): string {
  const raw = getConfig(`decrypt_failures:${sessionId}`);
  if (!raw) return '';
  try {
    const d = JSON.parse(raw) as { count: number; from_phone: number; last_at: string };
    if (!d.last_at || Date.now() - Date.parse(d.last_at) > 86_400_000 || !d.count) return '';
    const fromPhone = d.from_phone ? ` (${d.from_phone} del propio teléfono)` : '';
    return `<div class="ab-note ab-warn"><i class="ri-lock-unlock-line"></i>${esc(d.count)} mensaje(s) sin descifrar en 24 h${esc(fromPhone)}. Si sigue ocurriendo, volvé a vincular el número.</div>`;
  } catch {
    return '';
  }
}

// ── Monitoreo ──────────────────────────────────────────────────────────────────

function sessionCard(sess: SessionRow, health: HealthRow | undefined, custom: boolean): string {
  const policy = getPolicy(sess.id);
  const usage = sessionUsage(sess, policy);
  const trend = trend7d(sess.id);
  const reply = replyRate7d(sess.id);
  const h = health;
  const sent = h?.sent_24h ?? 0;
  const rate = (v: number) => (sent ? pct(v / sent) : '—');
  const quarantine = !!h?.quarantine;
  const id = esc(sess.id);
  const replyChip =
    reply.rate === null
      ? ''
      : `<span class="ab-chip ${reply.rate < 0.1 && reply.contacted >= 20 ? 'ab-warn' : ''}" title="De ${reply.contacted} contactos que recibieron un lote en 7 días, ${reply.replied} respondieron">
          <i class="ri-reply-line"></i>Responde ${pct(reply.rate)}</span>`;

  return `<article class="ab-session ${quarantine ? 'is-quarantine' : ''} ab-h-${esc(h?.health ?? 'green')}">
    <header class="ab-session-head">
      <span class="ab-session-ic"><i class="ri-whatsapp-line"></i></span>
      <div class="ab-session-id">
        <div class="ab-session-name">${esc(sessionLabel(sess, sess.id))}</div>
        <div class="ab-session-phone">${esc(sessionPhone(sess))}</div>
      </div>
      <div class="ab-session-badges">
        ${healthPill(h?.health ?? 'green')}
        ${quarantine ? '<span class="ab-pill ab-danger"><i class="ri-lock-line"></i>Cuarentena</span>' : ''}
      </div>
    </header>
    <p class="ab-session-reason">${esc(h?.status_reason ?? 'Operando normal')}</p>
    ${decryptWarning(sess.id)}

    <div class="ab-meters">
      ${meter('Hoy', usage.dailyUsed, usage.dailyLimit, usage.warmupActive ? `Tope reducido por el calentamiento (día ${usage.warmupDay})` : 'Mensajes salientes de hoy contra el límite diario')}
      ${meter('Última hora', usage.hourlyUsed, usage.hourlyLimit)}
      ${meter('Contactos nuevos hoy', usage.newContactsToday, usage.newContactsLimit, 'Números sin conversación previa')}
    </div>

    <div class="ab-chips">
      <span class="ab-chip ${usage.windowOpen ? 'ab-ok' : ''}"><i class="${usage.windowOpen ? 'ri-time-line' : 'ri-moon-line'}"></i>${esc(usage.windowLabel)}</span>
      ${usage.warmupActive ? `<span class="ab-chip ab-warn"><i class="ri-seedling-line"></i>Calentamiento · día ${usage.warmupDay}</span>` : ''}
      ${replyChip}
      <span class="ab-chip"><i class="ri-shield-star-line"></i>${custom ? 'Política propia' : 'Política global'} · ${esc(RISK_INFO[policy.risk_profile].title)}</span>
      ${policy.active ? '' : '<span class="ab-chip ab-danger"><i class="ri-alert-line"></i>Motor apagado</span>'}
    </div>

    <div class="ab-session-body">
      <dl class="ab-figures">
        <div><dt>Enviados 24 h</dt><dd>${sent}</dd></div>
        <div><dt>Entregados</dt><dd>${rate(h?.delivered_24h ?? 0)}</dd></div>
        <div><dt>Leídos</dt><dd>${rate(h?.read_24h ?? 0)}</dd></div>
        <div><dt>Fallidos</dt><dd class="${(h?.failed_24h ?? 0) ? 'ab-t-warn' : ''}">${h?.failed_24h ?? 0}</dd></div>
        <div><dt>Bloqueos y bajas</dt><dd class="${(h?.blocked_24h ?? 0) ? 'ab-t-danger' : ''}">${h?.blocked_24h ?? 0}</dd></div>
      </dl>
      <div class="ab-session-trend">
        <div class="ab-mini-label">Últimos 7 días</div>
        ${trendBars(trend)}
      </div>
    </div>

    <footer class="ab-session-actions">
      <a class="btn btn-sm btn-soft-primary" href="/anti-ban/session/${id}"><i class="ri-equalizer-line me-1"></i>Política</a>
      <form method="post" action="/anti-ban/rotate/${id}">
        <button class="btn btn-sm btn-light" type="submit" title="Mover sus lotes pendientes a otra línea sana"><i class="ri-arrow-left-right-line me-1"></i>Rotar lotes</button>
      </form>
      <form method="post" action="/anti-ban/session/${id}/reset" data-confirm="¿Reiniciar el calentamiento? La línea vuelve al día 1 con topes reducidos.">
        <button class="btn btn-sm btn-light" type="submit"><i class="ri-restart-line me-1"></i>Reiniciar warm-up</button>
      </form>
      ${
        quarantine
          ? `<form method="post" action="/anti-ban/quarantine/${id}" class="ms-auto"><input type="hidden" name="action" value="release"/>
               <button class="btn btn-sm btn-soft-success" type="submit"><i class="ri-lock-unlock-line me-1"></i>Liberar</button></form>`
          : `<form method="post" action="/anti-ban/quarantine/${id}" class="ms-auto" data-confirm="¿Poner la línea en cuarentena? Deja de enviar lotes y se rotan a otra línea sana.">
               <input type="hidden" name="action" value="apply"/>
               <button class="btn btn-sm btn-soft-danger" type="submit"><i class="ri-lock-line me-1"></i>Cuarentena</button></form>`
      }
    </footer>
  </article>`;
}

function monitorTab(sessions: SessionRow[], healthById: Map<string, HealthRow>, customIds: Set<string>): string {
  if (!sessions.length) {
    return `<div class="card"><div class="card-body">${emptyState(
      'ri-heart-pulse-line',
      'Sin líneas para monitorear',
      'Cuando vincules un número en Conexión, acá verás su uso del día, su entregabilidad y su calentamiento.',
    )}</div></div>`;
  }
  const order: Record<string, number> = { red: 0, yellow: 1, green: 2 };
  const sorted = sessions
    .slice()
    .sort((a, b) => (order[healthById.get(a.id)?.health ?? 'green'] ?? 2) - (order[healthById.get(b.id)?.health ?? 'green'] ?? 2));
  const byId = new Map(sessions.map((x) => [x.id, x]));
  const paused = pausedBatches();
  const pausedHtml = paused.length
    ? `<section class="ab-panel" id="ab-paused">
        <div class="ab-panel-head"><h6><i class="ri-pause-circle-line"></i>Lotes en pausa</h6><span class="ab-count">${paused.length}</span></div>
        <ul class="ab-paused">${paused
          .map(
            (b) => `<li>
              <div class="ab-paused-main">
                <a href="/batches/${b.id}">${esc(b.name || `Lote #${b.id}`)}</a>
                <span class="ab-paused-meta">${esc(sessionLabel(byId.get(b.session_id ?? ''), b.session_id))} · ${b.sent}/${b.total} enviados · ${esc(fmtDate(b.updated_at))}</span>
                <span class="ab-paused-reason">${esc(b.reason)}</span>
              </div>
              <a class="btn btn-sm btn-light" href="/batches/${b.id}">Revisar</a>
            </li>`,
          )
          .join('')}</ul>
      </section>`
    : '';
  return `<div class="ab-sessions">${sorted.map((x) => sessionCard(x, healthById.get(x.id), customIds.has(x.id))).join('')}</div>${pausedHtml}`;
}

// ── Políticas ──────────────────────────────────────────────────────────────────

function field(label: string, input: string, help?: string, cls = ''): string {
  return `<div class="ab-field ${cls}"><label class="form-label">${label}</label>${input}${help ? `<div class="form-text">${help}</div>` : ''}</div>`;
}

function numInput(name: string, value: number | string, attrs = '', suffix = ''): string {
  const input = `<input type="number" name="${name}" class="form-control" value="${esc(value)}" ${attrs} />`;
  return suffix ? `<div class="input-group">${input}<span class="input-group-text">${esc(suffix)}</span></div>` : input;
}

function switchInput(name: string, checked: boolean, label: string, uid: string, help?: string): string {
  return `<div class="ab-switch">
    <div class="form-check form-switch">
      <input class="form-check-input" type="checkbox" role="switch" name="${name}" value="1" id="ab-${name}-${uid}" ${checked ? 'checked' : ''}/>
      <label class="form-check-label" for="ab-${name}-${uid}">${esc(label)}</label>
    </div>
    ${help ? `<div class="form-text">${help}</div>` : ''}
  </div>`;
}

function group(id: string, icon: string, title: string, desc: string, body: string): string {
  return `<section class="ab-group" id="${id}">
    <header class="ab-group-head"><span class="ab-group-ic"><i class="${icon}"></i></span><div><h6>${esc(title)}</h6><p>${esc(desc)}</p></div></header>
    <div class="ab-grid">${body}</div>
  </section>`;
}

/** Formulario de política (global o de línea), agrupado por tema. */
function policyForm(action: string, p: AntiBanPolicy, opts: { scope: 'global' | 'session'; uid: string }): string {
  const uid = opts.uid;
  const daysBoxes = DAY_LABELS.map(
    ([d, label]) => `<label class="ab-day">
        <input type="checkbox" name="window_days" value="${d}" ${p.window_days.includes(d) ? 'checked' : ''}/><span>${label}</span>
      </label>`,
  ).join('');
  const presets = (['low', 'medium', 'high'] as RiskProfile[])
    .map((r) => {
      const pr = RISK_PRESETS[r];
      return `<label class="ab-preset">
        <input type="radio" name="risk_profile" value="${r}" ${p.risk_profile === r ? 'checked' : ''}/>
        <span class="ab-preset-body">
          <span class="ab-preset-title"><i class="${RISK_INFO[r].icon}"></i>${esc(RISK_INFO[r].title)}</span>
          <span class="ab-preset-text">${esc(RISK_INFO[r].text)}</span>
          <span class="ab-preset-figs">${pr.daily_limit}/día · ${pr.hourly_limit}/h · ${pr.delay_min_seconds}–${pr.delay_max_seconds} s · ${pr.new_contacts_daily_limit} nuevos</span>
        </span>
      </label>`;
    })
    .join('');

  const nav = [
    ['ab-g-ritmo', 'Ritmo'],
    ['ab-g-ventana', 'Ventana'],
    ['ab-g-warmup', 'Calentamiento'],
    ['ab-g-humano', 'Envío humano'],
    ['ab-g-contacto', 'Protección del contacto'],
    ['ab-g-freno', 'Seguimiento y freno'],
    ...(opts.scope === 'global' ? [['ab-g-bajas', 'Bajas']] : []),
  ]
    .map(([href, label]) => `<a href="#${href}">${label}</a>`)
    .join('');

  const blockRate = `<div class="input-group">
      <input type="number" name="block_rate_pct" class="form-control" value="${esc((p.block_rate_threshold * 100).toFixed(1))}" min="0.5" max="50" step="0.5" />
      <span class="input-group-text">%</span>
    </div>`;

  return `<form method="post" action="${action}" class="ab-form">
    <div class="ab-form-top">
      ${switchInput('active', p.active, 'Motor anti-baneo activo', uid, 'Apagado, los lotes salen sin límites, pausas ni controles. Solo para pruebas.')}
      <nav class="ab-form-nav" aria-label="Secciones de la política">${nav}</nav>
    </div>

    <section class="ab-group">
      <header class="ab-group-head"><span class="ab-group-ic"><i class="ri-dashboard-3-line"></i></span><div>
        <h6>Perfil de riesgo</h6><p>Elegí un punto de partida y ajustá lo que necesites. «Aplicar valores del perfil» reemplaza todos los campos.</p></div></header>
      <div class="ab-presets">${presets}</div>
    </section>

    ${group(
      'ab-g-ritmo',
      'ri-speed-up-line',
      'Ritmo y límites',
      'Cuántos mensajes salen y cada cuánto. Un ritmo irregular y moderado parece humano.',
      field('Límite diario', numInput('daily_limit', p.daily_limit, 'min="1"', 'msgs'), 'Tope de mensajes salientes por día.') +
        field('Límite por hora', numInput('hourly_limit', p.hourly_limit, 'min="1"', 'msgs'), 'Al llegar, el lote espera a la hora siguiente.') +
        field('Espera mínima', numInput('delay_min_seconds', p.delay_min_seconds, 'min="1"', 's'), 'Entre dos mensajes del mismo lote.') +
        field('Espera máxima', numInput('delay_max_seconds', p.delay_max_seconds, 'min="1"', 's'), 'Se elige un valor al azar dentro del rango.') +
        `<div class="ab-span-2 ab-subgrid">
          ${switchInput('pauses_enabled', p.pauses_enabled, 'Pausas por fatiga', uid, 'Cortes largos cada cierto número de envíos.')}
          ${field('Pausa cada', numInput('pause_every', p.pause_every, 'min="1"', 'msgs'))}
          ${field('Pausa mínima', numInput('pause_min_minutes', p.pause_min_minutes, 'min="0"', 'min'))}
          ${field('Pausa máxima', numInput('pause_max_minutes', p.pause_max_minutes, 'min="0"', 'min'))}
        </div>`,
    )}

    ${group(
      'ab-g-ventana',
      'ri-calendar-schedule-line',
      'Ventana y días de envío',
      'Fuera de este horario los lotes esperan. Admite ventanas que cruzan la medianoche.',
      field('Desde', `<input type="time" name="window_start" class="form-control" value="${esc(p.window_start)}" />`) +
        field('Hasta', `<input type="time" name="window_end" class="form-control" value="${esc(p.window_end)}" />`) +
        field('Días permitidos', `<div class="ab-days">${daysBoxes}</div>`, undefined, 'ab-span-2'),
    )}

    ${group(
      'ab-g-warmup',
      'ri-seedling-line',
      'Calentamiento (warm-up)',
      'Un número nuevo arranca con topes bajos y los sube día a día hasta el límite diario.',
      switchInput('warmup_enabled', p.warmup_enabled, 'Calentamiento activo', uid) +
        field('Tope del día 1', numInput('warmup_day1_limit', p.warmup_day1_limit, 'min="1"', 'msgs'), 'Cada día suma este valor (día 2 = el doble, etc.).'),
    )}

    ${group(
      'ab-g-humano',
      'ri-user-voice-line',
      'Envío humano',
      'Aplica a todo envío automático: lotes, API y respuestas automáticas.',
      switchInput('typing_simulation', p.typing_simulation, 'Simular «escribiendo…»', uid, 'Muestra escribiendo/grabando unos segundos antes de enviar.') +
        field('Separación mínima', numInput('min_gap_seconds', p.min_gap_seconds, 'min="0" max="120"', 's'), 'Entre dos envíos automáticos cualesquiera de la línea.') +
        field('Tope por minuto', numInput('burst_per_minute', p.burst_per_minute, 'min="0" max="120"', 'msgs'), 'Evita ráfagas (incluye el panel). 0 = sin tope.'),
    )}

    ${group(
      'ab-g-contacto',
      'ri-user-heart-line',
      'Protección del contacto',
      'Lo que más reportes provoca: escribir en frío, repetir campañas e insistir a quien no contesta.',
      field('Contactos nuevos por día', numInput('new_contacts_daily_limit', p.new_contacts_daily_limit, 'min="0"', 'números'), 'Números sin conversación previa. Al llegar, el lote se pausa. 0 = sin tope.') +
        field('Espera entre campañas al mismo número', numInput('recontact_cooldown_hours', p.recontact_cooldown_hours, 'min="0" max="720"', 'horas'), 'Si recibió un envío masivo hace menos, el lote lo omite. 0 = sin control.') +
        field('Máximo de mensajes sin respuesta', numInput('max_unanswered', p.max_unanswered, 'min="0" max="50"', 'msgs'), 'Si ya le escribimos esa cantidad sin que conteste, el lote lo omite. 0 = sin control.') +
        switchInput('verify_numbers', p.verify_numbers, 'Verificar que el número tenga WhatsApp', uid, 'Antes del primer mensaje; los que no tienen se omiten.'),
    )}

    ${group(
      'ab-g-freno',
      'ri-alarm-warning-line',
      'Seguimiento y freno automático',
      'Señales que ponen la línea en riesgo y frenan los lotes antes de que WhatsApp lo haga.',
      field('Entregabilidad mínima', numInput('health_threshold', Math.round(p.health_delivery_threshold * 100), 'min="1" max="100"', '%'), 'Por debajo, la línea pasa a «En riesgo».') +
        field('Bloqueos y bajas máximos', blockRate, 'De lo enviado en 24 h. Por encima, la línea pasa a «En riesgo» y los lotes se pausan.') +
        field('Fallos seguidos para cuarentena', numInput('max_consecutive_failures', p.max_consecutive_failures, 'min="1" max="50"', 'fallos'), 'La línea entra en cuarentena y sus lotes pasan a otra sana.') +
        switchInput('auto_pause_low_delivery', p.auto_pause_low_delivery, 'Pausar el lote si cae la entregabilidad', uid, 'Se revisa cada 10 envíos, con al menos 20 enviados.'),
    )}

    ${
      opts.scope === 'global'
        ? group(
            'ab-g-bajas',
            'ri-chat-off-line',
            'Pedidos de baja',
            'Quien escribe una de estas palabras pasa a la lista negra y no recibe más envíos.',
            field(
              'Palabras extra de baja',
              `<input type="text" name="optout_keywords" class="form-control" maxlength="500" value="${esc(p.optout_keywords)}" placeholder="Ej.: no me escriban, borrar, desuscribir" />`,
              'Separadas por coma; sin distinguir mayúsculas ni acentos. Siempre se detectan BAJA, STOP, CANCELAR, SALIR, UNSUBSCRIBE y NO MOLESTAR.',
              'ab-span-2',
            ),
          )
        : `<input type="hidden" name="optout_keywords" value="${esc(p.optout_keywords)}" />`
    }

    <div class="ab-savebar">
      <span class="ab-savebar-hint"><i class="ri-information-line"></i>Aplica a los próximos envíos; los lotes en curso la toman al reanudar.</span>
      <button class="btn btn-light" type="submit" name="action" value="preset" data-confirm="¿Reemplazar todos los campos por los valores del perfil elegido?"><i class="ri-magic-line me-1"></i>Aplicar valores del perfil</button>
      <button class="btn btn-primary" type="submit" name="action" value="save"><i class="ri-save-3-line me-1"></i>Guardar política</button>
    </div>
  </form>`;
}

function parsePolicyForm(body: Record<string, unknown>, base: AntiBanPolicy) {
  return {
    risk_profile: profile(body.risk_profile, base.risk_profile),
    daily_limit: Math.max(1, n(body.daily_limit, base.daily_limit)),
    hourly_limit: Math.max(1, n(body.hourly_limit, base.hourly_limit)),
    delay_min_seconds: Math.max(1, n(body.delay_min_seconds, base.delay_min_seconds)),
    delay_max_seconds: Math.max(1, n(body.delay_max_seconds, base.delay_max_seconds)),
    window_start: s(body.window_start) || base.window_start,
    window_end: s(body.window_end) || base.window_end,
    window_days: days(body.window_days),
    warmup_enabled: bool(body.warmup_enabled),
    warmup_day1_limit: Math.max(1, n(body.warmup_day1_limit, base.warmup_day1_limit)),
    pauses_enabled: bool(body.pauses_enabled),
    pause_every: Math.max(1, n(body.pause_every, base.pause_every)),
    pause_min_minutes: Math.max(0, n(body.pause_min_minutes, base.pause_min_minutes)),
    pause_max_minutes: Math.max(0, n(body.pause_max_minutes, base.pause_max_minutes)),
    health_delivery_threshold: Math.min(1, Math.max(0.01, n(body.health_threshold, base.health_delivery_threshold * 100) / 100)),
    active: bool(body.active),
    typing_simulation: bool(body.typing_simulation),
    min_gap_seconds: Math.min(120, Math.max(0, n(body.min_gap_seconds, base.min_gap_seconds))),
    burst_per_minute: Math.min(120, Math.max(0, n(body.burst_per_minute, base.burst_per_minute))),
    verify_numbers: bool(body.verify_numbers),
    new_contacts_daily_limit: Math.max(0, n(body.new_contacts_daily_limit, base.new_contacts_daily_limit)),
    max_consecutive_failures: Math.min(50, Math.max(1, n(body.max_consecutive_failures, base.max_consecutive_failures))),
    auto_pause_low_delivery: bool(body.auto_pause_low_delivery),
    recontact_cooldown_hours: Math.min(720, Math.max(0, n(body.recontact_cooldown_hours, base.recontact_cooldown_hours))),
    max_unanswered: Math.min(50, Math.max(0, n(body.max_unanswered, base.max_unanswered))),
    block_rate_threshold: Math.min(0.5, Math.max(0.005, f(body.block_rate_pct, base.block_rate_threshold * 100) / 100)),
    optout_keywords: s(body.optout_keywords).slice(0, 500).trim(),
  };
}

/** Rangos invertidos (mínimo mayor que máximo) se ordenan en lugar de fallar. */
function sanePolicy<T extends { delay_min_seconds: number; delay_max_seconds: number; pause_min_minutes: number; pause_max_minutes: number }>(p: T): T {
  return {
    ...p,
    delay_min_seconds: Math.min(p.delay_min_seconds, p.delay_max_seconds),
    delay_max_seconds: Math.max(p.delay_min_seconds, p.delay_max_seconds),
    pause_min_minutes: Math.min(p.pause_min_minutes, p.pause_max_minutes),
    pause_max_minutes: Math.max(p.pause_min_minutes, p.pause_max_minutes),
  };
}

function policiesTab(sessions: SessionRow[], healthById: Map<string, HealthRow>, customIds: Set<string>): string {
  const global = getPolicy(null);
  const list = sessions.length
    ? sessions
        .map((x) => {
          const custom = customIds.has(x.id);
          const eff = getPolicy(x.id);
          const tone = (HEALTH_INFO[healthById.get(x.id)?.health ?? 'green'] ?? HEALTH_INFO.green).tone;
          return `<a class="ab-line" href="/anti-ban/session/${esc(x.id)}">
            <span class="ab-dot ab-${tone}"></span>
            <span class="ab-line-main"><b>${esc(sessionLabel(x, x.id))}</b>
              <span>${esc(sessionPhone(x))}</span>
              <span>${custom ? 'Política propia' : 'Usa la global'} · ${esc(RISK_INFO[eff.risk_profile].title)} · ${eff.daily_limit}/día</span></span>
            <i class="ri-arrow-right-s-line"></i>
          </a>`;
        })
        .join('')
    : '<p class="text-muted mb-0">Las líneas aparecen al vincular números en Conexión.</p>';
  return `<div class="ab-policy-layout">
    <div class="card ab-card"><div class="card-body">
      <div class="ab-card-title"><h5>Política global</h5><span>Se aplica a toda línea sin política propia.</span></div>
      ${policyForm('/anti-ban/global', global, { scope: 'global', uid: 'g' })}
    </div></div>
    <aside class="ab-aside">
      <div class="card ab-card"><div class="card-body">
        <div class="ab-card-title"><h5>Políticas por línea</h5><span>Ajustá una línea sin tocar las demás.</span></div>
        <div class="ab-lines">${list}</div>
      </div></div>
      <div class="card ab-card ab-tips"><div class="card-body">
        <h6><i class="ri-lightbulb-line"></i>Buenas prácticas</h6>
        <ul>
          <li>Escribí primero a quien ya conversó con la línea: los contactos en frío son los que más reportan.</li>
          <li>Ofrecé siempre una salida: «Respondé BAJA si no querés recibir más mensajes».</li>
          <li>Variá el texto con <code>{opción1|opción2}</code>: mensajes idénticos en masa son una señal de spam.</li>
          <li>Si una línea pasa a «En riesgo», pausá sus lotes un día y bajá el perfil.</li>
        </ul>
      </div></div>
    </aside>
  </div>`;
}

// ── Lista negra ────────────────────────────────────────────────────────────────

const SOURCE_INFO: Record<string, { label: string; tone: string }> = {
  manual: { label: 'Manual', tone: 'mute' },
  reply: { label: 'Pidió la baja', tone: 'warn' },
  blocked: { label: 'Bloqueo', tone: 'danger' },
};

function blacklistTab(q: string, source: string, byId: Map<string, SessionRow>): string {
  const all = listOptouts();
  const counts = all.reduce<Record<string, number>>((acc, o) => {
    const k = o.source ?? 'manual';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const qd = q.replace(/\D+/g, '');
  const rows = all.filter(
    (o) =>
      (!source || (o.source ?? 'manual') === source) &&
      (!q || (qd && (o.phone ?? o.chat_id).includes(qd)) || (o.reason ?? '').toLowerCase().includes(q.toLowerCase())),
  );
  const shown = rows.slice(0, 300);
  const chip = (value: string, label: string, count: number) =>
    `<a class="ab-filter ${source === value ? 'on' : ''}" href="/anti-ban?tab=lista-negra${value ? `&source=${value}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}">${esc(label)} <span>${count}</span></a>`;
  const table = shown.length
    ? `<div class="table-responsive"><table class="table table-hover align-middle mb-0 ab-table">
        <thead><tr><th>Número</th><th>Motivo</th><th>Origen</th><th>Línea</th><th>Fecha</th><th></th></tr></thead>
        <tbody>${shown
          .map((o) => {
            const src = SOURCE_INFO[o.source ?? 'manual'] ?? SOURCE_INFO.manual;
            return `<tr>
              <td class="ab-mono">${esc(o.phone ? `+${o.phone}` : o.chat_id)}</td>
              <td>${esc(o.reason ?? '—')}</td>
              <td><span class="ab-pill ab-${src.tone}">${esc(src.label)}</span></td>
              <td>${o.session_id ? esc(sessionLabel(byId.get(o.session_id), o.session_id)) : '<span class="text-muted">—</span>'}</td>
              <td class="text-nowrap">${esc(fmtDate(o.created_at))}</td>
              <td class="text-end"><form method="post" action="/blacklist/${encodeURIComponent(o.chat_id)}/delete" data-confirm="¿Quitar ${esc(o.phone ?? o.chat_id)} de la lista negra? Podrá volver a recibir envíos.">
                <button class="btn btn-sm btn-soft-danger" type="submit">Quitar</button></form></td>
            </tr>`;
          })
          .join('')}</tbody></table></div>
      ${rows.length > shown.length ? `<p class="text-muted fs-12 mt-2 mb-0">Mostrando ${shown.length} de ${rows.length}. Afiná la búsqueda o exportá el CSV.</p>` : ''}`
    : emptyState(
        'ri-forbidden-2-line',
        all.length ? 'Sin coincidencias' : 'La lista negra está vacía',
        all.length ? 'Probá con otro número o quitá el filtro.' : 'Se llena sola con bloqueos y pedidos de baja; también podés agregar números a mano.',
      );

  return `<div class="ab-bl-layout">
    <div class="card ab-card"><div class="card-body">
      <div class="ab-bl-toolbar">
        <form method="get" action="/anti-ban" class="ab-search" role="search">
          <input type="hidden" name="tab" value="lista-negra" />${source ? `<input type="hidden" name="source" value="${esc(source)}" />` : ''}
          <i class="ri-search-line"></i><input type="search" name="q" value="${esc(q)}" placeholder="Buscar número o motivo…" aria-label="Buscar en la lista negra" />
        </form>
        <div class="ab-filters">
          ${chip('', 'Todos', all.length)}
          ${chip('blocked', 'Bloqueos', counts.blocked ?? 0)}
          ${chip('reply', 'Bajas', counts.reply ?? 0)}
          ${chip('manual', 'Manuales', counts.manual ?? 0)}
        </div>
      </div>
      ${table}
    </div></div>
    <aside class="ab-aside">
      <div class="card ab-card"><div class="card-body">
        <div class="ab-card-title"><h5>Agregar un número</h5><span>Nunca recibirá envíos de ninguna línea.</span></div>
        <form method="post" action="/blacklist" class="ab-stack">
          ${field('Número', '<input name="number" class="form-control" placeholder="591XXXXXXXX" required inputmode="tel"/>')}
          ${field('Motivo', '<input name="reason" class="form-control" placeholder="Solicitó la baja por teléfono"/>')}
          <button class="btn btn-primary w-100" type="submit"><i class="ri-add-line me-1"></i>Agregar</button>
        </form>
      </div></div>
      <div class="card ab-card"><div class="card-body">
        <div class="ab-card-title"><h5>Importar o exportar</h5><span>Un número por renglón; el motivo, opcional, después de una coma.</span></div>
        <form method="post" action="/blacklist/import" class="ab-stack">
          <textarea name="numbers" class="form-control" rows="4" placeholder="59170000000&#10;59170000001, solicitó la baja"></textarea>
          <div class="d-flex gap-2">
            <button class="btn btn-soft-primary flex-fill" type="submit"><i class="ri-upload-2-line me-1"></i>Importar</button>
            <a class="btn btn-light flex-fill" href="/blacklist/export"><i class="ri-download-2-line me-1"></i>Exportar CSV</a>
          </div>
        </form>
      </div></div>
    </aside>
  </div>`;
}

// ── Bitácora ───────────────────────────────────────────────────────────────────

function eventView(e: AntiBanEvent, byId: Map<string, SessionRow>): { icon: string; tone: string; title: string; detail: string } {
  const c = e.context;
  const line = (id: unknown) => esc(sessionLabel(byId.get(String(id ?? '')), typeof id === 'string' ? id : null));
  switch (e.action) {
    case 'anti_ban.policy_updated':
      return {
        icon: 'ri-shield-star-line',
        tone: 'info',
        title: c.scope === 'session' ? `Política de ${line(c.session_id)} actualizada` : 'Política global actualizada',
        detail: c.profile ? `Perfil: ${esc(RISK_INFO[c.profile as RiskProfile]?.title ?? String(c.profile))}${c.preset ? ' (valores del perfil)' : ''}` : '',
      };
    case 'anti_ban.policy_cleared':
      return { icon: 'ri-arrow-go-back-line', tone: 'info', title: `${line(c.session_id)} volvió a la política global`, detail: '' };
    case 'anti_ban.quarantine':
      return c.quarantine
        ? {
            icon: 'ri-lock-line',
            tone: 'danger',
            title: `${line(c.session_id)} en cuarentena`,
            detail: esc(String(c.reason ?? '')) + (c.moved ? ` · ${esc(c.moved)} lote(s) rotados` : ''),
          }
        : { icon: 'ri-lock-unlock-line', tone: 'ok', title: `${line(c.session_id)} liberada de la cuarentena`, detail: '' };
    case 'anti_ban.trust_reset':
      return { icon: 'ri-restart-line', tone: 'warn', title: `Calentamiento reiniciado en ${line(c.session_id)}`, detail: 'Vuelve al día 1.' };
    case 'anti_ban.rotate':
      return { icon: 'ri-arrow-left-right-line', tone: 'info', title: `Rotación manual de lotes de ${line(c.session_id)}`, detail: `${esc(c.batches ?? 0)} lote(s)` };
    case 'session.rotated':
      return { icon: 'ri-arrow-left-right-line', tone: 'info', title: `Lotes movidos de ${line(c.from)} a ${line(c.to)}`, detail: `${esc(c.batches ?? 0)} lote(s)` };
    case 'batch.paused':
      return { icon: 'ri-pause-circle-line', tone: 'warn', title: `Lote #${esc(c.batch_id)} pausado por el motor`, detail: esc(String(c.reason ?? '')) };
    case 'blacklist.added':
      return { icon: 'ri-forbidden-2-line', tone: 'mute', title: 'Número agregado a la lista negra', detail: esc(String(c.chat_id ?? '').replace(/@.*$/, '')) };
    case 'blacklist.imported':
      return { icon: 'ri-upload-2-line', tone: 'mute', title: 'Lista negra importada', detail: `${esc(c.count ?? 0)} número(s)` };
    case 'blacklist.removed':
      return { icon: 'ri-delete-back-2-line', tone: 'mute', title: 'Número quitado de la lista negra', detail: esc(String(c.chat_id ?? '').replace(/@.*$/, '')) };
    default:
      return { icon: 'ri-record-circle-line', tone: 'mute', title: esc(e.action), detail: '' };
  }
}

function logTab(byId: Map<string, SessionRow>): string {
  const events = antiBanEvents(60);
  if (!events.length) {
    return `<div class="card"><div class="card-body">${emptyState(
      'ri-history-line',
      'Sin actividad registrada',
      'Acá vas a ver cada pausa automática, cuarentena, rotación de lotes y cambio de política.',
    )}</div></div>`;
  }
  return `<div class="card ab-card"><div class="card-body">
    <ol class="ab-log">${events
      .map((e) => {
        const v = eventView(e, byId);
        return `<li class="ab-log-item">
          <span class="ab-log-ic ab-${v.tone}"><i class="${v.icon}"></i></span>
          <div class="ab-log-body"><div class="ab-log-title">${v.title}</div>${v.detail ? `<div class="ab-log-detail">${v.detail}</div>` : ''}</div>
          <time class="ab-log-time" datetime="${esc(e.created_at)}">${esc(fmtDate(e.created_at))}</time>
        </li>`;
      })
      .join('')}</ol>
  </div></div>`;
}

// ── Cabecera: indicadores ──────────────────────────────────────────────────────

function kpis(sessions: SessionRow[], health: HealthRow[]): string {
  const ids = new Set(sessions.map((x) => x.id));
  const rows = health.filter((h) => ids.has(h.session_id));
  const count = (lvl: string) => rows.filter((h) => h.health === lvl).length;
  const sent = rows.reduce((a, h) => a + h.sent_24h, 0);
  const delivered = rows.reduce((a, h) => a + h.delivered_24h, 0);
  const blocked = rows.reduce((a, h) => a + h.blocked_24h, 0);
  const paused = pausedBatches(100).length;
  const tile = (icon: string, tone: string, label: string, value: string, sub: string, href?: string) => {
    const inner = `<span class="ab-kpi-ic ab-${tone}"><i class="${icon}"></i></span>
      <span class="ab-kpi-body"><span class="ab-kpi-label">${esc(label)}</span><span class="ab-kpi-value">${value}</span><span class="ab-kpi-sub">${sub}</span></span>`;
    return href ? `<a class="ab-kpi" href="${href}">${inner}</a>` : `<div class="ab-kpi">${inner}</div>`;
  };
  return `<div class="ab-kpis">
    ${tile(
      'ri-heart-pulse-line',
      count('red') ? 'danger' : count('yellow') ? 'warn' : 'ok',
      'Líneas',
      String(rows.length),
      `<span class="ab-dotline" title="Saludables · en atención · en riesgo"><span class="ab-dot ab-ok"></span>${count('green')}<span class="ab-dot ab-warn"></span>${count('yellow')}<span class="ab-dot ab-danger"></span>${count('red')}</span>`,
    )}
    ${tile('ri-send-plane-line', 'info', 'Enviados 24 h', String(sent), 'todas las líneas')}
    ${tile('ri-check-double-line', sent && delivered / sent < 0.85 ? 'warn' : 'ok', 'Entregabilidad', sent ? pct(delivered / sent) : '—', 'entregados / enviados')}
    ${tile('ri-user-forbid-line', blocked ? 'danger' : 'mute', 'Bloqueos y bajas', String(blocked), 'últimas 24 h', '/anti-ban?tab=lista-negra')}
    ${tile('ri-pause-circle-line', paused ? 'warn' : 'mute', 'Lotes en pausa', String(paused), paused ? 'ver motivos' : 'ninguno', paused ? '/anti-ban?tab=monitoreo#ab-paused' : undefined)}
  </div>`;
}

/** Módulo de rutas del panel anti-baneo. */
export function registerAntiBanRoutes(
  app: express.Express,
  ctx: {
    requireUser: RequestHandler;
    requireSection: (section: string) => RequestHandler;
    sessions: () => SessionRow[];
    runner: BatchRunner;
  },
): void {
  const guard: RequestHandler[] = [ctx.requireUser, ctx.requireSection('policies')];
  const authed = (req: Request): UserRow => (req as Request & { user: UserRow }).user;
  const flashOf = (req: Request) => (typeof req.query.ok === 'string' ? req.query.ok : undefined);
  const back = (tab: Tab, msg: string) => `/anti-ban?tab=${tab}&ok=${encodeURIComponent(msg)}`;
  const hasOwnPolicy = (id: string) => !!get<{ c: number }>('SELECT COUNT(*) c FROM anti_ban_policies WHERE session_id = ?', id)?.c;

  app.get('/anti-ban', ...guard, (req: Request, res: Response) => {
    const tab = tabOf(req.query.tab);
    const sessions = ctx.sessions();
    const health = listHealth();
    const healthById = new Map(health.map((h) => [h.session_id, h]));
    const byId = new Map(sessions.map((x) => [x.id, x]));
    const custom = new Set(sessions.filter((x) => hasOwnPolicy(x.id)).map((x) => x.id));

    const tabs = `<nav class="ab-tabs" aria-label="Secciones de anti-baneo">${TABS.map(
      (t) =>
        `<a class="ab-tab ${t.id === tab ? 'on' : ''}" href="/anti-ban?tab=${t.id}" ${t.id === tab ? 'aria-current="page"' : ''}><i class="${t.icon}"></i>${t.label}</a>`,
    ).join('')}</nav>`;

    let content = '';
    if (tab === 'monitoreo') content = monitorTab(sessions, healthById, custom);
    else if (tab === 'politicas') content = policiesTab(sessions, healthById, custom);
    else if (tab === 'lista-negra') content = blacklistTab(s(req.query.q).trim(), s(req.query.source), byId);
    else content = logTab(byId);

    res.send(
      renderLayout('Anti-Baneo', authed(req), 'policies', `<div class="ab-page">${kpis(sessions, health)}${tabs}${content}</div>`, {
        subtitle: 'Cuida la reputación de cada número: límites, señales de riesgo y seguimiento de lo que hace el motor.',
        flash: flashOf(req),
        actions: `<a class="btn btn-soft-secondary btn-sm" href="/anti-ban?tab=${tab}"><i class="ri-refresh-line me-1"></i>Actualizar</a>`,
      }),
    );
  });

  app.post('/anti-ban/global', ...guard, (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const base = getPolicy(null);
    const applyPreset = s(body.action) === 'preset';
    const patch = applyPreset
      ? { ...presetFor(profile(body.risk_profile, base.risk_profile)), optout_keywords: base.optout_keywords }
      : sanePolicy(parsePolicyForm(body, base));
    upsertPolicy(null, patch);
    audit('anti_ban.policy_updated', { scope: 'global', profile: patch.risk_profile, preset: applyPreset });
    res.redirect(back('politicas', applyPreset ? 'Se aplicaron los valores del perfil a la política global.' : 'Política global guardada.'));
  });

  app.get('/anti-ban/session/:id', ...guard, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const sess = ctx.sessions().find((x) => x.id === id);
    if (!sess) {
      res.redirect(back('politicas', 'Esa línea ya no existe.'));
      return;
    }
    const policy = getPolicy(id);
    const health = getHealth(id) ?? recomputeHealth(id);
    const custom = hasOwnPolicy(id);
    const body = `<div class="ab-page">
      <div class="ab-policy-layout">
        <div class="card ab-card"><div class="card-body">
          <div class="ab-card-title"><h5>Política de ${esc(sessionLabel(sess, id))}</h5>
            <span>${custom ? 'Esta línea tiene política propia.' : 'Hoy usa la política global; al guardar, pasa a tener la suya.'}</span></div>
          ${policyForm(`/anti-ban/session/${esc(id)}`, policy, { scope: 'session', uid: 's' })}
        </div></div>
        <aside class="ab-aside">
          ${sessionCard(sess, health, custom)}
          ${
            custom
              ? `<div class="card ab-card"><div class="card-body">
                  <div class="ab-card-title"><h5>Volver a la global</h5><span>Borra la política propia; la línea pasa a usar la global.</span></div>
                  <form method="post" action="/anti-ban/session/${esc(id)}/clear" data-confirm="¿Borrar la política propia de esta línea? También se pierde la fecha de inicio de su calentamiento.">
                    <button class="btn btn-soft-secondary w-100" type="submit"><i class="ri-arrow-go-back-line me-1"></i>Usar la política global</button>
                  </form>
                </div></div>`
              : ''
          }
          <a class="btn btn-light w-100" href="/anti-ban?tab=politicas"><i class="ri-arrow-left-line me-1"></i>Volver a Anti-Baneo</a>
        </aside>
      </div>
    </div>`;
    res.send(renderLayout('Política de línea', authed(req), 'policies', body, { flash: flashOf(req) }));
  });

  app.post('/anti-ban/session/:id', ...guard, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = req.body as Record<string, unknown>;
    const base = getPolicy(id);
    const applyPreset = s(body.action) === 'preset';
    const patch = applyPreset
      ? { ...presetFor(profile(body.risk_profile, base.risk_profile)), optout_keywords: base.optout_keywords }
      : sanePolicy(parsePolicyForm(body, base));
    upsertPolicy(id, patch);
    recalcular(id);
    audit('anti_ban.policy_updated', { scope: 'session', session_id: id, profile: patch.risk_profile, preset: applyPreset });
    res.redirect(`/anti-ban/session/${encodeURIComponent(id)}?ok=` + encodeURIComponent('Política de la línea guardada.'));
  });

  app.post('/anti-ban/session/:id/clear', ...guard, (req: Request, res: Response) => {
    const id = String(req.params.id);
    run('DELETE FROM anti_ban_policies WHERE session_id = ?', id);
    recalcular(id);
    audit('anti_ban.policy_cleared', { session_id: id });
    res.redirect(back('politicas', 'La línea volvió a usar la política global.'));
  });

  app.post('/anti-ban/session/:id/reset', ...guard, (req: Request, res: Response) => {
    const id = String(req.params.id);
    resetTrust(id);
    recalcular(id);
    audit('anti_ban.trust_reset', { session_id: id });
    res.redirect(back('monitoreo', 'Calentamiento reiniciado: la línea vuelve al día 1.'));
  });

  app.post('/anti-ban/quarantine/:id', ...guard, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const release = s((req.body as Record<string, unknown>).action) === 'release';
    if (release) {
      setQuarantine(id, false, 'Cuarentena liberada manualmente');
      audit('anti_ban.quarantine', { session_id: id, quarantine: false });
      res.redirect(back('monitoreo', 'Línea liberada de la cuarentena.'));
      return;
    }
    const rot = quarantineAndRotate(id, (batchId) => ctx.runner.enqueue(batchId), 'Puesta en cuarentena manualmente');
    res.redirect(
      back('monitoreo', rot.moved ? `Línea en cuarentena; ${rot.moved} lote(s) rotados a otra línea.` : 'Línea en cuarentena (sin lotes pendientes o sin otra línea sana).'),
    );
  });

  app.post('/anti-ban/rotate/:id', ...guard, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const rot = rotateBatches(id, (batchId) => ctx.runner.enqueue(batchId));
    audit('anti_ban.rotate', { session_id: id, batches: rot.moved, to: rot.to });
    res.redirect(back('monitoreo', rot.moved ? `${rot.moved} lote(s) movidos a una línea sana.` : 'No hay lotes pendientes o no hay otra línea sana.'));
  });

  // ── Lista negra ──────────────────────────────────────────────────────────────

  app.post('/blacklist', ...guard, (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const chatId = normalizeChatId(s(body.number));
    if (!chatId) {
      res.redirect(back('lista-negra', 'El número no es válido.'));
      return;
    }
    addOptout(chatId, s(body.reason) || 'Agregado manualmente', 'manual');
    audit('blacklist.added', { chat_id: chatId });
    res.redirect(back('lista-negra', 'Número agregado a la lista negra.'));
  });

  app.post('/blacklist/import', ...guard, (req: Request, res: Response) => {
    const raw = s((req.body as Record<string, unknown>).numbers);
    let added = 0;
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      const [num, ...rest] = text.split(',');
      const chatId = normalizeChatId(num);
      if (!chatId) continue;
      addOptout(chatId, rest.join(',').trim() || 'Importado de lista', 'manual');
      added++;
    }
    audit('blacklist.imported', { count: added });
    res.redirect(back('lista-negra', `${added} número(s) importado(s).`));
  });

  app.get('/blacklist/export', ...guard, (_req: Request, res: Response) => {
    const rows = listOptouts();
    const csv = ['chat_id,phone,reason,source,session_id,created_at']
      .concat(
        rows.map((o) =>
          [o.chat_id, o.phone ?? '', o.reason ?? '', o.source ?? '', o.session_id ?? '', o.created_at]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`)
            .join(','),
        ),
      )
      .join('\n');
    res.setHeader('Content-Disposition', 'attachment; filename="blacklist.csv"');
    res.type('text/csv').send(csv);
  });

  app.post('/blacklist/:chatId/delete', ...guard, (req: Request, res: Response) => {
    const chatId = decodeURIComponent(String(req.params.chatId));
    removeOptout(chatId);
    audit('blacklist.removed', { chat_id: chatId });
    res.redirect(back('lista-negra', 'Número quitado de la lista negra.'));
  });

  function recalcular(sessionId: string): void {
    try {
      recomputeHealth(sessionId);
    } catch {
      // ignore
    }
  }
}

export default registerAntiBanRoutes;
