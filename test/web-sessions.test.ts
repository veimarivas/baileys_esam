import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sessionStore } from '../src/auth/sessions.js';
import { get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * La cookie del panel se valida en cada pedido. Una cookie manipulada tiene que
 * rechazarse siempre: antes, una firma de otro largo hacía explotar
 * `timingSafeEqual` y el pedido terminaba en 500 en vez de "no autorizado".
 */

function createUser(): number {
  return run(
    `INSERT INTO users (name, username, email, password, source, esam_autorizado, created_at, updated_at)
     VALUES ('Prueba', ?, ?, 'x', 'local', 1, ?, ?)`,
    `prueba-${Math.random().toString(36).slice(2)}`,
    `prueba-${Math.random().toString(36).slice(2)}@test.local`,
    nowIso(),
    nowIso(),
  ).lastInsertRowid;
}

describe('sesiones del panel', () => {
  it('acepta la cookie recién creada', () => {
    const userId = createUser();
    const { cookie } = sessionStore.create(userId);
    assert.equal(sessionStore.userId(cookie), userId);
  });

  it('rechaza una firma truncada o alargada sin romper', () => {
    const userId = createUser();
    const { cookie } = sessionStore.create(userId);
    const id = cookie.split('.')[0];

    assert.equal(sessionStore.userId(`${id}.corta`), null);
    assert.equal(sessionStore.userId(`${id}.${'x'.repeat(200)}`), null);
    assert.equal(sessionStore.userId(`${id}.`), null);
    assert.equal(sessionStore.userId(id), null);
  });

  it('rechaza una firma con el largo correcto pero distinta', () => {
    const userId = createUser();
    const { cookie } = sessionStore.create(userId);
    const [id, signature] = cookie.split('.');
    const changed = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);

    assert.equal(sessionStore.userId(`${id}.${changed}`), null);
  });

  it('rechaza una sesión vencida aunque la firma sea válida', () => {
    const userId = createUser();
    const { cookie } = sessionStore.create(userId);
    const id = cookie.split('.')[0];

    run('UPDATE web_sessions SET expires_at = ? WHERE id = ?', new Date(Date.now() - 60_000).toISOString(), id);
    assert.equal(sessionStore.userId(cookie), null);
  });

  it('rechaza una sesión con más de 12 h desde su creación (aunque la cookie siga)', () => {
    const userId = createUser();
    const { cookie } = sessionStore.create(userId);
    const id = cookie.split('.')[0];
    const old = new Date(Date.now() - 13 * 3600_000).toISOString();

    run('UPDATE web_sessions SET created_at = ?, last_seen_at = ? WHERE id = ?', old, nowIso(), id);
    assert.equal(sessionStore.userId(cookie), null);
  });

  it('rechaza una sesión inactiva más de 8 h', () => {
    const userId = createUser();
    const { cookie } = sessionStore.create(userId);
    const id = cookie.split('.')[0];
    const idle = new Date(Date.now() - 9 * 3600_000).toISOString();

    run('UPDATE web_sessions SET last_seen_at = ? WHERE id = ?', idle, id);
    assert.equal(sessionStore.userId(cookie), null);
  });

  it('mantiene la sesión activa y actualiza la última actividad', () => {
    const userId = createUser();
    const { cookie } = sessionStore.create(userId);
    const id = cookie.split('.')[0];
    const recent = new Date(Date.now() - 2 * 3600_000).toISOString();

    run('UPDATE web_sessions SET last_seen_at = ? WHERE id = ?', recent, id);
    assert.equal(sessionStore.userId(cookie), userId);

    const row = get<{ last_seen_at: string }>('SELECT last_seen_at FROM web_sessions WHERE id = ?', id);
    assert.ok(row && Date.parse(row.last_seen_at) > Date.now() - 60_000);
  });

  it('deja de aceptar la cookie al cerrar sesión', () => {
    const userId = createUser();
    const { cookie } = sessionStore.create(userId);

    sessionStore.destroy(cookie);
    assert.equal(sessionStore.userId(cookie), null);
  });
});
