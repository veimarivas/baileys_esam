import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { SessionManager } from '../src/baileys/manager.js';
import { invalidateTeam } from '../src/core/team.js';
import { run } from '../src/db/index.js';
import { createGatewayApp } from '../src/gateway/server.js';

/**
 * H0 del ESAM HUB (PLAN_HISTORIAL_BAILEYS.md): la API de SOLO LECTURA con la
 * que el CRM muestra el historial de una línea como lo muestra el panel.
 *
 * Lo que importa fijar: que cada consulta quede en SU línea (un chat de otra
 * línea no aparece ni se puede abrir), que las pestañas separen como el panel
 * (Números, Grupos, Equipo), y que el historial se pueda recorrer hacia atrás
 * por páginas sin saltear ni repetir mensajes.
 */
describe('gateway: API de lectura del historial', () => {
  const LINEA = 'linea-ana';
  const OTRA = 'linea-beto';
  const sesiones: Record<string, { id: string; phone: string | null; expected_phone: string | null }> = {
    [LINEA]: { id: LINEA, phone: '59170000100', expected_phone: null },
    [OTRA]: { id: OTRA, phone: '59170000200', expected_phone: null },
  };
  const manager = {
    list: () => [],
    byId: (id: string) => sesiones[id],
  } as unknown as SessionManager;

  let base = '';
  let server: ReturnType<ReturnType<typeof createGatewayApp>['listen']>;

  const iso = (min: number) => new Date(Date.UTC(2026, 10, 20, 12, min)).toISOString();

  // Como en la base real: cada chat individual tiene su ficha de contacto (con
  // la clave de su número), que es por donde se reconoce al equipo.
  function chat(session: string, chatId: string, nombre: string, min: number, unread = 0): void {
    let contactId: number | null = null;
    if (!chatId.endsWith('@g.us')) {
      const numero = chatId.replace(/@.*$/, '');
      contactId = Number(
        run(
          `INSERT INTO contacts (session_id, chat_id, name, phone, phone_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          session, chatId, nombre, numero, numero, iso(min), iso(min),
        ).lastInsertRowid,
      );
    }
    run(
      `INSERT INTO conversations (session_id, chat_id, contact_id, contact_name, unread_count, last_message_text, last_message_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session, chatId, contactId, nombre, unread, `último de ${nombre}`, iso(min), iso(min), iso(min),
    );
  }

  function mensaje(session: string, chatId: string, body: string, min: number, direction = 'in'): void {
    run(
      `INSERT INTO messages (session_id, chat_id, direction, content_type, body, wa_message_id, occurred_at, created_at)
       VALUES (?, ?, ?, 'text', ?, ?, ?, ?)`,
      session, chatId, direction, body, `WA-${session}-${chatId}-${min}`, iso(min), iso(min),
    );
  }

  before(async () => {
    // Un compañero del equipo (su número registrado lo hace «Equipo»).
    run(
      `INSERT INTO users (name, username, password, source, esam_autorizado, esam_numero, created_at, updated_at)
       VALUES ('Carla Equipo', 'carla', 'x', 'cronogramas', 1, '59170000300', ?, ?)`,
      iso(0), iso(0),
    );
    invalidateTeam();

    chat(LINEA, '59171111111@c.us', 'Juan Cliente', 50, 2);
    chat(LINEA, '59172222222@c.us', 'María Cliente', 40);
    chat(LINEA, '120363000000000001@g.us', 'Grupo Diplomado', 45, 5);
    chat(LINEA, '59170000300@c.us', 'Carla', 30, 1);
    chat(OTRA, '59173333333@c.us', 'Cliente de Beto', 55);
    for (let m = 1; m <= 25; m += 1) mensaje(LINEA, '59171111111@c.us', `mensaje ${m}`, m, m % 2 ? 'in' : 'out');
    mensaje(OTRA, '59173333333@c.us', 'secreto de otra línea', 1);

    const app = createGatewayApp(manager);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  const getJson = async <T>(path: string): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as T };
  };

  type Chats = { chats: Array<{ chat_id: string; team: unknown }>; next_cursor: string | null };

  it('las pestañas separan como el panel y no mezclan líneas', async () => {
    const numeros = await getJson<Chats>(`/api/sessions/${LINEA}/chats?kind=individual`);
    assert.deepEqual(numeros.body.chats.map((c) => c.chat_id), ['59171111111@c.us', '59172222222@c.us']);

    const grupos = await getJson<Chats>(`/api/sessions/${LINEA}/chats?kind=group`);
    assert.deepEqual(grupos.body.chats.map((c) => c.chat_id), ['120363000000000001@g.us']);

    const equipo = await getJson<Chats>(`/api/sessions/${LINEA}/chats?kind=team`);
    assert.deepEqual(equipo.body.chats.map((c) => c.chat_id), ['59170000300@c.us']);
    assert.ok(equipo.body.chats[0].team, 'el chat del compañero trae su marca de equipo');

    const todos = await getJson<Chats>(`/api/sessions/${LINEA}/chats`);
    assert.ok(!todos.body.chats.some((c) => c.chat_id === '59173333333@c.us'), 'un chat de otra línea no aparece');
  });

  it('resume chats y sin leer por pestaña', async () => {
    const { body } = await getJson<Record<string, { chats: number; unread: number }>>(`/api/sessions/${LINEA}/chats/summary`);
    assert.deepEqual(body, {
      individual: { chats: 2, unread: 1 },
      group: { chats: 1, unread: 1 },
      team: { chats: 1, unread: 1 },
    });
  });

  it('la lista se pagina con cursor sin repetir ni saltear', async () => {
    const p1 = await getJson<Chats>(`/api/sessions/${LINEA}/chats?limit=2`);
    assert.equal(p1.body.chats.length, 2);
    assert.ok(p1.body.next_cursor);
    const p2 = await getJson<Chats>(`/api/sessions/${LINEA}/chats?limit=2&cursor=${p1.body.next_cursor}`);
    const vistos = [...p1.body.chats, ...p2.body.chats].map((c) => c.chat_id);
    assert.equal(new Set(vistos).size, 4);
    assert.equal(p2.body.next_cursor, null);
  });

  it('el historial se recorre hacia atrás por páginas, en orden', async () => {
    type Page = { messages: Array<{ body: string; wa_message_id: string }>; has_more: boolean; next_before: string | null };
    const p1 = await getJson<Page>(`/api/sessions/${LINEA}/chats/59171111111@c.us/messages?limit=10`);
    assert.deepEqual(p1.body.messages.map((m) => m.body), Array.from({ length: 10 }, (_, i) => `mensaje ${16 + i}`));
    assert.equal(p1.body.has_more, true);

    const p2 = await getJson<Page>(`/api/sessions/${LINEA}/chats/59171111111@c.us/messages?limit=10&before=${p1.body.next_before}`);
    assert.equal(p2.body.messages[0].body, 'mensaje 6');
    assert.equal(p2.body.messages.at(-1)?.body, 'mensaje 15');

    const p3 = await getJson<Page>(`/api/sessions/${LINEA}/chats/59171111111@c.us/messages?limit=10&before=${p2.body.next_before}`);
    assert.equal(p3.body.messages.length, 5);
    assert.equal(p3.body.has_more, false);
    assert.equal(p3.body.next_before, null);
    // El id de WhatsApp viaja: con él se pide la media al endpoint de siempre.
    assert.ok(p3.body.messages[0].wa_message_id.startsWith('WA-'));
  });

  it('un chat de otra línea no se puede abrir ni leer', async () => {
    const abrir = await getJson(`/api/sessions/${LINEA}/chats/59173333333@c.us`);
    assert.equal(abrir.status, 404);
    const leer = await getJson(`/api/sessions/${LINEA}/chats/59173333333@c.us/messages`);
    assert.equal(leer.status, 404);
  });

  it('una línea que no existe responde 404', async () => {
    assert.equal((await getJson('/api/sessions/no-existe/chats')).status, 404);
    assert.equal((await getJson('/api/sessions/no-existe/team')).status, 404);
  });

  it('el equipo trae a los compañeros con su chat en esta línea, sin el dueño', async () => {
    type Team = { members: Array<{ name: string; phone: string; conversation: { chat_id: string } | null }> };
    const { body } = await getJson<Team>(`/api/sessions/${LINEA}/team`);
    const carla = body.members.find((m) => m.name === 'Carla Equipo');
    assert.ok(carla);
    assert.equal(carla.conversation?.chat_id, '59170000300@c.us');
  });

  it('el directorio de cronogramas lista personas aunque nunca escribieron', async () => {
    run(
      `INSERT INTO person_programs (phone_key, programa, programa_id, full_name, session_id, last_at)
       VALUES ('59174444444', 'Diplomado en Gestión Pública', 9, 'Pedro Registrado', ?, ?)`,
      LINEA, iso(10),
    );
    type Dir = { people: Array<{ full_name: string; chat: unknown }>; total: number; programas: string[] };
    const { body } = await getJson<Dir>(`/api/sessions/${LINEA}/directory?q=Pedro`);
    assert.equal(body.people[0].full_name, 'Pedro Registrado');
    assert.equal(body.people[0].chat, null);
    assert.ok(body.programas.includes('Diplomado en Gestión Pública'));
  });
});
