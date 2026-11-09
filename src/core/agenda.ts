import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { addNote, getNote, noteDTO, type ContactNoteWithAuthor } from './contacts.js';

/**
 * Sub-agendas de «Mi agenda». Cada usuario puede crear varios tableros (p. ej.
 * «Solicitud de titulaciones») y definir sus propias columnas del pipeline
 * («Solicitaron», «Exigen título retrasado», «Entregado», …). Las notas
 * personales se guardan en un tablero y una columna; siguen siendo privadas.
 */

export interface AgendaStage {
  id: number;
  board_id: number;
  name: string;
  color: string;
  position: number;
  /** 1 = al llegar a esta columna el proceso queda resuelto. */
  is_done: number;
}

export interface AgendaBoard {
  id: number;
  user_id: number;
  name: string;
  color: string | null;
  position: number;
  stages: AgendaStage[];
  /** Notas personales activas en este tablero. */
  notes: number;
}

const STAGE_COLORS = ['#64748b', '#045474', '#b45309', '#0f7b55', '#2e90b5', '#9a5b00', '#3f6212', '#475467'];

function colorFor(index: number): string {
  return STAGE_COLORS[index % STAGE_COLORS.length];
}

function boardRow(userId: number, boardId: number): { id: number; user_id: number } | undefined {
  return get<{ id: number; user_id: number }>(
    'SELECT id, user_id FROM agenda_boards WHERE id = ? AND user_id = ?',
    boardId,
    userId,
  );
}

function stagesFor(boardId: number): AgendaStage[] {
  return all<AgendaStage>(
    'SELECT * FROM agenda_stages WHERE board_id = ? ORDER BY position, id',
    boardId,
  );
}

/** Crea un tablero con sus columnas; la última se marca como «resuelto». */
export function createBoard(
  userId: number,
  name: string,
  stageNames: string[],
  color: string | null = null,
): number {
  const cleanName = String(name ?? '').trim().slice(0, 80);
  if (!cleanName) throw new Error('Escribí el nombre de la sub-agenda.');
  const names: string[] = [];
  for (const raw of stageNames) {
    const n = String(raw ?? '').trim().slice(0, 60);
    if (n && !names.some((x) => x.toLocaleLowerCase() === n.toLocaleLowerCase())) names.push(n);
  }
  if (!names.length) throw new Error('Agregá al menos una columna al pipeline.');
  const duplicate = get<{ id: number }>(
    'SELECT id FROM agenda_boards WHERE user_id = ? AND LOWER(name) = LOWER(?)',
    userId,
    cleanName,
  );
  if (duplicate) throw new Error('Ya existe una sub-agenda con ese nombre.');
  const now = nowIso();
  const position = Number(
    get<{ p: number | null }>('SELECT MAX(position) AS p FROM agenda_boards WHERE user_id = ?', userId)?.p ?? -1,
  ) + 1;
  const created = run(
    `INSERT INTO agenda_boards (user_id, name, color, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    userId,
    cleanName,
    color,
    position,
    now,
    now,
  );
  const boardId = created.lastInsertRowid;
  names.forEach((stageName, index) => {
    run(
      `INSERT INTO agenda_stages (board_id, name, color, position, is_done, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      boardId,
      stageName,
      colorFor(index),
      index,
      names.length > 1 && index === names.length - 1 ? 1 : 0,
      now,
      now,
    );
  });
  return boardId;
}

/** Garantiza que el usuario tenga al menos un tablero y devuelve su id. */
export function ensureDefaultBoard(userId: number): number {
  const existing = get<{ id: number }>(
    'SELECT id FROM agenda_boards WHERE user_id = ? ORDER BY position, id LIMIT 1',
    userId,
  );
  if (existing) {
    // Notas personales antiguas (antes de las sub-agendas): se ubican en el
    // tablero principal para que no queden invisibles.
    const stages = stagesFor(existing.id);
    if (stages.length) {
      const map: Record<string, AgendaStage> = {
        todo: stages[0],
        doing: stages[1] ?? stages[0],
        contacted: stages[2] ?? stages[stages.length - 1],
        done: stages[stages.length - 1],
      };
      for (const note of all<{ id: number; pipeline_stage: string | null }>(
        `SELECT id, pipeline_stage FROM contact_notes
          WHERE personal = 1 AND deleted_at IS NULL AND agenda_board_id IS NULL`,
      )) {
        const stage = map[note.pipeline_stage || 'todo'] ?? stages[0];
        run(
          `UPDATE contact_notes SET agenda_board_id = ?, agenda_stage_id = ? WHERE id = ?`,
          existing.id,
          stage.id,
          note.id,
        );
      }
    }
    return existing.id;
  }
  const id = createBoard(userId, 'General', ['Por hacer', 'En gestión', 'Contactado', 'Resuelto']);
  const stages = stagesFor(id);
  if (stages.length) {
    run(
      `UPDATE contact_notes SET agenda_board_id = ?, agenda_stage_id = ?
        WHERE personal = 1 AND deleted_at IS NULL AND agenda_board_id IS NULL`,
      id,
      stages[0].id,
    );
  }
  return id;
}

/** Tableros del usuario con sus columnas y cantidad de notas. */
export function listBoards(userId: number): AgendaBoard[] {
  ensureDefaultBoard(userId);
  const boards = all<Omit<AgendaBoard, 'stages' | 'notes'>>(
    'SELECT id, user_id, name, color, position FROM agenda_boards WHERE user_id = ? ORDER BY position, id',
    userId,
  );
  if (!boards.length) return [];
  const ids = boards.map((b) => b.id);
  const stages = all<AgendaStage>(
    `SELECT * FROM agenda_stages WHERE board_id IN (${ids.map(() => '?').join(',')})
      ORDER BY board_id, position, id`,
    ...ids,
  );
  const counts = all<{ board_id: number; c: number }>(
    `SELECT agenda_board_id AS board_id, COUNT(*) AS c
       FROM contact_notes
      WHERE personal = 1 AND deleted_at IS NULL AND user_id = ?
        AND agenda_board_id IN (${ids.map(() => '?').join(',')})
      GROUP BY agenda_board_id`,
    userId,
    ...ids,
  );
  const byBoard = new Map<number, AgendaStage[]>();
  for (const stage of stages) {
    const list = byBoard.get(stage.board_id) ?? [];
    list.push(stage);
    byBoard.set(stage.board_id, list);
  }
  const countMap = new Map(counts.map((c) => [c.board_id, Number(c.c)]));
  return boards.map((b) => ({
    ...b,
    stages: byBoard.get(b.id) ?? [],
    notes: countMap.get(b.id) ?? 0,
  }));
}

/** Primera columna del tablero principal (para notas nuevas sin tablero). */
export function defaultPlacement(userId: number): { boardId: number; stageId: number | null } {
  const boardId = ensureDefaultBoard(userId);
  const stages = stagesFor(boardId);
  return { boardId, stageId: stages[0]?.id ?? null };
}

/** Valida un tablero/columna del usuario y completa valores por defecto. */
export function resolvePlacement(
  userId: number,
  boardId?: number | null,
  stageId?: number | null,
): { boardId: number; stageId: number } {
  if (!boardId) {
    const fallback = defaultPlacement(userId);
    if (!fallback.stageId) throw new Error('La agenda no tiene columnas.');
    return { boardId: fallback.boardId, stageId: fallback.stageId };
  }
  if (!boardRow(userId, boardId)) throw new Error('Sub-agenda no encontrada.');
  const stages = stagesFor(boardId);
  if (!stages.length) throw new Error('La sub-agenda no tiene columnas.');
  const stage = stageId ? stages.find((s) => s.id === Number(stageId)) : stages[0];
  if (!stage) throw new Error('La columna no pertenece a esta sub-agenda.');
  return { boardId, stageId: stage.id };
}

/**
 * Actualiza nombre y columnas de una sub-agenda. Las columnas que se quitan
 * reubican sus notas en la primera columna para no perder el seguimiento.
 */
export function updateBoard(
  userId: number,
  boardId: number,
  input: { name: string; stages: Array<{ id?: number; name: string; color?: string }> },
): void {
  if (!boardRow(userId, boardId)) throw new Error('Sub-agenda no encontrada.');
  const name = String(input?.name ?? '').trim().slice(0, 80);
  if (!name) throw new Error('Escribí el nombre de la sub-agenda.');
  const duplicate = get<{ id: number }>(
    'SELECT id FROM agenda_boards WHERE user_id = ? AND id <> ? AND LOWER(name) = LOWER(?)',
    userId,
    boardId,
    name,
  );
  if (duplicate) throw new Error('Ya existe una sub-agenda con ese nombre.');
  const names: string[] = [];
  const cleaned: Array<{ id?: number; name: string; color?: string }> = [];
  for (const item of input.stages ?? []) {
    const stageName = String(item?.name ?? '').trim().slice(0, 60);
    if (!stageName) continue;
    if (names.some((n) => n.toLocaleLowerCase() === stageName.toLocaleLowerCase())) continue;
    names.push(stageName);
    cleaned.push({ id: item.id, name: stageName, color: item.color });
  }
  if (!cleaned.length) throw new Error('Dejá al menos una columna.');
  const existing = stagesFor(boardId);
  const existingIds = new Set(existing.map((s) => s.id));
  const now = nowIso();

  run('UPDATE agenda_boards SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?', name, now, boardId, userId);
  // Se renombran temporalmente para poder intercambiar nombres sin chocar con
  // la restricción UNIQUE(board_id, name) mientras se reordenan las columnas.
  run("UPDATE agenda_stages SET name = '__tmp_' || id WHERE board_id = ?", boardId);

  const finalIds: number[] = [];
  cleaned.forEach((item, index) => {
    const isDone = cleaned.length > 1 && index === cleaned.length - 1 ? 1 : 0;
    if (item.id && existingIds.has(item.id)) {
      run(
        `UPDATE agenda_stages SET name = ?, color = COALESCE(?, color), position = ?, is_done = ?, updated_at = ?
          WHERE id = ? AND board_id = ?`,
        item.name,
        item.color ?? null,
        index,
        isDone,
        now,
        item.id,
        boardId,
      );
      finalIds.push(item.id);
    } else {
      const created = run(
        `INSERT INTO agenda_stages (board_id, name, color, position, is_done, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        boardId,
        item.name,
        item.color || colorFor(index),
        index,
        isDone,
        now,
        now,
      );
      finalIds.push(created.lastInsertRowid);
    }
  });
  const keep = new Set(finalIds);
  const removed = existing.filter((s) => !keep.has(s.id)).map((s) => s.id);
  if (removed.length) {
    // Las notas de columnas eliminadas pasan a la primera columna.
    run(
      `UPDATE contact_notes SET agenda_stage_id = ?, done_at = NULL, done_by = NULL
        WHERE agenda_board_id = ? AND agenda_stage_id IN (${removed.map(() => '?').join(',')})`,
      finalIds[0],
      boardId,
      ...removed,
    );
    run(`DELETE FROM agenda_stages WHERE id IN (${removed.map(() => '?').join(',')})`, ...removed);
  }
}

/** Elimina una sub-agenda y reubica sus notas en otro tablero. */
export function deleteBoard(userId: number, boardId: number): void {
  if (!boardRow(userId, boardId)) throw new Error('Sub-agenda no encontrada.');
  const other = get<{ id: number }>(
    'SELECT id FROM agenda_boards WHERE user_id = ? AND id <> ? ORDER BY position, id LIMIT 1',
    userId,
    boardId,
  );
  if (!other) throw new Error('No podés eliminar la única sub-agenda.');
  const stages = stagesFor(other.id);
  if (!stages.length) throw new Error('El tablero de destino no tiene columnas.');
  run(
    `UPDATE contact_notes SET agenda_board_id = ?, agenda_stage_id = ?, done_at = NULL, done_by = NULL
      WHERE agenda_board_id = ?`,
    other.id,
    stages[0].id,
    boardId,
  );
  run('DELETE FROM agenda_boards WHERE id = ? AND user_id = ?', boardId, userId);
}

/** Lleva una nota a una columna (y tablero, si corresponde). */
export interface AgendaCopyResult {
  note: ContactNoteWithAuthor;
  created: boolean;
}

/**
 * Copia una nota de equipo a Mi agenda (privada). Si ya existe una copia para
 * ese usuario y esa nota, la mueve al tablero/columna elegidos. Así el usuario
 * puede agrupar por sub-agenda sin perder la nota original ni duplicarla.
 */
export function copyTeamNoteToAgenda(
  userId: number,
  sourceNoteId: number,
  boardId?: number | null,
  stageId?: number | null,
): AgendaCopyResult {
  const source = getNote(sourceNoteId);
  if (!source || source.personal) throw new Error('La nota no está disponible para enviar a la agenda.');
  const placement = resolvePlacement(userId, boardId, stageId);
  const existing = get<{ id: number; deleted_at: string | null }>(
    `SELECT id, deleted_at FROM contact_notes
      WHERE user_id = ? AND personal = 1 AND agenda_source_note_id = ?
      ORDER BY id DESC LIMIT 1`,
    userId,
    sourceNoteId,
  );
  if (existing) {
    if (existing.deleted_at) {
      run('UPDATE contact_notes SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?', nowIso(), existing.id);
    }
    moveNote(userId, existing.id, placement.boardId, placement.stageId);
    return { note: noteDTO(existing.id)!, created: false };
  }
  const tagIds = all<{ tag_id: number }>(
    'SELECT tag_id FROM contact_note_tags WHERE note_id = ?',
    sourceNoteId,
  ).map((r) => r.tag_id);
  const note = addNote(
    source.contact_id,
    userId,
    source.note_text,
    source.audio_path,
    source.due_at,
    tagIds,
    source.pinned === 1,
    {
      personal: true,
      agendaBoardId: placement.boardId,
      agendaStageId: placement.stageId,
      agendaSourceNoteId: sourceNoteId,
      pipelineStage: source.pipeline_stage ?? 'todo',
      dueTime: source.due_time,
    },
  );
  return { note, created: true };
}

/** Lleva una nota a una columna (y tablero, si corresponde). */
export function moveNote(userId: number, noteId: number, boardId: number, stageId?: number | null): void {
  if (!boardRow(userId, boardId)) throw new Error('Sub-agenda no encontrada.');
  const note = get<{ id: number; user_id: number | null; personal: number; done_at: string | null }>(
    'SELECT id, user_id, personal, done_at FROM contact_notes WHERE id = ?',
    noteId,
  );
  if (!note || note.personal !== 1 || note.user_id !== userId) throw new Error('Nota de agenda no encontrada.');
  const stages = stagesFor(boardId);
  if (!stages.length) throw new Error('La sub-agenda no tiene columnas.');
  const stage = stageId ? stages.find((s) => s.id === Number(stageId)) : stages[0];
  if (!stage) throw new Error('La columna no pertenece a esta sub-agenda.');
  const now = nowIso();
  run(
    `UPDATE contact_notes SET agenda_board_id = ?, agenda_stage_id = ?,
            done_at = CASE WHEN ? = 1 THEN COALESCE(done_at, ?) ELSE NULL END,
            done_by = CASE WHEN ? = 1 THEN COALESCE(done_by, ?) ELSE NULL END,
            updated_at = ?
      WHERE id = ? AND user_id = ? AND personal = 1`,
    boardId,
    stage.id,
    stage.is_done,
    now,
    stage.is_done,
    userId,
    now,
    noteId,
    userId,
  );
}
