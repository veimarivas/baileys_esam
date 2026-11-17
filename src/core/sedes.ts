import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';

export interface SedeRow {
  id: number;
  name: string;
  active: number;
  created_at: string;
  updated_at: string;
  users: number;
}

export function listSedes(): SedeRow[] {
  const rows = all<SedeRow>(
    `SELECT s.id, s.name, s.active, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM users u WHERE u.sede_id = s.id) AS users
       FROM sedes s
      ORDER BY s.name COLLATE NOCASE`,
  );
  return rows;
}

export function getSede(id: number): SedeRow | undefined {
  return get<SedeRow>('SELECT * FROM sedes WHERE id = ?', id);
}

export function createSede(name: string): number {
  const clean = String(name ?? '').trim().slice(0, 80);
  if (!clean) throw new Error('Escribí el nombre de la sede.');
  if (get<{ id: number }>('SELECT id FROM sedes WHERE LOWER(name) = LOWER(?)', clean)) {
    throw new Error('Ya existe una sede con ese nombre.');
  }
  const now = nowIso();
  return run(
    'INSERT INTO sedes (name, active, created_at, updated_at) VALUES (?, 1, ?, ?)',
    clean,
    now,
    now,
  ).lastInsertRowid;
}

export function renameSede(id: number, name: string): void {
  const clean = String(name ?? '').trim().slice(0, 80);
  if (!clean) throw new Error('Escribí el nombre de la sede.');
  if (!getSede(id)) throw new Error('Sede no encontrada.');
  if (get<{ id: number }>('SELECT id FROM sedes WHERE LOWER(name) = LOWER(?) AND id <> ?', clean, id)) {
    throw new Error('Ya existe una sede con ese nombre.');
  }
  run('UPDATE sedes SET name = ?, updated_at = ? WHERE id = ?', clean, nowIso(), id);
}

/** Solo se puede eliminar una sede sin usuarios asignados. */
export function deleteSede(id: number): void {
  if (!getSede(id)) throw new Error('Sede no encontrada.');
  const count = get<{ c: number }>('SELECT COUNT(*) AS c FROM users WHERE sede_id = ?', id)?.c ?? 0;
  if (count > 0) throw new Error('No podés eliminar una sede con usuarios asignados.');
  run('DELETE FROM sedes WHERE id = ?', id);
}
