import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { suspiciousBatch } from '../src/core/line-verdict.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Aviso de posible límite temporal: un lote con muchos mensajes sin acuse y
 * el mismo archivo repetido. No debe saltar si los mensajes ya entregaron o
 * si el lote no repite el mismo contenido.
 */

function seedSession(id: string): void {
  const now = nowIso();
  run(
    `INSERT INTO sessions (id, name, status, created_at, updated_at)
     VALUES (?, ?, 'ready', ?, ?)`,
    id,
    'Línea de prueba ' + id,
    now,
    now,
  );
}

function seedBatch(sessionId: string, name: string, media: (i: number) => string): number {
  const batchId = run(
    `INSERT INTO batches (session_id, name, total, status, created_at, updated_at)
     VALUES (?, ?, 10, 'done', ?, ?)`,
    sessionId,
    name,
    nowIso(),
    nowIso(),
  ).lastInsertRowid;
  const sentAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const createdAt = new Date(Date.now() - 25 * 60_000).toISOString();
  for (let i = 0; i < 10; i += 1) {
    const chat = `5917000${String(i).padStart(4, '0')}@c.us`;
    const messageId = `MSG-${name}-${i}`;
    run(
      `INSERT INTO batch_items (batch_id, chat_id, contact_name, content_type, media_path, status, message_id, created_at, updated_at)
       VALUES (?, ?, ?, 'image', ?, 'sent', ?, ?, ?)`,
      batchId,
      chat,
      `Persona ${i}`,
      media(i),
      messageId,
      createdAt,
      sentAt,
    );
    run(
      `INSERT INTO messages (session_id, chat_id, contact_name, direction, content_type, wa_message_id, status, origin, occurred_at, created_at)
       VALUES (?, ?, ?, 'out', 'image', ?, 'sent', 'batch', ?, ?)`,
      sessionId,
      chat,
      `Persona ${i}`,
      messageId,
      sentAt,
      sentAt,
    );
  }
  return batchId;
}

describe('aviso de lote con posible límite temporal', () => {
  it('detecta un lote con el mismo archivo y muchos mensajes sin acuse', () => {
    const sessionId = 's-suspicious-1';
    seedSession(sessionId);
    const batchId = seedBatch(sessionId, 'Lote repetido', () => '/tmp/misma-imagen.jpg');
    const found = suspiciousBatch(sessionId);
    assert.ok(found);
    assert.equal(found?.batchId, batchId);
    assert.equal(found?.total, 10);
    assert.equal(found?.unacked, 10);
    assert.equal(found?.sameMedia, 10);
  });

  it('no avisa si los mensajes ya se entregaron', () => {
    const sessionId = 's-suspicious-2';
    seedSession(sessionId);
    seedBatch(sessionId, 'Lote entregado', () => '/tmp/entregado.jpg');
    run("UPDATE messages SET status = 'delivered' WHERE session_id = ?", sessionId);
    assert.equal(suspiciousBatch(sessionId), null);
  });

  it('no avisa si el lote no repite el mismo archivo', () => {
    const sessionId = 's-suspicious-3';
    seedSession(sessionId);
    seedBatch(sessionId, 'Lote variado', (i) => `/tmp/imagen-${i}.jpg`);
    assert.equal(suspiciousBatch(sessionId), null);
  });
});
