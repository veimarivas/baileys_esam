import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createSede } from '../src/core/sedes.js';
import { createLocalUser, esamPuede, findById, updateManagedUser, type UserRow } from '../src/auth/users.js';
import {
  agregarASede,
  alcanceLeads,
  asignarJefe,
  candidatosDeOtrasSedes,
  jefesValidos,
  organigramaDeSede,
  puedeEditarOrganigrama,
  quitarDeSede,
  sedesDe,
} from '../src/core/organigrama.js';
import { comentarLead, equipoDe, listarLeads } from '../src/core/leads-vista.js';
import { moverEtapa } from '../src/core/leads.js';
import { analizarLeads } from '../src/core/leads-analisis.js';
import { renderAnalisis } from '../src/panel/leads-analisis-view.js';
import { get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Gerentes y supervisores en varias sedes, y el personal de «Control de Sedes».
 *
 *   Sucre                                   Potosí
 *   Gina (GG) ───────────── también ──────── Gina (GG)
 *   └ Mario (GM Sucre)                       └ Pablo (GM Potosí)
 *     └ Sara (Sup.) ─────── también ───────────└ Sara (Sup.)
 *       └ Ana (Sucre)                            ├ Bruno (Potosí)
 *                                             └ Pedro (Sup.) └ Carla (Potosí)
 */

let n = 0;
function persona(cargo: string, sedeId: number, nombre: string): UserRow {
  n += 1;
  return createLocalUser({
    name: nombre,
    username: `ms.${nombre.toLowerCase()}`,
    email: `ms.${nombre.toLowerCase()}@test.local`,
    ci: String(8900000 + n),
    password: 'secreto123',
    numero: `5917800${String(n).padStart(4, '0')}`,
    sedeId,
    roles: [cargo],
  });
}

function lead(owner: UserRow, sedeId: number, phone: string, etapa: string, programa = 'MBA'): number {
  const now = nowIso();
  const session = get<{ id: string }>('SELECT id FROM sessions WHERE owner_uid = ?', String(owner.id))!.id;
  return run(
    `INSERT INTO leads (sede_id, owner_user_id, session_id, phone_key, origen, programa, etapa, ultimo_contacto_at, ultima_actividad_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'linea', ?, ?, ?, ?, ?, ?)`,
    sedeId, owner.id, session, phone, programa, etapa, now, now, now, now,
  ).lastInsertRowid;
}

const ordenar = (ids: number[] | null) => (ids ?? []).slice().sort((a, b) => a - b);
const ids = (...us: UserRow[]) => us.map((u) => u.id).sort((a, b) => a - b);

describe('varias sedes y control de sedes', () => {
  let sucre: number, potosi: number;
  let admin: UserRow, gina: UserRow, mario: UserRow, pablo: UserRow, sara: UserRow, pedro: UserRow, ana: UserRow, bruno: UserRow, carla: UserRow, control: UserRow;
  let deAna: number;

  before(() => {
    sucre = createSede('MS Sucre');
    potosi = createSede('MS Potosí');
    const now = nowIso();
    admin = findById(run(
      "INSERT INTO users (name, username, password, source, esam_autorizado, esam_roles, created_at, updated_at) VALUES ('Admin', 'ms.root', 'x', 'local', 1, '[]', ?, ?)",
      now, now,
    ).lastInsertRowid)!;

    gina = persona('Gerente General', sucre, 'Gina');
    mario = persona('Gerente de Marketing', sucre, 'Mario');
    pablo = persona('Gerente de Marketing', potosi, 'Pablo');
    sara = persona('Supervisor de Marketing', sucre, 'Sara');
    pedro = persona('Supervisor de Marketing', potosi, 'Pedro');
    ana = persona('Asesor de Marketing', sucre, 'Ana');
    bruno = persona('Asesor de Marketing', potosi, 'Bruno');
    carla = persona('Asesor de Marketing', potosi, 'Carla');
    control = persona('Control de Sedes', sucre, 'Cecilia');

    // Gina y Sara trabajan también en Potosí.
    agregarASede(admin, potosi, gina.id);
    agregarASede(admin, potosi, sara.id);

    asignarJefe(admin, mario.id, gina.id);
    asignarJefe(admin, sara.id, mario.id);
    asignarJefe(admin, ana.id, sara.id);
    asignarJefe(admin, pablo.id, gina.id, potosi);
    asignarJefe(admin, sara.id, pablo.id, potosi);
    asignarJefe(admin, pedro.id, pablo.id, potosi);
    asignarJefe(admin, bruno.id, sara.id, potosi);
    asignarJefe(admin, carla.id, pedro.id, potosi);

    deAna = lead(ana, sucre, '59170030001', 'inscrito', 'MBA');
    lead(ana, sucre, '59170030002', 'nuevo', 'Diplomado');
    lead(bruno, potosi, '59170030003', 'contactado', 'MBA');
    lead(carla, potosi, '59170030004', 'inscrito', 'MBA');
    lead(carla, potosi, '59170030005', 'interesado', 'Maestría');
  });

  it('cada persona tiene su sede principal y las extra', () => {
    assert.deepEqual(sedesDe(sara.id).map((s) => [s.nombre, s.principal]), [['MS Sucre', true], ['MS Potosí', false]]);
  });

  it('un supervisor en dos sedes ve a sus asesores de las dos, no a los de otro supervisor', () => {
    assert.deepEqual(ordenar(alcanceLeads(sara)), ids(sara, ana, bruno));
  });

  it('un gerente de marketing ve solo su sede, aunque su supervisor también esté en otra', () => {
    assert.deepEqual(ordenar(alcanceLeads(mario)), ids(mario, sara, ana));
    assert.deepEqual(ordenar(alcanceLeads(pablo)), ids(pablo, sara, pedro, bruno, carla));
  });

  it('el gerente general en dos sedes ve marketing de las dos y edita las dos', () => {
    const alcance = alcanceLeads(gina)!;
    for (const u of [mario, pablo, sara, pedro, ana, bruno, carla]) assert.ok(alcance.includes(u.id), u.name!);
    assert.equal(puedeEditarOrganigrama(gina, potosi), true);
    assert.deepEqual(equipoDe(gina, gina.id, new Date(), potosi)!.filas.map((f) => f.nombre), ['Pablo'], 'filtrado por sede');
    assert.deepEqual(equipoDe(gina)!.filas.map((f) => f.nombre).sort(), ['Mario', 'Pablo'], 'todas sus sedes');
  });

  it('en el organigrama de la otra sede aparece marcada y con su gente de ahí', () => {
    const { raices } = organigramaDeSede(potosi);
    const pabloNodo = raices[0].hijos.find((h) => h.id === pablo.id)!;
    const saraNodo = pabloNodo.hijos.find((h) => h.id === sara.id)!;
    assert.equal(saraNodo.deOtraSede, true);
    assert.deepEqual(saraNodo.hijos.map((h) => h.id), [bruno.id]);
    assert.deepEqual(jefesValidos(sara, potosi).map((j) => j.id), [pablo.id], 'en Potosí depende de un gerente de Potosí');
  });

  it('solo gerentes y supervisores se suman a otra sede', () => {
    assert.ok(candidatosDeOtrasSedes(potosi).some((c) => c.id === mario.id));
    assert.ok(!candidatosDeOtrasSedes(potosi).some((c) => c.id === ana.id), 'un asesor no');
    assert.throws(() => agregarASede(admin, potosi, ana.id), /Solo gerentes y supervisores/);
    assert.throws(() => agregarASede(mario, potosi, mario.id), /Solo el Super Admin o el Gerente General/);
  });

  it('quitar de una sede extra suelta a su gente ahí; la principal no se quita desde acá', () => {
    const tito = persona('Supervisor de Marketing', sucre, 'Tito');
    const lia = persona('Asesor de Marketing', potosi, 'Lia');
    agregarASede(gina, potosi, tito.id);
    asignarJefe(gina, tito.id, pablo.id, potosi);
    asignarJefe(gina, lia.id, tito.id, potosi);

    quitarDeSede(gina, potosi, tito.id);
    assert.equal(get<{ jefe_id: number | null }>('SELECT jefe_id FROM sede_miembros WHERE user_id = ? AND sede_id = ?', lia.id, potosi)?.jefe_id, null);
    assert.throws(() => quitarDeSede(gina, sucre, tito.id), /sede principal/);
  });

  it('cambiar la sede principal muda la membresía y suelta su gente de la sede vieja', () => {
    const vera = persona('Supervisor de Marketing', sucre, 'Vera');
    const leo = persona('Asesor de Marketing', sucre, 'Leo');
    asignarJefe(admin, vera.id, mario.id);
    asignarJefe(admin, leo.id, vera.id);

    updateManagedUser(vera.id, { sedeId: potosi });

    assert.deepEqual(sedesDe(vera.id).map((s) => [s.nombre, s.principal, s.jefe_id]), [['MS Potosí', true, null]]);
    assert.equal(get<{ jefe_id: number | null }>('SELECT jefe_id FROM sede_miembros WHERE user_id = ? AND sede_id = ?', leo.id, sucre)?.jefe_id, null);
  });

  it('Control de Sedes ve todos los leads de todas las sedes, solo mira y comenta', () => {
    assert.equal(alcanceLeads(control), null);
    assert.equal(esamPuede(control, 'leads'), true);
    assert.equal(puedeEditarOrganigrama(control, sucre), false);
    assert.equal(listarLeads(control).tarjetas.length, 5);
    assert.throws(() => moverEtapa(control.id, deAna, 'nuevo'), /no encontrado/);
    comentarLead(control, deAna, 'Buen cierre.');
    assert.ok(!organigramaDeSede(sucre).sinJefe.some((p) => p.id === control.id), 'no aparece en el organigrama de su sede');
  });

  it('el análisis cuenta según el alcance de quien mira', () => {
    const todo = analizarLeads(control, { periodo: 'todo' });
    assert.equal(todo.kpis.total, 5);
    assert.equal(todo.kpis.inscritos, 2);
    assert.equal(todo.kpis.conversion, 40);
    assert.deepEqual(todo.sedes.map((s) => [s.sede, s.total]), [['MS Potosí', 3], ['MS Sucre', 2]]);
    assert.equal(todo.programas[0].programa, 'Sin programa asignado', 'todavía no se asignaron programas de la oferta');
    assert.equal(todo.asesores[0].inscritos, 1);

    const deSara = analizarLeads(sara, { periodo: 'todo' });
    assert.equal(deSara.kpis.total, 3, 'Ana y Bruno');
    assert.equal(analizarLeads(control, { periodo: 'todo', sede: sucre }).kpis.total, 2);
    assert.equal(analizarLeads(control, { periodo: 'todo', programaId: 0 }).kpis.total, 5, 'sin programa asignado');

    const html = renderAnalisis(control, { periodo: 'todo' });
    assert.match(html, /id="la-sedes"/, 'con varias sedes se compara por sede');
    assert.match(html, /"inscrito"/);
  });
});
