import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { massActivity, massActivityCsv } from '../src/core/mass-activity.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Reportes › Envíos masivos: quién pide los lotes, cuántas veces por día y
 * cuántos mensajes lleva cada uno, solo en las líneas del alcance.
 */
function line(id: string, owner: string, phone: string) {
  run(
    `INSERT INTO sessions (id, name, owner_uid, owner_name, phone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)`,
    id, `Línea ${owner}`, `uid-${id}`, owner, phone, nowIso(), nowIso(),
  );
}
let seq = 0;
function batch(session: string, at: Date, total: number, meta: Record<string, unknown>, extra: { sent?: number; failed?: number; status?: string } = {}) {
  seq++;
  const iso = at.toISOString();
  run(
    `INSERT INTO batches (session_id, name, total, sent, failed, skipped, status, meta, started_at, finished_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    session, `Lote ${seq}`, total, extra.sent ?? total, extra.failed ?? 0, extra.status ?? 'done', JSON.stringify(meta),
    iso, new Date(at.getTime() + 120_000).toISOString(), iso, iso,
  );
}
const day = (offset: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(hour, 0, 0, 0);
  return d;
};
const period = (() => {
  const from = day(-6, 0);
  const to = day(1, 0);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
})();

line('ma-1', 'Ana', '59170000001');
line('ma-2', 'Beto', '59170000002');
const ana = { solicitado_por: 'Ana Asesora', solicitado_por_id: 501, area: 'marketing', programa: 'Diplomado X', tipo: 'prospectos', origen_sistema: 'cronogramas' };
const beto = { solicitado_por: 'Beto Contable', solicitado_por_id: 502, area: 'contabilidad', tipo: 'cuotas', origen_sistema: 'cronogramas' };
batch('ma-1', day(0, 9), 20, ana);
batch('ma-1', day(0, 11), 10, ana, { sent: 8, failed: 2 });
batch('ma-1', day(0, 15), 30, ana);
batch('ma-1', day(-2, 10), 5, ana, { status: 'cancelled', sent: 1 });
batch('ma-2', day(-1, 10), 40, beto);
batch('ma-2', day(0, 8), 12, { origen: 'recordatorio_automatico', area: 'contabilidad' });
batch('ma-2', day(-20, 10), 99, beto); // fuera del período

describe('actividad de envíos masivos', () => {
  const a = massActivity(null, period);

  it('cuenta lotes y mensajes del período (sin los de fuera)', () => {
    assert.equal(a.totals.batches, 6);
    assert.equal(a.totals.messages, 20 + 10 + 30 + 5 + 40 + 12);
    assert.equal(a.totals.failed, 2);
  });

  it('agrupa por persona con veces por día y mensajes por lote', () => {
    const r = a.requesters.find((x) => x.key === 'u:501')!;
    assert.equal(r.name, 'Ana Asesora');
    assert.equal(r.batches, 4);
    assert.equal(r.daysActive, 2);
    assert.equal(r.maxPerDay, 3); // tres lotes hoy
    assert.equal(r.avgPerDay, 2);
    assert.equal(r.messages, 65);
    assert.equal(r.avgPerBatch, 16);
    assert.equal(r.maxPerBatch, 30);
    assert.equal(r.cancelled, 1);
    assert.equal(r.area, 'marketing');
    assert.deepEqual(r.lines, ['59170000001 · Ana']);
    assert.equal(Object.values(r.byDay).reduce((s, d) => s + d.batches, 0), 4);
  });

  it('los recordatorios automáticos van aparte de las personas', () => {
    const auto = a.requesters.find((x) => x.key === 'auto')!;
    assert.equal(auto.name, 'Recordatorios automáticos');
    assert.equal(auto.batches, 1);
  });

  it('el registro trae hora, persona, línea y duración', () => {
    const b = a.batches.find((x) => x.total === 40)!;
    assert.equal(b.requesterName, 'Beto Contable');
    assert.equal(b.time, '10:00');
    assert.equal(b.linePhone, '59170000002');
    assert.equal(b.durationMs, 120_000);
    assert.equal(a.totals.busiestDay?.batches, 4); // hoy: 3 de Ana + 1 recordatorio
  });

  it('respeta el alcance de líneas', () => {
    const solo = massActivity(['ma-2'], period);
    assert.equal(solo.totals.batches, 2);
    assert.ok(solo.requesters.every((r) => r.key !== 'u:501'));
    assert.equal(massActivity([], period).totals.batches, 0);
  });

  it('exporta CSV con resumen y registro', () => {
    const csv = massActivityCsv(a, 'Últimos 7 días');
    assert.match(csv, /Ana Asesora/);
    assert.match(csv, /Mensajes por lote/);
    // Filas del registro: la columna «Nombre» lleva «Lote N».
    assert.equal(csv.split('\r\n').filter((l) => /,"Lote \d+",/.test(l)).length, 6);
  });
});
