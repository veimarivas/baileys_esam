import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { Request, RequestHandler, Response } from 'express';
import { createSede } from '../src/core/sedes.js';
import { createLocalUser, findById, type UserRow } from '../src/auth/users.js';
import { asignarJefe } from '../src/core/organigrama.js';
import { registerOrganigramaRoutes, renderOrganigramaPersonas } from '../src/panel/organigrama-views.js';
import { get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * PLAN_ORGANIGRAMA.md, L1: organigrama de PERSONAS en la ficha de la sede y
 * en /organigrama, con edición de dependencias.
 */

let n = 0;
function persona(cargo: string, sedeId: number, nombre: string): UserRow {
  n += 1;
  return createLocalUser({
    name: nombre,
    username: `v.${nombre.toLowerCase()}`,
    email: `v.${nombre.toLowerCase()}@test.local`,
    ci: String(8000000 + n),
    password: 'secreto123',
    numero: `5917100${String(n).padStart(4, '0')}`,
    sedeId,
    roles: [cargo],
  });
}

/** Rutas registradas en un «app» de mentira, para llamarlas directo. */
function rutas() {
  const handlers = new Map<string, RequestHandler[]>();
  const app = {
    get: (path: string, ...h: RequestHandler[]) => handlers.set(`GET ${path}`, h),
    post: (path: string, ...h: RequestHandler[]) => handlers.set(`POST ${path}`, h),
  };
  const requireUser: RequestHandler = (_req, _res, next) => next();
  registerOrganigramaRoutes(app as never, { requireUser });

  return (method: 'GET' | 'POST', path: string, user: UserRow, extra: { body?: Record<string, string>; query?: Record<string, string> } = {}) => {
    const out: { status: number; redirect?: string; body?: string; cookies: string[] } = { status: 200, cookies: [] };
    const req = {
      method, path, user, body: extra.body ?? {}, query: extra.query ?? {}, secure: false, protocol: 'http',
      headers: {}, header: () => undefined, get: () => undefined,
    } as unknown as Request;
    const res = {
      req,
      locals: {},
      append(_k: string, v: string) { out.cookies.push(v); return this; },
      status(code: number) { out.status = code; return this; },
      send(body: string) { out.body = body; return this; },
      redirect(location: string) { out.status = 302; out.redirect = location; return this; },
    } as unknown as Response;
    for (const h of handlers.get(`${method} ${path}`) ?? []) h(req, res, () => {});
    return out;
  };
}

/** Texto entre dos marcas del HTML. */
const entre = (html: string, desde: string, hasta: string): string => {
  const i = html.indexOf(desde);
  const j = html.indexOf(hasta, i + desde.length);
  return i >= 0 && j > i ? html.slice(i, j) : '';
};

describe('organigrama de personas (vista)', () => {
  let norte: number;
  let sur: number;
  let admin: UserRow;
  let gg: UserRow, gm: UserRow, s1: UserRow, s2: UserRow, a1: UserRow, a2: UserRow, a3: UserRow, ggSur: UserRow;

  before(() => {
    norte = createSede('Vista Norte');
    sur = createSede('Vista Sur');
    const now = nowIso();
    admin = findById(run(
      "INSERT INTO users (name, username, password, source, esam_autorizado, esam_roles, created_at, updated_at) VALUES ('Admin', 'v.root', 'x', 'local', 1, '[]', ?, ?)",
      now, now,
    ).lastInsertRowid)!;

    gg = persona('Gerente Regional', norte, 'Gina');
    gm = persona('Gerente de Marketing', norte, 'Mario');
    s1 = persona('Supervisor de Marketing', norte, 'Sara');
    s2 = persona('Supervisor de Marketing', norte, 'Saul');
    a1 = persona('Asesor de Marketing', norte, 'Ana');
    a2 = persona('Asesor de Marketing', norte, 'Alan');
    a3 = persona('Asesor de Marketing', norte, 'Abel');
    persona('Asesor de Marketing', norte, 'Lucia');
    ggSur = persona('Gerente Regional', sur, 'Gabriel');

    asignarJefe(admin, gm.id, gg.id);
    asignarJefe(admin, s1.id, gm.id);
    asignarJefe(admin, s2.id, gm.id);
    asignarJefe(admin, a1.id, s1.id);
    asignarJefe(admin, a2.id, s1.id);
    asignarJefe(admin, a3.id, s2.id);

    // Leads de Ana: 2 abiertos (1 sin contactar, 1 sin movimiento) y 1 inscrito (no cuenta).
    const viejo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const lead = (phone: string, etapa: string, contacto: string | null, actividad: string) => run(
      `INSERT INTO leads (sede_id, owner_user_id, session_id, phone_key, origen, etapa, ultimo_contacto_at, ultima_actividad_at, created_at, updated_at)
       VALUES (?, ?, 's', ?, 'linea', ?, ?, ?, ?, ?)`,
      norte, a1.id, phone, etapa, contacto, actividad, now, now,
    );
    lead('591700001', 'nuevo', null, now);
    lead('591700002', 'interesado', now, viejo);
    lead('591700003', 'inscrito', now, now);
  });

  it('dibuja a cada supervisor con SUS asesores debajo', () => {
    const html = renderOrganigramaPersonas(admin, norte, { base: `/unidades/1/sedes/${norte}`, editar: false });

    assert.match(html, /op-node op-root[\s\S]*Gina/, 'el Gerente Regional es la raíz');
    const deSara = entre(html, '>Sara<', '>Saul<');
    assert.ok(deSara.includes('>Ana<') && deSara.includes('>Alan<'), 'Ana y Alan cuelgan de Sara');
    assert.ok(!deSara.includes('>Abel<'), 'Abel no es de Sara');
    assert.ok(entre(html, '>Saul<', 'op-loose').includes('>Abel<'), 'Abel cuelga de Saul');
  });

  it('muestra quién no tiene jefe asignado', () => {
    const html = renderOrganigramaPersonas(admin, norte, { base: '/x', editar: false });
    assert.ok(entre(html, 'Sin jefe asignado', '</section>').includes('>Lucia<'));
  });

  it('suma las cifras de control del equipo hacia arriba', () => {
    const html = renderOrganigramaPersonas(admin, norte, { base: '/x', editar: false });
    const ana = entre(html, '>Ana<', '</li>');
    assert.match(ana, /<b>2<\/b> leads/);
    assert.match(ana, /<b>1<\/b> sin contactar/);
    assert.match(ana, /<b>1<\/b> sin movimiento/);
    assert.match(entre(html, '>Sara<', '>Ana<'), /<b>2<\/b> del equipo/, 'Sara ve el total de su equipo');
    assert.match(entre(html, '>Mario<', '>Sara<'), /<b>2<\/b> del equipo/, 'el gerente de marketing también');
  });

  it('en modo edición ofrece solo los jefes válidos', () => {
    const html = renderOrganigramaPersonas(admin, norte, { base: '/x', editar: true });
    const formAna = entre(html, `name="user_id" value="${a1.id}"`, '</form>');
    assert.ok(formAna.includes('>Sara<') && formAna.includes('>Saul<'));
    assert.ok(!formAna.includes('>Mario<'), 'un asesor no puede depender del gerente');
    assert.match(formAna, new RegExp(`value="${s1.id}" selected`));
    assert.ok(!html.includes(`name="user_id" value="${gg.id}"`), 'la raíz no se mueve');
  });

  it('quien no puede editar no ve controles aunque pida ?editar=1', () => {
    const html = renderOrganigramaPersonas(gm, norte, { base: '/x', editar: true });
    assert.ok(!html.includes('data-op-form'));
    assert.ok(!html.includes('Editar dependencias'));
    assert.ok(renderOrganigramaPersonas(gg, norte, { base: '/x', editar: false }).includes('Editar dependencias'));
  });

  it('guardar una dependencia desde el formulario', () => {
    const llamar = rutas();
    const r = llamar('POST', '/organigrama/jefe', gg, { body: { user_id: String(a2.id), jefe_id: String(s2.id), volver: '/organigrama?editar=1#organigrama' } });

    assert.equal(r.redirect, '/organigrama?editar=1#organigrama');
    assert.equal(get<{ jefe_id: number }>('SELECT jefe_id FROM sede_miembros WHERE user_id = ? AND principal = 1', a2.id)?.jefe_id, s2.id);
    assert.ok(r.cookies.some((c) => c.startsWith('flash=') || c.includes('flash')));
  });

  it('el gerente de otra sede no puede mover a nadie y no se redirige afuera', () => {
    const llamar = rutas();
    const r = llamar('POST', '/organigrama/jefe', ggSur, { body: { user_id: String(a2.id), jefe_id: String(s1.id), volver: 'https://malo.com' } });

    assert.equal(r.redirect, '/organigrama');
    assert.equal(get<{ jefe_id: number }>('SELECT jefe_id FROM sede_miembros WHERE user_id = ? AND principal = 1', a2.id)?.jefe_id, s2.id, 'no cambió');
  });

  it('/organigrama es solo para el Gerente Regional; el Super Admin va a Unidades', () => {
    const llamar = rutas();
    assert.equal(llamar('GET', '/organigrama', a1).status, 403);
    assert.equal(llamar('GET', '/organigrama', gm).status, 403);
    assert.equal(llamar('GET', '/organigrama', admin).redirect, '/unidades');
  });
});
