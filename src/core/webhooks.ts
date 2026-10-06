import crypto from 'node:crypto';
import { all, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { enqueueWebhook } from './webhook-queue.js';

export interface WebhookRow {
  id: number;
  session_id: string;
  url: string;
  secret: string | null;
  events: string | null;
}

/** Registra (o actualiza) el webhook de una sesión. */
export function registerWebhook(sessionId: string, url: string, secret: string, events: string[]): void {
  run(
    `INSERT INTO webhooks (session_id, url, secret, events, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, url) DO UPDATE SET secret = excluded.secret, events = excluded.events`,
    sessionId,
    url,
    secret,
    JSON.stringify(events ?? []),
    nowIso(),
  );
}

export function listWebhooks(sessionId: string): WebhookRow[] {
  return all<WebhookRow>('SELECT * FROM webhooks WHERE session_id = ?', sessionId);
}

function webhookAccepts(row: WebhookRow, event: string): boolean {
  if (!row.events) return true;
  try {
    const events = JSON.parse(row.events);
    return !Array.isArray(events) || events.length === 0 || events.includes(event);
  } catch {
    return true;
  }
}

/**
 * Envía un evento a los webhooks registrados de la sesión, firmado con
 * HMAC-SHA256 en `X-OpenWA-Signature` (mismo contrato que OpenWA).
 */
export async function dispatchEvent(sessionId: string, event: string, data: unknown): Promise<void> {
  const envelope = { sessionId, event, data };
  const body = JSON.stringify(envelope);

  await Promise.all(
    listWebhooks(sessionId)
      .filter((row) => webhookAccepts(row, event))
      .map(async (row) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (row.secret) {
          headers['X-OpenWA-Signature'] = `sha256=${crypto.createHmac('sha256', row.secret).update(body).digest('hex')}`;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.webhookTimeoutMs);
        try {
          const res = await fetch(row.url, { method: 'POST', headers, body, signal: controller.signal });
          if (!res.ok) {
            logger.warn({ url: row.url, event, status: res.status }, 'Webhook respondió con error');
            enqueueWebhook({ sessionId, url: row.url, secret: row.secret, event, body, error: `HTTP ${res.status}` });
          }
        } catch (err) {
          const message = (err as Error).message;
          logger.warn({ url: row.url, event, err: message }, 'No se pudo entregar el webhook');
          enqueueWebhook({ sessionId, url: row.url, secret: row.secret, event, body, error: message });
        } finally {
          clearTimeout(timer);
        }
      }),
  );
}

/** Guarda un webhook entrante para diagnóstico. */
export function logIncoming(event: string | null, ip: string | null, payload: string): void {
  run(
    'INSERT INTO webhook_logs (event, ip, payload, created_at) VALUES (?, ?, ?, ?)',
    event,
    ip,
    payload.slice(0, 2000),
    nowIso(),
  );
}

/** Registro de auditoría. */
export function audit(action: string, context?: Record<string, unknown>): void {
  run('INSERT INTO audit_logs (action, context, created_at) VALUES (?, ?, ?)', action, context ? JSON.stringify(context) : null, nowIso());
}
