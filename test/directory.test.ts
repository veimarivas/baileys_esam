import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { directoryPrograms, listDirectory } from '../src/core/directory.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * El directorio es la única forma de encontrar a alguien que fue cargado por
 * cronogramas pero nunca escribió: no hay conversación de la cual sacar el
 * nombre. Por eso importa que busque por nombre, número y programa, y que el
 * nombre manual más reciente gane al de cronogramas.
 */

function seedConversation(session: string, chat: string, at: string, phone: string): void {
  run(
    `INSERT INTO conversations (session_id, chat_id, contact_name, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    session,
    chat,
    null,
    at,
    at,
    at,
  );
  run(
    `INSERT INTO contacts (session_id, chat_id, phone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    session,
    chat,
    phone,
    at,
    at,
  );
}

describe('listDirectory', () => {
  run(
    `INSERT INTO person_programs (phone_key, programa, programa_id, full_name, session_id, last_at)
     VALUES ('59171110001', 'DIPLOMADO EN CONTABILIDAD MINERA', 1, 'José Pérez', 's-a', '2026-01-10T10:00:00.000Z')`,
  );
  run(
    `INSERT INTO person_programs (phone_key, programa, programa_id, full_name, session_id, last_at)
     VALUES ('59171110001', 'Maestría en Educación', 2, 'José Pérez', 's-a', '2026-02-10T10:00:00.000Z')`,
  );
  run(
    `INSERT INTO person_programs (phone_key, programa, programa_id, full_name, session_id, last_at)
     VALUES ('59171110002', 'Diplomado en Educación Superior', 3, 'Ana Gómez', 's-b', '2026-01-05T10:00:00.000Z')`,
  );

  it('lista personas registradas aunque no tengan conversación', () => {
    const result = listDirectory();
    const person = result.people.find((p) => p.phone_key === '59171110001');
    assert.ok(person);
    assert.equal(person.full_name, 'José Pérez');
    assert.equal(person.name_source, 'cronogramas');
    assert.equal(person.chat, null);
    assert.deepEqual(person.programas.slice().sort(), [
      'DIPLOMADO EN CONTABILIDAD MINERA',
      'Maestría en Educación',
    ]);
    assert.equal(result.total, 2);
  });

  it('busca por nombre sin distinguir tildes ni mayúsculas', () => {
    const result = listDirectory({ q: 'jose perez' });
    assert.deepEqual(result.people.map((p) => p.phone_key), ['59171110001']);
  });

  it('busca por número aunque se escriba con espacios', () => {
    const result = listDirectory({ q: '711 100 02' });
    assert.deepEqual(result.people.map((p) => p.phone_key), ['59171110002']);
  });

  it('busca por programa', () => {
    const result = listDirectory({ q: 'contabilidad' });
    assert.deepEqual(result.people.map((p) => p.phone_key), ['59171110001']);
  });

  it('filtra por programa exacto y devuelve las opciones', () => {
    const result = listDirectory({ programa: 'Diplomado en Educación Superior' });
    assert.deepEqual(result.people.map((p) => p.phone_key), ['59171110002']);
    assert.ok(result.programas.includes('Maestría en Educación'));
    assert.ok(directoryPrograms().includes('DIPLOMADO EN CONTABILIDAD MINERA'));
  });

  it('trata % y _ de la búsqueda como texto, no comodines', () => {
    assert.equal(listDirectory({ q: '%' }).total, 0);
    assert.equal(listDirectory({ q: '_' }).total, 0);
  });

  it('adjunta la conversación más reciente dentro de las líneas del usuario', () => {
    seedConversation('s-a', '59171110002@c.us', '2026-03-01T10:00:00.000Z', '59171110002');
    seedConversation('s-b', '59171110002@c.us', '2026-04-01T10:00:00.000Z', '59171110002');
    const mine = listDirectory({ q: '59171110002', sessionIds: ['s-b'] });
    assert.equal(mine.people[0]?.chat?.session_id, 's-b');
    const none = listDirectory({ q: '59171110002', sessionIds: [] });
    assert.equal(none.people[0]?.chat, null);
    assert.equal(none.people.length, 1, 'sin líneas el directorio sigue visible');
  });

  it('prefiere el nombre manual cuando es más reciente que el de cronogramas', () => {
    run(
      `INSERT INTO person_names (phone_key, full_name, updated_by, updated_at)
       VALUES ('59171110001', 'José P. (manual)', NULL, '2026-05-01T10:00:00.000Z')`,
    );
    const person = listDirectory({ q: '59171110001' }).people[0];
    assert.equal(person.full_name, 'José P. (manual)');
    assert.equal(person.name_source, 'manual');
  });

  it('vuelve al nombre de cronogramas si el manual es más viejo', () => {
    run(
      `INSERT INTO person_names (phone_key, full_name, updated_by, updated_at)
       VALUES ('59171110002', 'Ana vieja', NULL, '2025-01-01T10:00:00.000Z')`,
    );
    const person = listDirectory({ q: '59171110002' }).people[0];
    assert.equal(person.full_name, 'Ana Gómez');
    assert.equal(person.name_source, 'cronogramas');
  });

  it('pagina y ordena por actividad más reciente', () => {
    const first = listDirectory({ limit: 1 });
    assert.equal(first.total, 2);
    assert.equal(first.people.length, 1);
    assert.equal(first.people[0].phone_key, '59171110001');
    const second = listDirectory({ limit: 1, offset: 1 });
    assert.equal(second.people[0]?.phone_key, '59171110002');
  });

  it('no adjunta conversaciones de difusión ni de canales', () => {
    const at = nowIso();
    seedConversation('s-a', '59171110003@broadcast', at, '59171110003');
    run(
      `INSERT INTO person_programs (phone_key, programa, programa_id, full_name, session_id, last_at)
       VALUES ('59171110003', 'Programa X', NULL, 'Luis Rojas', 's-a', ?)`,
      at,
    );
    const person = listDirectory({ q: '59171110003' }).people[0];
    assert.equal(person.chat, null);
  });
});
