import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeNext } from '../src/auth/sso.js';

describe('safeNext', () => {
  const fallback = '/conversations';

  it('acepta rutas internas con query y hash', () => {
    assert.equal(safeNext('/reports/equipo/7d?area=marketing', fallback), '/reports/equipo/7d?area=marketing');
    assert.equal(safeNext('/notes/12#nota', fallback), '/notes/12#nota');
  });

  it('rechaza destinos externos y variantes peligrosas', () => {
    for (const value of ['//evil.com', '/\\evil.com', 'https://evil.com', 'http://evil.com', 'javascript:alert(1)', '/ok\nLocation: https://evil.com', '\\\\evil.com', '']) {
      assert.equal(safeNext(value, fallback), fallback, value);
    }
  });

  it('rechaza valores que no son texto', () => {
    assert.equal(safeNext(null, fallback), fallback);
    assert.equal(safeNext(12, fallback), fallback);
    assert.equal(safeNext({ next: '/x' }, fallback), fallback);
  });
});
