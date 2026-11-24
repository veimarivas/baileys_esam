import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';

/**
 * Cargos por área y su dependencia. Son la estructura del organigrama:
 *
 *   área → cargo raíz → cargo que depende de otro → …
 *
 * Cada persona tiene un área y un cargo (guardado en `users.esam_roles`); el
 * organigrama de una sede se arma uniendo esos cargos con sus dependencias y
 * las personas de la sede.
 */
export const CARGOS_AREAS = ['Marketing', 'Contabilidad', 'Académica', 'Dirección'] as const;
export type CargoArea = (typeof CARGOS_AREAS)[number];

/** Clave interna del área (la que se guarda en `users.esam_area`). */
export const AREA_KEY: Record<string, string> = {
  Marketing: 'marketing',
  Contabilidad: 'contabilidad',
  Académica: 'academico',
  Dirección: 'general',
};

export interface CargoRow {
  id: number;
  area: string;
  name: string;
  parent_id: number | null;
  position: number;
  active: number;
  created_at: string;
  updated_at: string;
  users: number;
}

const SELECT = `SELECT c.id, c.area, c.name, c.parent_id, c.position, c.active, c.created_at, c.updated_at,
    (SELECT COUNT(*) FROM users u WHERE u.esam_roles LIKE '%"' || c.name || '"%') AS users
  FROM cargos c`;

function cleanArea(area: string): string {
  const clean = String(area ?? '').trim();
  if (!(CARGOS_AREAS as readonly string[]).includes(clean)) throw new Error('Elegí un área válida.');
  return clean;
}

function cleanName(name: string): string {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!clean) throw new Error('Escribí el nombre del cargo.');
  return clean;
}

export function listCargos(area?: string): CargoRow[] {
  return area
    ? all<CargoRow>(`${SELECT} WHERE c.area = ? ORDER BY c.position, c.name COLLATE NOCASE`, area)
    : all<CargoRow>(`${SELECT} ORDER BY c.area, c.position, c.name COLLATE NOCASE`);
}

export function getCargo(id: number): CargoRow | undefined {
  return get<CargoRow>(`${SELECT} WHERE c.id = ?`, id);
}

/** Área → cargos activos, para los selectores de alta y edición. */
export function cargoMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const cargo of listCargos()) {
    if (!cargo.active) continue;
    (map[cargo.area] ??= []).push(cargo.name);
  }
  return map;
}

export function cargoExists(name: string, area?: string): boolean {
  return !!get<{ id: number }>(
    `SELECT id FROM cargos WHERE active = 1 AND name = ? COLLATE NOCASE${area ? ' AND area = ?' : ''}`,
    ...(area ? [name, area] : [name]),
  );
}

export function areaOfCargo(name: string): string | null {
  return get<{ area: string }>('SELECT area FROM cargos WHERE name = ? COLLATE NOCASE', name)?.area ?? null;
}

/** ¿Colgar `parentId` de `id` formaría un ciclo? */
function wouldCycle(id: number, parentId: number | null): boolean {
  let current = parentId;
  const seen = new Set<number>();
  while (current) {
    if (current === id || seen.has(current)) return true;
    seen.add(current);
    current = get<{ parent_id: number | null }>('SELECT parent_id FROM cargos WHERE id = ?', current)?.parent_id ?? null;
  }
  return false;
}

function validateParent(area: string, parentId: number | null, selfId: number | null): void {
  if (!parentId) return;
  const parent = get<{ id: number; area: string }>('SELECT id, area FROM cargos WHERE id = ?', parentId);
  if (!parent) throw new Error('El cargo del que depende no existe.');
  if (parent.area !== area) throw new Error('El cargo del que depende debe ser de la misma área.');
  if (selfId && wouldCycle(selfId, parentId)) throw new Error('Un cargo no puede depender de sí mismo ni de uno que depende de él.');
}

export function createCargo(input: { name: string; area: string; parentId?: number | null }): number {
  const area = cleanArea(input.area);
  const name = cleanName(input.name);
  const parentId = input.parentId ? Number(input.parentId) : null;
  if (get<{ id: number }>('SELECT id FROM cargos WHERE area = ? AND name = ? COLLATE NOCASE', area, name)) {
    throw new Error('Ese cargo ya existe en el área.');
  }
  validateParent(area, parentId, null);
  const now = nowIso();
  const position = (get<{ n: number }>('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM cargos WHERE area = ?', area)?.n ?? 1);
  return run(
    'INSERT INTO cargos (area, name, parent_id, position, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
    area,
    name,
    parentId,
    position,
    now,
    now,
  ).lastInsertRowid;
}

export function updateCargo(id: number, input: { name: string; area: string; parentId?: number | null }): void {
  const current = getCargo(id);
  if (!current) throw new Error('Cargo no encontrado.');
  const area = cleanArea(input.area);
  const name = cleanName(input.name);
  const parentId = input.parentId ? Number(input.parentId) : null;
  if (get<{ id: number }>('SELECT id FROM cargos WHERE area = ? AND name = ? COLLATE NOCASE AND id <> ?', area, name, id)) {
    throw new Error('Ese cargo ya existe en el área.');
  }
  validateParent(area, parentId, id);

  const now = nowIso();
  run('UPDATE cargos SET area = ?, name = ?, parent_id = ?, updated_at = ? WHERE id = ?', area, name, parentId, now, id);

  // Si cambió el nombre, las personas que lo tenían pasan al nombre nuevo.
  if (current.name !== name) {
    run(
      `UPDATE users SET esam_roles = REPLACE(esam_roles, '"' || ? || '"', '"' || ? || '"')
        WHERE esam_roles LIKE '%"' || ? || '"%'`,
      current.name,
      name,
      current.name,
    );
  }
  // Si cambió el área, el área de esas personas acompaña al cargo.
  if (current.area !== area) {
    const key = AREA_KEY[area] ?? null;
    run(`UPDATE users SET esam_area = ? WHERE esam_roles LIKE '%"' || ? || '"%'`, key, name);
  }

  // Los cargos que dependían de este siguen apuntando a él (mismo id).
}

/** Borra un cargo solo si no tiene personas ni cargos que dependan de él. */
export function deleteCargo(id: number): void {
  const cargo = getCargo(id);
  if (!cargo) throw new Error('Cargo no encontrado.');
  const users = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM users WHERE esam_roles LIKE '%"' || ? || '"%'`,
    cargo.name,
  )?.c ?? 0;
  if (users > 0) throw new Error(`No podés eliminar «${cargo.name}»: ${users} persona${users === 1 ? '' : 's'} lo tiene asignado.`);
  const children = get<{ c: number }>('SELECT COUNT(*) AS c FROM cargos WHERE parent_id = ?', id)?.c ?? 0;
  if (children > 0) throw new Error(`No podés eliminar «${cargo.name}»: ${children} cargo${children === 1 ? '' : 's'} depende${children === 1 ? '' : 'n'} de él.`);
  run('DELETE FROM cargos WHERE id = ?', id);
}
