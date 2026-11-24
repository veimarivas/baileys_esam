import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';

export interface SedeRow {
  id: number;
  name: string;
  business_unit_id: number | null;
  business_unit_name: string | null;
  active: number;
  created_at: string;
  updated_at: string;
  users: number;
}

const SELECT = `
  SELECT s.id, s.name, s.business_unit_id, s.active, s.created_at, s.updated_at,
         u.name AS business_unit_name,
         (SELECT COUNT(*) FROM users us WHERE us.sede_id = s.id) AS users
    FROM sedes s
    LEFT JOIN business_units u ON u.id = s.business_unit_id`;

/** Sedes ordenadas por unidad y nombre; con `unitId` solo las de esa unidad. */
export function listSedes(unitId?: number | null): SedeRow[] {
  return unitId
    ? all<SedeRow>(`${SELECT} WHERE s.business_unit_id = ? ORDER BY s.name COLLATE NOCASE`, unitId)
    : all<SedeRow>(`${SELECT} ORDER BY COALESCE(u.name, 'zzz') COLLATE NOCASE, s.name COLLATE NOCASE`);
}

export function getSede(id: number): SedeRow | undefined {
  return get<SedeRow>(`${SELECT} WHERE s.id = ?`, id);
}

/**
 * Crea una sede dentro de una unidad. Sin unidad explícita usa la primera
 * (así el formulario viejo de /users sigue funcionando).
 */
export function createSede(name: string, businessUnitId?: number | null): number {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!clean) throw new Error('Escribí el nombre de la sede.');
  if (get<{ id: number }>('SELECT id FROM sedes WHERE name = ? COLLATE NOCASE', clean)) {
    throw new Error('Ya existe una sede con ese nombre.');
  }
  const unit = businessUnitId
    ?? get<{ id: number }>('SELECT id FROM business_units ORDER BY id LIMIT 1')?.id
    ?? null;
  if (businessUnitId && !get<{ id: number }>('SELECT id FROM business_units WHERE id = ?', businessUnitId)) {
    throw new Error('La unidad de negocio no existe.');
  }
  const now = nowIso();
  return run(
    'INSERT INTO sedes (name, business_unit_id, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    clean,
    unit,
    now,
    now,
  ).lastInsertRowid;
}

export function renameSede(id: number, name: string): void {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!clean) throw new Error('Escribí el nombre de la sede.');
  if (!getSede(id)) throw new Error('Sede no encontrada.');
  if (get<{ id: number }>('SELECT id FROM sedes WHERE name = ? COLLATE NOCASE AND id <> ?', clean, id)) {
    throw new Error('Ya existe una sede con ese nombre.');
  }
  run('UPDATE sedes SET name = ?, updated_at = ? WHERE id = ?', clean, nowIso(), id);
}

/** Mueve una sede a otra unidad de negocio (no mueve a sus usuarios). */
export function setSedeUnit(id: number, businessUnitId: number): void {
  if (!getSede(id)) throw new Error('Sede no encontrada.');
  if (!get<{ id: number }>('SELECT id FROM business_units WHERE id = ?', businessUnitId)) {
    throw new Error('La unidad de negocio no existe.');
  }
  run('UPDATE sedes SET business_unit_id = ?, updated_at = ? WHERE id = ?', businessUnitId, nowIso(), id);
}

/** Solo se puede eliminar una sede sin usuarios asignados. */
export function deleteSede(id: number): void {
  if (!getSede(id)) throw new Error('Sede no encontrada.');
  const count = get<{ c: number }>('SELECT COUNT(*) AS c FROM users WHERE sede_id = ?', id)?.c ?? 0;
  if (count > 0) throw new Error('No podés eliminar una sede con usuarios asignados.');
  run('DELETE FROM sedes WHERE id = ?', id);
}
