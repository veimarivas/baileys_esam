import type express from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { get } from '../db/index.js';
import { esc, renderLayout } from './layout.js';
import { badge, card, emptyState, fmtDate, sectionHead, stat, table } from './views.js';
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
import { getHealth, listHealth, recomputeHealth, setQuarantine } from '../core/health.js';
import { quarantineAndRotate, rotateBatches } from '../core/session-pool.js';
import type { BatchRunner } from '../core/batches.js';
import type { SessionRow } from '../types.js';

const DAY_LABELS: Array<[number, string]> = [
  [1, 'Lun'],
  [2, 'Mar'],
  [3, 'Mié'],
  [4, 'Jue'],
  [5, 'Vie'],
  [6, 'Sáb'],
  [7, 'Dom'],
];

const RISK_LABELS: Record<RiskProfile, string> = {
  low: 'Bajo · conservador',
  medium: 'Medio · balanceado',
  high: 'Alto · agresivo',
};

function s(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

function n(value: unknown, fallback: number): number {
  const x = parseInt(s(value), 10);
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

/** Semáforo de salud (sección 3.2). */
function semaphore(health: string): string {
  const map: Record<string, { color: string; label: string; icon: string }> = {
    green: { color: 'success', label: 'Saludable', icon: 'ri-checkbox-blank-circle-fill' },
    yellow: { color: 'warning', label: 'Atención', icon: 'ri-checkbox-blank-circle-fill' },
    red: { color: 'danger', label: 'En riesgo', icon: 'ri-checkbox-blank-circle-fill' },
  };
  const m = map[health] ?? map.green;
  return `<span class="badge bg-${m.color}-subtle text-${m.color}"><i class="${m.icon} me-1"></i>${m.label}</span>`;
}

/** Formulario de política (global o de sesión), agrupado por tema. */
function policyForm(action: string, p: AntiBanPolicy, scopeLabel: string): string {
  const daysBoxes = DAY_LABELS.map(
    ([d, label]) => `<label class="btn btn-outline-secondary btn-sm">
        <input type="checkbox" name="window_days" value="${d}" class="form-check-input me-1" ${p.window_days.includes(d) ? 'checked' : ''}/>
        ${label}
      </label>`,
  ).join(' ');
  const profileOpts = (['low', 'medium', 'high'] as RiskProfile[])
    .map((r) => `<option value="${r}" ${p.risk_profile === r ? 'selected' : ''}>${esc(RISK_LABELS[r])}</option>`)
    .join('');
  const preset = presetFor(p.risk_profile);

  return `<form method="post" action="${action}">
    <p class="text-muted mb-1">${esc(scopeLabel)}</p>

    <div class="policy-group">
      <div class="policy-legend"><i class="ri-speed-up-line"></i>Ritmo y límites</div>
      <div class="row g-3">
        <div class="col-md-4">
          <label class="form-label">Perfil de riesgo</label>
          <select name="risk_profile" class="form-select">${profileOpts}</select>
          <div class="form-text">Día 1: ${esc(preset.warmup_day1_limit)} msgs · ${esc(RISK_PRESETS[p.risk_profile].delay_min_seconds)}–${esc(RISK_PRESETS[p.risk_profile].delay_max_seconds)} s</div>
        </div>
        <div class="col-md-4">
          <label class="form-label">Límite diario</label>
          <input type="number" min="1" name="daily_limit" class="form-control" value="${p.daily_limit}" />
        </div>
        <div class="col-md-4">
          <label class="form-label">Límite por hora</label>
          <input type="number" min="1" name="hourly_limit" class="form-control" value="${p.hourly_limit}" />
        </div>
        <div class="col-md-6">
          <label class="form-label">Delay mínimo (s)</label>
          <input type="number" min="1" name="delay_min_seconds" class="form-control" value="${p.delay_min_seconds}" />
        </div>
        <div class="col-md-6">
          <label class="form-label">Delay máximo (s)</label>
          <input type="number" min="1" name="delay_max_seconds" class="form-control" value="${p.delay_max_seconds}" />
        </div>
      </div>
    </div>

    <div class="policy-group">
      <div class="policy-legend"><i class="ri-calendar-schedule-line"></i>Ventana y días de envío</div>
      <div class="row g-3">
        <div class="col-md-6">
          <label class="form-label">Ventana desde</label>
          <input type="time" name="window_start" class="form-control" value="${esc(p.window_start)}" />
        </div>
        <div class="col-md-6">
          <label class="form-label">Ventana hasta</label>
          <input type="time" name="window_end" class="form-control" value="${esc(p.window_end)}" />
        </div>
        <div class="col-12">
          <label class="form-label d-block">Días permitidos</label>
          <div class="d-flex flex-wrap gap-2">${daysBoxes}</div>
        </div>
      </div>
    </div>

    <div class="policy-group">
      <div class="policy-legend"><i class="ri-seedling-line"></i>Calentamiento (warm-up)</div>
      <div class="row g-3 align-items-end">
        <div class="col-md-4">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" name="warmup_enabled" value="1" id="ab-warm-${esc(action)}" ${p.warmup_enabled ? 'checked' : ''}/>
            <label class="form-check-label" for="ab-warm-${esc(action)}">Calentamiento activo</label>
          </div>
        </div>
        <div class="col-md-4">
          <label class="form-label">Tope día 1</label>
          <input type="number" min="1" name="warmup_day1_limit" class="form-control" value="${p.warmup_day1_limit}" />
        </div>
        <div class="col-md-4">
          <label class="form-label">Umbral de entregabilidad (%)</label>
          <input type="number" min="1" max="100" name="health_threshold" class="form-control" value="${Math.round(p.health_delivery_threshold * 100)}" />
        </div>
      </div>
    </div>

    <div class="policy-group">
      <div class="policy-legend"><i class="ri-pause-circle-line"></i>Pausas por fatiga</div>
      <div class="row g-3 align-items-end">
        <div class="col-md-3">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" name="pauses_enabled" value="1" id="ab-pause-${esc(action)}" ${p.pauses_enabled ? 'checked' : ''}/>
            <label class="form-check-label" for="ab-pause-${esc(action)}">Pausas activas</label>
          </div>
        </div>
        <div class="col-md-3">
          <label class="form-label">Pausa cada (msgs)</label>
          <input type="number" min="1" name="pause_every" class="form-control" value="${p.pause_every}" />
        </div>
        <div class="col-md-3">
          <label class="form-label">Pausa mín (min)</label>
          <input type="number" min="0" name="pause_min_minutes" class="form-control" value="${p.pause_min_minutes}" />
        </div>
        <div class="col-md-3">
          <label class="form-label">Pausa máx (min)</label>
          <input type="number" min="0" name="pause_max_minutes" class="form-control" value="${p.pause_max_minutes}" />
        </div>
      </div>
    </div>

    <div class="policy-group">
      <div class="policy-legend"><i class="ri-user-voice-line"></i>Envío humano (todos los envíos automáticos)</div>
      <div class="row g-3 align-items-end">
        <div class="col-md-4">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" name="typing_simulation" value="1" id="ab-typing-${esc(action)}" ${p.typing_simulation ? 'checked' : ''}/>
            <label class="form-check-label" for="ab-typing-${esc(action)}">Simular "escribiendo…"</label>
          </div>
          <div class="form-text">Muestra escribiendo/grabando unos segundos antes de cada envío de lotes, API y auto-respuestas.</div>
        </div>
        <div class="col-md-4">
          <label class="form-label">Separación mínima (s)</label>
          <input type="number" min="0" max="120" name="min_gap_seconds" class="form-control" value="${p.min_gap_seconds}" />
          <div class="form-text">Entre dos envíos automáticos cualesquiera de la sesión.</div>
        </div>
        <div class="col-md-4">
          <label class="form-label">Tope por minuto</label>
          <input type="number" min="0" max="120" name="burst_per_minute" class="form-control" value="${p.burst_per_minute}" />
          <div class="form-text">Evita ráfagas (incluye el panel). 0 = sin tope.</div>
        </div>
      </div>
    </div>

    <div class="policy-group">
      <div class="policy-legend"><i class="ri-shield-user-line"></i>Reputación del número</div>
      <div class="row g-3 align-items-end">
        <div class="col-md-4">
          <label class="form-label">Contactos nuevos por día</label>
          <input type="number" min="0" name="new_contacts_daily_limit" class="form-control" value="${p.new_contacts_daily_limit}" />
          <div class="form-text">Números sin conversación previa. Escribir en frío es la causa n.º 1 de reportes. 0 = sin tope.</div>
        </div>
        <div class="col-md-4">
          <label class="form-label">Fallos seguidos para cuarentena</label>
          <input type="number" min="1" max="50" name="max_consecutive_failures" class="form-control" value="${p.max_consecutive_failures}" />
        </div>
        <div class="col-md-4">
          <div class="form-check form-switch mb-2">
            <input class="form-check-input" type="checkbox" name="verify_numbers" value="1" id="ab-verify-${esc(action)}" ${p.verify_numbers ? 'checked' : ''}/>
            <label class="form-check-label" for="ab-verify-${esc(action)}">Verificar que el número tenga WhatsApp</label>
          </div>
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" name="auto_pause_low_delivery" value="1" id="ab-lowdel-${esc(action)}" ${p.auto_pause_low_delivery ? 'checked' : ''}/>
            <label class="form-check-label" for="ab-lowdel-${esc(action)}">Pausar el lote si cae la entregabilidad</label>
          </div>
        </div>
      </div>
    </div>

    <div class="policy-group">
      <div class="policy-legend"><i class="ri-toggle-line"></i>Estado del motor</div>
      <div class="form-check form-switch">
        <input class="form-check-input" type="checkbox" name="active" value="1" id="ab-active-${esc(action)}" ${p.active ? 'checked' : ''}/>
        <label class="form-check-label" for="ab-active-${esc(action)}">Motor activo</label>
      </div>
    </div>

    <div class="d-flex gap-2 flex-wrap">
      <button class="btn btn-primary" type="submit" name="action" value="save"><i class="ri-save-line me-1"></i>Guardar cambios</button>
      <button class="btn btn-soft-secondary" type="submit" name="action" value="preset"><i class="ri-magic-line me-1"></i>Aplicar preset del perfil</button>
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
  };
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
    return `<div class="text-warning fs-12"><i class="ri-lock-unlock-line me-1"></i>${esc(d.count)} mensaje(s) sin descifrar en 24 h${esc(fromPhone)}. Si sigue ocurriendo, volvé a vincular el número.</div>`;
  } catch {
    return '';
  }
}

function healthDashboard(): string {
  const rows = listHealth();
  if (!rows.length) {
    return card(
      'Salud de sesiones',
      emptyState('ri-heart-pulse-line', 'Sin sesiones para monitorear', 'Cuando vincules un número, acá verás su entregabilidad, su warm-up y su estado.'),
    );
  }
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.health] = (acc[r.health] ?? 0) + 1;
    return acc;
  }, {});
  const summary = `<div class="row g-3 mb-3">
    <div class="col-md-4">${stat('Saludables', counts.green ?? 0, 'success', 'ri-checkbox-circle-line', 'listas para enviar')}</div>
    <div class="col-md-4">${stat('En atención', counts.yellow ?? 0, 'warning', 'ri-alert-line', 'vigilar la entregabilidad')}</div>
    <div class="col-md-4">${stat('En riesgo', counts.red ?? 0, 'danger', 'ri-error-warning-line', 'revisar o poner en cuarentena')}</div>
  </div>`;
  const body = table(
    ['Sesión', 'Salud', 'Enviados 24h', 'Entregados', 'Leídos', 'Fallidos', 'Bloqueados', 'Entregab.', 'Warm-up', 'Acciones'],
    rows.map((r) => {
      const rate = `${Math.round(Number(r.delivery_rate) * 100)}%`;
      const warm = r.warmup_day ? `Día ${r.warmup_day}${r.warmup_limit ? ` · ${r.warmup_limit}/día` : ''}` : '—';
      const quarantineAction = r.quarantine
        ? `<form method="post" action="/anti-ban/quarantine/${esc(r.session_id)}" class="d-inline"><input type="hidden" name="action" value="release"/><button class="btn btn-soft-success btn-sm" type="submit">Liberar</button></form>`
        : `<form method="post" action="/anti-ban/quarantine/${esc(r.session_id)}" class="d-inline"><input type="hidden" name="action" value="apply"/><button class="btn btn-soft-danger btn-sm" type="submit">Cuarentena</button></form>`;
      return [
        `<span class="ff-monospace">${esc(r.session_id.slice(0, 8))}</span>${r.status_reason ? `<div class="text-muted fs-12">${esc(r.status_reason)}</div>` : ''}${decryptWarning(r.session_id)}`,
        semaphore(r.health),
        String(r.sent_24h),
        String(r.delivered_24h),
        String(r.read_24h),
        String(r.failed_24h),
        String(r.blocked_24h),
        `<b>${rate}</b>`,
        esc(warm),
        `<div class="d-flex gap-1">${quarantineAction}
           <form method="post" action="/anti-ban/rotate/${esc(r.session_id)}" class="d-inline"><button class="btn btn-soft-info btn-sm" type="submit" title="Rotar lotes a otra sesión sana">Rotar</button></form>
           <form method="post" action="/anti-ban/session/${esc(r.session_id)}/reset" class="d-inline"><button class="btn btn-soft-warning btn-sm" type="submit" title="Reiniciar warm-up">Reset</button></form>
         </div>`,
      ];
    }),
  );
  return `${summary}${card('Detalle por sesión (últimas 24h)', body)}`;
}

/** Módulo de rutas del panel anti-baneo (Fase 2). */
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

  app.get('/anti-ban', ...guard, (req: Request, res: Response) => {
    const user = (req as Request & { user: UserRow }).user;
    const sessions = ctx.sessions();
    const global = getPolicy(null);
    const healthById = new Map(listHealth().map((h) => [h.session_id, h]));

    const sessionRows = sessions.map((sess) => {
      const custom = !!get<{ c: number }>('SELECT COUNT(*) c FROM anti_ban_policies WHERE session_id = ?', sess.id)?.c;
      const eff = getPolicy(sess.id);
      const health = healthById.get(sess.id);
      return [
        `${esc(sess.owner_name ?? sess.name)}<div class="text-muted fs-12 ff-monospace">${esc(sess.phone ?? sess.expected_phone ?? sess.id.slice(0, 8))}</div>`,
        `${semaphore(health?.health ?? 'green')} ${custom ? badge('Personalizada', 'info') : badge('Global', 'secondary')}`,
        `${esc(RISK_LABELS[eff.risk_profile])}`,
        `${eff.daily_limit}/día · ${eff.hourly_limit}/h · ${eff.delay_min_seconds}-${eff.delay_max_seconds}s`,
        `<a class="btn btn-soft-primary btn-sm" href="/anti-ban/session/${esc(sess.id)}">Editar</a>`,
      ];
    });

    const blacklist = listOptouts();
    const blacklistBody = table(
      ['Número', 'Motivo', 'Origen', 'Fecha', ''],
      blacklist
        .slice(0, 200)
        .map((o) => [
          `<span class="ff-monospace">${esc(o.phone ?? o.chat_id)}</span>`,
          esc(o.reason ?? '—'),
          badge(o.source ?? 'manual', o.source === 'blocked' ? 'danger' : o.source === 'reply' ? 'warning' : 'secondary'),
          esc(fmtDate(o.created_at)),
          `<form method="post" action="/blacklist/${encodeURIComponent(o.chat_id)}/delete"><button class="btn btn-soft-danger btn-sm" type="submit">Quitar</button></form>`,
        ]),
    );

    const blacklistDetail = blacklist.length
      ? blacklistBody
      : emptyState('ri-forbidden-2-line', 'La lista negra está vacía', 'Agregá números que no deben recibir mensajes; se respetan en todos los envíos.');

    const body = `
      ${sectionHead('ri-heart-pulse-line', 'Salud de sesiones', 'Entregabilidad, warm-up y estado de cada número en las últimas 24 horas.')}
      ${healthDashboard()}

      ${sectionHead('ri-shield-star-line', 'Políticas anti-baneo', 'Definí el ritmo, las ventanas y el calentamiento que regulan los envíos.')}
      <div class="row g-3">
        <div class="col-xl-7">${card('Política global', policyForm('/anti-ban/global', global, 'Valores por defecto para todas las sesiones'))}</div>
        <div class="col-xl-5">${card(
          'Sesiones',
          sessionRows.length
            ? table(['Sesión', 'Política', 'Perfil', 'Límites', ''], sessionRows)
            : emptyState('ri-stack-line', 'Sin sesiones vinculadas', 'Las sesiones aparecen al vincular números en Conexión.'),
          `<a class="btn btn-soft-primary btn-sm" href="/anti-ban">Actualizar</a>`,
        )}</div>
      </div>

      ${sectionHead('ri-forbidden-2-line', 'Lista negra', 'Números que nunca deben recibir mensajes (opt-out y bloqueos).')}
      <div class="row g-3">
        <div class="col-lg-6">${card(
          'Agregar un número',
          `<form method="post" action="/blacklist" class="row g-2 align-items-end">
             <div class="col-md-6"><label class="form-label">Número</label><input name="number" class="form-control" placeholder="591XXXXXXXX" required/></div>
             <div class="col-md-6"><label class="form-label">Motivo</label><input name="reason" class="form-control" placeholder="Solicitó la baja"/></div>
             <div class="col-12"><button class="btn btn-primary w-100" type="submit"><i class="ri-add-line me-1"></i>Agregar a la lista</button></div>
           </form>`,
        )}</div>
        <div class="col-lg-6">${card(
          'Importar o exportar',
          `<form method="post" action="/blacklist/import" class="mb-2">
             <label class="form-label">Un número por línea</label>
             <textarea name="numbers" class="form-control mb-2" rows="3" placeholder="59170000000&#10;59170000001, solicitó la baja"></textarea>
             <div class="d-flex gap-2">
               <button class="btn btn-soft-primary" type="submit"><i class="ri-upload-2-line me-1"></i>Importar lista</button>
               <a class="btn btn-soft-secondary" href="/blacklist/export"><i class="ri-download-2-line me-1"></i>Exportar CSV</a>
             </div>
           </form>`,
        )}</div>
      </div>
      <div class="card mt-3"><div class="card-body pt-0">${blacklistDetail}</div></div>`;

    res.send(
      renderLayout('Anti-Baneo', user, 'policies', body, {
        subtitle: 'Políticas, salud de sesiones y lista negra global.',
        actions: `<a class="btn btn-soft-secondary btn-sm" href="/anti-ban"><i class="ri-refresh-line me-1"></i>Actualizar</a>`,
      }),
    );
  });

  app.post('/anti-ban/global', ...guard, (req: Request, res: Response) => {
    const base = getPolicy(null);
    const applyPreset = s((req.body as Record<string, unknown>).action) === 'preset';
    const patch = applyPreset ? presetFor(profile((req.body as Record<string, unknown>).risk_profile, base.risk_profile)) : parsePolicyForm(req.body as Record<string, unknown>, base);
    upsertPolicy(null, patch);
    audit('anti_ban.policy_updated', { scope: 'global', profile: patch.risk_profile });
    res.redirect('/anti-ban?ok=' + encodeURIComponent('Política global actualizada.'));
  });

  app.get('/anti-ban/session/:id', ...guard, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const policy = getPolicy(id);
    const health = getHealth(id) ?? recomputeHealth(id);
    const body = `
      ${card('Salud de la sesión', table(
        ['Enviados 24h', 'Entregados', 'Leídos', 'Fallidos', 'Bloqueados', 'Entregabilidad', 'Warm-up'],
        [[
          String(health.sent_24h),
          String(health.delivered_24h),
          String(health.read_24h),
          String(health.failed_24h),
          String(health.blocked_24h),
          `<b>${Math.round(Number(health.delivery_rate) * 100)}%</b>`,
          health.warmup_day ? `Día ${health.warmup_day}` : '—',
        ]],
      ))}
      ${card('Política de la sesión', policyForm(`/anti-ban/session/${esc(id)}`, policy, `Override para ${esc(id.slice(0, 8))} (vacío = usa la global)`))}
      <a class="btn btn-soft-secondary" href="/anti-ban"><i class="ri-arrow-left-line me-1"></i>Volver</a>`;
    res.send(renderLayout('Política de sesión', authed(req), 'policies', body));
  });

  app.post('/anti-ban/session/:id', ...guard, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const base = getPolicy(id);
    const applyPreset = s((req.body as Record<string, unknown>).action) === 'preset';
    const patch = applyPreset ? presetFor(profile((req.body as Record<string, unknown>).risk_profile, base.risk_profile)) : parsePolicyForm(req.body as Record<string, unknown>, base);
    upsertPolicy(id, patch);
    recalcular(id);
    audit('anti_ban.policy_updated', { scope: 'session', session_id: id, profile: patch.risk_profile });
    res.redirect(`/anti-ban/session/${encodeURIComponent(id)}?ok=` + encodeURIComponent('Política de la sesión actualizada.'));
  });

  app.post('/anti-ban/session/:id/reset', ...guard, (req: Request, res: Response) => {
    const id = String(req.params.id);
    resetTrust(id);
    audit('anti_ban.trust_reset', { session_id: id });
    res.redirect('/anti-ban?ok=' + encodeURIComponent('Confianza reiniciada (warm-up en día 1).'));
  });

  app.post('/anti-ban/quarantine/:id', ...guard, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const release = s((req.body as Record<string, unknown>).action) === 'release';
    if (release) {
      setQuarantine(id, false, 'Cuarentena liberada manualmente');
      audit('anti_ban.quarantine', { session_id: id, quarantine: false });
      res.redirect('/anti-ban?ok=' + encodeURIComponent('Sesión liberada.'));
      return;
    }
    const rot = quarantineAndRotate(id, (batchId) => ctx.runner.enqueue(batchId), 'Puesto en cuarentena manualmente');
    audit('anti_ban.quarantine', { session_id: id, quarantine: true, moved: rot.moved, to: rot.to });
    res.redirect(
      '/anti-ban?ok=' +
        encodeURIComponent(rot.moved ? `Sesión en cuarentena; ${rot.moved} lote(s) rotados.` : 'Sesión en cuarentena (sin lotes pendientes o sin reemplazo sano).'),
    );
  });

  app.post('/anti-ban/rotate/:id', ...guard, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const rot = rotateBatches(id, (batchId) => ctx.runner.enqueue(batchId));
    audit('anti_ban.rotate', { session_id: id, batches: rot.moved, to: rot.to });
    res.redirect(
      '/anti-ban?ok=' +
        encodeURIComponent(rot.moved ? `${rot.moved} lote(s) movidos a una sesión sana.` : 'No hay lotes pendientes ni sesión sana disponible.'),
    );
  });

  // ── Lista negra ──────────────────────────────────────────────────────────────

  app.post('/blacklist', ...guard, (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const chatId = normalizeChatId(s(body.number));
    if (chatId) {
      addOptout(chatId, s(body.reason) || 'Agregado manualmente', 'manual');
      audit('blacklist.added', { chat_id: chatId });
    }
    res.redirect('/anti-ban?ok=' + encodeURIComponent('Número agregado a la lista negra.'));
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
    res.redirect('/anti-ban?ok=' + encodeURIComponent(`${added} número(s) importado(s).`));
  });

  app.get('/blacklist/export', ...guard, (_req: Request, res: Response) => {
    const rows = listOptouts();
    const csv = ['chat_id,phone,reason,source,created_at']
      .concat(rows.map((o) => [o.chat_id, o.phone ?? '', o.reason ?? '', o.source ?? '', o.created_at].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))
      .join('\n');
    res.setHeader('Content-Disposition', 'attachment; filename="blacklist.csv"');
    res.type('text/csv').send(csv);
  });

  app.post('/blacklist/:chatId/delete', ...guard, (req: Request, res: Response) => {
    const chatId = decodeURIComponent(String(req.params.chatId));
    removeOptout(chatId);
    audit('blacklist.removed', { chat_id: chatId });
    res.redirect('/anti-ban?ok=' + encodeURIComponent('Número quitado de la lista negra.'));
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
