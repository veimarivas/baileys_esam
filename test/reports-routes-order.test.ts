import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Regresión: /reports/users/:id se registraba después de /reports/:tab/:period,
 * por lo que Express tomaba "users" como pestaña y la ficha devolvía 404.
 */
describe('orden de rutas de la ficha de usuario', () => {
  it('registra la ficha antes de la ruta genérica de reportes', () => {
    const source = readFileSync(new URL('../src/panel/server.ts', import.meta.url), 'utf8');

    const userRedirect = source.indexOf("'/reports/users/:id'");
    const userPeriod = source.indexOf("'/reports/users/:id/:period'");
    const genericPeriod = source.indexOf("'/reports/:tab/:period'");

    assert.ok(userRedirect > 0, 'falta la ruta /reports/users/:id');
    assert.ok(userPeriod > 0, 'falta la ruta /reports/users/:id/:period');
    assert.ok(genericPeriod > 0, 'falta la ruta genérica /reports/:tab/:period');
    assert.ok(
      userRedirect < genericPeriod && userPeriod < genericPeriod,
      'las rutas de ficha deben registrarse antes que /reports/:tab/:period',
    );
  });
});
