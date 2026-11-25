import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createSede } from '../src/core/sedes.js';
import { createLocalUser, findById, updateManagedUser, upsertUser, type UserRow } from '../src/auth/users.js';
import {
  alcanceLeads,
  asignarJefe,
  jefesValidos,
  organigramaDeSede,
  puedeEditarOrganigrama,
  puedeVerLeadsDe,
} from '../src/core/organigrama.js';
import { all, get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * PLAN_ORGANIGRAMA.md, L0: jefe directo por persona y regla de visibilidad
 * de leads de marketing.
 *
 *   Sede Norte                         Sede Sur
 *   Gerente General (gg)               Supervisor (sb)
 *   └ Gerente de Marketing (gm)        └ Asesor (ab)
 *     ├ Supervisor (s1) ─ a1, a2
 *     └ Supervisor (s2) ─ a3
 */

let n = 0;
function persona(cargo: string, sedeId: number, nombre: string): UserRow {
  n += 1;
  return createLocalUser({
    name: nombre,
    username: nombre.toLowerCase(),
    email: `${nombre.toLowerCase()}@test.local`,
    ci: String(7000000 + n),
    password: 'secreto123',
    numero: `5917000${String(n).padStart(4, '0')}`,
    sedeId,
    roles: [cargo],
  });
}

function jefeDe(u: UserRow): number | null {
  return get<{ jefe_id: number | null }>('SELECT jefe_id FROM sede_miembros WHERE user_id = ? AND principal = 1', u.id)?.jefe_id ?? null;
}

const ids = (lista: { id: number }[]) => lista.map((u) => u.id).sort((x, y) => x - y);

describe('organigrama por personas', () => {
  let norte: number;
  let sur: number;
  let admin: UserRow;
  let gg: UserRow, gm: UserRow, s1: UserRow, s2: UserRow, a1: UserRow, a2: UserRow, a3: UserRow, sb: UserRow, ab: UserRow;

  before(() => {
    norte = createSede('Norte');
    sur = createSede('Sur');
    const now = nowIso();
    // Cuenta local sin roles = Super Admin (como la cuenta de servicio del panel).
    const id = run(
      "INSERT INTO users (name, username, password, source, esam_autorizado, esam_roles, created_at, updated_at) VALUES ('Admin', 'root', 'x', 'local', 1, '[]', ?, ?)",
      now,
      now,
    ).lastInsertRowid;
    admin = findById(id)!;

    gg = persona('Gerente General', norte, 'Gina');
    gm = persona('Gerente de Marketing', norte, 'Mario');
    s1 = persona('Supervisor de Marketing', norte, 'Sara');
    s2 = persona('Supervisor de Marketing', norte, 'Saul');
    a1 = persona('Asesor de Marketing', norte, 'Ana');
    a2 = persona('Asesor de Marketing', norte, 'Alan');
    a3 = persona('Asesor de Marketing', norte, 'Abel');
    sb = persona('Supervisor de Marketing', sur, 'Sonia');
    ab = persona('Asesor de Marketing', sur, 'Aldo');

    asignarJefe(admin, gm.id, gg.id);
    asignarJefe(admin, s1.id, gm.id);
    asignarJefe(admin, s2.id, gm.id);
    asignarJefe(admin, a1.id, s1.id);
    asignarJefe(admin, a2.id, s1.id);
    asignarJefe(admin, a3.id, s2.id);
    asignarJefe(admin, ab.id, sb.id);
  });

  it('ofrece como jefe solo a quien tiene el cargo superior en la misma sede', () => {
    assert.deepEqual(ids(jefesValidos(a1)), ids([s1, s2]));
    assert.deepEqual(ids(jefesValidos(s1)), ids([gm]));
    assert.deepEqual(ids(jefesValidos(gm)), ids([gg]), 'el cargo raíz de marketing depende del Gerente General');
    assert.deepEqual(jefesValidos(gg), []);
  });

  it('cada cargo ve exactamente los leads que le corresponden', () => {
    assert.equal(alcanceLeads(admin), null);
    assert.deepEqual(ids(alcanceLeads(a1)!.map((id) => ({ id }))), ids([a1]), 'el asesor solo ve lo suyo');
    assert.deepEqual(ids(alcanceLeads(s1)!.map((id) => ({ id }))), ids([s1, a1, a2]), 'el supervisor solo ve a SU gente');
    assert.deepEqual(ids(alcanceLeads(gm)!.map((id) => ({ id }))), ids([gm, s1, s2, a1, a2, a3]), 'el gerente de marketing ve todo su subárbol');
    assert.deepEqual(ids(alcanceLeads(gg)!.map((id) => ({ id }))), ids([gg, gm, s1, s2, a1, a2, a3]), 'el gerente de sede ve todo marketing de su sede');

    assert.equal(puedeVerLeadsDe(s1, a3.id), false, 'un supervisor no ve a los asesores de otro');
    assert.equal(puedeVerLeadsDe(a1, a2.id), false, 'un asesor no ve a otro asesor');
    assert.equal(puedeVerLeadsDe(gg, ab.id), false, 'nadie ve otra sede');
    assert.equal(puedeVerLeadsDe(admin, ab.id), true);
  });

  it('rechaza dependencias que no corresponden', () => {
    assert.throws(() => asignarJefe(admin, a1.id, gm.id), /no puede ser jefe/);
    assert.throws(() => asignarJefe(admin, a1.id, sb.id), /misma sede/);
    assert.throws(() => asignarJefe(admin, a1.id, a1.id), /sí misma/);
    assert.equal(jefeDe(a1), s1.id, 'un intento rechazado no cambia nada');
  });

  it('editan el Super Admin y el Gerente General de esa sede, nadie más', () => {
    assert.equal(puedeEditarOrganigrama(admin, norte), true);
    assert.equal(puedeEditarOrganigrama(gg, norte), true);
    assert.equal(puedeEditarOrganigrama(gg, sur), false);
    assert.equal(puedeEditarOrganigrama(gm, norte), false);
    assert.throws(() => asignarJefe(s1, a3.id, s1.id), /Solo el Super Admin o el Gerente General/);

    asignarJefe(gg, a2.id, s2.id);
    assert.equal(jefeDe(a2), s2.id);
    asignarJefe(gg, a2.id, s1.id);
  });

  it('deja traza de cada cambio', () => {
    const cambios = all<{ jefe_anterior: number | null; jefe_nuevo: number | null; cambiado_por: number }>(
      'SELECT jefe_anterior, jefe_nuevo, cambiado_por FROM organigrama_cambios WHERE user_id = ? ORDER BY id',
      a2.id,
    );
    assert.deepEqual(cambios.map((c) => [c.jefe_anterior, c.jefe_nuevo]), [[null, s1.id], [s1.id, s2.id], [s2.id, s1.id]]);
    assert.equal(cambios[1].cambiado_por, gg.id);
    assert.ok(get<{ c: number }>("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'organigrama.jefe'")!.c >= 3);
  });

  it('si cambia el cargo, la dependencia que ya no encaja se suelta', () => {
    const extra = persona('Asesor de Marketing', norte, 'Elsa');
    asignarJefe(admin, extra.id, s1.id);

    updateManagedUser(extra.id, { roles: ['Supervisor de Marketing'] });

    assert.equal(jefeDe(extra), null, 'un supervisor no puede depender de otro supervisor');
    const ultimo = get<{ motivo: string }>('SELECT motivo FROM organigrama_cambios WHERE user_id = ? ORDER BY id DESC LIMIT 1', extra.id);
    assert.equal(ultimo?.motivo, 'automatico');
  });

  it('si se desactiva un jefe, su gente queda sin jefe asignado', () => {
    const sup = persona('Supervisor de Marketing', norte, 'Silvia');
    const ase = persona('Asesor de Marketing', norte, 'Andres');
    asignarJefe(admin, sup.id, gm.id);
    asignarJefe(admin, ase.id, sup.id);

    updateManagedUser(sup.id, { autorizado: false });

    assert.equal(jefeDe(ase), null);
    assert.ok(organigramaDeSede(norte).sinJefe.some((p) => p.id === ase.id));
  });

  it('el SSO de cronogramas no pisa el jefe asignado', () => {
    const sso = upsertUser({ source: 'cronogramas', sourceUid: 'cr-99', name: 'Carla', autorizado: true, roles: ['Asesor de Marketing'] });
    run('UPDATE users SET sede_id = ? WHERE id = ?', norte, sso.id);
    asignarJefe(admin, sso.id, s2.id);

    upsertUser({ source: 'cronogramas', sourceUid: 'cr-99', name: 'Carla Rojas', autorizado: true, roles: ['Asesor de Marketing'] });

    assert.equal(jefeDe(sso), s2.id);
  });

  it('arma el árbol de personas de la sede', () => {
    const { raices } = organigramaDeSede(norte);
    assert.deepEqual(raices.map((r) => r.id), [gg.id]);
    const marketing = raices[0].hijos.find((h) => h.id === gm.id)!;
    assert.equal(marketing.cargo, 'Gerente de Marketing');
    const sara = marketing.hijos.find((h) => h.id === s1.id)!;
    assert.deepEqual(ids(sara.hijos), ids([a1, a2]), 'cada supervisor con SUS asesores');
  });
});
