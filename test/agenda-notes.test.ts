import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addNote,
  listAllNotes,
  listNotes,
  listPersonalNotes,
  noteCountsFor,
  noteDTO,
  noteStats,
  noteAssigneeIds,
  updateNote,
} from '../src/core/contacts.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Las notas de «Mi agenda» son privadas: no se mezclan con las notas de equipo,
 * no se derivan y solo las ve su autor (salvo un admin en el panel).
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
     VALUES ('s-agenda', ?, ?, 'Persona agenda', ?, ?)`,
    chatId,
    phone,
    now,
    now,
  ).lastInsertRowid;
}

describe('notas personales de Mi agenda', () => {
  const autor = seedUser('Autora Agenda', 'autora.agenda');
  const otro = seedUser('Otro Usuario', 'otro.agenda');
  const contactId = seedContact('59170000999@c.us', '59170000999');

  const nota = addNote(contactId, autor, 'Llamar el viernes y confirmar documentación.', null, null, [], false, {
    personal: true,
    pipelineStage: 'doing',
  });

  it('se crea privada, sin responsable ni derivación', () => {
    assert.equal(nota.personal, 1);
    assert.equal(nota.assigned_to, null);
    assert.deepEqual(noteAssigneeIds(nota.id), []);
    assert.equal(nota.pipeline_stage, 'doing');
  });

  it('aparece solo en la agenda de su autor', () => {
    assert.deepEqual(listPersonalNotes(autor).map((n) => n.id), [nota.id]);
    assert.deepEqual(listPersonalNotes(otro), []);
  });

  it('no se mezcla en Notas y tareas del equipo', () => {
    assert.equal(listAllNotes({ sessionIds: null, status: 'all' }).some((n) => n.id === nota.id), false);
    assert.equal(noteStats({ sessionIds: null }).all >= 0, true);
  });

  it('en la ficha del contacto solo la ve su autor', () => {
    assert.equal(listNotes(contactId, 200, autor).some((n) => n.id === nota.id), true);
    assert.equal(listNotes(contactId, 200, otro).some((n) => n.id === nota.id), false);
    assert.equal(noteCountsFor([contactId], autor).get(contactId)?.open, 1);
    assert.equal(noteCountsFor([contactId], otro).get(contactId)?.open ?? 0, 0);
  });

  it('al convertirla en nota de equipo deja de ser privada y puede derivarse', () => {
    updateNote(nota.id, { personal: false }, autor);
    assert.equal(noteDTO(nota.id)?.personal, 0);
    assert.equal(listAllNotes({ sessionIds: null, status: 'all' }).some((n) => n.id === nota.id), true);
    assert.deepEqual(listPersonalNotes(autor), []);
  });

  it('al volver a convertirla en personal se limpia cualquier derivación', () => {
    updateNote(nota.id, { assignedToIds: [otro] }, autor);
    assert.deepEqual(noteAssigneeIds(nota.id), [otro]);
    updateNote(nota.id, { personal: true }, autor);
    assert.equal(noteDTO(nota.id)?.personal, 1);
    assert.deepEqual(noteAssigneeIds(nota.id), []);
  });
});
