import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';

export interface UserRow {
  id: number;
  name: string | null;
  username: string | null;
  email: string | null;
  password: string;
  source: string;
  source_uid: string | null;
  esam_autorizado: number;
  esam_area: string | null;
  esam_numero: string | null;
  esam_roles: string | null;
  last_login_at: string | null;
  last_login_ip: string | null;
  login_count: number;
  created_at: string;
  updated_at: string;
}

// ── Roles / control de acceso (espejo de config/esam.php) ─────────────────────

export const ESAM_ADMINS = ['Super Admin', 'Administrador'];

export const ROLE_AREAS: Record<string, string> = {
  'Super Admin': 'admin',
  Administrador: 'admin',
  Consulta: 'consulta',
  Contabilidad: 'contabilidad',
  Academicos: 'academico',
  'Responsable Académico': 'academico',
  'Asesor de Marketing': 'marketing',
  'Gerencia Marketing': 'marketing',
  'Supervisor de Marketing': 'marketing',
};

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
  if (user.source !== 'cronogramas') return true;
  return esamRoles(user).some((rol) => ESAM_ADMINS.includes(rol));
}

export function esamPuede(user: UserRow, seccion: string): boolean {
  if (esamEsAdmin(user)) return true;
  if (NON_ADMIN_SECTIONS.includes(seccion)) return true;
  const allowed = SECTION_AREAS[seccion] ?? [];
  return esamAreas(user).some((a) => allowed.includes(a));
}

export function esamHome(user: UserRow): string {
  if (esamPuede(user, 'conversations')) return '/conversations';
  if (esamPuede(user, 'settings')) return '/settings';
  return '/reports';
}

export function esamAreaLabel(user: UserRow): string {
  if (esamEsAdmin(user)) return 'Administrador';
  const areas = esamAreas(user);
  const nombres: Record<string, string> = {
    contabilidad: 'Contabilidad',
    academico: 'Académico',
    marketing: 'Marketing',
    consulta: 'Consulta',
    admin: 'Administrador',
  };
  return areas.length ? (nombres[areas[0]] ?? areas[0]) : 'Sin rol';
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
 */
export function sessionScopeFor(user: UserRow): string[] | null {
  // Solo la cuenta local administra todas las sesiones. Los usuarios de
  // cronogramas ven exclusivamente su propio número, aunque sean admin.
  if (user.source === 'local') return null;

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
  return all<{ id: string }>('SELECT id FROM sessions WHERE owner_uid = ?', user.source_uid ?? '').map((r) => r.id);
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

  if (!user) {
    const created = run(
      `INSERT INTO users (name, username, email, password, source, source_uid, esam_autorizado, esam_area, esam_numero, esam_roles, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name ?? 'Usuario ESAM',
      username || null,
      email,
      bcrypt.hashSync(input.password || randomUUID(), 10),
      input.source ?? 'cronogramas',
      input.sourceUid ?? null,
      input.autorizado ? 1 : 0,
      input.area ?? null,
      input.numero ?? null,
      JSON.stringify(input.roles ?? []),
      nowIso(),
      nowIso(),
    );
    user = findById(created.lastInsertRowid)!;
    return user;
  }

  const password = input.password ? bcrypt.hashSync(input.password, 10) : user.password;
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
    input.numero ?? user.esam_numero,
    JSON.stringify(input.roles ?? esamRoles(user)),
    nowIso(),
    user.id,
  );
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
    `INSERT INTO users (name, username, email, password, source, esam_autorizado, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'local', 1, ?, ?)`,
    'Administrador local',
    username,
    email,
    bcrypt.hashSync(password, 10),
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
  const numero = (user.esam_numero ?? '').replace(/\D+/g, '');
  const ownerUid = user.source_uid ?? String(user.id);
  const now = nowIso();

  if (!numero) {
    // Sin número: solo marca como suya la sesión que ya tenga por owner_uid.
    const owned = get<SessionLite>('SELECT id, name, expected_phone, phone, owner_uid FROM sessions WHERE owner_uid = ?', ownerUid);
    return owned?.id ?? null;
  }

  const sessions = all<SessionLite>('SELECT id, name, expected_phone, phone, owner_uid FROM sessions');
  const match = sessions.find((s) => {
    const exp = (s.expected_phone ?? '').replace(/\D+/g, '');
    const ph = (s.phone ?? '').replace(/\D+/g, '');
    return exp === numero || ph === numero || s.owner_uid === ownerUid;
  });

  if (match) {
    run(
      `UPDATE sessions
         SET owner_uid = ?, owner_name = ?, owner_email = ?,
             expected_phone = COALESCE(NULLIF(expected_phone, ''), ?),
             updated_at = ?
       WHERE id = ?`,
      ownerUid,
      user.name,
      user.email,
      numero,
      now,
      match.id,
    );
    return match.id;
  }

  // No hay sesión con ese número: se crea una dedicada (queda en 'created').
  const id = `user-${ownerUid}`;
  const existingById = get<SessionLite>('SELECT id, name, expected_phone, phone, owner_uid FROM sessions WHERE id = ?', id);
  if (existingById) {
    run(
      `UPDATE sessions SET owner_uid = ?, owner_name = ?, owner_email = ?,
         expected_phone = ?, updated_at = ? WHERE id = ?`,
      ownerUid,
      user.name,
      user.email,
      numero,
      now,
      id,
    );
    return id;
  }
  run(
    `INSERT INTO sessions (id, name, owner_uid, owner_name, owner_email, expected_phone, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
    id,
    user.name ?? `Sesión ${numero}`,
    ownerUid,
    user.name,
    user.email,
    numero,
    now,
    now,
  );
  return id;
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
