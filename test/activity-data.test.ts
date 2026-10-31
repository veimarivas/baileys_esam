import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activityData, monitoringData } from '../src/core/monitoring.js';
import { upsertUser } from '../src/auth/users.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Las estadísticas por usuario de Seguimiento y Reportes deben sumar en la
 * misma fila los envíos de cronogramas (por `source_uid`), los lotes del panel
 * y los mensajes escritos en la bandeja (por id local). Antes se partían en dos
 * identidades y los totales no coincidían con la ficha individual.
 */

function crearUsuario(sourceUid: string, username: string) {
  return upsertUser({
    sourceUid,
    name: `Persona ${sourceUid}`,
    username,
    email: `${username}@test.local`,
    source: 'cronogramas',
    autorizado: true,
    area: 'academico',
  });
}

function crearLote(opts: {
  sessionId: string;
  meta: Record<string, unknown>;
  total: number;
  items: number;
  at: string;
}): number {
  const batch = run(
    `INSERT INTO batches (session_id, name, total, status, meta, started_at, created_at, updated_at)
     VALUES (?, 'Lote de prueba', ?, 'done', ?, ?, ?, ?)`,
    opts.sessionId,
    opts.total,
    JSON.stringify(opts.meta),
    opts.at,
    opts.at,
    opts.at,
  );
  for (let i = 0; i < opts.items; i++) {
    run(
      `INSERT INTO batch_items (batch_id, chat_id, status, updated_at, created_at)
       VALUES (?, ?, 'sent', ?, ?)`,
      batch.lastInsertRowid,
      `5917000000${i}@c.us`,
      opts.at,
      opts.at,
    );
  }
  return batch.lastInsertRowid;
}

describe('actividad de envíos por usuario', () => {
  it('unifica cronogramas, lotes del panel y bandeja en una sola persona', () => {
    const user = crearUsuario('ad-1', 'ana-envios');
    const now = nowIso();
    run(
      `INSERT INTO sessions (id, name, owner_uid, expected_phone, area, status, created_at, updated_at)
       VALUES ('s-ad', 'Línea de Ana', 'ad-1', '59171110000', 'academico', 'ready', ?, ?)`,
      now,
      now,
    );
    const at = '2026-10-10T14:00:00.000Z';
    crearLote({
      sessionId: 's-ad',
      meta: { source: 'integration', account: 'ad-1', programa: 'Programa A', area: 'academico', tipo: 'participantes' },
      total: 2,
      items: 2,
      at,
    });
    crearLote({
      sessionId: 's-ad',
      meta: { source: 'panel', account: 'ad-1', programa: 'Programa A', area: 'academico', tipo: 'notas' },
      total: 1,
      items: 1,
      at,
    });
    run(
      `INSERT INTO messages (session_id, chat_id, direction, content_type, origin, sender_uid, occurred_at, created_at)
       VALUES ('s-ad', '59170000009@c.us', 'out', 'text', 'panel', ?, ?, ?)`,
      user.id,
      at,
      at,
    );
    // Mensaje viejo sin autor: cae al dueño de la línea.
    run(
      `INSERT INTO messages (session_id, chat_id, direction, content_type, origin, sender_uid, occurred_at, created_at)
       VALUES ('s-ad', '59170000008@c.us', 'out', 'text', 'panel', NULL, ?, ?)`,
      at,
      at,
    );

    const data = activityData({ from: '2026-10-01', to: '2026-10-31' }, null);
    assert.equal(data.rows.length, 1);
    const row = data.rows[0];
    assert.equal(row.uid, String(user.id));
    assert.equal(row.userId, user.id);
    assert.equal(row.name, 'ana-envios');
    assert.equal(row.cronogramas, 2);
    assert.equal(row.lotes, 1);
    assert.equal(row.bandeja, 2);
    assert.equal(row.total, 5);
    assert.equal(row.batches, 2);
    assert.equal(row.cronBatches, 1);
    assert.equal(row.panelBatches, 1);
    assert.equal(row.batchMessages, 3);
    assert.equal(row.avgPerBatch, 2);
    assert.equal(row.maxBatch, 2);
    assert.equal(row.recent.length, 2);
    assert.equal(row.byDay.reduce((acc, d) => acc + d.cronogramas + d.lotes + d.bandeja, 0), 5);
    assert.deepEqual(
      { total: data.totals.total, cronogramas: data.totals.cronogramas, lotes: data.totals.lotes, bandeja: data.totals.bandeja },
      { total: 5, cronogramas: 2, lotes: 1, bandeja: 2 },
    );

    const report = monitoringData({ from: '2026-10-01', to: '2026-10-31' });
    const stat = report.byUser.find((u) => u.id === String(user.id));
    assert.ok(stat);
    assert.equal(stat.total, 5);
    assert.equal(stat.batches, 2);
    assert.equal(stat.batchMessages, 3);
    assert.equal(stat.avgPerBatch, 2);
  });

  it('respeta el filtro por programa y el alcance de líneas', () => {
    crearUsuario('ad-2', 'bruno-envios');
    const now = nowIso();
    run(
      `INSERT INTO sessions (id, name, owner_uid, status, created_at, updated_at)
       VALUES ('s-ad2', 'Línea de Bruno', 'ad-2', 'ready', ?, ?)`,
      now,
      now,
    );
    crearLote({
      sessionId: 's-ad2',
      meta: { source: 'integration', account: 'ad-2', programa: 'Programa B', area: 'academico', tipo: 'participantes' },
      total: 3,
      items: 3,
      at: '2026-10-12T14:00:00.000Z',
    });

    const filtrado = activityData({ from: '2026-10-01', to: '2026-10-31', programa: 'Programa B' }, null);
    assert.equal(filtrado.rows[0]?.cronogramas, 3);
    const otro = activityData({ from: '2026-10-01', to: '2026-10-31', programa: 'Programa C' }, null);
    assert.equal(otro.rows.length, 0);
    const sinAlcance = activityData({ from: '2026-10-01', to: '2026-10-31' }, []);
    assert.equal(sinAlcance.rows.length, 0);
    const fuera = activityData({ from: '2026-10-01', to: '2026-10-31' }, ['s-otra']);
    assert.equal(fuera.rows.length, 0);

    const reporteSinAlcance = monitoringData({ from: '2026-10-01', to: '2026-10-31' }, 14, []);
    assert.equal(reporteSinAlcance.totals.cronogramas, 0);
    assert.equal(reporteSinAlcance.byUser.length, 0);
    const reporteDeOtraLinea = monitoringData({ from: '2026-10-01', to: '2026-10-31' }, 14, ['s-otra']);
    assert.equal(reporteDeOtraLinea.totals.cronogramas, 0);
  });
});
