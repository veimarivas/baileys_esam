import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyLineFix, lineIssues, notifyNewLineIssues } from '../src/core/line-health.js';
import { upsertUser } from '../src/auth/users.js';
import { get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Consistencia cuentas ↔ líneas. Reproduce el desorden del incidente del
 * 28/10/2026: una cuenta con dos líneas (una de Contabilidad), un número
 * esperado desactualizado y la línea de un número a nombre de otra cuenta.
 */
const line = (id: string, owner: string | null, expected: string | null, phone: string | null) =>
  run(
    `INSERT INTO sessions (id, name, owner_uid, owner_name, expected_phone, phone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
    id, id, owner, owner ? `Dueño ${owner}` : null, expected, phone, nowIso(), nowIso(),
  );
const user = (uid: string, name: string, numero: string | null, roles: string[] = []) =>
  upsertUser({ sourceUid: uid, name, username: uid, email: `${uid}@t.local`, source: 'cronogramas', autorizado: true, numero, roles });

line('lh-principal', 'lh-sa', '59170000001', '59170000001');
user('lh-sa', 'Super Admin', '59170000001', ['Super Admin']); // recibe los avisos
// La cuenta de Ana tiene su línea y además la de Contabilidad.
user('lh-ana', 'Ana', '59171111111');
line('lh-ana-propia', 'lh-ana', '59171111111', '59171111111');
line('lh-contable', 'lh-ana', '59172222222', '59172222222');
// Beto: su línea espera un número viejo y no tiene nada vinculado.
user('lh-beto', 'Beto', '59173333333');
line('lh-beto', 'lh-beto', '59179999999', null);
// Carla: la línea con su número figura a nombre de nadie.
user('lh-carla', 'Carla', '59174444444');
line('lh-sin-dueno', null, '59174444444', null);
// Línea vinculada a otro teléfono del que espera.
line('lh-rota', 'lh-dora', '59175555555', '59176666666');

describe('consistencia de líneas', () => {
  it('detecta cada tipo de problema', () => {
    const kinds = lineIssues().map((i) => i.kind);
    assert.ok(kinds.includes('duplicate_owner'));
    assert.ok(kinds.includes('owner_number_mismatch'));
    assert.ok(kinds.includes('number_other_owner'));
    assert.ok(kinds.includes('linked_mismatch'));
    assert.equal(lineIssues()[0].severity, 'alta'); // los graves primero
  });

  it('cuenta con dos líneas: propone soltar la que no es de su número', () => {
    const dup = lineIssues().find((i) => i.kind === 'duplicate_owner')!;
    assert.equal(dup.fixes.length, 1);
    assert.equal(dup.fixes[0].sessionId, 'lh-contable');
    applyLineFix('release_owner', 'lh-contable', 1);
    assert.equal(get<{ owner_uid: string | null }>("SELECT owner_uid FROM sessions WHERE id = 'lh-contable'")!.owner_uid, null);
    assert.ok(!lineIssues().some((i) => i.kind === 'duplicate_owner'));
  });

  it('número esperado desactualizado: lo alinea con cronogramas', () => {
    const m = lineIssues().find((i) => i.kind === 'owner_number_mismatch')!;
    applyLineFix(m.fixes[0].action, m.fixes[0].sessionId, 1);
    assert.equal(get<{ expected_phone: string }>("SELECT expected_phone FROM sessions WHERE id = 'lh-beto'")!.expected_phone, '59173333333');
  });

  it('línea con el número de un usuario a nombre de otro: se la asigna', () => {
    const o = lineIssues().find((i) => i.kind === 'number_other_owner')!;
    applyLineFix('assign_owner', o.fixes[0].sessionId, 1, o.fixes[0].uid);
    assert.equal(get<{ owner_uid: string }>("SELECT owner_uid FROM sessions WHERE id = 'lh-sin-dueno'")!.owner_uid, 'lh-carla');
  });

  it('una línea con otro teléfono vinculado no se repara sola (requiere reescanear)', () => {
    const r = lineIssues().find((i) => i.kind === 'linked_mismatch')!;
    assert.equal(r.fixes.length, 0);
    assert.match(r.hint ?? '', /QR/);
  });

  it('no aplica una reparación vencida', () => {
    assert.throws(() => applyLineFix('release_owner', 'lh-contable', 1), /ya no está/);
  });

  it('avisa una sola vez por problema', () => {
    const primera = notifyNewLineIssues();
    assert.ok(primera >= 1);
    assert.equal(notifyNewLineIssues(), 0);
    assert.ok((get<{ c: number }>("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'line_issue'")?.c ?? 0) >= 1);
  });
});
