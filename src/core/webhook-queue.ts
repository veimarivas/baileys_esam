import crypto from 'node:crypto';
import { all, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

export interface WebhookQueueRow {
  id: number;
  session_id: string;
  url: string;
  secret: string | null;
  event: string;
  body: string;
  attempts: number;
  next_try_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Instante lejano para marcar un webhook como agotado (no se reintenta). */
const DEAD = '9999-12-31T00:00:00.000Z';
const MAX_BACKOFF_MS = 3_600_000;

/** Backoff exponencial acotado a 1 hora. */
function backoffMs(attempts: number): number {
  return Math.min(config.webhookRetry.baseDelayMs * 2 ** attempts, MAX_BACKOFF_MS);
}

/**
 * Encola un webhook que no se pudo entregar para reintentarlo con backoff
 * exponencial (sección 4.2 de MEJORAS.md).
 */
export function enqueueWebhook(opts: {
  sessionId: string;
  url: string;
  secret: string | null;
  event: string;
  body: string;
  error?: string | null;
}): void {
  const now = nowIso();
  run(
    `INSERT INTO webhook_queue (session_id, url, secret, event, body, attempts, next_try_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    opts.sessionId,
    opts.url,
    opts.secret,
    opts.event,
    opts.body,
    new Date(Date.now() + config.webhookRetry.baseDelayMs).toISOString(),
    opts.error ?? null,
    now,
    now,
  );
}

/** Entrega un webhook firmado; devuelve el resultado sin lanzar. */
export async function deliverWebhook(
  url: string,
  secret: string | null,
  body: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) {
    headers['X-OpenWA-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.webhookTimeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Procesa los webhooks vencidos: los reintenta y, al agotar los intentos, los
 * marca como muertos (quedan en la tabla para inspección).
 */
export async function processWebhookQueue(limit = 20): Promise<number> {
  const rows = all<WebhookQueueRow>(
    'SELECT * FROM webhook_queue WHERE next_try_at <= ? ORDER BY next_try_at LIMIT ?',
    nowIso(),
    limit,
  );
  let processed = 0;
  for (const row of rows) {
    const result = await deliverWebhook(row.url, row.secret, row.body);
    if (result.ok) {
      run('DELETE FROM webhook_queue WHERE id = ?', row.id);
    } else {
      const attempts = row.attempts + 1;
      if (attempts >= config.webhookRetry.maxAttempts) {
        run(
          'UPDATE webhook_queue SET attempts = ?, next_try_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
          attempts,
          DEAD,
          `${result.error ?? 'error'} (reintentos agotados)`,
          nowIso(),
          row.id,
        );
        logger.warn({ url: row.url, event: row.event, attempts }, 'Webhook descartado tras agotar reintentos');
      } else {
        run(
          'UPDATE webhook_queue SET attempts = ?, next_try_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
          attempts,
          new Date(Date.now() + backoffMs(attempts)).toISOString(),
          result.error ?? null,
          nowIso(),
          row.id,
        );
      }
    }
    processed++;
  }
  return processed;
}

/** Pendientes de reintento (para el panel/diagnóstico). */
export function pendingWebhooks(limit = 100): WebhookQueueRow[] {
  return all<WebhookQueueRow>(
    "SELECT * FROM webhook_queue WHERE next_try_at <> ? ORDER BY next_try_at LIMIT ?",
    DEAD,
    limit,
  );
}

/** Arranca el worker que reintenta webhooks periódicamente. */
export function startWebhookQueueWorker(intervalMs = 30_000): NodeJS.Timeout {
  const tick = () => {
    processWebhookQueue().catch((err) =>
      logger.warn({ err: (err as Error).message }, 'Error procesando la cola de webhooks'),
    );
  };
  const timer = setInterval(tick, intervalMs);
  setTimeout(tick, 5_000);
  return timer;
}
