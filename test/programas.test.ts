import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createSede } from '../src/core/sedes.js';
import { createLocalUser, esamPuede, findById, type UserRow } from '../src/auth/users.js';
import { agregarASede, asignarJefe } from '../src/core/organigrama.js';
import {
  aCentavos,
  alternarPrograma,
  borrarPrograma,
  bs,
  crearPrograma,
  enCuotas,
  getPrograma,
  actualizarPrograma,
  puedeEditarProgramas,
  sedesEditables,
  totalCredito,
} from '../src/core/programas.js';
import { asignarPrograma, getLead, sincronizarProspecto } from '../src/core/leads.js';
import { detalleLead, listarLeads, ofertaParaLead } from '../src/core/leads-vista.js';
import { analizarLeads } from '../src/core/leads-analisis.js';
import { renderLeadDetalle } from '../src/panel/leads-views.js';
import { renderProgramas } from '../src/panel/programas-views.js';
import { all, get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Oferta de programas por sede: tipos, precios al contado y a crédito, y su
 * uso en los leads (asignar, filtrar y analizar).
 */

let n = 0;
function persona(cargo: string, sedeId: number, nombre: string): UserRow {
  n += 1;
  return createLocalUser({
    name: nombre,
    username: `pg.${nombre.toLowerCase()}`,
    email: `pg.${nombre.toLowerCase()}@test.local`,
    ci: String(9400000 + n),
    password: 'secreto123',
    numero: `5917910${String(n).padStart(4, '0')}`,
    sedeId,
    roles: [cargo],
  });
}

function lead(owner: UserRow, sedeId: number, phone: string, etapa = 'nuevo'): number {
  const now = nowIso();
  const session = get<{ id: string }>('SELECT id FROM sessions WHERE owner_uid = ?', String(owner.id))!.id;
  return run(
    `INSERT INTO leads (sede_id, owner_user_id, session_id, phone_key, origen, etapa, ultima_actividad_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'linea', ?, ?, ?, ?)`,
    sedeId, owner.id, session, phone, etapa, now, now, now,
  ).lastInsertRowid;
}

describe('programas de la oferta por sede', () => {
  let sucre: number, potosi: number;
  let admin: UserRow, gg: UserRow, gm: UserRow, sup: UserRow, ana: UserRow, beto: UserRow, ggPotosi: UserRow;
  let maestria: number, diplomado: number, curso: number, dePotosi: number;
  let deAna: number;

  before(() => {
    sucre = createSede('PG Sucre');
    potosi = createSede('PG Potosí');
    const now = nowIso();
    admin = findById(run(
      "INSERT INTO users (name, username, password, source, esam_autorizado, esam_roles, created_at, updated_at) VALUES ('Admin', 'pg.root', 'x', 'local', 1, '[]', ?, ?)",
      now, now,
    ).lastInsertRowid)!;
    gg = persona('Gerente Regional', sucre, 'Gina');
    gm = persona('Gerente de Marketing', sucre, 'Mario');
    sup = persona('Supervisor de Marketing', sucre, 'Sara');
    ana = persona('Asesor de Marketing', sucre, 'Ana');
    beto = persona('Asesor de Marketing', potosi, 'Beto');
    ggPotosi = persona('Gerente Regional', potosi, 'Gabo');
    asignarJefe(admin, gm.id, gg.id);
    asignarJefe(admin, sup.id, gm.id);
    asignarJefe(admin, ana.id, sup.id);
    deAna = lead(ana, sucre, '59170040001');
  });

  it('entiende los montos como los escribe la gente', () => {
    assert.equal(aCentavos('1.500', 'x'), 150000);
    assert.equal(aCentavos('1500,50', 'x'), 150050);
    assert.equal(aCentavos('1,500.50', 'x'), 150050);
    assert.equal(aCentavos('Bs 12.000', 'x'), 1200000);
    assert.equal(aCentavos('', 'x'), null);
    assert.throws(() => aCentavos('doce', 'Matrícula'), /Matrícula: escribí un monto válido/);
    assert.equal(bs(150000), 'Bs 1.500');
    assert.equal(bs(150050), 'Bs 1.500,50');
    assert.equal(enCuotas(500000, 10), '10 cuotas de Bs 500');
    assert.equal(enCuotas(30000, 1), '1 pago de Bs 300');
  });

  it('la oferta la cargan el Super Admin y los gerentes de la sede', () => {
    assert.equal(puedeEditarProgramas(admin, sucre), true);
    assert.equal(puedeEditarProgramas(gg, sucre), true);
    assert.equal(puedeEditarProgramas(gm, sucre), true);
    assert.equal(puedeEditarProgramas(sup, sucre), false);
    assert.equal(puedeEditarProgramas(ana, sucre), false);
    assert.equal(puedeEditarProgramas(gg, potosi), false, 'no la de otra sede');
    assert.deepEqual(sedesEditables(gm).map((s) => s.id), [sucre]);
    assert.equal(esamPuede(gm, 'programas'), true);
    assert.equal(esamPuede(ana, 'programas'), false);
  });

  it('registra programas por tipo con precio al contado y a crédito', () => {
    maestria = crearPrograma(gm, sucre, {
      tipo: 'maestria', nombre: 'Maestría en Educación Superior',
      contado: '12.000', matricula: '500', matriculaCuotas: 1, colegiatura: '12.000', colegiaturaCuotas: 20, certificacion: '1.500', certificacionCuotas: 3,
    });
    diplomado = crearPrograma(gm, sucre, { tipo: 'diplomado', nombre: 'Diplomado en Docencia', contado: '3.000' });
    curso = crearPrograma(gg, sucre, { tipo: 'curso', nombre: 'Curso de Excel', matricula: '100', colegiatura: '400', colegiaturaCuotas: 2 });
    dePotosi = crearPrograma(ggPotosi, potosi, { tipo: 'maestria', nombre: 'Maestría en Educación Superior', contado: '11.000' });

    const p = getPrograma(maestria)!;
    assert.equal(p.colegiatura_centavos, 1200000);
    assert.equal(p.colegiatura_cuotas, 20);
    assert.equal(totalCredito(p), 1400000, '500 + 12.000 + 1.500');
  });

  it('valida lo que se carga', () => {
    assert.throws(() => crearPrograma(gm, sucre, { tipo: 'taller', nombre: 'X', contado: '1' }), /tipo/);
    assert.throws(() => crearPrograma(gm, sucre, { tipo: 'curso', nombre: 'Curso sin precio' }), /al menos el precio/);
    assert.throws(() => crearPrograma(gm, sucre, { tipo: 'diplomado', nombre: 'diplomado en docencia', contado: '1' }), /Ya existe/);
    assert.throws(() => crearPrograma(gm, sucre, { tipo: 'curso', nombre: 'Curso X', matricula: '1', matriculaCuotas: 99 }), /de 1 a 60/);
    assert.throws(() => crearPrograma(sup, sucre, { tipo: 'curso', nombre: 'Curso Y', contado: '1' }), /No podés/);
    actualizarPrograma(gm, curso, { tipo: 'curso', nombre: 'Curso de Excel Avanzado', matricula: '100', colegiatura: '600', colegiaturaCuotas: 3 });
    assert.equal(getPrograma(curso)!.nombre, 'Curso de Excel Avanzado');
  });

  it('el asesor asigna a su lead un programa de la oferta de SU sede', () => {
    assert.deepEqual(ofertaParaLead(getLead(deAna)!).map((o) => o.id).sort(), [maestria, diplomado, curso].sort());
    asignarPrograma(ana.id, deAna, maestria);
    assert.equal(getLead(deAna)!.programa_id, maestria);
    const ev = all<{ tipo: string; a: string }>("SELECT tipo, a FROM lead_eventos WHERE lead_id = ? AND tipo = 'programa'", deAna);
    assert.equal(ev[0].a, 'Maestría en Educación Superior');

    assert.throws(() => asignarPrograma(ana.id, deAna, dePotosi), /otra sede/);
    assert.throws(() => asignarPrograma(sup.id, deAna, diplomado), /no encontrado/, 'el jefe solo mira');
  });

  it('un programa en pausa no se ofrece, pero el lead que ya lo tenía lo conserva', () => {
    alternarPrograma(gm, maestria);
    const oferta = ofertaParaLead(getLead(deAna)!).map((o) => o.id);
    assert.ok(oferta.includes(maestria), 'lo ve porque ya lo tiene');
    const otro = lead(ana, sucre, '59170040009');
    assert.ok(!ofertaParaLead(getLead(otro)!).map((o) => o.id).includes(maestria));
    assert.throws(() => asignarPrograma(ana.id, otro, maestria), /no está en la oferta/);
    alternarPrograma(gm, maestria);
  });

  it('no se borra un programa con leads (se pausa)', () => {
    assert.throws(() => borrarPrograma(gm, maestria), /pausalo/);
    const tmp = crearPrograma(gm, sucre, { tipo: 'curso', nombre: 'Curso temporal', contado: '50' });
    borrarPrograma(gm, tmp);
    assert.equal(getPrograma(tmp), undefined);
  });

  it('lo que manda cronogramas se empareja solo con la oferta de la sede', () => {
    const id = sincronizarProspecto({
      ref: 'mp:pg1', ownerUserId: ana.id, sessionId: get<{ id: string }>('SELECT id FROM sessions WHERE owner_uid = ?', String(ana.id))!.id,
      clave: '59170040002', contactId: null, programa: 'diplomado EN DOCENCIA', estado: 'nuevo', estadoCambio: true,
    });
    assert.equal(getLead(id)!.programa_id, diplomado, 'sin distinguir mayúsculas');
  });

  it('el tablero filtra por programa y por tipo', () => {
    assert.ok(listarLeads(ana, { programaId: maestria }).tarjetas.every((t) => t.programa_id === maestria));
    assert.equal(listarLeads(ana, { tipo: 'diplomado' }).tarjetas.length, 1);
    assert.ok(listarLeads(ana, { programaId: 0 }).tarjetas.every((t) => t.programa_id === null));
    const t = listarLeads(ana, { programaId: maestria }).tarjetas[0];
    assert.equal(t.programa, 'Maestría en Educación Superior');
    assert.equal(t.programa_tipo, 'maestria');
  });

  it('el análisis agrupa por programa de la oferta y por tipo', () => {
    run("UPDATE leads SET etapa = 'inscrito' WHERE id = ?", deAna);
    const a = analizarLeads(gg, { periodo: 'todo' });
    const porTipo = Object.fromEntries(a.tipos.map((t) => [t.tipo, t]));
    assert.equal(porTipo.maestria.total, 1);
    assert.equal(porTipo.maestria.conversion, 100);
    assert.equal(porTipo.diplomado.total, 1);
    assert.ok(a.programas.some((p) => p.programa === 'Maestría en Educación Superior' && p.tipo === 'maestria'));
    assert.equal(analizarLeads(gg, { periodo: 'todo', tipo: 'diplomado' }).kpis.total, 1);
    assert.equal(analizarLeads(gg, { periodo: 'todo', programaId: maestria }).kpis.inscritos, 1);
  });

  it('pantallas: la oferta por tipo y el programa en la ficha', () => {
    const html = renderProgramas(gm, sucre);
    assert.match(html, /Maestrías/);
    assert.match(html, /20 cuotas de Bs 600/);
    assert.match(html, /Bs 14\.000/, 'total a crédito');

    const delAsesor = renderLeadDetalle(ana, detalleLead(ana, deAna)!);
    assert.match(delAsesor, /name="programa_id"/);
    assert.match(delAsesor, /20 cuotas de Bs 600/);
    const delJefe = renderLeadDetalle(sup, detalleLead(sup, deAna)!);
    assert.ok(!delJefe.includes('name="programa_id"'), 'el jefe no asigna');
    assert.match(delJefe, /Maestría en Educación Superior/);
  });

  it('un gerente en dos sedes administra la oferta de las dos', () => {
    agregarASede(admin, potosi, gm.id);
    assert.deepEqual(sedesEditables(gm).map((s) => s.id).sort(), [sucre, potosi].sort());
    void beto;
  });
});
