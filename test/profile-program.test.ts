import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addNote, listAllNotes, listPersonalNotes } from '../src/core/contacts.js';
import { listDirectory } from '../src/core/directory.js';
import { personTagsByKeys, setPersonName, setPersonProgram } from '../src/core/person.js';
import { run, get } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Nombre completo y programa registrados a mano: deben quedar disponibles para
 * todos los usuarios y usarse para agrupar/filtrar notas y agenda.
 */

function seedUser(name: string, username: string): number {
  const now = nowIso();
  return run(
    `INSERT INTO users (name, username, password, source, esam_autorizado, created_at, updated_at)
     VALUES (?, ?, 'x', 'local', 1, ?, ?)`,
    name,
    username,
    now,
    now,
  ).lastInsertRowid;
}

function seedContact(chatId: string, phone: string): number {
  const now = nowIso();
  return run(
    `INSERT INTO contacts (session_id, chat_id, phone, name, created_at, updated_at)
     VALUES ('s-programa', ?, ?, 'Persona sin datos', ?, ?)`,
    chatId,
    phone,
    now,
    now,
  ).lastInsertRowid;
}

describe('nombre y programa registrados a mano', () => {
  const userId = seedUser('Operadora Programa', 'operadora.programa');
  const phone = '59170000888';
  const contactId = seedContact(`${phone}@c.us`, phone);

  it('quedan visibles para todos y se incluyen en el directorio', () => {
    setPersonName(phone, 'Ana Pérez', userId);
    setPersonProgram(phone, 'Diplomado en Prueba', userId);

    const tags = personTagsByKeys([phone]).get(phone);
    assert.equal(tags?.full_name, 'Ana Pérez');
    assert.deepEqual(tags?.programas, ['Diplomado en Prueba']);

    // Escribir una variante no crea un programa duplicado: se usa el existente.
    setPersonProgram(phone, 'diplomado en prueba', userId);
    assert.equal(get<{ programa: string }>('SELECT programa FROM person_manual_programs WHERE phone_key = ?', phone)?.programa, 'Diplomado en Prueba');

    const dir = listDirectory({ q: 'Ana Pérez', programa: 'Diplomado en Prueba', sessionIds: null });
    const person = dir.people.find((p) => p.phone_key === phone);
    assert.equal(person?.full_name, 'Ana Pérez');
    assert.deepEqual(person?.programas, ['Diplomado en Prueba']);
  });

  it('el programa agrupa las notas de equipo y de Mi agenda', () => {
    const teamNote = addNote(contactId, userId, 'Nota de equipo con programa.', null, null, [], false);
    const personalNote = addNote(contactId, userId, 'Nota personal con programa.', null, null, [], false, {
      personal: true,
    });

    assert.equal(teamNote.programa, 'Diplomado en Prueba');
    assert.equal(personalNote.programa, 'Diplomado en Prueba');

    const team = listAllNotes({ sessionIds: null, status: 'all' }).find((n) => n.id === teamNote.id);
    const personal = listPersonalNotes(userId).find((n) => n.id === personalNote.id);
    assert.equal(team?.programa, 'Diplomado en Prueba');
    assert.equal(personal?.programa, 'Diplomado en Prueba');
  });
});
