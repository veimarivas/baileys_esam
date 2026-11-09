import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createBoard,
  deleteBoard,
  ensureDefaultBoard,
  listBoards,
  moveNote,
  resolvePlacement,
  updateBoard,
} from '../src/core/agenda.js';
import { addNote, listPersonalNotes, noteDTO } from '../src/core/contacts.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Sub-agendas personales: cada tablero tiene sus columnas y las notas se mueven
 * entre columnas/tableros sin perder el contacto ni la privacidad.
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
     VALUES ('s-boards', ?, ?, 'Persona boards', ?, ?)`,
    chatId,
    phone,
    now,
    now,
  ).lastInsertRowid;
}

describe('sub-agendas y columnas pipeline', () => {
  const autor = seedUser('Autora Boards', 'autora.boards');
  const otro = seedUser('Otro Boards', 'otro.boards');
  const contactId = seedContact('59170000888@c.us', '59170000888');

  const defaultBoard = ensureDefaultBoard(autor);
  const titulaciones = createBoard(autor, 'Solicitud de titulaciones', [
    'Solicitaron',
    'Exigen título retrasado',
    'En revisión',
    'Entregado',
  ]);
  const boards = listBoards(autor);
  const board = boards.find((b) => b.id === titulaciones);
  const otherBoard = boards.find((b) => b.id === defaultBoard);
  const [solicitaron, retrasado, revision, entregado] = board?.stages ?? [];

  const nota = addNote(contactId, autor, 'Solicitud de título con documentación pendiente.', null, null, [], false, {
    personal: true,
    agendaBoardId: titulaciones,
    agendaStageId: retrasado.id,
  });

  it('crea la sub-agenda con sus columnas y la última como resuelta', () => {
    assert.ok(board);
    assert.deepEqual(board?.stages.map((s) => s.name), ['Solicitaron', 'Exigen título retrasado', 'En revisión', 'Entregado']);
    assert.equal(entregado.is_done, 1);
    assert.equal(solicitaron.is_done, 0);
    assert.equal(otherBoard?.stages.length, 4);
    assert.throws(() => createBoard(autor, 'solicitud de titulaciones', ['Otra']), /Ya existe/);
  });

  it('ubica la nota en la columna elegida y la cuenta en el tablero', () => {
    const enTablero = listPersonalNotes(autor, { boardId: titulaciones });
    assert.deepEqual(enTablero.map((n) => n.id), [nota.id]);
    assert.equal(enTablero[0].agenda_board_id, titulaciones);
    assert.equal(enTablero[0].agenda_stage_id, retrasado.id);
    assert.equal(listBoards(autor).find((b) => b.id === titulaciones)?.notes, 1);
  });

  it('mover a la columna final marca el proceso como resuelto', () => {
    moveNote(autor, nota.id, titulaciones, entregado.id);
    assert.equal(noteDTO(nota.id)?.agenda_stage_id, entregado.id);
    assert.ok(noteDTO(nota.id)?.done_at);
    moveNote(autor, nota.id, titulaciones, revision.id);
    assert.equal(noteDTO(nota.id)?.agenda_stage_id, revision.id);
    assert.equal(noteDTO(nota.id)?.done_at, null);
  });

  it('valida que el tablero y la columna sean del usuario', () => {
    const ajeno = createBoard(otro, 'Tablero ajeno', ['Uno', 'Dos']);
    assert.throws(() => resolvePlacement(autor, ajeno, null), /no encontrada/);
    assert.throws(() => moveNote(otro, nota.id, ajeno, null), /no encontrada/);
  });

  it('edita columnas y reubica las notas de una columna eliminada', () => {
    moveNote(autor, nota.id, titulaciones, revision.id);
    updateBoard(autor, titulaciones, {
      name: 'Titulaciones 2026',
      stages: [
        { id: solicitaron.id, name: 'Solicitaron' },
        { id: retrasado.id, name: 'Título retrasado' },
        { id: entregado.id, name: 'Entregado' },
      ],
    });
    const after = listBoards(autor).find((b) => b.id === titulaciones);
    assert.equal(after?.name, 'Titulaciones 2026');
    assert.deepEqual(after?.stages.map((s) => s.name), ['Solicitaron', 'Título retrasado', 'Entregado']);
    // La columna «En revisión» se eliminó: la nota pasa a la primera.
    assert.equal(noteDTO(nota.id)?.agenda_stage_id, solicitaron.id);
  });

  it('elimina una sub-agenda y mueve sus notas a otra', () => {
    deleteBoard(autor, titulaciones);
    const after = listBoards(autor);
    assert.equal(after.some((b) => b.id === titulaciones), false);
    assert.equal(noteDTO(nota.id)?.agenda_board_id, defaultBoard);
    assert.equal(noteDTO(nota.id)?.agenda_stage_id, otherBoard?.stages[0].id);
  });
});
