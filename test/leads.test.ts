import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createSede } from '../src/core/sedes.js';
import { createLocalUser, type UserRow } from '../src/auth/users.js';
import {
  claveDeChat,
  crearLeadDesdeLinea,
  getLead,
  moverEtapa,
  quitarProspecto,
  registrarActividadLead,
  sincronizarProspecto,
  type LeadRow,
} from '../src/core/leads.js';
import { all, get, migrate, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * PLAN_ORGANIGRAMA.md, L2: de dónde nacen los leads de /leads y cómo se
 * mantiene su actividad.
 */

let n = 0;
function persona(cargo: string, sedeId: number, nombre: string, numero?: string): UserRow {
  n += 1;
  return createLocalUser({
    name: nombre,
    username: `l.${nombre.toLowerCase()}`,
    email: `l.${nombre.toLowerCase()}@test.local`,
    ci: String(8500000 + n),
    password: 'secreto123',
    numero: numero ?? `5917300${String(n).padStart(4, '0')}`,
    sedeId,
    roles: [cargo],
  });
}

/** Línea de WhatsApp de la persona (la crea el alta). */
function lineaDe(u: UserRow): string {
  const fila = get<{ id: string }>('SELECT id FROM sessions WHERE owner_uid = ?', u.source_uid ?? String(u.id));
  assert.ok(fila, `la persona ${u.name} tiene línea`);
  return fila.id;
}

const leadsDe = (u: UserRow): LeadRow[] => all<LeadRow>('SELECT * FROM leads WHERE owner_user_id = ? ORDER BY id', u.id);
const eventos = (leadId: number) => all<{ tipo: string; de: string | null; a: string | null; user_id: number | null }>(
  'SELECT tipo, de, a, user_id FROM lead_eventos WHERE lead_id = ? ORDER BY id',
  leadId,
);

describe('leads de marketing', () => {
  let sede: number;
  let ana: UserRow;
  let luis: UserRow;
  let contador: UserRow;
  let lineaAna: string;

  before(() => {
    sede = createSede('Leads Centro');
    ana = persona('Asesor de Marketing', sede, 'Ana');
    luis = persona('Asesor de Marketing', sede, 'Luis', '59176666666');
    contador = persona('Contador General', sede, 'Carlos');
    lineaAna = lineaDe(ana);
  });

  it('nace un lead con el primer mensaje a la línea de marketing, una sola vez', () => {
    const t = '2026-11-20T10:00:00.000Z';
    const id = crearLeadDesdeLinea(lineaAna, '59170001111@s.whatsapp.net', t);
    assert.ok(id);
    assert.equal(crearLeadDesdeLinea(lineaAna, '59170001111@s.whatsapp.net', t), null, 'no se duplica');

    const lead = getLead(id!)!;
    assert.equal(lead.owner_user_id, ana.id);
    assert.equal(lead.sede_id, sede);
    assert.equal(lead.origen, 'linea');
    assert.equal(lead.etapa, 'nuevo');
    assert.equal(lead.phone_key, '59170001111');
    assert.equal(lead.ultima_actividad_at, t);
    assert.deepEqual(eventos(id!).map((e) => e.tipo), ['creado']);
  });

  it('no crea leads de grupos, de otras áreas ni de colegas', () => {
    assert.equal(crearLeadDesdeLinea(lineaAna, '120363000000000000@g.us'), null);
    assert.equal(crearLeadDesdeLinea(lineaDe(contador), '59170002222@s.whatsapp.net'), null, 'la línea de contabilidad no genera leads');
    assert.equal(crearLeadDesdeLinea(lineaAna, '59176666666@s.whatsapp.net'), null, 'Luis es del equipo');
    assert.equal(crearLeadDesdeLinea('linea-inexistente', '59170003333@s.whatsapp.net'), null);
  });

  it('identifica a quien escribe por LID cuando no se conoce su número', () => {
    assert.equal(claveDeChat('98765432101234@lid'), 'lid:98765432101234');
    assert.equal(claveDeChat('status@broadcast'), null);
  });

  it('los mensajes actualizan la actividad; los de la línea cuentan como contacto', () => {
    const lead = leadsDe(ana).find((l) => l.phone_key === '59170001111')!;

    registrarActividadLead(lineaAna, '59170001111@s.whatsapp.net', 'out', '2026-11-21T09:00:00.000Z');
    let actual = getLead(lead.id)!;
    assert.equal(actual.ultimo_contacto_at, '2026-11-21T09:00:00.000Z');
    assert.equal(actual.ultima_actividad_at, '2026-11-21T09:00:00.000Z');

    // Un mensaje viejo (historial) no hace retroceder las fechas.
    registrarActividadLead(lineaAna, '59170001111@s.whatsapp.net', 'out', '2026-11-01T09:00:00.000Z');
    registrarActividadLead(lineaAna, '59170001111@s.whatsapp.net', 'in', '2026-11-22T08:00:00.000Z');
    actual = getLead(lead.id)!;
    assert.equal(actual.ultimo_contacto_at, '2026-11-21T09:00:00.000Z');
    assert.equal(actual.ultima_actividad_at, '2026-11-22T08:00:00.000Z');

    // A quien no es lead, el mensaje no le crea nada.
    registrarActividadLead(lineaAna, '59170009999@s.whatsapp.net', 'in', nowIso());
    assert.ok(!leadsDe(ana).some((l) => l.phone_key === '59170009999'));
  });

  it('un prospecto nuevo de cronogramas es un lead con la etapa de su estado', () => {
    const id = sincronizarProspecto({
      ref: 'mp:1', ownerUserId: ana.id, sessionId: lineaAna, clave: '59170004444', contactId: null,
      programa: 'Maestría en Educación', estado: 'interesado', estadoCambio: true,
    });
    const lead = getLead(id)!;
    assert.equal(lead.origen, 'prospecto');
    assert.equal(lead.etapa, 'interesado');
    assert.equal(lead.programa, 'Maestría en Educación');
    assert.equal(lead.prospect_ref, 'mp:1');
  });

  it('si ya escribía por la línea, el prospecto se suma al mismo lead', () => {
    const antes = leadsDe(ana).length;
    const id = sincronizarProspecto({
      ref: 'mp:2', ownerUserId: ana.id, sessionId: lineaAna, clave: '59170001111', contactId: null,
      programa: 'Diplomado', estado: 'contactado', estadoCambio: true,
    });
    assert.equal(leadsDe(ana).length, antes, 'no se duplica');
    const lead = getLead(id)!;
    assert.equal(lead.origen, 'prospecto');
    assert.equal(lead.prospect_ref, 'mp:2');
    assert.equal(lead.etapa, 'contactado');
  });

  it('el asesor mueve su lead; lo movido se respeta si el estado en cronogramas no cambió', () => {
    const lead = leadsDe(ana).find((l) => l.prospect_ref === 'mp:1')!;
    moverEtapa(ana.id, lead.id, 'inscrito');

    sincronizarProspecto({
      ref: 'mp:1', ownerUserId: ana.id, sessionId: lineaAna, clave: '59170004444', contactId: null,
      programa: 'Maestría en Educación', estado: 'interesado', estadoCambio: false,
    });
    assert.equal(getLead(lead.id)!.etapa, 'inscrito');

    sincronizarProspecto({
      ref: 'mp:1', ownerUserId: ana.id, sessionId: lineaAna, clave: '59170004444', contactId: null,
      programa: 'Maestría en Educación', estado: 'no_interesado', estadoCambio: true,
    });
    assert.equal(getLead(lead.id)!.etapa, 'no_interesado');

    const ev = eventos(lead.id).filter((e) => e.tipo === 'etapa');
    assert.deepEqual(ev.map((e) => [e.de, e.a, e.user_id]), [['interesado', 'inscrito', ana.id], ['inscrito', 'no_interesado', null]]);
  });

  it('solo el dueño mueve su lead, y solo a etapas válidas', () => {
    const lead = leadsDe(ana)[0];
    assert.throws(() => moverEtapa(luis.id, lead.id, 'contactado'), /no encontrado/);
    assert.throws(() => moverEtapa(ana.id, lead.id, 'perdido'), /no válida/);
  });

  it('al borrar el prospecto en cronogramas: se va si nadie le escribió; si hubo charla, queda de la línea', () => {
    sincronizarProspecto({
      ref: 'mp:3', ownerUserId: ana.id, sessionId: lineaAna, clave: '59170005555', contactId: null,
      programa: null, estado: 'nuevo', estadoCambio: true,
    });
    quitarProspecto('mp:3');
    assert.ok(!leadsDe(ana).some((l) => l.phone_key === '59170005555'));

    quitarProspecto('mp:2'); // 59170001111: Ana ya le escribió
    const lead = leadsDe(ana).find((l) => l.phone_key === '59170001111')!;
    assert.equal(lead.origen, 'linea');
    assert.equal(lead.prospect_ref, null);
  });

  it('los prospectos que ya existían pasan a leads una sola vez, con su actividad', () => {
    const now = nowIso();
    const contacto = run(
      "INSERT INTO contacts (session_id, chat_id, phone, created_at, updated_at) VALUES (?, '59170007777@c.us', '59170007777', ?, ?)",
      lineaAna, now, now,
    ).lastInsertRowid;
    run(
      `INSERT INTO contact_notes (contact_id, user_id, note_text, prospect_ref, prospect_meta, created_at)
       VALUES (?, ?, 'Prospecto', 'mp:viejo', '{"estado":"contactado","programa":"MBA"}', ?)`,
      contacto, ana.id, now,
    );
    run(
      `INSERT INTO messages (session_id, chat_id, direction, content_type, body, occurred_at, created_at)
       VALUES (?, '59170007777@c.us', 'out', 'text', 'Hola', '2026-11-10T10:00:00.000Z', ?)`,
      lineaAna, now,
    );
    run("DELETE FROM configs WHERE key = 'leads_prospectos_v1'");

    migrate();
    migrate(); // idempotente

    const migrados = leadsDe(ana).filter((l) => l.prospect_ref === 'mp:viejo');
    assert.equal(migrados.length, 1);
    assert.equal(migrados[0].etapa, 'contactado');
    assert.equal(migrados[0].programa, 'MBA');
    assert.equal(migrados[0].ultimo_contacto_at, '2026-11-10T10:00:00.000Z');
  });
});
