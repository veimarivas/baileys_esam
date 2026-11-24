import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';

/**
 * Unidades de negocio (ESAM, DBS, …). Son el primer nivel de la jerarquía:
 *
 *   unidad de negocio → sedes → usuarios (con su cargo y su número de acceso)
 *
 * Una sede pertenece a una unidad (`sedes.business_unit_id`) y un usuario
 * pertenece a una sede (`users.sede_id`). Borrar una unidad o una sede con
 * contenido no se permite: primero se mueve o se elimina lo que tiene adentro.
 */
export interface BusinessUnitRow {
  id: number;
  name: string;
  code: string | null;
  active: number;
  created_at: string;
  updated_at: string;
  sedes: number;
  users: number;
}

const SELECT = `
  SELECT u.id, u.name, u.code, u.active, u.created_at, u.updated_at,
         (SELECT COUNT(*) FROM sedes s WHERE s.business_unit_id = u.id) AS sedes,
         (SELECT COUNT(*) FROM users us
            JOIN sedes s2 ON s2.id = us.sede_id
           WHERE s2.business_unit_id = u.id) AS users
    FROM business_units u`;

/** Nombre visible: sin espacios de sobra y con un máximo razonable. */
function cleanName(name: string): string {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!clean) throw new Error('Escribí el nombre de la unidad de negocio.');
  return clean;
}

/** Sigla corta para el distintivo de la tarjeta (ESAM, DBS, …). */
function cleanCode(code: string | null | undefined): string | null {
  const clean = String(code ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return clean || null;
}

export function listBusinessUnits(): BusinessUnitRow[] {
  return all<BusinessUnitRow>(`${SELECT} ORDER BY u.name COLLATE NOCASE`);
}

export function getBusinessUnit(id: number): BusinessUnitRow | undefined {
  return get<BusinessUnitRow>(`${SELECT} WHERE u.id = ?`, id);
}

export function createBusinessUnit(input: { name: string; code?: string | null }): number {
  const name = cleanName(input.name);
  const code = cleanCode(input.code);
  if (get<{ id: number }>('SELECT id FROM business_units WHERE name = ? COLLATE NOCASE', name)) {
    throw new Error('Ya existe una unidad de negocio con ese nombre.');
  }
  if (code && get<{ id: number }>('SELECT id FROM business_units WHERE code = ? COLLATE NOCASE', code)) {
    throw new Error('Ese código ya está en uso por otra unidad.');
  }
  const now = nowIso();
  return run(
    'INSERT INTO business_units (name, code, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    name,
    code,
    now,
    now,
  ).lastInsertRowid;
}

export function updateBusinessUnit(id: number, input: { name: string; code?: string | null }): void {
  if (!get<{ id: number }>('SELECT id FROM business_units WHERE id = ?', id)) {
    throw new Error('Unidad de negocio no encontrada.');
  }
  const name = cleanName(input.name);
  const code = cleanCode(input.code);
  if (get<{ id: number }>('SELECT id FROM business_units WHERE name = ? COLLATE NOCASE AND id <> ?', name, id)) {
    throw new Error('Ya existe una unidad de negocio con ese nombre.');
  }
  if (code && get<{ id: number }>('SELECT id FROM business_units WHERE code = ? COLLATE NOCASE AND id <> ?', code, id)) {
    throw new Error('Ese código ya está en uso por otra unidad.');
  }
  run('UPDATE business_units SET name = ?, code = ?, updated_at = ? WHERE id = ?', name, code, nowIso(), id);
}

/** Solo se elimina una unidad sin sedes: las sedes se borran o se mueven antes. */
export function deleteBusinessUnit(id: number): void {
  if (!get<{ id: number }>('SELECT id FROM business_units WHERE id = ?', id)) {
    throw new Error('Unidad de negocio no encontrada.');
  }
  const sedes = get<{ c: number }>('SELECT COUNT(*) AS c FROM sedes WHERE business_unit_id = ?', id)?.c ?? 0;
  if (sedes > 0) throw new Error('No podés eliminar una unidad con sedes. Movelas o eliminá sus sedes primero.');
  run('DELETE FROM business_units WHERE id = ?', id);
}
