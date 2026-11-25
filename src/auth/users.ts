import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { normalizePhone } from '../core/phone.js';
import { AREA_KEY, areaOfCargo, cargoExists } from '../core/cargos.js';
import { revalidarDependencias } from '../core/organigrama.js';

export interface UserRow {
  id: number;
  name: string | null;
  username: string | null;
  email: string | null;
  /** Carnet de identidad (cuentas locales). */
  ci: string | null;
  password: string;
  source: string;
  source_uid: string | null;
  esam_autorizado: number;
  esam_area: string | null;
  esam_numero: string | null;
  esam_roles: string | null;
  /** Sede a la que pertenece el usuario (usuarios locales y de cronogramas). */
  sede_id: number | null;
  /** Jefe directo en el organigrama de su sede (PLAN_ORGANIGRAMA.md). */
  jefe_id?: number | null;
  last_login_at: string | null;
  last_login_ip: string | null;
  login_count: number;
  created_at: string;
  updated_at: string;
}

// ── Roles / control de acceso (espejo de config/esam.php) ─────────────────────

/**
 * Único rol de cronogramas con acceso completo al panel. El resto (incluido
 * «Administrador») solo usa Conversaciones y Notas y tareas de su propio número.
 */
export const ESAM_ADMINS = ['Super Admin'];

/**
 * Áreas de la institución y los cargos de cada una. El formulario de usuarios
 * pide primero el área y después el cargo, para que no se mezclen puestos de
 * áreas distintas.
 */
export const LOCAL_CARGOS_POR_AREA: Record<string, string[]> = {
  Marketing: ['Gerente de Marketing', 'Supervisor de Marketing', 'Asesor de Marketing'],
  Contabilidad: ['Contador General', 'Analista Contable', 'Auxiliar Contable'],
  Académica: ['Director Académico', 'Coordinador Académico', 'Asesor Académico'],
  Dirección: ['Gerente Regional'],
};

/** Cargos válidos para una cuenta local (todas las áreas). */
export const LOCAL_CARGOS = Object.values(LOCAL_CARGOS_POR_AREA).flat() as readonly string[];

export type LocalCargo = string;

/** Área a la que pertenece cada cargo (clave interna, igual que `esam_area`). */
export const LOCAL_CARGO_AREA: Record<string, string> = {
  'Gerente de Marketing': 'marketing',
  'Supervisor de Marketing': 'marketing',
  'Asesor de Marketing': 'marketing',
  'Contador General': 'contabilidad',
  'Analista Contable': 'contabilidad',
  'Auxiliar Contable': 'contabilidad',
  'Director Académico': 'academico',
  'Coordinador Académico': 'academico',
  'Asesor Académico': 'academico',
  'Gerente Regional': 'general',
  'Gerente General': 'general',
};

export const ROLE_AREAS: Record<string, string> = {
  'Super Admin': 'admin',
  Administrador: 'admin',
  Consulta: 'consulta',
  Contabilidad: 'contabilidad',
  Academicos: 'academico',
  'Responsable Académico': 'academico',
  'Asesor de Marketing': 'marketing',
  'Gerencia Marketing': 'marketing',
  'Gerente de Marketing': 'marketing',
  'Supervisor de Marketing': 'marketing',
  'Contador General': 'contabilidad',
  'Analista Contable': 'contabilidad',
  'Auxiliar Contable': 'contabilidad',
  'Director Académico': 'academico',
  'Coordinador Académico': 'academico',
  'Asesor Académico': 'academico',
  'Gerente Regional': 'general',
  'Gerente General': 'general',
};

/** Secciones de quien no es Super Admin: su bandeja, notas y tareas, y su conexión (QR). */
export const NON_ADMIN_SECTIONS = ['conversations', 'settings'];

export const SECTION_AREAS: Record<string, string[]> = {
  settings: ['admin'],
  conversations: ['admin'],
  diagnostics: ['admin'],
  reports: ['admin'],
  monitoring: ['admin'],
  policies: ['admin'],
  optouts: ['admin'],
  audit: ['admin'],
  stickers: ['admin'],
  contacts: ['admin'],
  templates: ['admin'],
  batches: ['admin'],
  messages: ['admin'],
  autoreplies: ['admin'],
  users: ['admin'],
};

export function esamRoles(user: UserRow): string[] {
  if (!user.esam_roles) return [];
  try {
    const parsed = JSON.parse(user.esam_roles);
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

export function esamAreas(user: UserRow): string[] {
  const areas = esamRoles(user).map((rol) => ROLE_AREAS[rol]).filter((a): a is string => !!a);
  return [...new Set(areas)];
}

export function esamEsAdmin(user: UserRow): boolean {
  const roles = esamRoles(user);
  if (roles.includes('Super Admin')) return true;
  // Cuenta local inicial (creada antes de los cargos): sigue siendo Super Admin.
  return user.source === 'local' && roles.length === 0;
}

/** ¿Es gerente regional de una sede? Accede a todas las líneas de su sede. */
export function esamEsGerenteSede(user: UserRow): boolean {
  return !esamEsAdmin(user) && (esamRoles(user).includes('Gerente Regional') || esamRoles(user).includes('Gerente General'));
}

/** Gerente o supervisor de Marketing: supervisa el área en su sede. */
export function esamEsMarketingManager(user: UserRow): boolean {
  if (esamEsAdmin(user)) return false;
  const roles = esamRoles(user);
  return roles.includes('Gerente de Marketing')
    || roles.includes('Gerencia Marketing')
    || roles.includes('Supervisor de Marketing');
}

export function esamEsAsesorMarketing(user: UserRow): boolean {
  return !esamEsAdmin(user) && esamRoles(user).includes('Asesor de Marketing');
}

/** Roles de cronogramas que supervisan todo el seguimiento de un área en /notes. */
const AREA_SUPERVISORS: Record<string, string> = {
  'Gerencia Marketing': 'marketing',
  'Gerente de Marketing': 'marketing',
  'Supervisor de Marketing': 'marketing',
};

/**
 * Área cuyo seguimiento supervisa el usuario (ve las notas de todos sus
 * asesores), o null. El Super Admin no la necesita: ya ve todo.
 */
export function esamSupervisaArea(user: UserRow): string | null {
  if (esamEsAdmin(user)) return null;
  if (esamEsMarketingManager(user)) return 'marketing';
  for (const rol of esamRoles(user)) if (AREA_SUPERVISORS[rol]) return AREA_SUPERVISORS[rol];
  return null;
}

/**
 * Secciones visibles. El Super Admin ve todo. Los gerentes de sede y de
 * marketing acceden a las vistas operativas; su alcance de datos se limita en
 * `sessionScopeFor` a su sede/área.
 */
export function esamPuede(user: UserRow, seccion: string): boolean {
  if (esamEsAdmin(user)) return true;
  const allowed = new Set(NON_ADMIN_SECTIONS);
  if (esamEsGerenteSede(user) || esamEsMarketingManager(user)) {
    allowed.add('reports');
    allowed.add('monitoring');
  }
  // Organigrama de su sede (PLAN_ORGANIGRAMA.md): lo ve y lo edita el Gerente Regional.
  if (esamEsGerenteSede(user)) allowed.add('organigrama');
  // Leads de marketing: el área Marketing y el Gerente Regional (lo que ve cada
  // uno lo recorta el organigrama, en `alcanceLeads`).
  if (esamEsGerenteSede(user) || esamAreas(user).includes('marketing') || (user.esam_area ?? '').toLowerCase() === 'marketing') {
    allowed.add('leads');
  }
  // Oferta de programas de su sede: Gerente Regional y Gerente de Marketing.
  if (esamEsGerenteSede(user) || esamRoles(user).some((r) => r === 'Gerente de Marketing' || r === 'Gerencia Marketing')) {
    allowed.add('programas');
  }
  // «Control de Sedes»: ve los leads de todas las sedes y su análisis (solo mira y comenta).
  if (esamRoles(user).includes('Control de Sedes')) {
    allowed.add('leads');
  }
  return allowed.has(seccion);
}

export function esamHome(user: UserRow): string {
  if (esamPuede(user, 'conversations')) return '/conversations';
  if (esamPuede(user, 'settings')) return '/settings';
  return '/reports';
}

/** Nombre visible de un área interna (`marketing` -> «Marketing»). */
export function esamAreaName(area: string | null | undefined): string {
  const key = String(area ?? '').trim().toLowerCase();
  if (!key) return 'Sin área';
  const nombres: Record<string, string> = {
    contabilidad: 'Contabilidad',
    academico: 'Académica',
    marketing: 'Marketing',
    consulta: 'Consulta',
    admin: 'Administrador',
    administracion: 'Administración',
    general: 'Dirección',
  };
  return nombres[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

export function esamAreaLabel(user: UserRow): string {
  if (esamEsAdmin(user)) return 'Super Admin';
  const roles = esamRoles(user);
  if (user.source === 'local') return roles.length ? roles[0] : 'Administrador local';
  const areas = esamAreas(user);
  return areas.length ? esamAreaName(areas[0]) : 'Sin rol';
}

/**
 * Sesión de WhatsApp que le corresponde a un usuario para ver su historial.
 *
 * Regla: el historial es **siempre** el de la sesión/número del usuario.
 * - Admin **local** (cuenta de servicio del panel): ve todas (`null`).
 * - Usuario con `esam_numero` (incluidos admins de cronogramas): solo las
 *   sesiones cuyo `expected_phone`/`phone` coincide exactamente con su número.
 * - Usuario sin número: sesiones de su `owner_uid`.
 * - Usuario sin número ni `owner_uid`: ninguna (lista vacía).
 *
 * Para las vistas de Reportes, ver `reportsScopeFor` (el Super Admin ve todo).
 */
export function sessionScopeFor(user: UserRow): string[] | null {
  // La cuenta local principal administra todas las sesiones. Los usuarios de
  // cronogramas con Super Admin ven su propio número en el historial.
  if (user.source === 'local' && esamEsAdmin(user)) return null;

  // Gerente Regional: todas las líneas de su sede.
  if (esamEsGerenteSede(user) && user.sede_id) {
    return all<{ id: string }>('SELECT id FROM sessions WHERE sede_id = ?', user.sede_id).map((r) => r.id);
  }

  // Gerente/Supervisor de Marketing: las líneas de marketing de su sede.
  if (esamEsMarketingManager(user) && user.sede_id) {
    const ownerUid = user.source_uid ?? String(user.id);
    return all<{ id: string }>(
      `SELECT id FROM sessions
        WHERE sede_id = ? AND (LOWER(COALESCE(area, '')) = 'marketing' OR owner_uid = ?)`,
      user.sede_id,
      ownerUid,
    ).map((r) => r.id);
  }

  const numero = (user.esam_numero ?? '').replace(/\D+/g, '');
  if (numero) {
    // Comparación exacta de dígitos (evita que 59170000001 matchee 591700000011).
    const rows = all<{ id: string; expected_phone: string | null; phone: string | null }>(
      'SELECT id, expected_phone, phone FROM sessions',
    );
    return rows
      .filter((r) => {
        const exp = (r.expected_phone ?? '').replace(/\D+/g, '');
        const ph = (r.phone ?? '').replace(/\D+/g, '');
        return exp === numero || ph === numero;
      })
      .map((r) => r.id);
  }
  return all<{ id: string }>('SELECT id FROM sessions WHERE owner_uid = ?', user.source_uid ?? String(user.id)).map((r) => r.id);
}

/**
 * Sesión (número de WhatsApp) del usuario para el inbox.
 * - Admin: `null` (sin restricción).
 * - Usuario normal con número: sesiones cuyo `expected_phone`/`phone` coincide
 *   exactamente con su `esam_numero`.
 * - Usuario normal sin número: sesiones de su `owner_uid`.
 */
export function sessionIdsFor(user: UserRow): string[] | null {
  return sessionScopeFor(user);
}

/**
 * Alcance de Reportes: el Super Admin ve todas las líneas, no solo la suya.
 * El historial del inbox y el resto de las vistas conservan `sessionScopeFor`.
 */
export function reportsScopeFor(user: UserRow): string[] | null {
  return esamEsAdmin(user) ? null : sessionScopeFor(user);
}

// ── Consultas ─────────────────────────────────────────────────────────────────

export function findBySourceUid(uid: string): UserRow | undefined {
  return get<UserRow>('SELECT * FROM users WHERE source_uid = ?', uid);
}

export function findByLogin(login: string): UserRow | undefined {
  return get<UserRow>('SELECT * FROM users WHERE username = ? OR email = ?', login, login);
}

/**
 * Devuelve el username si está libre o si ya pertenece al mismo usuario
 * (`sourceUid`); si otro usuario lo tiene, devuelve null para no romper el
 * UNIQUE (el usuario podrá entrar por email).
 */
export function usernameAvailableFor(username: string | null | undefined, sourceUid?: string | null): string | null {
  const name = (username ?? '').trim();
  if (!name) return null;
  const row = get<{ source_uid: string | null }>('SELECT source_uid FROM users WHERE username = ?', name);
  if (!row) return name;
  if (sourceUid && row.source_uid === sourceUid) return name;
  return null;
}

export function findByEmail(email: string): UserRow | undefined {
  return get<UserRow>('SELECT * FROM users WHERE email = ?', email);
}

export function findById(id: number): UserRow | undefined {
  return get<UserRow>('SELECT * FROM users WHERE id = ?', id);
}

export function listUsers(): UserRow[] {
  return all<UserRow>('SELECT * FROM users ORDER BY id');
}

export interface UpsertUser {
  sourceUid?: string | null;
  name?: string | null;
  username?: string | null;
  email?: string | null;
  password?: string | null;
  passwordHash?: string | null;
  source?: string;
  autorizado?: boolean;
  area?: string | null;
  numero?: string | null;
  roles?: string[];
}

/**
 * Crea/actualiza un usuario espejo (SSO o registro de cuenta). La contraseña
 * solo se reemplaza cuando se envía una nueva.
 */
export function upsertUser(input: UpsertUser): UserRow {
  let user = input.sourceUid ? findBySourceUid(input.sourceUid) : undefined;
  if (!user && input.email) user = findByEmail(input.email);

  const username = (input.username ?? '').trim();
  const email = input.email || (input.sourceUid ? `cronogramas-${input.sourceUid}@esam.local` : null);

  // El número identifica a un único usuario: si ya pertenece a otra cuenta no
  // se reasigna (evita que dos usuarios compartan la misma línea de WhatsApp).
  const numeroEntrante = input.numero ? normalizePhone(input.numero) : input.numero === null ? null : undefined;
  const numeroEnUso = numeroEntrante ? userWithNumber(numeroEntrante, user?.id) : undefined;
  const numeroFinal = numeroEnUso ? undefined : numeroEntrante;

  if (!user) {
    const created = run(
      `INSERT INTO users (name, username, email, password, source, source_uid, esam_autorizado, esam_area, esam_numero, esam_roles, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name ?? 'Usuario ESAM',
      username || null,
      email,
      input.passwordHash || bcrypt.hashSync(input.password || randomUUID(), 10),
      input.source ?? 'cronogramas',
      input.sourceUid ?? null,
      input.autorizado ? 1 : 0,
      input.area ?? null,
      numeroFinal ?? null,
      JSON.stringify(input.roles ?? []),
      nowIso(),
      nowIso(),
    );
    user = findById(created.lastInsertRowid)!;
    return user;
  }

  const password = input.passwordHash || (input.password ? bcrypt.hashSync(input.password, 10) : user.password);
  run(
    `UPDATE users SET name = ?, username = COALESCE(NULLIF(?, ''), username), email = ?, password = ?,
       source = ?, source_uid = COALESCE(?, source_uid), esam_autorizado = ?, esam_area = ?, esam_numero = ?,
       esam_roles = ?, updated_at = ? WHERE id = ?`,
    input.name ?? user.name,
    username,
    email ?? user.email,
    password,
    input.source ?? user.source,
    input.sourceUid ?? null,
    input.autorizado !== undefined ? (input.autorizado ? 1 : 0) : user.esam_autorizado,
    input.area ?? user.esam_area,
    numeroFinal === undefined ? user.esam_numero : numeroFinal,
    JSON.stringify(input.roles ?? esamRoles(user)),
    nowIso(),
    user.id,
  );
  // El SSO puede cambiar el cargo: si el jefe ya no corresponde, se suelta.
  revalidarDependencias(user.id);
  return findById(user.id)!;
}

export function verifyPassword(user: UserRow, password: string): boolean {
  return bcrypt.compareSync(password, user.password);
}

export function registerLogin(userId: number, ip: string | null): void {
  run(
    'UPDATE users SET last_login_at = ?, last_login_ip = ?, login_count = login_count + 1, updated_at = ? WHERE id = ?',
    nowIso(),
    ip,
    nowIso(),
    userId,
  );
}

/** Crea el admin local inicial si no hay usuarios locales. */
export function ensureLocalAdmin(): void {
  const row = get<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE source = 'local'");
  if ((row?.c ?? 0) > 0) return;
  const username = process.env.LOCAL_ADMIN_USER ?? 'admin';
  const email = process.env.LOCAL_ADMIN_EMAIL ?? 'admin@baileys.local';
  const password = process.env.LOCAL_ADMIN_PASSWORD ?? 'admin123';
  run(
    `INSERT INTO users (name, username, email, password, source, esam_autorizado, esam_roles, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'local', 1, ?, ?, ?)`,
    'Administrador local',
    username,
    email,
    bcrypt.hashSync(password, 10),
    JSON.stringify(['Super Admin']),
    nowIso(),
    nowIso(),
  );
}

interface SessionLite {
  id: string;
  name: string;
  expected_phone: string | null;
  phone: string | null;
  owner_uid: string | null;
  area?: string | null;
  sede_id?: number | null;
}

type SessionInvalidator = (sessionId: string) => void;
let invalidateSession: SessionInvalidator | null = null;

/**
 * El proceso principal registra aquí cómo desconectar una línea en caliente.
 * Se usa cuando el número autorizado cambia y la línea está vinculada con otro.
 */
export function setSessionInvalidator(fn: SessionInvalidator | null): void {
  invalidateSession = fn;
}

function requestSessionInvalidation(ids: string[]): void {
  for (const id of ids) {
    try {
      invalidateSession?.(id);
    } catch {
      // La reconciliación en base ya quedó hecha; si falla el socket se corrige al reconectar.
    }
  }
}

function digitsOf(value: string | null | undefined): string {
  return (value ?? '').replace(/\D+/g, '');
}

/** Usuario que ya tiene registrado ese número (para impedir duplicados). */
function userWithNumber(numero: string, exceptId?: number): UserRow | undefined {
  const wanted = digitsOf(numero);
  if (!wanted) return undefined;
  const rows = all<{ id: number; name: string; esam_numero: string | null }>('SELECT id, name, esam_numero FROM users');
  const hit = rows.find((r) => r.id !== exceptId && digitsOf(r.esam_numero) === wanted);
  return hit ? findById(hit.id) : undefined;
}

/**
 * Propaga el número del usuario a sus líneas. Si una línea quedó vinculada con
 * otro número, se bloquea y se desvincula: el número registrado es la identidad
 * del usuario y no puede operar con uno distinto.
 */
export function reconcileUserNumber(user: UserRow, previousNumber?: string | null): string[] {
  const ownerUid = user.source_uid ?? String(user.id);
  const numero = digitsOf(user.esam_numero);
  const anterior = digitsOf(previousNumber);
  const now = nowIso();
  const sessions = all<SessionLite>('SELECT id, name, expected_phone, phone, owner_uid FROM sessions');
  const affected: string[] = [];
  for (const s of sessions) {
    const owns = s.owner_uid === ownerUid;
    const matchesPrevious = !!anterior && digitsOf(s.expected_phone) === anterior;
    if (!owns && !matchesPrevious) continue;

    if (!numero) {
      // Sin número autorizado no hay línea válida para este usuario.
      run(
        `UPDATE sessions
           SET expected_phone = NULL, phone = NULL, phone_verified_at = NULL,
               status = 'blocked',
               blocked_reason = 'El usuario no tiene número de WhatsApp autorizado',
               owner_uid = ?, updated_at = ?
         WHERE id = ?`,
        ownerUid,
        now,
        s.id,
      );
      affected.push(s.id);
      continue;
    }

    const vinculado = digitsOf(s.phone);
    const mismatch = !!vinculado && vinculado !== numero;
    run(
      `UPDATE sessions
         SET owner_uid = ?, owner_name = ?, owner_email = ?, expected_phone = ?,
             status = CASE WHEN ? = 1 THEN 'blocked' ELSE status END,
             blocked_reason = CASE WHEN ? = 1 THEN 'El número vinculado no es el autorizado por ESAM' ELSE blocked_reason END,
             phone = CASE WHEN ? = 1 THEN NULL ELSE phone END,
             phone_verified_at = CASE WHEN ? = 1 THEN NULL ELSE phone_verified_at END,
             updated_at = ?
       WHERE id = ?`,
      ownerUid,
      user.name,
      user.email,
      numero,
      mismatch ? 1 : 0,
      mismatch ? 1 : 0,
      mismatch ? 1 : 0,
      mismatch ? 1 : 0,
      now,
      s.id,
    );
    if (mismatch) affected.push(s.id);
  }
  requestSessionInvalidation(affected);
  return affected;
}

/**
 * Asegura que exista una sesión de WhatsApp vinculada al número del usuario y
 * la marca como suya (`owner_uid` + `expected_phone`).
 *
 * - Si ya hay una sesión con ese número (`expected_phone`/`phone` exactos), se
 *   adopta para el usuario (fija `owner_uid` y, si falta, `expected_phone`).
 * - Si no existe, se crea una **dedicada** con `expected_phone` = número del
 *   usuario, de modo que al vincular por QR solo se acepte ese número.
 *
 * Devuelve el id de la sesión o `null` si el usuario no tiene número.
 */
export function ensureUserSession(user: UserRow): string | null {
  const numero = digitsOf(user.esam_numero);
  const ownerUid = user.source_uid ?? String(user.id);
  const now = nowIso();

  if (!numero) {
    // Sin número: solo marca como suya la sesión que ya tenga por owner_uid.
    const owned = get<SessionLite>('SELECT id, name, expected_phone, phone, owner_uid FROM sessions WHERE owner_uid = ?', ownerUid);
    if (owned) {
      run(
        'UPDATE sessions SET sede_id = COALESCE(?, sede_id), area = ?, updated_at = ? WHERE id = ?',
        user.sede_id,
        user.esam_area,
        now,
        owned.id,
      );
    }
    return owned?.id ?? null;
  }

  const sessions = all<SessionLite>('SELECT id, name, expected_phone, phone, owner_uid FROM sessions');
  const match = sessions.find((s) => {
    const exp = digitsOf(s.expected_phone);
    const ph = digitsOf(s.phone);
    return exp === numero || ph === numero;
  }) ?? sessions.find((s) => s.owner_uid === ownerUid);

  if (match) {
    // El número registrado manda: si la línea tenía otro número vinculado, se
    // bloquea y se pide volver a vincular (el número es la identidad del usuario).
    const vinculado = digitsOf(match.phone);
    const mismatch = !!vinculado && vinculado !== numero;
    run(
      `UPDATE sessions
         SET owner_uid = ?, owner_name = ?, owner_email = ?,
             expected_phone = ?,
             status = CASE WHEN ? = 1 THEN 'blocked' ELSE status END,
             blocked_reason = CASE WHEN ? = 1 THEN 'El número vinculado no es el autorizado por ESAM' ELSE blocked_reason END,
             phone = CASE WHEN ? = 1 THEN NULL ELSE phone END,
             phone_verified_at = CASE WHEN ? = 1 THEN NULL ELSE phone_verified_at END,
             sede_id = COALESCE(?, sede_id),
             area = ?,
             updated_at = ?
       WHERE id = ?`,
      ownerUid,
      user.name,
      user.email,
      numero,
      mismatch ? 1 : 0,
      mismatch ? 1 : 0,
      mismatch ? 1 : 0,
      mismatch ? 1 : 0,
      user.sede_id,
      user.esam_area,
      now,
      match.id,
    );
    if (mismatch) requestSessionInvalidation([match.id]);
    return match.id;
  }

  // No hay sesión con ese número: se crea una dedicada (queda en 'created').
  const id = `user-${ownerUid}`;
  const existingById = get<SessionLite>('SELECT id, name, expected_phone, phone, owner_uid FROM sessions WHERE id = ?', id);
  if (existingById) {
    const vinculado = digitsOf(existingById.phone);
    const mismatch = !!vinculado && vinculado !== numero;
    run(
      `UPDATE sessions SET owner_uid = ?, owner_name = ?, owner_email = ?,
         expected_phone = ?,
         status = CASE WHEN ? = 1 THEN 'blocked' ELSE status END,
         blocked_reason = CASE WHEN ? = 1 THEN 'El número vinculado no es el autorizado por ESAM' ELSE blocked_reason END,
         phone = CASE WHEN ? = 1 THEN NULL ELSE phone END,
         phone_verified_at = CASE WHEN ? = 1 THEN NULL ELSE phone_verified_at END,
         sede_id = COALESCE(?, sede_id), area = ?,
         updated_at = ? WHERE id = ?`,
      ownerUid,
      user.name,
      user.email,
      numero,
      mismatch ? 1 : 0,
      mismatch ? 1 : 0,
      mismatch ? 1 : 0,
      mismatch ? 1 : 0,
      user.sede_id,
      user.esam_area,
      now,
      id,
    );
    if (mismatch) requestSessionInvalidation([id]);
    return id;
  }
  run(
    `INSERT INTO sessions (id, name, owner_uid, owner_name, owner_email, expected_phone, area, sede_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
    id,
    user.name ?? `Sesión ${numero}`,
    ownerUid,
    user.name,
    user.email,
    numero,
    user.esam_area,
    user.sede_id,
    now,
    now,
  );
  return id;
}

/**
 * Propaga sede/área a las líneas del usuario (por `owner_uid` o por número).
 * Se usa al editar una cuenta para que el alcance por sede quede al día.
 */
export function syncUserSessions(user: UserRow): void {
  const now = nowIso();
  const ownerUid = user.source_uid ?? String(user.id);
  const numero = (user.esam_numero ?? '').replace(/\D+/g, '');
  const sessions = all<SessionLite>('SELECT id, name, expected_phone, phone, owner_uid FROM sessions');
  for (const s of sessions) {
    const exp = (s.expected_phone ?? '').replace(/\D+/g, '');
    const ph = (s.phone ?? '').replace(/\D+/g, '');
    const phoneMatch = !!numero && (exp === numero || ph === numero);
    if (s.owner_uid === ownerUid || phoneMatch) {
      run(
        'UPDATE sessions SET sede_id = ?, area = ?, updated_at = ? WHERE id = ?',
        user.sede_id,
        user.esam_area,
        now,
        s.id,
      );
    }
  }
}

/** Área interna que corresponde a un cargo local (solo Marketing la usa). */
export function areaForLocalRoles(roles: string[]): string | null {
  for (const role of roles) {
    const label = areaOfCargo(role);
    if (label && AREA_KEY[label]) return AREA_KEY[label];
    const area = LOCAL_CARGO_AREA[role] ?? ROLE_AREAS[role];
    if (area) return area;
  }
  return null;
}

export interface LocalUserInput {
  name: string;
  ci?: string | null;
  username: string;
  email: string | null;
  password: string;
  numero: string;
  sedeId: number;
  roles: string[];
  autorizado?: boolean;
}

/** Crea una cuenta local (no cronogramas) con cargo y sede. */
export function createLocalUser(input: LocalUserInput): UserRow {
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const username = String(input.username ?? '').trim().slice(0, 60);
  const email = String(input.email ?? '').trim() || null;
  const ci = String(input.ci ?? '').trim().toUpperCase().slice(0, 20) || null;
  const numero = normalizePhone(input.numero);
  // La contraseña por defecto es el CI (se puede cambiar desde el formulario).
  const password = String(input.password ?? '').trim() || ci || '';
  if (!name) throw new Error('Escribí el nombre.');
  if (!ci) throw new Error('Escribí el CI.');
  if (!/^\d{6,10}(-[A-Za-z0-9]{1,3})?$/.test(ci)) throw new Error('El CI no es válido (ej.: 1234567 o 1234567-1A).');
  if (!username) throw new Error('Escribí el usuario.');
  if (!input.sedeId) throw new Error('Elegí una sede.');
  if (!input.roles.length) throw new Error('Elegí un cargo.');
  if (input.roles.some((r) => !cargoExists(r))) {
    throw new Error('El cargo elegido no es válido.');
  }
  if (password.length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres.');
  if (!numero || numero.length < 8 || numero.length > 15) throw new Error('El número de WhatsApp no es válido.');
  if (findByLogin(username)) throw new Error('Ese usuario ya existe.');
  if (email && findByEmail(email)) throw new Error('Ese correo ya está registrado.');
  if (get<{ id: number }>('SELECT id FROM users WHERE ci = ? COLLATE NOCASE', ci)) {
    throw new Error('Ese CI ya está registrado para otra persona.');
  }
  const repetido = userWithNumber(numero);
  if (repetido) throw new Error(`Ese número de WhatsApp ya está registrado para ${repetido.name}.`);
  const now = nowIso();
  const created = run(
    `INSERT INTO users (name, ci, username, email, password, source, esam_autorizado, esam_area, esam_numero,
       esam_roles, sede_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
    name,
    ci,
    username,
    email,
    bcrypt.hashSync(password, 10),
    input.autorizado === false ? 0 : 1,
    areaForLocalRoles(input.roles),
    numero,
    JSON.stringify(input.roles),
    input.sedeId,
    now,
    now,
  );
  const user = findById(created.lastInsertRowid)!;
  ensureUserSession(user);
  syncUserSessions(user);
  // Miembro de su sede principal en el organigrama.
  revalidarDependencias(user.id);
  return user;
}

export interface ManagedUserPatch {
  name?: string;
  ci?: string | null;
  username?: string;
  email?: string | null;
  password?: string | null;
  numero?: string | null;
  sedeId?: number | null;
  roles?: string[];
  /** Área interna (marketing, contabilidad, academico, general) para ubicar la cuenta en el organigrama sin cambiar su cargo. */
  area?: string | null;
  autorizado?: boolean;
  /** En cronogramas el cargo lo actualiza el SSO y no se toca desde el panel. */
  preserveRoles?: boolean;
}

/** Actualiza una cuenta desde el panel, respetando el origen cronogramas. */
export function updateManagedUser(id: number, patch: ManagedUserPatch): UserRow {
  const current = findById(id);
  if (!current) throw new Error('Usuario no encontrado.');
  const username = patch.username !== undefined ? String(patch.username).trim().slice(0, 60) : current.username;
  const name = patch.name !== undefined ? String(patch.name).trim().slice(0, 120) : current.name;
  const email = patch.email !== undefined ? (String(patch.email ?? '').trim() || null) : current.email;
  const ci = patch.ci !== undefined ? (String(patch.ci ?? '').trim().toUpperCase().slice(0, 20) || null) : current.ci;
  if (!name) throw new Error('Escribí el nombre.');
  if (!username) throw new Error('Escribí el usuario.');
  if (ci && !/^\d{6,10}(-[A-Za-z0-9]{1,3})?$/.test(ci)) throw new Error('El CI no es válido (ej.: 1234567 o 1234567-1A).');
  if (ci) {
    const dupCi = get<{ id: number }>('SELECT id FROM users WHERE ci = ? COLLATE NOCASE AND id <> ?', ci, id);
    if (dupCi) throw new Error('Ese CI ya está registrado para otra persona.');
  }
  if (username) {
    const dup = get<{ id: number }>('SELECT id FROM users WHERE username = ? AND id <> ?', username, id);
    if (dup) throw new Error('Ese usuario ya existe.');
  }
  if (email) {
    const dup = get<{ id: number }>('SELECT id FROM users WHERE email = ? AND id <> ?', email, id);
    if (dup) throw new Error('Ese correo ya está registrado.');
  }
  const numero = patch.numero !== undefined ? (patch.numero ? normalizePhone(patch.numero) : null) : current.esam_numero;
  if (numero && (numero.length < 8 || numero.length > 15)) throw new Error('El número de WhatsApp no es válido.');
  if (numero) {
    const repetido = userWithNumber(numero, id);
    if (repetido) throw new Error(`Ese número de WhatsApp ya está registrado para ${repetido.name}.`);
  }
  if (patch.password && patch.password.length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres.');
  const roles = patch.preserveRoles ? esamRoles(current) : (patch.roles ?? esamRoles(current));
  const area = patch.area !== undefined
    ? patch.area
    : patch.preserveRoles ? current.esam_area : areaForLocalRoles(roles);
  const password = patch.password ? bcrypt.hashSync(patch.password, 10) : current.password;
  run(
    `UPDATE users SET name = ?, ci = ?, username = ?, email = ?, password = ?, esam_autorizado = ?, esam_area = ?,
       esam_numero = ?, esam_roles = ?, sede_id = ?, updated_at = ? WHERE id = ?`,
    name,
    ci,
    username,
    email,
    password,
    patch.autorizado !== undefined ? (patch.autorizado ? 1 : 0) : current.esam_autorizado,
    area,
    numero,
    JSON.stringify(roles),
    patch.sedeId !== undefined ? patch.sedeId : current.sede_id,
    nowIso(),
    id,
  );
  const user = findById(id)!;
  syncUserSessions(user);
  // Si el número cambió, la línea del usuario debe apuntar al nuevo y cualquier
  // número distinto ya vinculado se rechaza (el número es su identidad).
  if (digitsOf(current.esam_numero) !== digitsOf(user.esam_numero)) {
    reconcileUserNumber(user, current.esam_numero);
  }
  ensureUserSession(user);
  // Cambio de cargo, sede o estado: el organigrama no puede quedar inválido.
  revalidarDependencias(user.id);
  return findById(user.id)!;
}

/** ¿El número vinculado corresponde al autorizado para esa sesión? */
export function sessionMatchesPhone(session: SessionLite, phone: string): boolean {
  const vinculado = (phone ?? '').replace(/\D+/g, '');
  if (!vinculado) return false;
  const exp = (session.expected_phone ?? '').replace(/\D+/g, '');
  if (exp) return exp === vinculado;
  const ph = (session.phone ?? '').replace(/\D+/g, '');
  return ph ? ph === vinculado : true;
}
