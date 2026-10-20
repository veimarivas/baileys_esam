import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reportsScopeFor, sessionScopeFor, upsertUser } from '../src/auth/users.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Reportes es una vista de gestión: el Super Admin debe ver todas las líneas.
 * El inbox/historial personal sigue limitado al número de la cuenta.
 */
describe('alcance de Reportes', () => {
  it('el Super Admin ve todas las líneas en Reportes, pero no en su historial', () => {
    const user = upsertUser({
      sourceUid: 'scope-super',
      name: 'Super Admin de prueba',
      username: 'scope-super',
      email: 'scope-super@test.local',
      source: 'cronogramas',
      autorizado: true,
      roles: ['Super Admin'],
    });
    run(
      `INSERT INTO sessions (id, name, owner_uid, status, created_at, updated_at)
       VALUES ('s-scope-super', 'Línea propia', 'scope-super', 'ready', ?, ?)`,
      nowIso(),
      nowIso(),
    );
    run(
      `INSERT INTO sessions (id, name, owner_uid, status, created_at, updated_at)
       VALUES ('s-scope-otra', 'Línea de otra persona', 'scope-otra', 'ready', ?, ?)`,
      nowIso(),
      nowIso(),
    );

    assert.equal(reportsScopeFor(user), null);
    assert.deepEqual(sessionScopeFor(user), ['s-scope-super']);
  });

  it('un administrador que no es Super Admin conserva su alcance personal', () => {
    const user = upsertUser({
      sourceUid: 'scope-admin',
      name: 'Administrador de prueba',
      username: 'scope-admin',
      email: 'scope-admin@test.local',
      source: 'cronogramas',
      autorizado: true,
      roles: ['Administrador'],
    });
    run(
      `INSERT INTO sessions (id, name, owner_uid, status, created_at, updated_at)
       VALUES ('s-scope-admin', 'Línea del administrador', 'scope-admin', 'ready', ?, ?)`,
      nowIso(),
      nowIso(),
    );

    assert.deepEqual(reportsScopeFor(user), ['s-scope-admin']);
  });
});
