import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { logger } from '../logger.js';
import type { BatchRunner } from './batches.js';
import { expireAwaiting } from './batch-confirm.js';

/**
 * Arranca los lotes cuyo `scheduled_at` ya venció y los encola. Se ejecuta
 * periódicamente desde el arranque del servicio.
 */
export function startScheduler(runner: BatchRunner): NodeJS.Timeout {
  const tick = () => {
    try {
      // Programaciones que nadie confirmó: se cancelan (nunca se envían solas).
      expireAwaiting();
      const due = all<{ id: number; scheduled_at: string }>(
        "SELECT id, scheduled_at FROM batches WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?",
        nowIso(),
      );
      for (const batch of due) {
        run("UPDATE batches SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), batch.id);
        runner.enqueue(batch.id);
        logger.info({ batch: batch.id }, 'Lote programado iniciado');
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Error en el planificador de lotes');
    }
  };

  const timer = setInterval(tick, 30_000);
  tick();
  return timer;
}

/** Programa un lote para una fecha/hora futura. */
export function scheduleBatch(batchId: number, when: string): void {
  run("UPDATE batches SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?", when, nowIso(), batchId);
}

/** Lotes programados y su estado. */
export function scheduledBatches() {
  return all('SELECT id, name, scheduled_at, status FROM batches WHERE status = \'scheduled\' ORDER BY scheduled_at');
}
