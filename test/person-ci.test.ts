import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getPersonCi, setPersonCi } from '../src/core/person.js';
import { addNote, listAllNotes, listPersonalNotes, noteDTO } from '../src/core/contacts.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/** El carnet de identidad es opcional y se guarda por persona/número. */

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
     VALUES ('s-ci', ?, ?, 'Persona con CI', ?, ?)`,
    chatId,
    phone,
    now,
    now,
  ).lastInsertRowid;
}

describe('carnet de identidad de la persona', () => {
  const userId = seedUser('Operadora CI', 'operadora.ci');
  const phone = '59170000555';
  const contactId = seedContact(`${phone}@c.us`, phone);

  it('se registra y se recupera por número', () => {
    setPersonCi(phone, ' 12345678 LP ', userId);
    assert.equal(getPersonCi(phone), '12345678 LP');
  });

  it('se puede corregir', () => {
    setPersonCi(phone, '87654321 SC', userId);
    assert.equal(getPersonCi(phone), '87654321 SC');
  });

  it('las notas de la persona lo muestran cuando corresponde', () => {
    setPersonCi(phone, '55555555 CB', userId);
    const team = addNote(contactId, userId, 'Nota de equipo con CI.', null, null, [], false);
    const personal = addNote(contactId, userId, 'Nota personal con CI.', null, null, [], false, { personal: true });
    assert.equal(noteDTO(team.id)?.person_ci, '55555555 CB');
    assert.equal(noteDTO(personal.id)?.person_ci, '55555555 CB');
    assert.equal(listAllNotes({ sessionIds: null, status: 'all' }).find((n) => n.id === team.id)?.person_ci, '55555555 CB');
    assert.equal(listPersonalNotes(userId).find((n) => n.id === personal.id)?.person_ci, '55555555 CB');
  });

  it('es opcional: se puede borrar', () => {
    setPersonCi(phone, '', userId);
    assert.equal(getPersonCi(phone), null);
    assert.equal(noteDTO(listAllNotes({ sessionIds: null, status: 'all' })[0].id)?.person_ci, null);
  });

  it('no inventa un carnet para números sin dato', () => {
    assert.equal(getPersonCi('59170000000'), null);
  });
});
