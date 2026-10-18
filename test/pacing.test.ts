import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pacing, type PacingOptions } from '../src/core/pacing.js';

/**
 * Motor anti-baneo: ventana horaria, jitter, pausas por fatiga y enfriamiento
 * entre programas. Es lo que evita que un lote salga en ráfaga, así que sus
 * reglas quedan fijadas acá. No toca la base.
 *
 * Fechas de referencia (hora local): 19/10/2026 = lunes, 24/10 = sábado,
 * 25/10 = domingo.
 */

function opts(over: Partial<PacingOptions> = {}): PacingOptions {
  return {
    enabled: true,
    delayMin: 2,
    delayMax: 2,
    windowDays: [1, 2, 3, 4, 5],
    windowStart: '08:00',
    windowEnd: '18:00',
    programCooldownMinutes: 10,
    pausesEnabled: false,
    pauseEvery: 3,
    pauseMin: 9,
    pauseMax: 9,
    ...over,
  };
}

const lunes = (h: number, m = 0) => new Date(2026, 9, 19, h, m);
const sabado = (h: number, m = 0) => new Date(2026, 9, 24, h, m);
const domingo = (h: number, m = 0) => new Date(2026, 9, 25, h, m);

describe('Pacing.isWithinWindow', () => {
  it('con el motor apagado siempre está en ventana', () => {
    const p = new Pacing('w-off', opts({ enabled: false }));
    assert.equal(p.isWithinWindow(domingo(3)), true);
    assert.equal(p.enabled(), false);
  });

  it('respeta el horario del día laboral', () => {
    const p = new Pacing('w-days', opts());
    assert.equal(p.isWithinWindow(lunes(10)), true);
    assert.equal(p.isWithinWindow(lunes(7, 59)), false);
    assert.equal(p.isWithinWindow(lunes(8)), true);
    // El final es exclusivo: a las 18:00 ya no se envía.
    assert.equal(p.isWithinWindow(lunes(18)), false);
    assert.equal(p.isWithinWindow(lunes(19)), false);
  });

  it('deja fuera los días no habilitados', () => {
    const p = new Pacing('w-week', opts());
    assert.equal(p.isWithinWindow(sabado(10)), false);
    assert.equal(p.isWithinWindow(domingo(10)), false);
  });

  it('entiende una ventana que cruza la medianoche', () => {
    const p = new Pacing('w-night', opts({ windowStart: '22:00', windowEnd: '02:00', windowDays: [1] }));
    assert.equal(p.isWithinWindow(lunes(23)), true);
    assert.equal(p.isWithinWindow(lunes(1)), true);
    assert.equal(p.isWithinWindow(lunes(3)), false);
    assert.equal(p.isWithinWindow(lunes(12)), false);
  });

  it('si inicio y fin coinciden, la ventana es todo el día', () => {
    const p = new Pacing('w-all', opts({ windowStart: '08:00', windowEnd: '08:00' }));
    assert.equal(p.isWithinWindow(lunes(3)), true);
    assert.equal(p.isWithinWindow(lunes(23)), true);
  });
});

describe('Pacing.nextWindowStartMs / secondsUntilNextWindow', () => {
  it('devuelve la próxima apertura del mismo día', () => {
    const p = new Pacing('n-1', opts());
    const from = lunes(3).getTime();
    const next = new Date(p.nextWindowStartMs(from));
    assert.equal(next.getHours(), 8);
    assert.equal(next.getMinutes(), 0);
    assert.ok(p.nextWindowStartMs(from) > from);
    assert.equal(p.secondsUntilNextWindow(from), 5 * 3600);
  });

  it('salta al próximo día habilitado', () => {
    const p = new Pacing('n-2', opts());
    const next = new Date(p.nextWindowStartMs(sabado(9).getTime()));
    // Sábado y domingo quedan fuera: la próxima apertura es el lunes.
    assert.equal(next.getDay(), 1);
    assert.equal(next.getHours(), 8);
  });

  it('nunca devuelve menos de un segundo', () => {
    const p = new Pacing('n-3', opts());
    assert.ok(p.secondsUntilNextWindow(Date.now()) >= 1);
  });
});

describe('Pacing.delayBeforeMs', () => {
  it('el primer envío de un lote sin programa no espera', () => {
    const p = new Pacing('d-first', opts());
    assert.equal(p.delayBeforeMs(0), 0);
  });

  it('con el motor apagado solo deja un segundo de separación', () => {
    const p = new Pacing('d-off', opts({ enabled: false }));
    assert.equal(p.delayBeforeMs(5), 1000);
  });

  it('espera el enfriamiento al cambiar de programa', () => {
    const p = new Pacing('d-cool', opts({ programCooldownMinutes: 10 }));
    assert.equal(p.delayBeforeMs(0, 'MAT'), 0);
    assert.equal(p.delayBeforeMs(0, 'INF'), 10 * 60 * 1000);
  });

  it('aplica pausa por fatiga cada N envíos', () => {
    const p = new Pacing('d-fatigue', opts({ pausesEnabled: true, pauseEvery: 3, pauseMin: 9, pauseMax: 9, delayMin: 2, delayMax: 2 }));
    assert.equal(p.delayBeforeMs(2), 2000);
    assert.equal(p.delayBeforeMs(3), 9000);
    assert.equal(p.delayBeforeMs(6), 9000);
  });

  it('sin pausas activadas solo aplica el jitter', () => {
    const p = new Pacing('d-nopause', opts({ pausesEnabled: false, delayMin: 2, delayMax: 2 }));
    assert.equal(p.delayBeforeMs(3), 2000);
  });

  it('el jitter cae dentro del rango configurado', () => {
    const p = new Pacing('d-jitter', opts({ delayMin: 1, delayMax: 5 }));
    const vistos = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const ms = p.delayBeforeMs(7);
      assert.ok(ms >= 1000 && ms <= 5000, `fuera de rango: ${ms}`);
      seenPush(vistos, ms);
    }
    // Con 300 tiradas aleatorias no puede salir siempre el mismo valor.
    assert.ok(vistos.size > 1, 'el jitter no varía');
  });
});

function seenPush(set: Set<number>, value: number): void {
  set.add(value);
}
