import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { panelRangeParams, resolvePanelRange } from '../src/panel/period-filter.js';

/** 11 de noviembre de 2026, hora local del servidor. */
const NOW = new Date(2026, 10, 11, 15, 30, 0);

describe('resolvePanelRange', () => {
  it('sin filtros abre el mes en curso', () => {
    const r = resolvePanelRange(undefined, undefined, undefined, NOW);
    assert.equal(r.period, 'month');
    assert.equal(r.from, '2026-11-01');
    assert.equal(r.to, '2026-11-30');
    assert.equal(r.label, 'Noviembre 2026');
    assert.ok(r.fromIso && r.toIso);
  });

  it('permite ver el mes anterior', () => {
    const r = resolvePanelRange('prev', undefined, undefined, NOW);
    assert.equal(r.from, '2026-10-01');
    assert.equal(r.to, '2026-10-31');
    assert.equal(r.label, 'Octubre 2026');
  });

  it('los últimos tres meses incluyen el mes en curso', () => {
    const r = resolvePanelRange('quarter', undefined, undefined, NOW);
    assert.equal(r.from, '2026-09-01');
    assert.equal(r.to, '2026-11-30');
    assert.match(r.label, /septiembre/i);
    assert.match(r.label, /noviembre/i);
  });

  it('el año completo va de enero a diciembre', () => {
    const r = resolvePanelRange('year', undefined, undefined, NOW);
    assert.equal(r.from, '2026-01-01');
    assert.equal(r.to, '2026-12-31');
    assert.equal(r.label, 'Año 2026');
  });

  it('todo el historial no lleva límites', () => {
    const r = resolvePanelRange('all', undefined, undefined, NOW);
    assert.equal(r.period, 'all');
    assert.equal(r.fromIso, null);
    assert.equal(r.toIso, null);
    assert.equal(r.label, 'Todo el historial');
  });

  it('el rango personalizado usa fechas inclusivas', () => {
    const r = resolvePanelRange('custom', '2026-11-03', '2026-11-05', NOW);
    assert.equal(r.period, 'custom');
    assert.equal(r.from, '2026-11-03');
    assert.equal(r.to, '2026-11-05');
    assert.equal(r.fromIso, new Date(2026, 10, 3, 0, 0, 0, 0).toISOString());
    assert.equal(r.toIso, new Date(2026, 10, 6, 0, 0, 0, 0).toISOString());
    assert.equal(r.label, 'Del 03/11/2026 al 05/11/2026');
  });

  it('si llegan fechas sin período se interpreta como rango', () => {
    const r = resolvePanelRange(undefined, '2026-10-01', undefined, NOW);
    assert.equal(r.period, 'custom');
    assert.equal(r.from, '2026-10-01');
  });

  it('ordena las fechas invertidas y conserva el período en la URL', () => {
    const r = resolvePanelRange('custom', '2026-11-08', '2026-11-02', NOW);
    assert.equal(r.from, '2026-11-02');
    assert.equal(r.to, '2026-11-08');
    assert.deepEqual(panelRangeParams(r), { period: 'custom', from: '2026-11-02', to: '2026-11-08' });
    assert.deepEqual(panelRangeParams(resolvePanelRange('month', undefined, undefined, NOW)), { period: 'month' });
  });
});
