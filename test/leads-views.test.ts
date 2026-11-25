import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { Request, RequestHandler, Response } from 'express';
import { createSede } from '../src/core/sedes.js';
import { createLocalUser, esamPuede, findById, type UserRow } from '../src/auth/users.js';
import { asignarJefe } from '../src/core/organigrama.js';
import { detalleLead, listarLeads } from '../src/core/leads-vista.js';
import { registerLeadsRoutes, renderLeadsBoard } from '../src/panel/leads-views.js';
import { get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * PLAN_ORGANIGRAMA.md, L3: /leads. Cada uno ve lo que le toca según el
 * organigrama; solo el dueño mueve la etapa.
 */

let n = 0;
function persona(cargo: string, sedeId: number, nombre: string): UserRow {
  n += 1;
  return createLocalUser({
    name: nombre,
    username: `lv.${nombre.toLowerCase()}`,
    email: `lv.${nombre.toLowerCase()}@test.local`,
    ci: String(8700000 + n),
    password: 'secreto123',
    numero: `5917400${String(n).padStart(4, '0')}`,
    sedeId,
    roles: [cargo],
  });
}

function lineaDe(u: UserRow): string {
  return get<{ id: string }>('SELECT id FROM sessions WHERE owner_uid = ?', String(u.id))!.id;
}

function lead(owner: UserRow, phone: string, etapa: string, extra: { programa?: string; contacto?: string | null; actividad?: string; nombre?: string } = {}): number {
  const now = nowIso();
  const session = lineaDe(owner);
  const contacto = run(
    'INSERT INTO contacts (session_id, chat_id, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    session, `${phone}@c.us`, extra.nombre ?? null, phone, now, now,
  ).lastInsertRowid;
  return run(
    `INSERT INTO leads (sede_id, owner_user_id, session_id, contact_id, phone_key, origen, programa, etapa, ultimo_contacto_at, ultima_actividad_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'linea', ?, ?, ?, ?, ?, ?)`,
    owner.sede_id, owner.id, session, contacto, phone, extra.programa ?? null, etapa,
    extra.contacto === undefined ? now : extra.contacto, extra.actividad ?? now, now, now,
  ).lastInsertRowid;
}

function rutas() {
  const handlers = new Map<string, RequestHandler[]>();
  const app = {
    get: (p: string, ...h: RequestHandler[]) => handlers.set(`GET ${p}`, h),
    post: (p: string, ...h: RequestHandler[]) => handlers.set(`POST ${p}`, h),
  };
  const pasa: RequestHandler = (_q, _r, next) => next();
  registerLeadsRoutes(app as never, { requireUser: pasa, requireSection: () => pasa });
  return (method: 'GET' | 'POST', path: string, params: Record<string, string>, user: UserRow, body: Record<string, string> = {}, json = true) => {
    const out: { status: number; json?: { error?: string; etapa?: string }; body?: string; redirect?: string } = { status: 200 };
    const req = { method, params, body, query: {}, user, headers: json ? { accept: 'application/json' } : {}, header: () => undefined, secure: false } as unknown as Request;
    const res = {
      req, append() { return this; },
      status(c: number) { out.status = c; return this; },
      json(v: never) { out.json = v; return this; },
      send(b: string) { out.body = b; return this; },
      redirect(l: string) { out.status = 302; out.redirect = l; return this; },
    } as unknown as Response;
    for (const h of handlers.get(`${method} ${path}`) ?? []) h(req, res, () => {});
    return out;
  };
}

describe('/leads', () => {
  let admin: UserRow, gg: UserRow, gm: UserRow, sup: UserRow, ana: UserRow, beto: UserRow, otroSup: UserRow, carlos: UserRow, contador: UserRow;
  let deAna: number, deBeto: number, deCarlos: number;

  before(() => {
    const sede = createSede('Leads Vista');
    const now = nowIso();
    admin = findById(run(
      "INSERT INTO users (name, username, password, source, esam_autorizado, esam_roles, created_at, updated_at) VALUES ('Admin', 'lv.root', 'x', 'local', 1, '[]', ?, ?)",
      now, now,
    ).lastInsertRowid)!;
    gg = persona('Gerente Regional', sede, 'Gaby');
    gm = persona('Gerente de Marketing', sede, 'Mateo');
    sup = persona('Supervisor de Marketing', sede, 'Sofia');
    otroSup = persona('Supervisor de Marketing', sede, 'Sergio');
    ana = persona('Asesor de Marketing', sede, 'Ana');
    beto = persona('Asesor de Marketing', sede, 'Beto');
    carlos = persona('Asesor de Marketing', sede, 'Carlos');
    contador = persona('Contador General', sede, 'Conta');
    asignarJefe(admin, gm.id, gg.id);
    asignarJefe(admin, sup.id, gm.id);
    asignarJefe(admin, otroSup.id, gm.id);
    asignarJefe(admin, ana.id, sup.id);
    asignarJefe(admin, beto.id, sup.id);
    asignarJefe(admin, carlos.id, otroSup.id);

    const viejo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    deAna = lead(ana, '59170010001', 'nuevo', { programa: 'MBA', contacto: null, nombre: 'Laura Paz' });
    lead(ana, '59170010002', 'interesado', { programa: 'Diplomado', actividad: viejo });
    deBeto = lead(beto, '59170010003', 'contactado', { programa: 'MBA' });
    deCarlos = lead(carlos, '59170010004', 'inscrito');
    run(
      `INSERT INTO messages (session_id, chat_id, direction, content_type, body, occurred_at, created_at) VALUES (?, '59170010001@c.us', 'in', 'text', 'Quiero info del MBA', ?, ?)`,
      lineaDe(ana), now, now,
    );
  });

  const ids = (u: UserRow, f = {}) => listarLeads(u, f).tarjetas.map((t) => t.id).sort((a, b) => a - b);

  it('cada uno ve solo lo que le toca', () => {
    assert.equal(ids(ana).length, 2, 'Ana ve sus dos leads');
    assert.ok(!ids(ana).includes(deBeto));
    assert.deepEqual(ids(sup).sort(), [...ids(ana), deBeto].sort(), 'Sofía ve a Ana y a Beto');
    assert.ok(!ids(sup).includes(deCarlos), 'no ve a los asesores de otro supervisor');
    assert.equal(ids(gm).length, 4, 'el gerente de marketing ve todo su equipo');
    assert.equal(ids(gg).length, 4);
    assert.equal(ids(admin).length, 4);
  });

  it('filtra por persona solo dentro del alcance, por programa y por atajos', () => {
    assert.deepEqual(ids(sup, { persona: beto.id }), [deBeto]);
    assert.deepEqual(ids(sup, { persona: carlos.id }), [], 'no abre el pipeline de alguien ajeno');
    assert.equal(ids(gm, { programa: 'MBA' }).length, 2);
    assert.deepEqual(ids(ana, { filtro: 'sin_contactar' }), [deAna]);
    assert.equal(ids(ana, { filtro: 'sin_movimiento' }).length, 1);
    assert.deepEqual(ids(gm, { q: 'Laura' }), [deAna], 'busca por el nombre del contacto');
  });

  it('la ficha muestra la conversación y no existe para quien no la puede ver', () => {
    const d = detalleLead(ana, deAna)!;
    assert.equal(d.tarjeta.nombre, 'Laura Paz');
    assert.equal(d.mensajes[0].body, 'Quiero info del MBA');
    assert.equal(detalleLead(beto, deAna), undefined);
    assert.equal(detalleLead(otroSup, deAna), undefined);
    assert.ok(detalleLead(sup, deAna), 'su supervisora sí');
  });

  it('el tablero: tarjetas propias arrastrables, las del equipo no', () => {
    const delAsesor = renderLeadsBoard(ana, {});
    assert.match(delAsesor, new RegExp(`data-lead="${deAna}"[^>]*draggable="true"`));
    assert.ok(!delAsesor.includes('ld-card-owner'), 'el asesor no ve el nombre del dueño (son todos suyos)');

    const delJefe = renderLeadsBoard(sup, {});
    assert.ok(!new RegExp(`data-lead="${deAna}"[^>]*draggable`).test(delJefe), 'el jefe no arrastra');
    assert.ok(delJefe.includes('ld-card-owner'), 'el jefe ve de quién es cada tarjeta');
    assert.match(delJefe, /name="persona"/, 'y puede elegir a una persona de su equipo');
  });

  it('solo el dueño mueve la etapa', () => {
    const llamar = rutas();
    const ok = llamar('POST', '/leads/:id/etapa', { id: String(deAna) }, ana, { etapa: 'contactado' });
    assert.equal(ok.json?.etapa, 'contactado');

    const jefe = llamar('POST', '/leads/:id/etapa', { id: String(deAna) }, sup, { etapa: 'inscrito' });
    assert.equal(jefe.status, 404);
    const invalida = llamar('POST', '/leads/:id/etapa', { id: String(deAna) }, ana, { etapa: 'perdido' });
    assert.equal(invalida.status, 422);
    assert.equal(get<{ etapa: string }>('SELECT etapa FROM leads WHERE id = ?', deAna)?.etapa, 'contactado');
  });

  it('la ficha en panel: 404 para quien no la ve', () => {
    const llamar = rutas();
    assert.equal(llamar('GET', '/leads/:id/panel', { id: String(deAna) }, beto).status, 404);
    const r = llamar('GET', '/leads/:id/panel', { id: String(deAna) }, sup);
    assert.equal(r.status, 200);
    assert.ok(r.body?.includes('La etapa la mueve'), 'el jefe ve la etapa sin poder moverla');
  });

  it('acceso a la sección: Marketing y Gerente Regional, no otras áreas', () => {
    assert.equal(esamPuede(ana, 'leads'), true);
    assert.equal(esamPuede(gm, 'leads'), true);
    assert.equal(esamPuede(gg, 'leads'), true);
    assert.equal(esamPuede(contador, 'leads'), false);
  });
});
