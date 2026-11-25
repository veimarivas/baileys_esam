import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { esamEsAdmin, esamEsGerenteSede, esamRoles, findById, type UserRow } from '../auth/users.js';

/**
 * Organigrama por PERSONAS y por SEDE (PLAN_ORGANIGRAMA.md).
 *
 * `/cargos` define qué cargo depende de cuál (Asesor → Supervisor → Gerente de
 * Marketing). Cada persona es miembro de una o más sedes (`sede_miembros`):
 * la de `users.sede_id` es su sede principal, y un gerente o supervisor que
 * trabaja también en otra sede tiene ahí otra membresía, con su propio jefe.
 * Eso decide qué leads ve cada uno (`alcanceLeads`). Reglas:
 *
 * - Dentro de cada sede: un solo jefe por persona, miembro de esa misma sede.
 * - El cargo del jefe es el cargo del que depende el cargo de la persona.
 *   Un cargo raíz de un área (p. ej. Gerente de Marketing) depende del
 *   Gerente Regional de la sede.
 * - Sin ciclos. El SSO de cronogramas nunca toca las dependencias.
 * - Editan el Super Admin y el Gerente Regional de esa sede.
 * - «Control de Sedes»: ve los leads de TODAS las sedes (solo mira y comenta);
 *   no edita el organigrama ni mueve etapas.
 */

export const CARGO_GERENTE_SEDE = 'Gerente Regional';
/** Personal que controla todas las sedes (ve todos los leads y el análisis). */
export const CARGO_CONTROL = 'Control de Sedes';

/** Nombres de rol de cronogramas que equivalen a un cargo de `/cargos`. */
const ALIAS_CARGO: Record<string, string> = {
  'Gerencia Marketing': 'Gerente de Marketing',
  'Gerente General': 'Gerente Regional',
};

interface CargoLite {
  id: number;
  name: string;
  area: string;
  parent_id: number | null;
}

interface Membresia {
  user_id: number;
  sede_id: number;
  jefe_id: number | null;
  principal: number;
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
  return esamRoles(user).includes(CARGO_GERENTE_SEDE) || esamRoles(user).includes('Gerente General');
}

/** ¿Es personal de control de todas las sedes? */
export function esControlDeSedes(user: UserRow): boolean {
  return !esamEsAdmin(user) && esamRoles(user).includes(CARGO_CONTROL);
}

// ── Membresías ────────────────────────────────────────────────────────────

/**
 * Deja la membresía de la sede principal (`users.sede_id`) al día. Si la
 * persona cambió de sede principal, la membresía principal se muda (sin jefe:
 * en la sede nueva hay que ubicarla). Las membresías extra no se tocan.
 */
export function sincronizarSedePrincipal(userId: number): void {
  const user = findById(userId);
  if (!user) return;
  const principal = get<Membresia>('SELECT * FROM sede_miembros WHERE user_id = ? AND principal = 1', userId);

  if (!user.sede_id) {
    if (principal) run('UPDATE sede_miembros SET principal = 0 WHERE user_id = ? AND sede_id = ?', userId, principal.sede_id);
    return;
  }
  if (principal?.sede_id === user.sede_id) return;

  const yaMiembro = get<Membresia>('SELECT * FROM sede_miembros WHERE user_id = ? AND sede_id = ?', userId, user.sede_id);
  run('UPDATE sede_miembros SET principal = 0 WHERE user_id = ?', userId);
  if (yaMiembro) {
    run('UPDATE sede_miembros SET principal = 1 WHERE user_id = ? AND sede_id = ?', userId, user.sede_id);
  } else if (principal) {
    run('UPDATE sede_miembros SET sede_id = ?, jefe_id = NULL, principal = 1 WHERE user_id = ? AND sede_id = ?', user.sede_id, userId, principal.sede_id);
    // Quienes dependían de esta persona en la sede vieja quedan sin jefe.
    for (const sub of all<Membresia>('SELECT * FROM sede_miembros WHERE jefe_id = ? AND sede_id = ?', userId, principal.sede_id)) {
      run('UPDATE sede_miembros SET jefe_id = NULL WHERE user_id = ? AND sede_id = ?', sub.user_id, sub.sede_id);
      registrarCambio(sub.user_id, sub.sede_id, userId, null, null, 'automatico');
    }
  } else {
    run('INSERT INTO sede_miembros (user_id, sede_id, jefe_id, principal, created_at) VALUES (?, ?, NULL, 1, ?)', userId, user.sede_id, nowIso());
  }
}

/** Sedes de una persona (la principal primero). */
export function sedesDe(userId: number): Array<{ sede_id: number; nombre: string; principal: boolean; jefe_id: number | null }> {
  return all<{ sede_id: number; nombre: string; principal: number; jefe_id: number | null }>(
    `SELECT m.sede_id, s.name AS nombre, m.principal, m.jefe_id
       FROM sede_miembros m JOIN sedes s ON s.id = m.sede_id
      WHERE m.user_id = ? ORDER BY m.principal DESC, s.name COLLATE NOCASE`,
    userId,
  ).map((r) => ({ ...r, principal: !!r.principal }));
}

function membresia(userId: number, sedeId: number): Membresia | undefined {
  return get<Membresia>('SELECT * FROM sede_miembros WHERE user_id = ? AND sede_id = ?', userId, sedeId);
}

/** Personas activas miembro de una sede. */
function personasDeSede(sedeId: number): Array<UserRow & { jefe_id: number | null; principal: number }> {
  return all<UserRow & { jefe_id: number | null; principal: number }>(
    `SELECT u.*, m.jefe_id AS jefe_id, m.principal AS principal
       FROM sede_miembros m JOIN users u ON u.id = m.user_id
      WHERE m.sede_id = ? AND u.esam_autorizado = 1
      ORDER BY u.name COLLATE NOCASE`,
    sedeId,
  );
}

/** Cargos que pueden estar en más de una sede: los que tienen gente a cargo. */
function esCargoDeJefe(user: UserRow): boolean {
  if (esGerenteDeSede(user)) return true;
  const cargo = cargoDe(user);
  return !!cargo && !!get<{ id: number }>('SELECT id FROM cargos WHERE parent_id = ? AND active = 1 LIMIT 1', cargo.id);
}

/** Gerentes y supervisores de OTRAS sedes que se pueden sumar a esta. */
export function candidatosDeOtrasSedes(sedeId: number): Array<{ id: number; nombre: string; cargo: string | null; sedes: string }> {
  return all<UserRow>(
    `SELECT u.* FROM users u
      WHERE u.esam_autorizado = 1
        AND NOT EXISTS (SELECT 1 FROM sede_miembros m WHERE m.user_id = u.id AND m.sede_id = ?)
        AND EXISTS (SELECT 1 FROM sede_miembros m WHERE m.user_id = u.id)
      ORDER BY u.name COLLATE NOCASE`,
    sedeId,
  )
    .filter(esCargoDeJefe)
    .map((u) => ({
      id: u.id,
      nombre: u.name ?? u.username ?? '—',
      cargo: cargoDe(u)?.name ?? null,
      sedes: sedesDe(u.id).map((s) => s.nombre).join(', '),
    }));
}

/** Suma a un gerente o supervisor de otra sede a esta (sin jefe todavía). */
export function agregarASede(actor: UserRow, sedeId: number, userId: number): void {
  if (!puedeEditarOrganigrama(actor, sedeId)) throw new Error('Solo el Super Admin o el Gerente Regional de la sede pueden cambiar el organigrama.');
  const user = findById(userId);
  if (!user || !user.esam_autorizado) throw new Error('Persona no encontrada.');
  if (!esCargoDeJefe(user)) throw new Error('Solo gerentes y supervisores pueden estar en más de una sede.');
  if (membresia(userId, sedeId)) return;
  run('INSERT INTO sede_miembros (user_id, sede_id, jefe_id, principal, created_at) VALUES (?, ?, NULL, 0, ?)', userId, sedeId, nowIso());
  registrarCambio(userId, sedeId, null, null, actor.id, 'agregado a la sede');
}

/** Saca a alguien de una sede que no es la suya principal; su gente ahí queda sin jefe. */
export function quitarDeSede(actor: UserRow, sedeId: number, userId: number): void {
  if (!puedeEditarOrganigrama(actor, sedeId)) throw new Error('Solo el Super Admin o el Gerente Regional de la sede pueden cambiar el organigrama.');
  const m = membresia(userId, sedeId);
  if (!m) return;
  if (m.principal) throw new Error('Es su sede principal: se cambia desde la ficha del usuario.');
  for (const sub of all<Membresia>('SELECT * FROM sede_miembros WHERE jefe_id = ? AND sede_id = ?', userId, sedeId)) {
    run('UPDATE sede_miembros SET jefe_id = NULL WHERE user_id = ? AND sede_id = ?', sub.user_id, sedeId);
    registrarCambio(sub.user_id, sedeId, userId, null, actor.id, 'automatico');
  }
  run('DELETE FROM sede_miembros WHERE user_id = ? AND sede_id = ?', userId, sedeId);
  registrarCambio(userId, sedeId, m.jefe_id, null, actor.id, 'quitado de la sede');
}

// ── Jefes ─────────────────────────────────────────────────────────────────

/**
 * Quiénes pueden ser jefe directo de `user` en una sede (por defecto la
 * principal), según `/cargos`. Vacío si no es miembro, no tiene cargo o es el
 * Gerente Regional.
 */
export function jefesValidos(user: UserRow, sedeId: number | null = user.sede_id): Array<UserRow & { jefe_id: number | null }> {
  if (!sedeId || esGerenteDeSede(user) || esControlDeSedes(user) || !membresia(user.id, sedeId)) return [];
  const cargo = cargoDe(user);
  if (!cargo) return [];

  const candidatos = personasDeSede(sedeId).filter((p) => p.id !== user.id);
  if (cargo.parent_id) return candidatos.filter((p) => cargoDe(p)?.id === cargo.parent_id);
  // Cargo raíz de su área: depende del Gerente Regional de la sede.
  return candidatos.filter((p) => esGerenteDeSede(p));
}

/** ¿`jefeId` está por encima de `userId` (o es él) en esa sede? Evita ciclos. */
function formaCiclo(userId: number, jefeId: number, sedeId: number): boolean {
  const vistos = new Set<number>();
  let actual: number | null = jefeId;
  while (actual) {
    if (actual === userId || vistos.has(actual)) return true;
    vistos.add(actual);
    actual = membresia(actual, sedeId)?.jefe_id ?? null;
  }
  return false;
}

/** Super Admin, o un Gerente Regional miembro de esa sede. */
export function puedeEditarOrganigrama(actor: UserRow, sedeId: number | null): boolean {
  if (esamEsAdmin(actor)) return true;
  return !!sedeId && esamEsGerenteSede(actor) && !!membresia(actor.id, sedeId);
}

function registrarCambio(userId: number, sedeId: number | null, anterior: number | null, nuevo: number | null, actorId: number | null, motivo: string): void {
  const now = nowIso();
  run(
    'INSERT INTO organigrama_cambios (user_id, sede_id, jefe_anterior, jefe_nuevo, cambiado_por, motivo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    userId,
    sedeId,
    anterior,
    nuevo,
    actorId,
    motivo,
    now,
  );
  run(
    'INSERT INTO audit_logs (action, context, created_at) VALUES (?, ?, ?)',
    'organigrama.jefe',
    JSON.stringify({ user_id: userId, sede_id: sedeId, jefe_anterior: anterior, jefe_nuevo: nuevo, cambiado_por: actorId, motivo }),
    now,
  );
}

/**
 * Asigna (o quita, con `null`) el jefe directo de una persona en una sede
 * (por defecto su sede principal). Lanza Error con un mensaje para mostrar.
 */
export function asignarJefe(actor: UserRow, userId: number, jefeId: number | null, sedeId?: number | null): void {
  const user = findById(userId);
  if (!user) throw new Error('Persona no encontrada.');
  sincronizarSedePrincipal(userId);
  const sede = sedeId ?? user.sede_id;
  if (!sede) throw new Error('La persona no tiene sede.');
  if (!puedeEditarOrganigrama(actor, sede)) {
    throw new Error('Solo el Super Admin o el Gerente Regional de la sede pueden cambiar el organigrama.');
  }
  const m = membresia(userId, sede);
  if (!m) throw new Error('Esa persona no es de esta sede.');

  const anterior = m.jefe_id ?? null;
  if (jefeId === anterior) return;

  if (jefeId !== null) {
    if (jefeId === user.id) throw new Error('Una persona no puede depender de sí misma.');
    const jefe = findById(jefeId);
    if (!jefe || !jefe.esam_autorizado) throw new Error('El jefe elegido no existe o no está activo.');
    if (!membresia(jefeId, sede)) throw new Error('El jefe tiene que ser de la misma sede.');
    if (!jefesValidos(user, sede).some((p) => p.id === jefeId)) {
      const cargo = cargoDe(user);
      throw new Error(`${jefe.name ?? 'Esa persona'} no puede ser jefe de un${cargo ? ` ${cargo.name}` : 'a persona sin cargo'}: revisá de qué cargo depende en «Cargos y organigrama».`);
    }
    if (formaCiclo(user.id, jefeId, sede)) throw new Error('Ese cambio formaría un círculo en el organigrama.');
  }

  run('UPDATE sede_miembros SET jefe_id = ? WHERE user_id = ? AND sede_id = ?', jefeId, user.id, sede);
  registrarCambio(user.id, sede, anterior, jefeId, actor.id, 'manual');
}

/**
 * Después de cambiar el cargo, la sede o el estado de alguien: su sede
 * principal se sincroniza y, en cada sede, si su jefe (o el de su gente) ya
 * no corresponde, la dependencia se suelta y queda en «Sin jefe asignado».
 */
export function revalidarDependencias(userId: number, actorId: number | null = null): void {
  sincronizarSedePrincipal(userId);
  const revisar = (m: Membresia): void => {
    if (!m.jefe_id) return;
    const u = findById(m.user_id);
    const sigueValido = !!u && !!u.esam_autorizado && jefesValidos(u, m.sede_id).some((j) => j.id === m.jefe_id);
    if (sigueValido) return;
    run('UPDATE sede_miembros SET jefe_id = NULL WHERE user_id = ? AND sede_id = ?', m.user_id, m.sede_id);
    registrarCambio(m.user_id, m.sede_id, m.jefe_id, null, actorId, 'automatico');
  };

  for (const m of all<Membresia>('SELECT * FROM sede_miembros WHERE user_id = ?', userId)) revisar(m);
  for (const sub of all<Membresia>('SELECT * FROM sede_miembros WHERE jefe_id = ?', userId)) revisar(sub);
}

// ── Alcance ───────────────────────────────────────────────────────────────

/**
 * Ids de usuarios cuyos leads ve `user`. `null` = todos.
 *
 * - Super Admin y «Control de Sedes»: todos.
 * - Gerente Regional: todas las personas de marketing de CADA sede donde es
 *   gerente (y él).
 * - Cualquier otro: él y todo su subárbol, sede por sede (un supervisor en dos
 *   sedes ve a sus asesores de las dos).
 */
export function alcanceLeads(user: UserRow): number[] | null {
  if (esamEsAdmin(user) || esControlDeSedes(user)) return null;

  if (esamEsGerenteSede(user)) {
    const ids = all<{ id: number }>(
      `SELECT DISTINCT u.id FROM sede_miembros m JOIN users u ON u.id = m.user_id
        WHERE m.sede_id IN (SELECT sede_id FROM sede_miembros WHERE user_id = ?)
          AND LOWER(COALESCE(u.esam_area, '')) = 'marketing'`,
      user.id,
    ).map((r) => r.id);
    return [...new Set([user.id, ...ids])];
  }

  const ids = all<{ id: number }>(
    `WITH RECURSIVE equipo(user_id, sede_id, nivel) AS (
       SELECT user_id, sede_id, 0 FROM sede_miembros WHERE user_id = ?
       UNION
       SELECT m.user_id, m.sede_id, e.nivel + 1
         FROM sede_miembros m JOIN equipo e ON m.jefe_id = e.user_id AND m.sede_id = e.sede_id
        WHERE e.nivel < 20
     )
     SELECT DISTINCT user_id AS id FROM equipo`,
    user.id,
  ).map((r) => r.id);
  return [...new Set([user.id, ...ids])];
}

/** ¿`user` puede ver los leads de `ownerUserId`? */
export function puedeVerLeadsDe(user: UserRow, ownerUserId: number): boolean {
  const alcance = alcanceLeads(user);
  return alcance === null || alcance.includes(ownerUserId);
}

/** Jefe directo de una persona en alguna de sus sedes que esté dentro de `alcance` (para las migas). */
export function jefeVisible(userId: number, alcance: number[] | null): number | null {
  const jefes = all<{ jefe_id: number }>('SELECT jefe_id FROM sede_miembros WHERE user_id = ? AND jefe_id IS NOT NULL ORDER BY principal DESC', userId);
  return jefes.find((j) => !alcance || alcance.includes(j.jefe_id))?.jefe_id ?? null;
}

/** Personas que dependen directo de `jefeId` (en una sede, o en cualquiera de las suyas). */
export function directosDe(jefeId: number, sedeId: number | null = null): UserRow[] {
  return all<UserRow>(
    `SELECT DISTINCT u.* FROM sede_miembros m JOIN users u ON u.id = m.user_id
      WHERE m.jefe_id = ? AND u.esam_autorizado = 1 ${sedeId ? 'AND m.sede_id = ?' : ''}
      ORDER BY u.name COLLATE NOCASE`,
    ...(sedeId ? [jefeId, sedeId] : [jefeId]),
  );
}

// ── Cifras y árbol ────────────────────────────────────────────────────────

/** Días sin actividad para que un lead abierto cuente como «sin movimiento». */
export const DIAS_SIN_MOVIMIENTO = 7;

export interface MetricasLeads {
  abiertos: number;
  sinContactar: number;
  sinMovimiento: number;
}

/**
 * Cifras de control de los leads PROPIOS de cada persona en esa sede (las del
 * equipo se suman en la vista recorriendo el árbol).
 */
export function metricasLeadsDeSede(sedeId: number, ahora: Date = new Date()): Map<number, MetricasLeads> {
  const limite = new Date(ahora.getTime() - DIAS_SIN_MOVIMIENTO * 86_400_000).toISOString();
  const filas = all<{ owner_user_id: number; abiertos: number; sin_contactar: number; sin_movimiento: number }>(
    `SELECT l.owner_user_id,
            COUNT(*) AS abiertos,
            SUM(CASE WHEN l.etapa = 'nuevo' AND l.ultimo_contacto_at IS NULL THEN 1 ELSE 0 END) AS sin_contactar,
            SUM(CASE WHEN l.ultima_actividad_at < ? THEN 1 ELSE 0 END) AS sin_movimiento
       FROM leads l JOIN sede_miembros m ON m.user_id = l.owner_user_id AND m.sede_id = ?
      WHERE (l.sede_id = ? OR (l.sede_id IS NULL AND m.principal = 1))
        AND l.etapa NOT IN ('no_interesado', 'inscrito')
      GROUP BY l.owner_user_id`,
    limite,
    sedeId,
    sedeId,
  );
  return new Map(filas.map((f) => [f.owner_user_id, { abiertos: f.abiertos, sinContactar: f.sin_contactar, sinMovimiento: f.sin_movimiento }]));
}

export interface NodoOrganigrama {
  id: number;
  nombre: string;
  cargo: string | null;
  area: string | null;
  jefe_id: number | null;
  /** Su sede principal es otra (está acá como segunda sede). */
  deOtraSede: boolean;
  hijos: NodoOrganigrama[];
}

/**
 * Árbol de personas de una sede: raíces (el Gerente Regional) y quienes
 * todavía no tienen jefe asignado en esta sede.
 */
export function organigramaDeSede(sedeId: number): { raices: NodoOrganigrama[]; sinJefe: NodoOrganigrama[] } {
  // El personal de control mira todas las sedes: no es parte del organigrama de una.
  const personas = personasDeSede(sedeId).filter((p) => !esControlDeSedes(p));
  const nodos = new Map<number, NodoOrganigrama>(
    personas.map((p) => {
      const cargo = cargoDe(p);
      return [p.id, {
        id: p.id, nombre: p.name ?? p.username ?? '—', cargo: cargo?.name ?? null, area: cargo?.area ?? null,
        jefe_id: p.jefe_id ?? null, deOtraSede: !p.principal, hijos: [],
      }];
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
