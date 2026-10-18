import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { config } from '../src/config.js';
import { systemHealth } from '../src/core/system-health.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Estado del proceso (`/health` y `/healthz`). Es una ruta pública: además de que
 * los contadores estén bien, se verifica que **no** filtre rutas de archivos.
 */

describe('systemHealth', () => {
  it('cuenta las líneas por estado', () => {
    const h = systemHealth([
      { status: 'ready' },
      { status: 'ready' },
      { status: 'disconnected' },
      { status: 'connecting' },
      { status: 'blocked' },
    ]);
    assert.equal(h.ok, true);
    assert.equal(h.engine, 'baileys');
    assert.equal(h.app, 'baileys_esam');
    assert.equal(h.sessions.total, 5);
    assert.equal(h.sessions.ready, 2);
    assert.equal(h.sessions.disconnected, 1);
    assert.equal(h.sessions.connecting, 1);
    assert.equal(h.sessions.other, 1);
    assert.ok(h.uptimeSeconds >= 0);
    assert.ok(h.memoryMb > 0);
    assert.ok(typeof h.db.mb === 'number');
    assert.ok(typeof h.runtime.pid === 'number');
    assert.ok(Array.isArray(h.warnings));
  });

  it('avisa cuando ninguna línea está conectada', () => {
    const h = systemHealth([{ status: 'disconnected' }, { status: 'connecting' }]);
    assert.ok(h.warnings.some((w) => /Ninguna línea/.test(w)));
  });

  it('avisa cuando no hay líneas configuradas', () => {
    const h = systemHealth([]);
    assert.ok(h.warnings.some((w) => /No hay líneas/.test(w)));
  });

  it('no avisa por líneas caídas si al menos una está conectada', () => {
    const h = systemHealth([{ status: 'ready' }, { status: 'disconnected' }]);
    assert.ok(!h.warnings.some((w) => /Ninguna línea/.test(w)));
  });

  it('avisa cuando el log supera el límite', () => {
    const file = path.join(config.logsDir, 'service.out.log');
    fs.writeFileSync(file, Buffer.alloc((config.logMaxMb + 0.2) * 1024 * 1024, 120));
    const h = systemHealth([{ status: 'ready' }]);
    assert.equal(h.logs.overLimit, true);
    assert.equal(h.logs.maxMb, config.logMaxMb);
    assert.ok(h.warnings.some((w) => /se rota al reiniciar/.test(w)));
  });

  it('informa los webhooks descartados', () => {
    const now = nowIso();
    run(
      `INSERT INTO webhook_queue (session_id, url, event, body, attempts, next_try_at, created_at, updated_at)
       VALUES ('s-1', 'http://ejemplo.test/hook', 'message.in', '{}', 8, '9999-12-31T00:00:00.000Z', ?, ?)`,
      now,
      now,
    );
    const h = systemHealth([{ status: 'ready' }]);
    assert.equal(h.webhooks.dead, 1);
    assert.equal(h.webhooks.pending, 0);
    assert.ok(h.warnings.some((w) => /descartado/.test(w)));
  });

  it('no expone rutas de archivos ni el nombre de la base', () => {
    const json = JSON.stringify(systemHealth([{ status: 'ready' }]));
    assert.ok(!json.includes('\\'), 'no debe incluir rutas de Windows');
    assert.ok(!json.includes('.sqlite'), 'no debe incluir el archivo de la base');
    assert.ok(!/storage|backups|\/data\//.test(json), 'no debe incluir carpetas del disco');
  });
});
