import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createBoard,
  ensureDefaultBoard,
  listBoardNotes,
  listBoardShares,
  listBoards,
  moveNote,
  permissionFor,
  removeBoardShare,
  resolvePlacement,
  setBoardShare,
} from '../src/core/agenda.js';
import { addNote, noteDTO } from '../src/core/contacts.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Sub-agendas compartidas: el dueño define permisos por usuario o por área.
 * «view» solo permite leer; «edit» permite agregar y mover notas.
 */

function seedUser(name: string, username: string, roles: string[] = []): number {
  const now = nowIso();
  return run(
    `INSERT INTO users (name, username, password, source, esam_autorizado, esam_roles, created_at, updated_at)
     VALUES (?, ?, 'x', 'cronogramas', 1, ?, ?, ?)`,
    name,
    username,
    roles.length ? JSON.stringify(roles) : null,
    now,
    now,
  ).lastInsertRowid;
}

function seedContact(chatId: string, phone: string): number {
  const now = nowIso();
  return run(
    `INSERT INTO contacts (session_id, chat_id, phone, name, created_at, updated_at)
     VALUES ('s-shares', ?, ?, 'Persona compartida', ?, ?)`,
    chatId,
    phone,
    now,
    now,
  ).lastInsertRowid;
}

describe('sub-agendas compartidas', () => {
  const dueno = seedUser('Dueña Agenda', 'duena.agenda');
  const lector = seedUser('Lector Agenda', 'lector.agenda');
  const editor = seedUser('Editor Agenda', 'editor.agenda');
  const asesor = seedUser('Asesor Marketing', 'asesor.marketing', ['Asesor de Marketing']);
  const contactId = seedContact('59170000999@c.us', '59170000999');

  ensureDefaultBoard(dueno);
  const boardId = createBoard(dueno, 'Titulaciones compartidas', ['Solicitaron', 'En revisión', 'Entregado']);
  const board = listBoards(dueno).find((b) => b.id === boardId)!;
  const [solicitaron, revision] = board.stages;
  const nota = addNote(contactId, dueno, 'Documento pendiente de revisión.', null, null, [], false, {
    personal: true,
    agendaBoardId: boardId,
    agendaStageId: solicitaron.id,
  });

  it('no muestra el tablero hasta otorgar un permiso', () => {
    assert.equal(permissionFor(lector, boardId), null);
    assert.equal(listBoards(lector).some((b) => b.id === boardId), false);
    assert.throws(() => listBoardNotes(lector, boardId), /no encontrada/);
  });

  it('comparte solo lectura por usuario y muestra el dueño', () => {
    setBoardShare(dueno, boardId, { principal_type: 'user', principal_id: lector, permission: 'view' });
    assert.equal(permissionFor(lector, boardId), 'view');
    const shared = listBoards(lector).find((b) => b.id === boardId);
    assert.ok(shared);
    assert.equal(shared?.permission, 'view');
    assert.equal(shared?.can_edit, false);
    assert.equal(shared?.shared, true);
    assert.equal(shared?.owner_name, 'Dueña Agenda');
    assert.deepEqual(listBoardNotes(lector, boardId).map((n) => n.id), [nota.id]);
    assert.throws(() => resolvePlacement(lector, boardId, null), /no encontrada/);
    assert.throws(() => moveNote(lector, nota.id, boardId, revision.id, 'Intento sin permiso'), /no encontrada/);
  });

  it('comparte por área y el permiso directo del usuario prevalece', () => {
    setBoardShare(dueno, boardId, { principal_type: 'area', principal_id: 'marketing', permission: 'edit' });
    assert.equal(permissionFor(asesor, boardId), 'edit');
    assert.equal(permissionFor(lector, boardId), 'view');
    setBoardShare(dueno, boardId, { principal_type: 'user', principal_id: editor, permission: 'edit' });
    assert.equal(permissionFor(editor, boardId), 'edit');
  });

  it('con permiso de edición se agrega y mueve, dejando auditoría', () => {
    moveNote(editor, nota.id, boardId, revision.id, 'Se recibió la documentación.');
    const moved = noteDTO(nota.id) as ReturnType<typeof noteDTO> & { last_stage_by?: string | null };
    assert.equal(moved?.agenda_stage_id, revision.id);
    assert.equal(moved?.last_stage_by, 'Editor Agenda');
    const propia = addNote(contactId, editor, 'Seguimiento del editor.', null, null, [], false, {
      personal: true,
      agendaBoardId: boardId,
      agendaStageId: revision.id,
    });
    const fresh = noteDTO(propia.id) as ReturnType<typeof noteDTO> & { last_stage_by?: string | null };
    assert.equal(fresh?.last_stage_by, null, 'la creación inicial no cuenta como movimiento');
    assert.equal(noteDTO(propia.id)?.user_id, editor);
    assert.equal(listBoardNotes(dueno, boardId).length, 2);

    const boardEditor = createBoard(editor, 'Agenda privada del editor', ['Uno', 'Dos']);
    const stageEditor = listBoards(editor).find((b) => b.id === boardEditor)!.stages[0];
    assert.throws(
      () => moveNote(editor, nota.id, boardEditor, stageEditor.id, 'Intento de llevarla a mi agenda'),
      /agenda privada/,
    );
  });

  it('lista y quita permisos solo desde el dueño', () => {
    const shares = listBoardShares(dueno, boardId);
    assert.ok(shares.some((s) => s.principal_type === 'user' && s.principal_id === String(lector)));
    assert.ok(shares.some((s) => s.principal_type === 'area' && s.principal_id === 'marketing' && s.principal_name === 'Marketing'));
    assert.throws(() => listBoardShares(lector, boardId), /no encontrada/);
    const lectorShare = shares.find((s) => s.principal_type === 'user' && s.principal_id === String(lector))!;
    removeBoardShare(dueno, boardId, lectorShare.id);
    assert.equal(permissionFor(lector, boardId), null);
  });
});
