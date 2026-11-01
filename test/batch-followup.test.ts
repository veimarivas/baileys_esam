import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { followUpTargets } from '../src/core/batch-engagement.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/** Volver a escribir: quiénes no leyeron, no respondieron o no recibieron. */
const t0 = Date.now() - 5 * 3600_000;
const at = (m: number) => new Date(t0 + m * 60_000).toISOString();
run("INSERT INTO sessions (id, name, status, created_at, updated_at) VALUES ('fu-line', 'fu', 'ready', ?, ?)", nowIso(), nowIso());
const b = Number(run("INSERT INTO batches (session_id, name, total, sent, status, meta, created_at, updated_at) VALUES ('fu-line', 'L', 5, 4, 'done', '{}', ?, ?)", at(0), at(0)).lastInsertRowid);
function item(phone: string, status: string, ack: string | null) {
  const wa = ack ? `FU-${phone}` : null;
  run('INSERT INTO batch_items (batch_id, chat_id, body, status, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', b, `${phone}@c.us`, 'Hola', status, wa, at(1), at(1));
  if (wa) run("INSERT INTO messages (session_id, chat_id, direction, content_type, body, wa_message_id, status, origin, occurred_at, created_at) VALUES ('fu-line', ?, 'out', 'text', 'Hola', ?, ?, 'batch', ?, ?)", `${phone}@c.us`, wa, ack, at(1), at(1));
}
item('5917000001', 'sent', 'read'); // leyó, no respondió
item('5917000002', 'sent', 'delivered'); // no leyó
item('5917000003', 'sent', 'read'); // respondió
item('5917000004', 'sent', 'sent'); // no leyó (solo enviado)
item('5917000005', 'failed', null);
run("INSERT INTO messages (session_id, chat_id, direction, content_type, body, status, occurred_at, created_at) VALUES ('fu-line', '5917000003@c.us', 'in', 'text', 'Gracias', 'received', ?, ?)", at(20), at(20));

const phones = (mode: 'unread' | 'unreplied' | 'failed') => followUpTargets(b, mode).map((t) => t.chat_id.slice(0, 10)).sort();

describe('volver a escribir a quienes no leyeron', () => {
  it('no leyeron: acuse de enviado o entregado y sin respuesta', () => {
    assert.deepEqual(phones('unread'), ['5917000002', '5917000004']);
  });
  it('no respondieron: todos los enviados sin respuesta', () => {
    assert.deepEqual(phones('unreplied'), ['5917000001', '5917000002', '5917000004']);
  });
  it('fallidos', () => {
    assert.deepEqual(phones('failed'), ['5917000005']);
  });
});
