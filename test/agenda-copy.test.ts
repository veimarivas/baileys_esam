import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBoard, copyTeamNoteToAgenda, ensureDefaultBoard } from '../src/core/agenda.js';
import { addNote, deleteNote, getNote, listPersonalNotes, noteDTO } from '../src/core/contacts.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Copiar una nota asignada de /notes a Mi agenda debe crear una nota privada
 * vinculada a la original, sin duplicarla y respetando sub-agenda y columna.
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
     VALUES ('s-copy', ?, ?, 'Persona copia', ?, ?)`,
    chatId,
    phone,
    now,
    now,
  ).lastInsertRowid;
}

describe('copiar notas asignadas a Mi agenda', () => {
  const user = seedUser('Usuaria Copia', 'usuaria.copia');
  const other = seedUser('Otra Copia', 'otra.copia');
  const contactId = seedContact('59170000777@c.us', '59170000777');
  const now = nowIso();
  const tag = run(
    'INSERT INTO note_tags (name, color, created_at, updated_at) VALUES (?, ?, ?, ?)',
    'Titulación',
    '#045474',
    now,
    now,
  ).lastInsertRowid;
  const source = addNote(contactId, other, 'Solicitud asignada para seguimiento.', null, now.slice(0, 10), [tag], true, {
    assignedTo: user,
    dueTime: '11:30',
  });
  ensureDefaultBoard(user);
  const board = createBoard(user, 'Solicitud de titulaciones', ['Solicitaron', 'Entregado']);

  it('crea una copia privada con el vínculo a la nota original', () => {
    const result = copyTeamNoteToAgenda(user, source.id, board, null);
    assert.equal(result.created, true);
    assert.equal(result.note.personal, 1);
    assert.equal(result.note.user_id, user);
    assert.equal(result.note.agenda_source_note_id, source.id);
    assert.equal(result.note.agenda_board_id, board);
    assert.equal(result.note.note_text, source.note_text);
    assert.equal(result.note.pinned, 1);
    assert.equal(result.note.due_time, '11:30');
    assert.ok(result.note.tags.some((t) => t.name === 'Titulación'));
    // La nota original sigue siendo de equipo.
    assert.equal(getNote(source.id)?.personal, 0);
    assert.equal(getNote(source.id)?.assigned_to, user);
  });

  it('no duplica: si ya existe, solo la mueve de sub-agenda/columna', () => {
    const first = copyTeamNoteToAgenda(user, source.id, board, null);
    const stageId = listPersonalNotes(user, { boardId: board })[0]?.agenda_stage_id;
    assert.ok(stageId);
    const again = copyTeamNoteToAgenda(user, source.id, board, stageId);
    assert.equal(again.created, false);
    assert.equal(again.note.id, first.note.id);
    assert.equal(listPersonalNotes(user, { boardId: board }).length, 1);
  });

  it('restaura la copia si estaba en la papelera', () => {
    const copy = listPersonalNotes(user, { boardId: board })[0];
    assert.ok(copy);
    deleteNote(copy.id, user);
    assert.equal(listPersonalNotes(user, { boardId: board }).length, 0);
    const restored = copyTeamNoteToAgenda(user, source.id, board, null);
    assert.equal(restored.created, false);
    assert.equal(noteDTO(restored.note.id)?.deleted_at, null);
    assert.equal(listPersonalNotes(user, { boardId: board }).length, 1);
  });
});
