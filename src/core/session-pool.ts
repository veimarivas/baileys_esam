import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { audit } from './webhooks.js';
import { setQuarantine } from './health.js';
import { logger } from '../logger.js';
import type { SessionRow } from '../types.js';

/** ¿La sesión está marcada en cuarentena? */
export function isQuarantined(sessionId: string): boolean {
  if (!sessionId) return false;
  return !!(get<{ q: number }>('SELECT quarantine AS q FROM session_health_metrics WHERE session_id = ?', sessionId)?.q);
}

/**
 * Elige una sesión sana del pool (conectada, sin cuarentena y no en rojo),
 * prefiriendo las verdes y con menos envíos en las últimas 24h.
 */
export function pickHealthySession(excludeId?: string): SessionRow | undefined {
  const params: unknown[] = [];
  let filter = "s.status = 'ready' AND COALESCE(h.quarantine, 0) = 0 AND COALESCE(h.health, 'green') <> 'red'";
  if (excludeId) {
    filter += ' AND s.id <> ?';
    params.push(excludeId);
  }
  return all<SessionRow>(
    `SELECT s.* FROM sessions s
       LEFT JOIN session_health_metrics h ON h.session_id = s.id
     WHERE ${filter}
     ORDER BY CASE COALESCE(h.health, 'green') WHEN 'green' THEN 0 WHEN 'yellow' THEN 1 ELSE 2 END,
              COALESCE(h.sent_24h, 0) ASC
     LIMIT 1`,
    ...params,
  )[0];
}

/** Sesiones que forman el pool disponible para rotación. */
export function poolSnapshot(): Array<SessionRow & { quarantine: number; health: string }> {
  return all<SessionRow & { quarantine: number; health: string }>(
    `SELECT s.*, COALESCE(h.quarantine, 0) AS quarantine, COALESCE(h.health, 'green') AS health
     FROM sessions s LEFT JOIN session_health_metrics h ON h.session_id = s.id
     WHERE s.status = 'ready'
     ORDER BY quarantine ASC, s.created_at ASC`,
  );
}

/**
 * Reasigna los lotes pendientes/en curso/pausados de una sesión a otra sana
 * del pool y los vuelve a encolar. Devuelve cuántos se movieron y el destino.
 */
export function rotateBatches(
  fromSessionId: string,
  enqueue: (batchId: number) => void,
): { moved: number; to: string | null } {
  const target = pickHealthySession(fromSessionId);
  if (!target) return { moved: 0, to: null };

  const batches = all<{ id: number }>(
    "SELECT id FROM batches WHERE session_id = ? AND status IN ('scheduled','running','paused')",
    fromSessionId,
  );
  const now = nowIso();
  for (const b of batches) {
    run(
      "UPDATE batches SET session_id = ?, status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
      target.id,
      now,
      now,
      b.id,
    );
    enqueue(b.id);
  }
  if (batches.length) {
    audit('session.rotated', { from: fromSessionId, to: target.id, batches: batches.length });
    logger.info({ from: fromSessionId, to: target.id, batches: batches.length }, 'Lotes rotados a una sesión sana');
  }
  return { moved: batches.length, to: target.id };
}

/**
 * Pone una sesión en cuarentena y rota sus lotes a otra sesión sana del pool.
 * Si no hay reemplazo, no mueve nada (el runner pausará el lote).
 */
export function quarantineAndRotate(
  sessionId: string,
  enqueue: (batchId: number) => void,
  reason: string,
): { moved: number; to: string | null } {
  setQuarantine(sessionId, true, reason);
  return rotateBatches(sessionId, enqueue);
}
