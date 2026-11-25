import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createSede } from '../src/core/sedes.js';
import { createLocalUser, findById, type UserRow } from '../src/auth/users.js';
import { asignarJefe } from '../src/core/organigrama.js';
import { comentarLead, detalleLead, equipoDe, listarLeads, tieneEquipo } from '../src/core/leads-vista.js';
import { renderEquipo, renderLeadDetalle } from '../src/panel/leads-views.js';
import { all, get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * PLAN_ORGANIGRAMA.md, L4: «Mi equipo» y comentarios de los jefes.
 *
 *   Gerente General (gg)
 *   └ Gerente de Marketing (gm)
 *     ├ Supervisora (sup) ─ ana, beto
 *     └ Supervisor (sup2) ─ carlos
 *   + Contador General (conta), que también depende del Gerente General
 */

let n = 0;
function persona(cargo: string, sedeId: number, nombre: string): UserRow {
  n += 1;
  return createLocalUser({
    name: nombre,
    username: `eq.${nombre.toLowerCase()}`,
    email: `eq.${nombre.toLowerCase()}@test.local`,
    ci: String(8800000 + n),
    password: 'secreto123',
    numero: `5917700${String(n).padStart(4, '0')}`,
    sedeId,
    roles: [cargo],
  });
}

function lead(owner: UserRow, phone: string, etapa: string, opts: { creado?: string; contacto?: string | null; actividad?: string } = {}): number {
  const now = nowIso();
  const session = get<{ id: string }>('SELECT id FROM sessions WHERE owner_uid = ?', String(owner.id))!.id;
  return run(
    `INSERT INTO leads (sede_id, owner_user_id, session_id, phone_key, origen, etapa, ultimo_contacto_at, ultima_actividad_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'linea', ?, ?, ?, ?, ?)`,
    owner.sede_id, owner.id, session, phone, etapa,
    opts.contacto === undefined ? now : opts.contacto, opts.actividad ?? now, opts.creado ?? now, now,
  ).lastInsertRowid;
}

const notificaciones = (u: UserRow) => all<{ kind: string; title: string; link: string }>(
  "SELECT kind, title, link FROM notifications WHERE user_id = ? AND kind = 'lead_comment' ORDER BY id",
  u.id,
);

describe('Mi equipo y comentarios', () => {
  let admin: UserRow, gg: UserRow, gm: UserRow, sup: UserRow, sup2: UserRow, ana: UserRow, beto: UserRow, carlos: UserRow;
  let deAna: number;

  before(() => {
    const sede = createSede('Equipo Norte');
    const now = nowIso();
    admin = findById(run(
      "INSERT INTO users (name, username, password, source, esam_autorizado, esam_roles, created_at, updated_at) VALUES ('Admin', 'eq.root', 'x', 'local', 1, '[]', ?, ?)",
      now, now,
    ).lastInsertRowid)!;
    gg = persona('Gerente General', sede, 'Gaby');
    gm = persona('Gerente de Marketing', sede, 'Mateo');
    sup = persona('Supervisor de Marketing', sede, 'Sofia');
    sup2 = persona('Supervisor de Marketing', sede, 'Sergio');
    ana = persona('Asesor de Marketing', sede, 'Ana');
    beto = persona('Asesor de Marketing', sede, 'Beto');
    carlos = persona('Asesor de Marketing', sede, 'Carlos');
    const conta = persona('Contador General', sede, 'Conta');
    for (const [u, j] of [[gm, gg], [sup, gm], [sup2, gm], [ana, sup], [beto, sup], [carlos, sup2], [conta, gg]] as const) asignarJefe(admin, u.id, j.id);

    const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString();
    deAna = lead(ana, '59170020001', 'nuevo', { creado: hace(2), contacto: null, actividad: hace(2) });
    lead(ana, '59170020002', 'inscrito');
    lead(ana, '59170020003', 'interesado', { actividad: hace(9) });
    lead(beto, '59170020004', 'contactado');
    lead(carlos, '59170020005', 'inscrito');
    lead(carlos, '59170020006', 'no_interesado');
  });

  it('el supervisor ve una fila por asesor con sus cifras y alertas', () => {
    const eq = equipoDe(sup)!;
    assert.deepEqual(eq.filas.map((f) => f.nombre), ['Ana', 'Beto']);
    const filaAna = eq.filas[0];
    assert.deepEqual([filaAna.porEtapa.nuevo, filaAna.porEtapa.interesado, filaAna.porEtapa.inscrito], [1, 1, 1]);
    assert.equal(filaAna.conversion, 33);
    assert.equal(filaAna.sinContactar24h, 1, 'nuevo de hace 2 días sin contactar');
    assert.equal(filaAna.sinMovimiento, 1, 'el interesado lleva 9 días quieto (el nuevo, 2: todavía no cuenta)');
    assert.equal(eq.total.total, 4, 'Ana (3) + Beto (1)');
  });

  it('el gerente de marketing ve a sus supervisores con el total de cada equipo y puede bajar', () => {
    const eq = equipoDe(gm)!;
    assert.deepEqual(eq.filas.map((f) => [f.nombre, f.total, f.conEquipo]), [['Sergio', 2, true], ['Sofia', 4, true]]);
    const bajando = equipoDe(gm, sup.id)!;
    assert.deepEqual(bajando.filas.map((f) => f.nombre), ['Ana', 'Beto']);
    assert.deepEqual(bajando.ruta.map((r) => r.nombre), ['Mateo', 'Sofia'], 'migas desde quien mira');
  });

  it('el Gerente General ve solo a Marketing, aunque también tenga contabilidad a cargo', () => {
    assert.deepEqual(equipoDe(gg)!.filas.map((f) => f.nombre), ['Mateo']);
  });

  it('nadie baja al equipo de alguien fuera de su alcance', () => {
    assert.equal(equipoDe(sup, sup2.id), undefined);
    assert.equal(equipoDe(ana, sup.id), undefined);
    assert.equal(tieneEquipo(ana), false);
    assert.equal(tieneEquipo(sup), true);
  });

  it('el tablero del equipo de un supervisor reúne sus leads y los de su gente', () => {
    assert.equal(listarLeads(gm, { equipo: sup.id }).tarjetas.length, 4);
    assert.equal(listarLeads(sup, { equipo: sup2.id }).tarjetas.length, 0, 'fuera de su alcance');
  });

  it('el Super Admin elige primero la sede', () => {
    assert.match(renderEquipo(admin, null)!, new RegExp(`/leads/equipo\\?sobre=${gg.id}`));
    assert.match(renderEquipo(admin, gg.id)!, /Mateo/);
  });

  it('un jefe comenta y al asesor le llega el aviso; al abrir el lead queda leído', () => {
    comentarLead(sup, deAna, 'Llamala hoy, preguntó por la beca.');
    assert.deepEqual(notificaciones(ana).map((x) => x.link), [`/leads/${deAna}`]);
    assert.match(notificaciones(ana)[0].title, /Sofia comentó tu lead/);

    assert.equal(listarLeads(ana, { id: deAna }).tarjetas[0].comentario_nuevo, true);
    const d = detalleLead(ana, deAna)!;
    assert.match(renderLeadDetalle(ana, d), /Llamala hoy/);
    assert.equal(listarLeads(ana, { id: deAna }).tarjetas[0].comentario_nuevo, false, 'abrir el lead lo marca leído');
  });

  it('si el asesor responde, les llega a los jefes que comentaron', () => {
    comentarLead(gm, deAna, 'Que sea antes de las 18.');
    comentarLead(ana, deAna, 'Listo, la llamé.');
    assert.equal(notificaciones(sup).length, 1);
    assert.equal(notificaciones(gm).length, 1);
    assert.match(notificaciones(sup)[0].title, /Ana respondió/);
    assert.equal(notificaciones(ana).length, 2, 'Ana no se avisa a sí misma');
  });

  it('no comenta quien no ve el lead, ni un comentario vacío', () => {
    assert.throws(() => comentarLead(sup2, deAna, 'hola'), /no encontrado/);
    assert.throws(() => comentarLead(beto, deAna, 'hola'), /no encontrado/);
    assert.throws(() => comentarLead(sup, deAna, '   '), /Escribí/);
  });
});
