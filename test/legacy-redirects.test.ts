import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { legacyRedirects } from '../src/panel/legacy-redirects.js';

function run(path: string, query: Record<string, string> = {}): { location?: string; next: boolean } {
  const req = {
    method: 'GET',
    path,
    query,
    originalUrl: path + (Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : ''),
  } as unknown as Request;
  const result: { location?: string; next: boolean } = { next: false };
  const res = {
    redirect(_code: number, location: string) {
      result.location = location;
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    result.next = true;
  };
  legacyRedirects(req, res, next);
  return result;
}

describe('redirecciones de URLs viejas', () => {
  it('Anti-Baneo pasa de query a path', () => {
    assert.equal(run('/anti-ban').location, '/anti-ban/monitoreo');
    assert.equal(run('/anti-ban', { tab: 'monitoreo', estado: 'sin-vincular', area: 'marketing' }).location, '/anti-ban/monitoreo/sin-vincular/marketing');
    assert.equal(run('/anti-ban', { tab: 'lista-negra', source: 'reply', q: '591' }).location, '/anti-ban/lista-negra/reply?q=591');
    assert.equal(run('/anti-ban', { tab: 'politicas' }).location, '/anti-ban/politicas');
  });

  it('Seguimiento y Reportes pasan a rutas canónicas y conservan filtros', () => {
    assert.equal(run('/monitoring').location, '/monitoring/pendientes/hoy');
    assert.equal(run('/monitoring', { tab: 'actividad', period: '7d' }).location, '/monitoring/actividad/7d');
    assert.equal(run('/reports').location, '/reports/atencion/30d');
    assert.equal(run('/reports', { tab: 'equipo', period: '30d', area: 'marketing' }).location, '/reports/equipo/30d?area=marketing');
    assert.equal(run('/reports/users/12', { tab: 'equipo', period: '7d' }).location, '/reports/users/12/7d');
  });

  it('Auditoría, plantillas y notas pasan sus selecciones al path', () => {
    assert.equal(run('/audit', { cat: 'lotes', q: '12' }).location, '/audit/lotes?q=12');
    assert.equal(run('/templates', { edit: '8', cat: 'cobranza' }).location, '/templates/8?cat=cobranza');
    assert.equal(run('/notes', { nota: '55' }).location, '/notes/55');
    assert.equal(run('/notes', { status: 'overdue' }).location, '/notes/estado/vencidas');
    assert.equal(run('/notifications/history', { cat: 'notas', estado: 'sin-leer', p: '2' }).location, '/notifications/history/notas/sin-leer/2');
  });

  it('ignora los mensajes viejos de la URL', () => {
    const r = run('/reports', { period: '7d', ok: 'mensaje falso', error: 'otro' });
    assert.equal(r.location, '/reports/atencion/7d');
  });

  it('no redirige páginas que ya son canónicas', () => {
    for (const path of ['/monitoring/pendientes/hoy', '/reports/equipo/7d', '/notes/55', '/templates/8', '/notifications/history/notas/sin-leer/2']) {
      assert.equal(run(path).next, true, path);
    }
  });

  it('no toca POST ni APIs', () => {
    const req = { method: 'POST', path: '/reports', query: {}, originalUrl: '/reports' } as unknown as Request;
    let called = false;
    legacyRedirects(req, {} as Response, () => {
      called = true;
    });
    assert.equal(called, true);
  });
});
