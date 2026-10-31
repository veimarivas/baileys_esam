import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { quarantineAndRotate, rotateBatches } from '../src/core/session-pool.js';
import { lineVerdict, sendBlockedReason } from '../src/core/line-verdict.js';
import { setQuarantine } from '../src/core/health.js';
import { upsertUser } from '../src/auth/users.js';
import { get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';
import type { SessionRow } from '../src/types.js';

/**
 * Anti-baneo inteligente: la cuarentena nunca hace salir los mensajes desde
 * otro número, pausa y avisa; y el semáforo dice si una línea está sana.
 */
const line = (id: string, owner: string | null, status = 'ready') =>
  run(
    `INSERT INTO sessions (id, name, owner_uid, owner_name, expected_phone, phone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, id, owner, owner, `5917${id.length}000000`, null, status, nowIso(), nowIso(),
  );
const batch = (session: string, meta: Record<string, unknown>, status = 'running') =>
  Number(run(
    `INSERT INTO batches (session_id, name, total, sent, failed, skipped, status, meta, created_at, updated_at) VALUES (?, 'Lote', 5, 0, 0, 0, ?, ?, ?, ?)`,
    session, status, JSON.stringify(meta), nowIso(), nowIso(),
  ).lastInsertRowid);
const session = (id: string) => get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id)!;
const batchRow = (id: number) => get<{ session_id: string; status: string; meta: string }>('SELECT session_id, status, meta FROM batches WHERE id = ?', id)!;

upsertUser({ sourceUid: 'ab-sa', name: 'Super Admin', username: 'ab-sa', email: 'ab-sa@t.local', source: 'cronogramas', autorizado: true, roles: ['Super Admin'] });
upsertUser({ sourceUid: 'ab-ana', name: 'Ana', username: 'ab-ana', email: 'ab-ana@t.local', source: 'cronogramas', autorizado: true, roles: [] });
line('ab-ana', 'ab-ana');        // línea personal
line('ab-sistema', null);        // línea del sistema (sin dueño)
line('ab-sana', null);           // reemplazo sano del pool

describe('cuarentena sin enviar desde otro número', () => {
  it('una línea personal nunca rota sus lotes', () => {
    const b = batch('ab-ana', { account: 'ab-ana' });
    const rot = rotateBatches('ab-ana', () => {});
    assert.equal(rot.moved, 0);
    assert.equal(batchRow(b).session_id, 'ab-ana');
  });

  it('en una línea del sistema solo rotan los lotes que no son de una cuenta', () => {
    const propio = batch('ab-sistema', { solicitado_por_id: 26 });
    const libre = batch('ab-sistema', { source: 'csv' });
    const rot = rotateBatches('ab-sistema', () => {});
    assert.equal(rot.moved, 1);
    assert.equal(batchRow(libre).session_id, 'ab-sana');
    assert.equal(batchRow(propio).session_id, 'ab-sistema');
  });

  it('la cuarentena pausa el lote en curso de la línea personal y avisa', () => {
    const b = batch('ab-ana', { account: 'ab-ana' });
    quarantineAndRotate('ab-ana', () => {}, '3 fallos consecutivos de envío');
    const row = batchRow(b);
    assert.equal(row.status, 'paused');
    assert.equal(row.session_id, 'ab-ana');
    assert.match(JSON.parse(row.meta).anti_ban_pause, /no enviar desde otro número/);
    const avisos = get<{ c: number }>(`SELECT COUNT(*) AS c FROM notifications WHERE kind = 'batch_paused' AND link = ?`, `/batches/${b}`)!.c;
    assert.ok(avisos >= 1);
  });
});

describe('semáforo del número', () => {
  it('línea en cuarentena: rojo y no se crean envíos', () => {
    const v = lineVerdict(session('ab-ana'));
    assert.equal(v.level, 'red');
    assert.equal(v.canSend, false);
    assert.match(sendBlockedReason(session('ab-ana')) ?? '', /cuarentena/);
  });

  it('línea sana: verde (o amarillo solo por calentamiento) y se puede enviar', () => {
    setQuarantine('ab-sana', false, 'ok');
    const v = lineVerdict(session('ab-sana'));
    assert.notEqual(v.level, 'red');
    assert.equal(v.canSend, true);
    assert.equal(sendBlockedReason(session('ab-sana')), null);
  });

  it('línea desconectada: rojo con la acción de vincular', () => {
    line('ab-caida', 'ab-caida', 'disconnected');
    const v = lineVerdict(session('ab-caida'));
    assert.equal(v.level, 'red');
    assert.match(v.action ?? '', /QR/);
    // La desconexión la explica la API aparte (notReadyMessage).
    assert.equal(sendBlockedReason(session('ab-caida')), null);
  });
});

describe('semáforo: mensajes desde el teléfono / WhatsApp Web', () => {
  it('no cuentan para la entrega ni para el cupo, y el semáforo explica cada punto', () => {
    line('ab-web', 'ab-web');
    const old = new Date(Date.now() - 3600_000).toISOString();
    // 12 mensajes escritos desde WhatsApp Web: quedan «sent» (sin acuse en el gateway).
    for (let i = 0; i < 12; i++) {
      run(
        `INSERT INTO messages (session_id, chat_id, direction, content_type, body, status, origin, occurred_at, created_at)
         VALUES ('ab-web', ?, 'out', 'text', 'hola', 'sent', 'phone', ?, ?)`,
        `5917700000${i}@c.us`, old, old,
      );
    }
    // 6 del sistema, todos entregados.
    for (let i = 0; i < 6; i++) {
      run(
        `INSERT INTO messages (session_id, chat_id, direction, content_type, body, status, origin, occurred_at, created_at)
         VALUES ('ab-web', ?, 'out', 'text', 'hola', 'delivered', 'panel', ?, ?)`,
        `5917800000${i}@c.us`, old, old,
      );
    }
    const v = lineVerdict(session('ab-web'));
    assert.notEqual(v.level, 'red');
    assert.equal(v.canSend, true);
    assert.equal(v.stats.phone24h, 12);
    assert.equal(v.stats.deliveryRate, 1);
    const delivery = v.checks.find((c) => c.key === 'delivery')!;
    assert.equal(delivery.status, 'ok');
    assert.match(delivery.why, /WhatsApp Web/);
    assert.ok(v.checks.every((c) => c.label && c.value && c.rule && c.why));
  });
});
