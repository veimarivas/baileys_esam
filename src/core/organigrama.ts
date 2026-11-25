import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { esamEsAdmin, esamEsGerenteSede, esamRoles, findById, type UserRow } from '../auth/users.js';

/**
 * Organigrama por PERSONAS (PLAN_ORGANIGRAMA.md, L0).
 *
 * `/cargos` define qué cargo depende de cuál (Asesor → Supervisor → Gerente de
 * Marketing). Acá cada persona tiene su jefe directo (`users.jefe_id`), y eso
 * decide qué leads ve cada uno (`alcanceLeads`). Reglas:
 *
 * - Jefe y persona en la misma sede; un solo jefe por persona.
 * - El cargo del jefe es el cargo del que depende el cargo de la persona.
 *   Un cargo raíz de un área (p. ej. Gerente de Marketing) depende del
 *   Gerente General de la sede.
 * - Sin ciclos. El SSO de cronogramas nunca toca `jefe_id`.
 * - Editan el Super Admin y el Gerente General de esa sede.
 */

export const CARGO_GERENTE_SEDE = 'Gerente General';

/** Nombres de rol de cronogramas que equivalen a un cargo de `/cargos`. */
const ALIAS_CARGO: Record<string, string> = {
  'Gerencia Marketing': 'Gerente de Marketing',
};

interface CargoLite {
  id: number;
  name: string;
  area: string;
  parent_id: number | null;
}

type Persona = UserRow & { jefe_id: number | null };

function persona(id: number): Persona | undefined {
  return findById(id) as Persona | undefined;
}

/** Cargo de una persona según `/cargos` (el primero de sus roles que exista). */
export function cargoDe(user: UserRow): CargoLite | null {
  for (const rol of esamRoles(user)) {
    const nombre = ALIAS_CARGO[rol] ?? rol;
    const cargo = get<CargoLite>(
      'SELECT id, name, area, parent_id FROM cargos WHERE active = 1 AND name = ? COLLATE NOCASE',
      nombre,
    );
    if (cargo) return cargo;
  }
  return null;
}

function esGerenteDeSede(user: UserRow): boolean {
  return esamRoles(user).includes(CARGO_GERENTE_SEDE);
}

/** Personas activas de una sede. */
function personasDeSede(sedeId: number): Persona[] {
  return all<Persona>('SELECT * FROM users WHERE sede_id = ? AND esam_autorizado = 1 ORDER BY name COLLATE NOCASE', sedeId);
}

/**
 * Quiénes pueden ser jefe directo de `user` en su sede, según `/cargos`.
 * Vacío si la persona no tiene sede o cargo, o si es el Gerente General.
 */
export function jefesValidos(user: UserRow): Persona[] {
  if (!user.sede_id || esGerenteDeSede(user)) return [];
  const cargo = cargoDe(user);
  if (!cargo) return [];

  const candidatos = personasDeSede(user.sede_id).filter((p) => p.id !== user.id);

  if (cargo.parent_id) {
    const padre = get<{ name: string }>('SELECT name FROM cargos WHERE id = ?', cargo.parent_id);
    if (!padre) return [];
    return candidatos.filter((p) => cargoDe(p)?.id === cargo.parent_id);
  }

  // Cargo raíz de su área: depende del Gerente General de la sede.
  return candidatos.filter((p) => esGerenteDeSede(p));
}

/** ¿`jefeId` está por encima de `userId` (o es él)? Evita ciclos. */
function formaCiclo(userId: number, jefeId: number): boolean {
  const vistos = new Set<number>();
  let actual: number | null = jefeId;
  while (actual) {
    if (actual === userId || vistos.has(actual)) return true;
    vistos.add(actual);
    actual = get<{ jefe_id: number | null }>('SELECT jefe_id FROM users WHERE id = ?', actual)?.jefe_id ?? null;
  }
  return false;
}

/** Super Admin, o el Gerente General de esa sede. */
export function puedeEditarOrganigrama(actor: UserRow, sedeId: number | null): boolean {
  if (esamEsAdmin(actor)) return true;
  return !!sedeId && esamEsGerenteSede(actor) && actor.sede_id === sedeId;
}

function registrarCambio(userId: number, anterior: number | null, nuevo: number | null, actorId: number | null, motivo: string): void {
  const now = nowIso();
  run(
    'INSERT INTO organigrama_cambios (user_id, jefe_anterior, jefe_nuevo, cambiado_por, motivo, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    userId,
    anterior,
    nuevo,
    actorId,
    motivo,
    now,
  );
  run(
    'INSERT INTO audit_logs (action, context, created_at) VALUES (?, ?, ?)',
    'organigrama.jefe',
    JSON.stringify({ user_id: userId, jefe_anterior: anterior, jefe_nuevo: nuevo, cambiado_por: actorId, motivo }),
    now,
  );
}

/**
 * Asigna (o quita, con `null`) el jefe directo de una persona.
 * Lanza Error con un mensaje para mostrar si no corresponde.
 */
export function asignarJefe(actor: UserRow, userId: number, jefeId: number | null): void {
  const user = persona(userId);
  if (!user) throw new Error('Persona no encontrada.');
  if (!puedeEditarOrganigrama(actor, user.sede_id)) {
    throw new Error('Solo el Super Admin o el Gerente General de la sede pueden cambiar el organigrama.');
  }

  const anterior = user.jefe_id ?? null;
  if (jefeId === anterior) return;

  if (jefeId !== null) {
    if (jefeId === user.id) throw new Error('Una persona no puede depender de sí misma.');
    const jefe = persona(jefeId);
    if (!jefe || !jefe.esam_autorizado) throw new Error('El jefe elegido no existe o no está activo.');
    if (jefe.sede_id !== user.sede_id) throw new Error('El jefe tiene que ser de la misma sede.');
    if (!jefesValidos(user).some((p) => p.id === jefeId)) {
      const cargo = cargoDe(user);
      throw new Error(`${jefe.name ?? 'Esa persona'} no puede ser jefe de un${cargo ? ` ${cargo.name}` : 'a persona sin cargo'}: revisá de qué cargo depende en «Cargos y organigrama».`);
    }
    if (formaCiclo(user.id, jefeId)) throw new Error('Ese cambio formaría un círculo en el organigrama.');
  }

  run('UPDATE users SET jefe_id = ?, updated_at = ? WHERE id = ?', jefeId, nowIso(), user.id);
  registrarCambio(user.id, anterior, jefeId, actor.id, 'manual');
}

/**
 * Después de cambiar el cargo, la sede o el estado de alguien: si su jefe (o
 * el de su gente) ya no corresponde, la dependencia se suelta y queda en
 * «Sin jefe asignado». Nunca queda colgando de alguien que no puede ser su jefe.
 */
export function revalidarDependencias(userId: number, actorId: number | null = null): void {
  const revisar = (p: Persona): void => {
    if (!p.jefe_id) return;
    const sigueValido = p.esam_autorizado && jefesValidos(p).some((j) => j.id === p.jefe_id);
    if (sigueValido) return;
    run('UPDATE users SET jefe_id = NULL, updated_at = ? WHERE id = ?', nowIso(), p.id);
    registrarCambio(p.id, p.jefe_id, null, actorId, 'automatico');
  };

  const user = persona(userId);
  if (!user) return;
  revisar(user);
  for (const sub of all<Persona>('SELECT * FROM users WHERE jefe_id = ?', userId)) revisar(sub);
}

/**
 * Ids de usuarios cuyos leads ve `user`. `null` = todos (Super Admin).
 *
 * - Gerente General: todas las personas de marketing de su sede (y él).
 * - Cualquier otro: él y todo su subárbol por `jefe_id` (el Gerente de
 *   Marketing ve a sus supervisores y a los asesores de ellos; el supervisor,
 *   a sus asesores; el asesor, solo a él).
 */
export function alcanceLeads(user: UserRow): number[] | null {
  if (esamEsAdmin(user)) return null;

  if (esamEsGerenteSede(user) && user.sede_id) {
    const ids = all<{ id: number }>(
      `SELECT id FROM users WHERE sede_id = ? AND (LOWER(COALESCE(esam_area, '')) = 'marketing' OR id = ?)`,
      user.sede_id,
      user.id,
    ).map((r) => r.id);
    return [...new Set([user.id, ...ids])];
  }

  return all<{ id: number }>(
    `WITH RECURSIVE equipo(id, nivel) AS (
       SELECT id, 0 FROM users WHERE id = ?
       UNION
       SELECT u.id, e.nivel + 1 FROM users u JOIN equipo e ON u.jefe_id = e.id WHERE e.nivel < 20
     )
     SELECT DISTINCT id FROM equipo`,
    user.id,
  ).map((r) => r.id);
}

/** ¿`user` puede ver los leads de `ownerUserId`? */
export function puedeVerLeadsDe(user: UserRow, ownerUserId: number): boolean {
  const alcance = alcanceLeads(user);
  return alcance === null || alcance.includes(ownerUserId);
}

export interface NodoOrganigrama {
  id: number;
  nombre: string;
  cargo: string | null;
  area: string | null;
  jefe_id: number | null;
  hijos: NodoOrganigrama[];
}

/**
 * Árbol de personas de una sede: raíces (sin jefe y con cargo raíz, p. ej. el
 * Gerente General) y quienes todavía no tienen jefe asignado.
 */
export function organigramaDeSede(sedeId: number): { raices: NodoOrganigrama[]; sinJefe: NodoOrganigrama[] } {
  const personas = personasDeSede(sedeId);
  const nodos = new Map<number, NodoOrganigrama>(
    personas.map((p) => {
      const cargo = cargoDe(p);
      return [p.id, { id: p.id, nombre: p.name ?? p.username ?? '—', cargo: cargo?.name ?? null, area: cargo?.area ?? null, jefe_id: p.jefe_id ?? null, hijos: [] }];
    }),
  );

  const raices: NodoOrganigrama[] = [];
  const sinJefe: NodoOrganigrama[] = [];
  for (const p of personas) {
    const nodo = nodos.get(p.id)!;
    const jefe = p.jefe_id ? nodos.get(p.jefe_id) : undefined;
    if (jefe) jefe.hijos.push(nodo);
    else if (esGerenteDeSede(p)) raices.push(nodo);
    else sinJefe.push(nodo);
  }

  return { raices, sinJefe };
}
