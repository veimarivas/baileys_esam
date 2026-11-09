import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addNote,
  listAllNotes,
  markAssignmentSeen,
  noteAssigneeIds,
  noteAssignees,
  noteDTO,
  noteStats,
  noteVisibleIn,
  setNoteAssignees,
  updateNote,
} from '../src/core/contacts.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Derivación múltiple de notas: la tarea puede quedar para varias personas a la
 * vez, agrupadas por área en la ficha. `assigned_to` conserva al responsable
 * principal y la lista completa vive en `contact_note_assignees`.
 */

function seedUser(name: string, username: string, area: string): number {
  const now = nowIso();
  const created = run(
    `INSERT INTO users (name, username, password, source, esam_autorizado, esam_area, created_at, updated_at)
     VALUES (?, ?, 'x', 'local', 1, ?, ?, ?)`,
    name,
    username,
    area,
    now,
    now,
  );
  return created.lastInsertRowid;
}

function seedContact(chatId: string, phone: string): number {
  const now = nowIso();
  return run(
    `INSERT INTO contacts (session_id, chat_id, phone, name, created_at, updated_at)
     VALUES ('s-deriv', ?, ?, ?, ?, ?)`,
    chatId,
    phone,
    'Persona de prueba',
    now,
    now,
  ).lastInsertRowid;
}

describe('derivación múltiple de notas', () => {
  const marina = seedUser('Marina Quispe', 'marina', 'marketing');
  const jorge = seedUser('Jorge Rojas', 'jorge', 'academico');
  const lucia = seedUser('Lucía Paz', 'lucia', 'contabilidad');
  const contactId = seedContact('59170000123@c.us', '59170000123');

  it('crea la nota con varias personas y la primera queda como principal', () => {
    const note = addNote(contactId, marina, 'Enviar el cronograma y confirmar el pago.', null, null, [], false, {
      assigneeIds: [jorge, lucia],
    });
    assert.equal(note.assigned_to, jorge);
    assert.deepEqual(noteAssigneeIds(note.id), [jorge, lucia]);
    const dto = noteDTO(note.id);
    assert.ok(dto);
    assert.deepEqual(dto.assignees.map((a) => a.id), [jorge, lucia]);
    assert.equal(dto.assignees[0].primary, true);
    assert.equal(dto.assignees[0].area_label, 'Académico');
    assert.equal(dto.assignees[1].area_label, 'Contabilidad');
  });

  it('las personas adicionales ven la nota aunque no tengan la línea', () => {
    const note = listAllNotes({ status: 'derived', viewerId: lucia, sessionIds: [] })[0];
    assert.ok(note);
    assert.equal(note.id, listAllNotes({ status: 'derived', viewerId: jorge, sessionIds: [] })[0]?.id);

    const id = note.id;
    assert.equal(noteVisibleIn(id, [], lucia), true);
    assert.equal(noteVisibleIn(id, [], marina), false);
    assert.equal(noteVisibleIn(id, [], jorge), true);

    // El alcance por sesión y el filtro «lo mío» también contemplan a las
    // personas adicionales (validan que los parámetros SQL sigan en orden).
    assert.ok(listAllNotes({ sessionIds: ['s-deriv'], viewerId: lucia }).some((n) => n.id === id));
    assert.ok(listAllNotes({ sessionIds: ['otra-linea'], viewerId: lucia }).some((n) => n.id === id));
    assert.ok(listAllNotes({ sessionIds: null, ownerId: lucia }).some((n) => n.id === id));
    assert.ok(listAllNotes({ sessionIds: null, ownerId: marina }).some((n) => n.id === id));
  });

  it('cuenta las derivadas para cada responsable', () => {
    assert.equal(noteStats({ sessionIds: [], viewerId: lucia }).derived, 1);
    assert.equal(noteStats({ sessionIds: [], viewerId: marina }).derived, 0);
    assert.equal(noteStats({ sessionIds: [], assignedTo: lucia }).derived, 1);
    assert.equal(noteStats({ sessionIds: [], assignedTo: marina }).derived, 0);
  });

  it('reemplaza la derivación y reinicia la vista/confirmación del nuevo grupo', () => {
    const note = listAllNotes({ status: 'derived', viewerId: lucia, sessionIds: [] })[0];
    assert.ok(note);
    updateNote(note.id, { assignedToIds: [marina, jorge] }, jorge);
    assert.deepEqual(noteAssigneeIds(note.id), [marina, jorge]);
    const updated = noteDTO(note.id);
    assert.equal(updated?.assigned_to, marina);
    assert.equal(updated?.assignees?.[0].primary, true);
    assert.equal(updated?.seen_at, null);

    assert.equal(markAssignmentSeen(note.id, jorge), true);
    assert.equal(noteDTO(note.id)?.seen_at !== null, true);
    assert.equal(markAssignmentSeen(note.id, jorge), false, 'solo registra la primera vista');
  });

  it('permite quitar todas las personas derivadas', () => {
    const note = listAllNotes({ status: 'derived', viewerId: marina, sessionIds: [] })[0];
    assert.ok(note);
    assert.equal(setNoteAssignees(note.id, [], marina), true);
    assert.deepEqual(noteAssigneeIds(note.id), []);
    assert.equal(noteDTO(note.id)?.assigned_to, null);
    assert.equal(noteStats({ sessionIds: [], viewerId: marina }).derived, 0);
  });

  it('mantiene el modo anterior de un solo responsable', () => {
    const note = addNote(contactId, marina, 'Nota con un responsable.', null, null, [], false, { assignedTo: lucia });
    assert.equal(note.assigned_to, lucia);
    assert.deepEqual(noteAssigneeIds(note.id), [lucia]);
    assert.deepEqual(noteDTO(note.id)?.assignees.map((a) => a.id), [lucia]);
  });

  it('devuelve las personas disponibles con su área visible', () => {
    const people = noteAssignees();
    const areas = people.map((p) => p.area_label);
    assert.ok(areas.includes('Marketing'));
    assert.ok(areas.includes('Académico'));
    assert.ok(areas.includes('Contabilidad'));
    assert.ok(people.every((p) => !!p.area_label));
  });
});
