import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { linkedToOtherNumber, resolveUserLine } from '../src/core/line-resolver.js';
import type { SessionRow } from '../src/types.js';

/**
 * Los envíos salen desde el número del usuario que envía, aunque la relación
 * cuenta ↔ línea esté desordenada (caso real: el Super Admin envió cobranzas y
 * salieron desde la línea de Contabilidad).
 */
const line = (id: string, owner: string | null, expected: string | null, phone: string | null) =>
  ({ id, name: id, owner_uid: owner, expected_phone: expected, phone, status: 'ready' }) as unknown as SessionRow;

const contable = line('contable', '26', '59170000002', '59170000002'); // quedó asociada a la cuenta 26
const propia = line('propia', '26', '59171865104', '59171865104');
const otra = line('otra', '10', '59177117771', null);

describe('línea desde la que envía un usuario', () => {
  it('con su número: la línea vinculada a ese número, no la primera de la cuenta', () => {
    assert.equal(resolveUserLine([contable, propia, otra], '26', '59171865104')?.id, 'propia');
    assert.equal(resolveUserLine([contable, propia, otra], '26', '71865104')?.id, 'propia'); // sin 591
  });

  it('nunca cae a una línea de otro número', () => {
    assert.equal(resolveUserLine([contable, otra], '26', '59171865104'), undefined);
  });

  it('si su número solo está esperado (aún sin vincular), usa esa línea', () => {
    assert.equal(resolveUserLine([contable, propia, otra], '1', '59177117771')?.id, 'otra');
  });

  it('sin número (clientes anteriores): la propia que tiene vinculado su número esperado', () => {
    const rota = line('rota', '26', '59171865104', '59170000002');
    assert.equal(resolveUserLine([rota, propia], '26', null)?.id, 'propia');
    assert.equal(resolveUserLine([otra], '10', null)?.id, 'otra');
  });

  it('detecta una línea con otro número vinculado', () => {
    assert.equal(linkedToOtherNumber(contable, '59171865104'), '59170000002');
    assert.equal(linkedToOtherNumber(propia, '59171865104'), null);
    assert.equal(linkedToOtherNumber(otra, '59177117771'), null); // sin vincular todavía
  });
});
