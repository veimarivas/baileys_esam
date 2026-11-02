import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  antiBanUrl,
  auditUrl,
  isOneOf,
  monitoringUrl,
  notesUrl,
  notificationsHistoryUrl,
  periodToSlug,
  positiveInt,
  reportsUrl,
  reportsUserUrl,
  slugToNoteStatus,
  slugToPeriod,
  templatesUrl,
  validSessionId,
  withQuery,
} from '../src/panel/urls.js';

describe('constructores de URLs limpias', () => {
  it('arma las rutas de Anti-Baneo con estado y área', () => {
    assert.equal(antiBanUrl(), '/anti-ban/monitoreo');
    assert.equal(antiBanUrl({ estado: 'todas' }), '/anti-ban/monitoreo');
    assert.equal(antiBanUrl({ estado: 'vinculadas' }), '/anti-ban/monitoreo/vinculadas');
    assert.equal(antiBanUrl({ estado: 'sin-vincular', area: 'marketing' }), '/anti-ban/monitoreo/sin-vincular/marketing');
    assert.equal(antiBanUrl({ area: 'academico' }), '/anti-ban/monitoreo/todas/academico');
    assert.equal(antiBanUrl({ area: 'sin-area' }), '/anti-ban/monitoreo/todas/sin-area');
    assert.equal(antiBanUrl({ tab: 'politicas' }), '/anti-ban/politicas');
    assert.equal(antiBanUrl({ tab: 'lista-negra', source: 'reply', q: '591 7' }), '/anti-ban/lista-negra/reply?q=591+7');
    assert.equal(antiBanUrl({ tab: 'lista-negra', source: 'otro' }), '/anti-ban/lista-negra');
  });

  it('arma Seguimiento y Reportes con período, sesión y filtros', () => {
    assert.equal(monitoringUrl(), '/monitoring/pendientes/hoy');
    assert.equal(monitoringUrl({ tab: 'actividad', period: '7d', session: 'abc-123' }), '/monitoring/actividad/7d/abc-123');
    assert.equal(monitoringUrl({ period: 'rango', from: '2026-10-01', to: '2026-10-31' }), '/monitoring/pendientes/rango?from=2026-10-01&to=2026-10-31');
    assert.equal(reportsUrl(), '/reports/atencion/30d');
    assert.equal(
      reportsUrl({ tab: 'equipo', period: 'mes', area: 'marketing', programa: 'A', account: '', tipo: 'cobranza' }),
      '/reports/equipo/mes?programa=A&area=marketing&tipo=cobranza',
    );
    assert.equal(reportsUserUrl({ id: 12, period: '7d', area: 'academico' }), '/reports/users/12/7d?area=academico');
  });

  it('arma Auditoría, Plantillas, Notas e historial', () => {
    assert.equal(auditUrl(), '/audit');
    assert.equal(auditUrl({ cat: 'lotes', q: '12', auto: true }), '/audit/lotes?q=12&auto=true');
    assert.equal(templatesUrl(), '/templates');
    assert.equal(templatesUrl({ id: 8, cat: 'cobranza' }), '/templates/8?cat=cobranza');
    assert.equal(notesUrl(), '/notes');
    assert.equal(notesUrl({ id: 55 }), '/notes/55');
    assert.equal(notesUrl({ status: 'vencidas' }), '/notes/estado/vencidas');
    assert.equal(notesUrl({ status: 'todas' }), '/notes');
    assert.equal(notificationsHistoryUrl(), '/notifications/history');
    assert.equal(notificationsHistoryUrl({ category: 'notas' }), '/notifications/history/notas');
    assert.equal(notificationsHistoryUrl({ category: 'notas', state: 'sin-leer' }), '/notifications/history/notas/sin-leer');
    assert.equal(notificationsHistoryUrl({ state: 'sin-leer' }), '/notifications/history/todas/sin-leer');
    assert.equal(notificationsHistoryUrl({ category: 'notas', state: 'sin-leer', page: 2 }), '/notifications/history/notas/sin-leer/2');
    assert.equal(notificationsHistoryUrl({ page: 3 }), '/notifications/history/todas/todas/3');
  });

  it('codifica solo los parámetros con valor', () => {
    assert.equal(withQuery('/x', { a: 'hola mundo', b: '', c: false, d: null, n: 0 }), '/x?a=hola+mundo&n=0');
    assert.equal(withQuery('/x'), '/x');
  });

  it('valida IDs, sesiones y slugs', () => {
    assert.equal(positiveInt('12'), 12);
    assert.equal(positiveInt('-1'), null);
    assert.equal(positiveInt('1.5'), null);
    assert.equal(positiveInt('abc'), null);
    assert.equal(validSessionId('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
    assert.equal(validSessionId('../etc/passwd'), null);
    assert.equal(validSessionId('con espacios'), null);
    assert.equal(isOneOf('lotes', ['lotes', 'cuentas'] as const), true);
    assert.equal(isOneOf('otro', ['lotes', 'cuentas'] as const), false);
  });

  it('traduce períodos y estados de notas', () => {
    assert.equal(periodToSlug('today'), 'hoy');
    assert.equal(periodToSlug('custom'), 'rango');
    assert.equal(slugToPeriod('mes'), 'month');
    assert.equal(slugToNoteStatus('vencidas'), 'overdue');
  });
});
