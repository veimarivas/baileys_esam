import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSede } from '../src/core/sedes.js';
import {
  createLocalUser,
  ensureUserSession,
  setSessionInvalidator,
  updateManagedUser,
} from '../src/auth/users.js';
import { get, run } from '../src/db/index.js';

/**
 * El número de WhatsApp es la identidad del usuario: no se comparte entre
 * cuentas y, si la línea queda vinculada con otro número, se bloquea.
 */

let seq = 0;
const uniq = (): string => `${Date.now()}${seq++}`;

function sede(): number {
  return createSede(`Sede Numero ${uniq()}`);
}

function usuario(sedeId: number, numero: string) {
  const suffix = uniq();
  return createLocalUser({
    name: `Usuario ${suffix}`,
    username: `numero.${suffix}`,
    email: `numero.${suffix}@test.local`,
    password: 'secreto123',
    numero,
    sedeId,
    roles: ['Asesor de Marketing'],
  });
}

interface SessionRow {
  expected_phone: string | null;
  phone: string | null;
  status: string;
  blocked_reason: string | null;
}

function sessionRow(id: string): SessionRow {
  return get<SessionRow>('SELECT expected_phone, phone, status, blocked_reason FROM sessions WHERE id = ?', id)!;
}

describe('número de WhatsApp autorizado', () => {
  it('no permite registrar el mismo número en dos usuarios', () => {
    const s = sede();
    usuario(s, '59170000101');
    assert.throws(() => usuario(s, '59170000101'), /ya está registrado/);

    const otro = usuario(s, '59170000102');
    assert.throws(() => updateManagedUser(otro.id, { numero: '59170000101' }), /ya está registrado/);
  });

  it('al cambiar el número actualiza la línea y no la bloquea si no estaba vinculada', () => {
    const s = sede();
    const user = usuario(s, '59170000201');
    const sessionId = ensureUserSession(user)!;
    assert.equal(sessionRow(sessionId).expected_phone, '59170000201');

    const updated = updateManagedUser(user.id, { numero: '59170000202' });
    const row = sessionRow(sessionId);
    assert.equal(row.expected_phone, '59170000202');
    assert.equal(row.status, 'created');
    assert.equal(updated.esam_numero, '59170000202');
  });

  it('si la línea estaba vinculada con otro número, la bloquea y la desvincula', () => {
    const s = sede();
    const user = usuario(s, '59170000301');
    const sessionId = ensureUserSession(user)!;

    // Simula que el usuario escaneó OTRO número.
    run("UPDATE sessions SET status = 'ready', phone = '59170000399' WHERE id = ?", sessionId);

    const invalidados: string[] = [];
    setSessionInvalidator((id) => invalidados.push(id));
    try {
      updateManagedUser(user.id, { numero: '59170000302' });
    } finally {
      setSessionInvalidator(null);
    }

    const row = sessionRow(sessionId);
    assert.equal(row.expected_phone, '59170000302');
    assert.equal(row.phone, null);
    assert.equal(row.status, 'blocked');
    assert.match(row.blocked_reason ?? '', /no es el autorizado/);
    assert.deepEqual(invalidados, [sessionId]);
  });

  it('ensureUserSession corrige un expected_phone viejo en vez de conservarlo', () => {
    const s = sede();
    const user = usuario(s, '59170000401');
    const sessionId = ensureUserSession(user)!;

    // Escenario de datos heredados: el usuario cambió de número sin reconciliar.
    run("UPDATE sessions SET expected_phone = '59170000400' WHERE id = ?", sessionId);
    run("UPDATE users SET esam_numero = '59170000402' WHERE id = ?", user.id);

    const again = ensureUserSession({ ...user, esam_numero: '59170000402' })!;
    assert.equal(again, sessionId);
    assert.equal(sessionRow(sessionId).expected_phone, '59170000402');
  });

  it('al quitar el número bloquea la línea del usuario', () => {
    const s = sede();
    const user = usuario(s, '59170000501');
    const sessionId = ensureUserSession(user)!;

    updateManagedUser(user.id, { numero: null });
    const row = sessionRow(sessionId);
    assert.equal(row.expected_phone, null);
    assert.equal(row.status, 'blocked');
    assert.match(row.blocked_reason ?? '', /no tiene número/);
  });
});
