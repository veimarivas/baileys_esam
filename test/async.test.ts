import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nowEpoch, nowIso, randInt } from '../src/util/async.js';

/**
 * Utilidades base: el azar de `randInt` es el que da el "jitter" anti-baneo, así
 * que debe respetar siempre los límites.
 */

describe('randInt', () => {
  it('devuelve el mismo valor cuando el rango es de uno', () => {
    assert.equal(randInt(5, 5), 5);
    assert.equal(randInt(0, 0), 0);
  });

  it('nunca se sale del rango', () => {
    for (let i = 0; i < 500; i++) {
      const v = randInt(1, 3);
      assert.ok(v >= 1 && v <= 3, `fuera de rango: ${v}`);
    }
  });

  it('ordena los límites si vienen invertidos', () => {
    for (let i = 0; i < 200; i++) {
      const v = randInt(4, 2);
      assert.ok(v >= 2 && v <= 4, `fuera de rango: ${v}`);
    }
  });
});

describe('nowIso', () => {
  it('devuelve una fecha ISO en UTC', () => {
    const iso = nowIso();
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(!Number.isNaN(Date.parse(iso)));
  });
});

describe('nowEpoch', () => {
  it('devuelve los segundos de ahora', () => {
    const epoch = nowEpoch();
    assert.ok(Math.abs(epoch - Math.floor(Date.now() / 1000)) <= 1);
  });
});
