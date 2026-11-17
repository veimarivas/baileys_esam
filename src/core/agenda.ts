import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { esamAreas, esamAreaName, type UserRow } from '../auth/users.js';
import { addNote, getNote, listNotesByBoard, logNoteCite, logNoteStage, noteDTO, type ContactNoteWithAuthor, type GlobalNote } from './contacts.js';
import { citeById, citeConceptLabel } from './cites.js';

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
  /** 1 = al entrar a esta columna hay que elegir un cite habilitado. */
  requires_cite: number;
}

export interface AgendaBoard {
  id: number;
  user_id: number;
  name: string;
  color: string | null;
  position: number;
  /** 1 = al cambiar de columna hay que elegir un cite habilitado. */
  uses_cites: number;
  stages: AgendaStage[];
  /** Notas personales activas en este tablero. */
  notes: number;
  /** Dueño del tablero (alias de user_id, para la interfaz). */
  owner_id: number;
  owner_name: string | null;
  /** Permiso efectivo de quien consulta: dueño, edición o solo lectura. */
  permission: BoardPermission;
  /** `true` cuando el usuario puede agregar o mover notas. */
  can_edit: boolean;
  /** `true` cuando el tablero es de otra persona y se comparte con el usuario. */
  shared: boolean;
}

export type BoardPermission = 'owner' | 'edit' | 'view';

export interface AgendaBoardShare {
  id: number;
  board_id: number;
  principal_type: 'user' | 'area';
  principal_id: string;
  principal_name: string;
  permission: 'view' | 'edit';
  created_at: string;
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

/** Áreas internas del usuario (según sus roles de cronogramas). */
function areasFor(userId: number): string[] {
  const row = get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  return row ? esamAreas(row) : [];
}

/**
 * Permiso efectivo de un usuario sobre un tablero. Un permiso directo de
 * usuario prevalece sobre el permiso por área; entre áreas, «edit» gana.
 */
export function permissionFor(userId: number, boardId: number): BoardPermission | null {
  const board = get<{ user_id: number }>('SELECT user_id FROM agenda_boards WHERE id = ?', boardId);
  if (!board) return null;
  if (Number(board.user_id) === Number(userId)) return 'owner';
  const direct = get<{ permission: string }>(
    `SELECT permission FROM agenda_board_shares
      WHERE board_id = ? AND principal_type = 'user' AND principal_id = ?`,
    boardId,
    String(userId),
  );
  if (direct) return direct.permission === 'edit' ? 'edit' : 'view';
  const areas = areasFor(userId);
  if (!areas.length) return null;
  const rows = all<{ permission: string }>(
    `SELECT permission FROM agenda_board_shares
      WHERE board_id = ? AND principal_type = 'area'
        AND principal_id IN (${areas.map(() => '?').join(',')})`,
    boardId,
    ...areas,
  );
  if (!rows.length) return null;
  return rows.some((r) => r.permission === 'edit') ? 'edit' : 'view';
}

/** `true` si el usuario puede agregar o mover notas en el tablero. */
export function canEditBoard(userId: number, boardId: number): boolean {
  const permission = permissionFor(userId, boardId);
  return permission === 'owner' || permission === 'edit';
}

/** Crea un tablero con sus columnas; la última se marca como «resuelto». */
export function createBoard(
  userId: number,
  name: string,
  stageNames: string[],
  color: string | null = null,
  usesCites = false,
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
    `INSERT INTO agenda_boards (user_id, name, color, position, uses_cites, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId,
    cleanName,
    color,
    position,
    usesCites ? 1 : 0,
    now,
    now,
  );
  const boardId = created.lastInsertRowid;
  names.forEach((stageName, index) => {
    run(
      `INSERT INTO agenda_stages (board_id, name, color, position, is_done, requires_cite, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      boardId,
      stageName,
      colorFor(index),
      index,
      names.length > 1 && index === names.length - 1 ? 1 : 0,
      usesCites ? 1 : 0,
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

interface BoardRow {
  id: number;
  user_id: number;
  name: string;
  color: string | null;
  position: number;
  uses_cites: number;
  owner_name: string | null;
}

/** Tableros propios y compartidos, con sus columnas y cantidad de notas. */
export function listBoards(userId: number): AgendaBoard[] {
  ensureDefaultBoard(userId);
  const own = all<BoardRow>(
    `SELECT b.id, b.user_id, b.name, b.color, b.position, b.uses_cites, u.name AS owner_name
       FROM agenda_boards b
       LEFT JOIN users u ON u.id = b.user_id
      WHERE b.user_id = ?
      ORDER BY b.position, b.id`,
    userId,
  );
  const areas = areasFor(userId);
  const shared = all<BoardRow>(
    `SELECT DISTINCT b.id, b.user_id, b.name, b.color, b.position, b.uses_cites, u.name AS owner_name
       FROM agenda_boards b
       LEFT JOIN users u ON u.id = b.user_id
       JOIN agenda_board_shares s ON s.board_id = b.id
      WHERE b.user_id <> ?
        AND ((s.principal_type = 'user' AND s.principal_id = ?)
          ${areas.length ? `OR (s.principal_type = 'area' AND s.principal_id IN (${areas.map(() => '?').join(',')}))` : ''})
      ORDER BY u.name COLLATE NOCASE, b.position, b.id`,
    userId,
    String(userId),
    ...areas,
  );
  const boards: Array<BoardRow & { permission: BoardPermission }> = [
    ...own.map((b) => ({ ...b, permission: 'owner' as BoardPermission })),
    ...shared.map((b) => ({
      ...b,
      permission: permissionFor(userId, b.id) ?? ('view' as BoardPermission),
    })),
  ];
  if (!boards.length) return [];
  const ids = boards.map((b) => b.id);
  const stages = all<AgendaStage>(
    `SELECT * FROM agenda_stages WHERE board_id IN (${ids.map(() => '?').join(',')})
      ORDER BY board_id, position, id`,
    ...ids,
  );
  // En tableros compartidos se cuentan las notas de todas las personas con acceso.
  const counts = all<{ board_id: number; c: number }>(
    `SELECT agenda_board_id AS board_id, COUNT(*) AS c
       FROM contact_notes
      WHERE personal = 1 AND deleted_at IS NULL
        AND agenda_board_id IN (${ids.map(() => '?').join(',')})
      GROUP BY agenda_board_id`,
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
    id: b.id,
    user_id: b.user_id,
    owner_id: b.user_id,
    owner_name: b.owner_name,
    permission: b.permission,
    can_edit: b.permission === 'owner' || b.permission === 'edit',
    shared: b.permission !== 'owner',
    name: b.name,
    color: b.color,
    position: b.position,
    uses_cites: Number(b.uses_cites) === 1 ? 1 : 0,
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
  if (!canEditBoard(userId, boardId)) throw new Error('Sub-agenda no encontrada.');
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
  input: {
    name: string;
    stages: Array<{ id?: number; name: string; color?: string; requires_cite?: boolean }>;
    usesCites?: boolean;
  },
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
  const cleaned: Array<{ id?: number; name: string; color?: string; requires_cite?: boolean }> = [];
  for (const item of input.stages ?? []) {
    const stageName = String(item?.name ?? '').trim().slice(0, 60);
    if (!stageName) continue;
    if (names.some((n) => n.toLocaleLowerCase() === stageName.toLocaleLowerCase())) continue;
    names.push(stageName);
    cleaned.push({ id: item.id, name: stageName, color: item.color, requires_cite: item.requires_cite });
  }
  if (!cleaned.length) throw new Error('Dejá al menos una columna.');
  const existing = stagesFor(boardId);
  const existingIds = new Set(existing.map((s) => s.id));
  const now = nowIso();

  run('UPDATE agenda_boards SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?', name, now, boardId, userId);
  if (typeof input.usesCites === 'boolean') {
    run('UPDATE agenda_boards SET uses_cites = ? WHERE id = ? AND user_id = ?', input.usesCites ? 1 : 0, boardId, userId);
  }
  // Se renombran temporalmente para poder intercambiar nombres sin chocar con
  // la restricción UNIQUE(board_id, name) mientras se reordenan las columnas.
  run("UPDATE agenda_stages SET name = '__tmp_' || id WHERE board_id = ?", boardId);

  const finalIds: number[] = [];
  cleaned.forEach((item, index) => {
    const isDone = cleaned.length > 1 && index === cleaned.length - 1 ? 1 : 0;
    if (item.id && existingIds.has(item.id)) {
      run(
        `UPDATE agenda_stages SET name = ?, color = COALESCE(?, color), position = ?, is_done = ?,
                requires_cite = COALESCE(?, requires_cite), updated_at = ?
          WHERE id = ? AND board_id = ?`,
        item.name,
        item.color ?? null,
        index,
        isDone,
        item.requires_cite === undefined ? null : (item.requires_cite ? 1 : 0),
        now,
        item.id,
        boardId,
      );
      finalIds.push(item.id);
    } else {
      const created = run(
        `INSERT INTO agenda_stages (board_id, name, color, position, is_done, requires_cite, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        boardId,
        item.name,
        item.color || colorFor(index),
        index,
        isDone,
        item.requires_cite ? 1 : 0,
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
  // Solo se elimina si está vacía: las notas activas deben moverse o borrarse
  // primero. Las notas en papelera se reubican para no quedar huérfanas.
  const active = Number(
    get<{ c: number | null }>(
      'SELECT COUNT(*) AS c FROM contact_notes WHERE agenda_board_id = ? AND deleted_at IS NULL',
      boardId,
    )?.c ?? 0,
  );
  if (active > 0) {
    throw new Error('La sub-agenda no está vacía. Mové o eliminá sus notas antes de borrarla.');
  }
  const stages = stagesFor(other.id);
  if (!stages.length) throw new Error('El tablero de destino no tiene columnas.');
  run(
    `UPDATE contact_notes SET agenda_board_id = ?, agenda_stage_id = ?, done_at = NULL, done_by = NULL
      WHERE agenda_board_id = ?`,
    other.id,
    stages[0].id,
    boardId,
  );
  run('DELETE FROM agenda_board_shares WHERE board_id = ?', boardId);
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
    moveNote(userId, existing.id, placement.boardId, placement.stageId, 'Movida desde Notas y tareas');
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
export function moveNote(
  userId: number,
  noteId: number,
  boardId: number,
  stageId?: number | null,
  comment?: string | null,
  citeId?: number | null,
): void {
  const destination = permissionFor(userId, boardId);
  if (destination !== 'owner' && destination !== 'edit') throw new Error('Sub-agenda no encontrada.');
  const note = get<{
    id: number;
    user_id: number | null;
    personal: number;
    deleted_at: string | null;
    done_at: string | null;
    agenda_board_id: number | null;
    agenda_stage_id: number | null;
    cite_folio_id: number | null;
    cite_number: string | null;
    cite_concept: string | null;
  }>(
    `SELECT id, user_id, personal, deleted_at, done_at, agenda_board_id, agenda_stage_id,
            cite_folio_id, cite_number, cite_concept
       FROM contact_notes WHERE id = ?`,
    noteId,
  );
  if (!note || note.personal !== 1 || note.deleted_at) throw new Error('Nota de agenda no encontrada.');
  if (note.user_id != null && note.user_id !== userId) {
    // Una nota ajena solo se mueve dentro de tableros compartidos con edición.
    const source = note.agenda_board_id ? permissionFor(userId, note.agenda_board_id) : null;
    if (source !== 'owner' && source !== 'edit') {
      throw new Error('Nota de agenda no encontrada.');
    }
    if (destination === 'owner') {
      throw new Error('No podés mover a tu agenda privada una nota de otra persona.');
    }
  }
  const stages = stagesFor(boardId);
  if (!stages.length) throw new Error('La sub-agenda no tiene columnas.');
  const stage = stageId ? stages.find((s) => s.id === Number(stageId)) : stages[0];
  if (!stage) throw new Error('La columna no pertenece a esta sub-agenda.');
  const changed = note.agenda_board_id !== boardId || note.agenda_stage_id !== stage.id;
  const detail = String(comment ?? '').trim();
  if (changed && !detail) {
    throw new Error('Para cambiar de columna, escribí un detalle del seguimiento.');
  }
  // Sub-agendas que llevan cites: solo las columnas marcadas lo exigen. Se
  // guarda el número en la nota y en el historial del movimiento.
  const boardInfo = get<{ uses_cites: number }>('SELECT uses_cites FROM agenda_boards WHERE id = ?', boardId);
  const boardUsesCites = Number(boardInfo?.uses_cites ?? 0) === 1;
  const stageRequiresCite = Number(stage.requires_cite) === 1;
  let nextCite: { id: number; number: string; concept: string | null } | null = null;
  let citeAction: 'set' | 'keep' | 'clear' = 'keep';
  if (changed) {
    if (boardUsesCites && stageRequiresCite) {
      if (!citeId) throw new Error('Elegí el número de cite para entrar a esta columna.');
      const cite = citeById(Number(citeId));
      if (!cite || cite.status !== 'habilitado') throw new Error('El cite elegido no está habilitado.');
      nextCite = { id: cite.id, number: cite.nombre, concept: cite.concepto };
      citeAction = 'set';
    } else if (!boardUsesCites) {
      // La nota sale de un tablero con cites: se limpia el vínculo anterior.
      citeAction = 'clear';
    }
  }
  const now = nowIso();
  const citeColumns = citeAction === 'keep' ? '' : ', cite_folio_id = ?, cite_number = ?, cite_concept = ?';
  const citeParams: unknown[] = citeAction === 'set'
    ? [nextCite!.id, nextCite!.number, nextCite!.concept]
    : citeAction === 'clear'
      ? [null, null, null]
      : [];
  run(
    `UPDATE contact_notes SET agenda_board_id = ?, agenda_stage_id = ?,
            done_at = CASE WHEN ? = 1 THEN COALESCE(done_at, ?) ELSE NULL END,
            done_by = CASE WHEN ? = 1 THEN COALESCE(done_by, ?) ELSE NULL END,
            updated_at = ?${citeColumns}
      WHERE id = ? AND personal = 1`,
    boardId,
    stage.id,
    stage.is_done,
    now,
    stage.is_done,
    userId,
    now,
    ...citeParams,
    noteId,
  );
  if (changed) {
    const fromStage = note.agenda_stage_id
      ? get<{ name: string; board_id: number }>('SELECT name, board_id FROM agenda_stages WHERE id = ?', note.agenda_stage_id)
      : null;
    const fromBoard = fromStage
      ? get<{ name: string }>('SELECT name FROM agenda_boards WHERE id = ?', fromStage.board_id)
      : null;
    const toBoard = get<{ name: string }>('SELECT name FROM agenda_boards WHERE id = ?', boardId);
    logNoteStage(noteId, userId, {
      fromBoard: fromBoard?.name ?? null,
      from: fromStage?.name ?? null,
      toBoard: toBoard?.name ?? null,
      to: stage.name,
      comment: detail,
      cite: nextCite?.number ?? null,
      citeConcept: nextCite?.concept ?? null,
    });
  }
}

/** `true` si la columna exige cite (en una sub-agenda que usa cites). */
export function stageRequiresCite(boardId: number, stageId: number): boolean {
  const row = get<{ requires_cite: number; uses_cites: number }>(
    `SELECT s.requires_cite, b.uses_cites
       FROM agenda_stages s JOIN agenda_boards b ON b.id = s.board_id
      WHERE s.id = ? AND s.board_id = ?`,
    stageId,
    boardId,
  );
  return !!row && Number(row.requires_cite) === 1 && Number(row.uses_cites) === 1;
}

/**
 * Agrega, cambia o quita el cite de una nota que ya está en una sub-agenda,
 * sin moverla de columna. Sirve para completar tarjetas existentes.
 */
export function setNoteCite(
  userId: number,
  noteId: number,
  citeId?: number | null,
): ContactNoteWithAuthor {
  const note = get<{
    id: number;
    user_id: number | null;
    personal: number;
    deleted_at: string | null;
    agenda_board_id: number | null;
    agenda_stage_id: number | null;
  }>(
    'SELECT id, user_id, personal, deleted_at, agenda_board_id, agenda_stage_id FROM contact_notes WHERE id = ?',
    noteId,
  );
  if (!note || note.personal !== 1 || note.deleted_at) throw new Error('Nota de agenda no encontrada.');
  if (!note.agenda_board_id) throw new Error('La nota no está en una sub-agenda.');
  const permission = permissionFor(userId, note.agenda_board_id);
  if (permission !== 'owner' && permission !== 'edit') throw new Error('Sub-agenda no encontrada.');
  const board = get<{ uses_cites: number }>(
    'SELECT uses_cites FROM agenda_boards WHERE id = ?',
    note.agenda_board_id,
  );
  if (Number(board?.uses_cites ?? 0) !== 1) throw new Error('Esta sub-agenda no usa cites.');
  // El cite solo corresponde a las columnas que lo exigen.
  const stage = note.agenda_stage_id
    ? get<{ requires_cite: number }>('SELECT requires_cite FROM agenda_stages WHERE id = ?', note.agenda_stage_id)
    : null;
  if (Number(stage?.requires_cite ?? 0) !== 1) throw new Error('Esta columna no usa cite.');
  const cite = citeId ? citeById(Number(citeId)) : undefined;
  if (citeId && (!cite || cite.status !== 'habilitado')) throw new Error('El cite elegido no está habilitado.');
  const now = nowIso();
  run(
    `UPDATE contact_notes SET cite_folio_id = ?, cite_number = ?, cite_concept = ?, updated_at = ?
      WHERE id = ? AND personal = 1`,
    cite?.id ?? null,
    cite?.nombre ?? null,
    cite?.concepto ?? null,
    now,
    noteId,
  );
  logNoteCite(
    noteId,
    userId,
    cite ? cite.nombre : 'Sin cite',
    cite ? citeConceptLabel(cite.concepto) : null,
  );
  return noteDTO(noteId)!;
}

/** Notas de un tablero al que el usuario tiene acceso (propio o compartido). */
export function listBoardNotes(
  userId: number,
  boardId: number,
  opts: { q?: string | null; limit?: number } = {},
): GlobalNote[] {
  if (!permissionFor(userId, boardId)) throw new Error('Sub-agenda no encontrada.');
  return listNotesByBoard(boardId, opts);
}

/** Permisos vigentes de una sub-agenda. Solo los administra su dueño. */
export function listBoardShares(userId: number, boardId: number): AgendaBoardShare[] {
  if (!boardRow(userId, boardId)) throw new Error('Sub-agenda no encontrada.');
  const rows = all<{
    id: number;
    board_id: number;
    principal_type: string;
    principal_id: string;
    permission: string;
    created_at: string;
    user_name: string | null;
  }>(
    `SELECT s.id, s.board_id, s.principal_type, s.principal_id, s.permission, s.created_at,
            u.name AS user_name
       FROM agenda_board_shares s
       LEFT JOIN users u ON s.principal_type = 'user' AND CAST(u.id AS TEXT) = s.principal_id
      WHERE s.board_id = ?
      ORDER BY s.principal_type, COALESCE(u.name, s.principal_id) COLLATE NOCASE`,
    boardId,
  );
  return rows.map((r) => {
    const type: 'user' | 'area' = r.principal_type === 'area' ? 'area' : 'user';
    return {
      id: r.id,
      board_id: r.board_id,
      principal_type: type,
      principal_id: r.principal_id,
      principal_name: type === 'area'
        ? esamAreaName(r.principal_id)
        : (r.user_name || ('Usuario ' + r.principal_id)),
      permission: r.permission === 'edit' ? 'edit' : 'view',
      created_at: r.created_at,
    };
  });
}

/** Otorga o actualiza un permiso por usuario o por área. */
export function setBoardShare(
  userId: number,
  boardId: number,
  input: { principal_type?: string | null; principal_id?: string | number | null; permission?: string | null },
): void {
  if (!boardRow(userId, boardId)) throw new Error('Sub-agenda no encontrada.');
  const type: 'user' | 'area' = input?.principal_type === 'area' ? 'area' : 'user';
  const principalId = String(input?.principal_id ?? '').trim().slice(0, 80);
  if (!principalId) throw new Error('Elegí un usuario o un área.');
  if (type === 'user') {
    const target = Number(principalId);
    if (!Number.isInteger(target) || target <= 0 || !get<{ id: number }>('SELECT id FROM users WHERE id = ?', target)) {
      throw new Error('Usuario no encontrado.');
    }
    if (target === Number(userId)) throw new Error('Vos ya sos el dueño de esta sub-agenda.');
  }
  const permission = input?.permission === 'edit' ? 'edit' : 'view';
  const now = nowIso();
  run(
    `INSERT INTO agenda_board_shares (board_id, principal_type, principal_id, permission, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(board_id, principal_type, principal_id)
     DO UPDATE SET permission = excluded.permission`,
    boardId,
    type,
    principalId,
    permission,
    userId,
    now,
  );
}

/** Quita un permiso de la sub-agenda. */
export function removeBoardShare(userId: number, boardId: number, shareId: number): void {
  if (!boardRow(userId, boardId)) throw new Error('Sub-agenda no encontrada.');
  run('DELETE FROM agenda_board_shares WHERE id = ? AND board_id = ?', shareId, boardId);
}

