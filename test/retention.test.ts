import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanupLogs, optimizeDb } from '../src/core/retention.js';
import { all, run } from '../src/db/index.js';

/**
 * Mantenimiento de la base (A4). Las tablas de diagnóstico crecían para siempre;
 * acá se fija qué se poda y qué **no** (los avisos sin leer se conservan).
 */

const DEAD = '9999-12-31T00:00:00.000Z';

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

function webhookLog(event: string, daysAgo: number): void {
  run('INSERT INTO webhook_logs (event, ip, payload, created_at) VALUES (?, ?, ?, ?)', event, '127.0.0.1', '{}', iso(daysAgo));
}

function auditLog(action: string, daysAgo: number): void {
  run('INSERT INTO audit_logs (action, context, created_at) VALUES (?, ?, ?)', action, null, iso(daysAgo));
}

function notice(title: string, daysAgo: number, read: boolean): void {
  run(
    `INSERT INTO notifications (user_id, kind, title, body, link, session_id, created_at, read_at)
     VALUES (1, 'note_created', ?, NULL, NULL, NULL, ?, ?)`,
    title,
    iso(daysAgo),
    read ? iso(daysAgo) : null,
  );
}

function queueWebhook(nextTryAt: string, daysAgo: number): void {
  run(
    `INSERT INTO webhook_queue (session_id, url, event, body, attempts, next_try_at, created_at, updated_at)
     VALUES ('s-1', 'http://ejemplo.test/hook', 'message.in', '{}', 8, ?, ?, ?)`,
    nextTryAt,
    iso(daysAgo),
    iso(daysAgo),
  );
}

describe('cleanupLogs', () => {
  it('borra los logs viejos y conserva los recientes', () => {
    webhookLog('viejo', 200);
    webhookLog('nuevo', 1);
    auditLog('accion.vieja', 200);
    auditLog('accion.nueva', 1);

    const res = cleanupLogs(90, 30);
    assert.equal(res.webhooks, 1);
    assert.equal(res.audits, 1);
    assert.deepEqual(
      all<{ event: string }>('SELECT event FROM webhook_logs ORDER BY event').map((r) => r.event),
      ['nuevo'],
    );
    assert.deepEqual(
      all<{ action: string }>('SELECT action FROM audit_logs ORDER BY action').map((r) => r.action),
      ['accion.nueva'],
    );
  });

  it('poda los avisos ya leídos y conserva los que nadie leyó', () => {
    notice('leido-viejo', 200, true);
    notice('leido-nuevo', 2, true);
    notice('sin-leer-viejo', 200, false);

    const res = cleanupLogs(90, 30);
    assert.equal(res.notifications, 1);
    assert.deepEqual(
      all<{ title: string }>('SELECT title FROM notifications ORDER BY title').map((r) => r.title),
      ['leido-nuevo', 'sin-leer-viejo'],
    );
  });

  it('poda solo los webhooks descartados y viejos', () => {
    queueWebhook(DEAD, 200); // descartado y viejo → se borra
    queueWebhook(DEAD, 1); // descartado pero reciente → queda para inspección
    queueWebhook(iso(0), 200); // pendiente viejo → no se toca (se sigue reintentando)

    const res = cleanupLogs(90, 30);
    assert.equal(res.deadWebhooks, 1);
    assert.equal(all<{ c: number }>('SELECT COUNT(*) AS c FROM webhook_queue')[0]?.c, 2);
  });

  it('con retención 0 no deja logs antiguos', () => {
    const res = cleanupLogs(0, 0);
    assert.ok(res.webhooks + res.audits + res.notifications + res.deadWebhooks > 0);
    assert.equal(all<{ c: number }>('SELECT COUNT(*) AS c FROM webhook_logs')[0]?.c, 0);
    assert.equal(all<{ c: number }>('SELECT COUNT(*) AS c FROM audit_logs')[0]?.c, 0);
  });
});

describe('optimizeDb', () => {
  it('no falla al actualizar las estadísticas', () => {
    assert.doesNotThrow(() => optimizeDb());
  });
});
