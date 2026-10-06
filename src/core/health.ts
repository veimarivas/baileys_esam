import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { getPolicy, warmupState, warmupStartMs } from './anti-ban.js';
import type { SessionRow } from '../types.js';

export type HealthLevel = 'green' | 'yellow' | 'red';

export interface HealthRow {
  session_id: string;
  health: HealthLevel;
  status_reason: string | null;
  sent_24h: number;
  delivered_24h: number;
  read_24h: number;
  failed_24h: number;
  blocked_24h: number;
  delivery_rate: number;
  report_rate: number;
  warmup_day: number | null;
  warmup_limit: number | null;
  quarantine: number;
  last_error: string | null;
  updated_at: string;
}

const DAY_MS = 86_400_000;

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0) || 0;
}

/**
 * Recalcula las metricas de 24h de una sesion y su semaforo de salud, y las
 * deja materializadas en `session_health_metrics` (seccion 3.2 de MEJORAS.md).
 */
export function recomputeHealth(sessionId: string, opts: { lastError?: string | null } = {}): HealthRow {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const session = get<SessionRow>('SELECT * FROM sessions WHERE id = ?', sessionId) ?? null;
  const policy = getPolicy(sessionId);

  const counts = get<{ sent: number; delivered: number; read: number; failed: number }>(
    `SELECT
       SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN direction = 'out' AND status IN ('delivered','read','played') THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN direction = 'out' AND status IN ('read','played') THEN 1 ELSE 0 END) AS read,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM messages WHERE session_id = ? AND occurred_at >= ?`,
    sessionId,
    since,
  );

  const sent = num(counts?.sent);
  const delivered = num(counts?.delivered);
  const read = num(counts?.read);
  const failed = num(counts?.failed);
  const blocked = num(
    get<{ c: number }>("SELECT COUNT(*) AS c FROM optouts WHERE source = 'blocked' AND created_at >= ?", since)?.c,
  );
  const deliveryRate = sent > 0 ? delivered / sent : 1;
  const reportRate = sent > 0 ? blocked / sent : 0;

  const warm = warmupState(policy, warmupStartMs(policy, session));
  const existing = get<{ quarantine: number; last_error: string | null }>(
    'SELECT quarantine, last_error FROM session_health_metrics WHERE session_id = ?',
    sessionId,
  );
  const quarantine = existing?.quarantine ?? 0;
  const lastError = opts.lastError ?? existing?.last_error ?? null;

  let health: HealthLevel = 'green';
  let reason = 'Operando normal';
  if (quarantine) {
    health = 'red';
    reason = 'En cuarentena por el sistema';
  } else if (sent >= 5 && deliveryRate < policy.health_delivery_threshold) {
    health = 'red';
    reason = `Tasa de entrega baja (${Math.round(deliveryRate * 100)}%)`;
  } else if (sent >= 5 && deliveryRate < policy.health_delivery_threshold + 0.05) {
    health = 'yellow';
    reason = `Tasa de entrega acercandose al umbral (${Math.round(deliveryRate * 100)}%)`;
  } else if (warm.active) {
    health = 'yellow';
    reason = `En calentamiento (dia ${warm.day})`;
  }

  const now = nowIso();
  run(
    `INSERT INTO session_health_metrics
       (session_id, health, status_reason, sent_24h, delivered_24h, read_24h, failed_24h, blocked_24h,
        delivery_rate, report_rate, warmup_day, warmup_limit, quarantine, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       health = excluded.health,
       status_reason = excluded.status_reason,
       sent_24h = excluded.sent_24h,
       delivered_24h = excluded.delivered_24h,
       read_24h = excluded.read_24h,
       failed_24h = excluded.failed_24h,
       blocked_24h = excluded.blocked_24h,
       delivery_rate = excluded.delivery_rate,
       report_rate = excluded.report_rate,
       warmup_day = excluded.warmup_day,
       warmup_limit = excluded.warmup_limit,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
    sessionId,
    health,
    reason,
    sent,
    delivered,
    read,
    failed,
    blocked,
    deliveryRate,
    reportRate,
    warm.enabled ? warm.day : null,
    warm.active ? warm.dailyLimit : null,
    quarantine,
    lastError,
    now,
  );

  return getHealth(sessionId)!;
}

export function getHealth(sessionId: string): HealthRow | undefined {
  return get<HealthRow>('SELECT * FROM session_health_metrics WHERE session_id = ?', sessionId);
}

/** Todas las sesiones con una fila de salud (crea las ausentes al vuelo). */
export function listHealth(): HealthRow[] {
  const sessions = all<{ id: string }>('SELECT id FROM sessions ORDER BY created_at');
  for (const s of sessions) {
    if (!getHealth(s.id)) recomputeHealth(s.id);
  }
  return all<HealthRow>('SELECT * FROM session_health_metrics ORDER BY updated_at DESC');
}

/** Pone (o quita) una sesion en cuarentena y refresca su semaforo. */
export function setQuarantine(sessionId: string, quarantine: boolean, reason: string): void {
  const now = nowIso();
  run(
    `INSERT INTO session_health_metrics (session_id, health, status_reason, quarantine, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET quarantine = excluded.quarantine, updated_at = excluded.updated_at`,
    sessionId,
    quarantine ? 'red' : 'green',
    reason,
    quarantine ? 1 : 0,
    now,
  );
  recomputeHealth(sessionId, { lastError: reason });
}
