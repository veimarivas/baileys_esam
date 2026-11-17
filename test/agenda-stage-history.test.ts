import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBoard, listBoards, moveNote } from '../src/core/agenda.js';
import { addNote, listNoteHistory } from '../src/core/contacts.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Cada cambio de columna en Mi agenda exige un detalle y deja una entrada en
 * el historial con la columna de origen, la de destino y la fecha.
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
     VALUES ('s-stage-history', ?, ?, 'Persona historial', ?, ?)`,
    chatId,
    phone,
    now,
    now,
  ).lastInsertRowid;
}

describe('historial de columnas de Mi agenda', () => {
  const autor = seedUser('Autora Historial', 'autora.historial');
  const contactId = seedContact('59170000777@c.us', '59170000777');
  const boardId = createBoard(autor, 'Solicitud de título', ['Solicitaron', 'En revisión', 'Entregado']);
  const stages = listBoards(autor).find((b) => b.id === boardId)!.stages;
  const [solicitaron, revision, entregado] = stages;
  const note = addNote(contactId, autor, 'Presentó la documentación inicial.', null, null, [], false, {
    personal: true,
    agendaBoardId: boardId,
    agendaStageId: solicitaron.id,
  });

  it('registra la columna inicial al crear la nota', () => {
    const history = listNoteHistory(note.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].action, 'stage');
    assert.equal(history[0].created_at, note.created_at);
    const detail = JSON.parse(history[0].detail!);
    assert.equal(detail.from, null);
    assert.equal(detail.to, 'Solicitaron');
    assert.equal(detail.toBoard, 'Solicitud de título');
    assert.equal(detail.comment, 'Nota creada en esta columna');
  });

  it('exige un detalle para cambiar de columna', () => {
    assert.throws(
      () => moveNote(autor, note.id, boardId, revision.id),
      /detalle del seguimiento/i,
    );
  });

  it('guarda el detalle y las columnas de origen y destino', () => {
    moveNote(autor, note.id, boardId, revision.id, 'Se recibió el comprobante y pasa a revisión.');
    const history = listNoteHistory(note.id);
    assert.equal(history.length, 2);
    const detail = JSON.parse(history[1].detail!);
    assert.equal(detail.from, 'Solicitaron');
    assert.equal(detail.to, 'En revisión');
    assert.equal(detail.fromBoard, 'Solicitud de título');
    assert.equal(detail.toBoard, 'Solicitud de título');
    assert.match(detail.comment, /comprobante/);
    assert.ok(history[1].created_at);
  });

  it('no duplica historial si la columna no cambió', () => {
    const before = listNoteHistory(note.id).length;
    moveNote(autor, note.id, boardId, revision.id);
    assert.equal(listNoteHistory(note.id).length, before);
  });

  it('también registra los cambios de sub-agenda', () => {
    const other = createBoard(autor, 'Otra sub-agenda', ['Inicio', 'Fin']);
    const otherStages = listBoards(autor).find((b) => b.id === other)!.stages;
    moveNote(autor, note.id, other, otherStages[0].id, 'Se reabre en otra sub-agenda.');
    const entries = listNoteHistory(note.id);
    const detail = JSON.parse(entries[entries.length - 1].detail!);
    assert.equal(detail.fromBoard, 'Solicitud de título');
    assert.equal(detail.toBoard, 'Otra sub-agenda');
    assert.equal(detail.from, 'En revisión');
    assert.equal(detail.to, 'Inicio');
  });

  it('mover a la columna final conserva el detalle aunque la nota quede resuelta', () => {
    assert.ok(entregado.is_done);
    moveNote(autor, note.id, boardId, entregado.id, 'Se entregó el título.');
    const entries = listNoteHistory(note.id);
    const detail = JSON.parse(entries[entries.length - 1].detail!);
    assert.equal(detail.to, 'Entregado');
    assert.match(detail.comment, /título/);
  });
});
