import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { esamEsAdmin, upsertUser, type UserRow } from '../auth/users.js';

/**
 * Seguimiento del desarrollo de módulos (cronogramas → /notes).
 *
 * Cronogramas detecta sesiones pasadas marcadas como «Desarrollado» que todavía
 * no tienen asistencia y las envía a la persona responsable. No son notas de una
 * conversación: son tareas independientes, visibles en la sección exclusiva
 * «Seguimiento de módulos» de /notes.
 */

export interface ModuleFollowupRow {
  id: number;
  ref: string;
  assigned_to: number;
  created_by: number | null;
  title: string;
  program: string | null;
  module: string | null;
  session_at: string | null;
  session_label: string | null;
  details: string | null;
  link: string | null;
  status: string;
  seen_at: string | null;
  done_at: string | null;
  done_by: number | null;
  meta: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModuleFollowupSession {
  horario_id: number | null;
  program: string | null;
  module: string | null;
  time: string | null;
  link: string | null;
}

export interface ModuleFollowupDTO extends ModuleFollowupRow {
  assigned_name: string | null;
  /** Sesiones del día incluidas en la nota (pueden ser varias). */
  sessions: ModuleFollowupSession[];
}

export interface ModuleFollowupInput {
  /** Referencia estable de cronogramas (p. ej. `modulo-123-45`). */
  ref: string;
  /** Usuario de cronogramas responsable (su id se busca en `users.source_uid`). */
  account: string;
  /** Nombre visible del responsable (para crear su usuario espejo si aún no existe). */
  responsibleName?: string | null;
  title?: string | null;
  program?: string | null;
  programId?: number | null;
  module?: string | null;
  moduleId?: number | null;
  horarioId?: number | null;
  sessionAt?: string | null;
  sessionLabel?: string | null;
  details?: string | null;
  link?: string | null;
  status?: string | null;
  /** Sesiones que agrupa la nota diaria. */
  sessions?: Array<{
    horarioId?: number | null;
    program?: string | null;
    module?: string | null;
    time?: string | null;
    link?: string | null;
  }>;
}

export class ModuleFollowupError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

function clean(value: unknown, max = 500): string | null {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return text || null;
}

/** Texto libre: conserva los saltos de línea (párrafos del detalle). */
function cleanText(value: unknown, max = 4000): string | null {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
  return text || null;
}

function parseSession(value: unknown): ModuleFollowupSession | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  const session: ModuleFollowupSession = {
    horario_id: Number.isFinite(Number(s.horario_id ?? s.horarioId)) ? Number(s.horario_id ?? s.horarioId) : null,
    program: clean(s.program, 300),
    module: clean(s.module, 300),
    time: clean(s.time, 80),
    link: clean(s.link, 1000),
  };
  return session.program || session.module || session.link ? session : null;
}

function mapFollowup(row: ModuleFollowupRow & { assigned_name?: string | null }): ModuleFollowupDTO {
  let sessions: ModuleFollowupSession[] = [];
  if (row.meta) {
    try {
      const meta = JSON.parse(row.meta) as { sessions?: unknown };
      if (Array.isArray(meta.sessions)) {
        sessions = meta.sessions.map(parseSession).filter((s): s is ModuleFollowupSession => !!s);
      }
    } catch {
      sessions = [];
    }
  }
  return { ...row, assigned_name: row.assigned_name ?? null, sessions };
}

/**
 * Crea o actualiza el seguimiento. Idempotente por `ref`: si se vuelve a enviar
 * la misma sesión, se actualizan los datos en lugar de duplicar la tarea.
 */
export function upsertModuleFollowup(input: ModuleFollowupInput): { id: number; created: boolean; assignedTo: number } {
  const ref = clean(input.ref, 120);
  if (!ref) throw new ModuleFollowupError('Falta la referencia del seguimiento.');

  const account = clean(input.account, 80);
  if (!account) throw new ModuleFollowupError('Falta la cuenta del responsable.');

  let user = get<{ id: number }>('SELECT id FROM users WHERE source_uid = ? OR username = ? LIMIT 1', account, account);
  if (!user) {
    // El responsable todavía no ingresó a Seguimiento ESAM: se crea su usuario
    // espejo para que el seguimiento le quede asignado. Cuando entre por SSO,
    // se completa con sus roles y número.
    user = upsertUser({
      sourceUid: account,
      name: clean(input.responsibleName, 160) || 'Responsable de módulo',
      source: 'cronogramas',
      autorizado: false,
      roles: [],
    });
  }

  const program = clean(input.program, 300);
  const module = clean(input.module, 300);
  const sessionLabel = clean(input.sessionLabel, 200);
  const title = clean(input.title, 300) || `Asistencia pendiente · ${module || 'Módulo'}`;
  const details =
    cleanText(input.details, 4000) ||
    `La sesión${sessionLabel ? ` del ${sessionLabel}` : ''} del módulo ${module || '—'}${program ? ` (${program})` : ''} está marcada como Desarrollada pero no tiene asistencia registrada.`;
  const link = clean(input.link, 1000);
  const status = input.status === 'done' ? 'done' : 'pending';
  const now = nowIso();
  const sessions = (input.sessions ?? [])
    .map(parseSession)
    .filter((s): s is ModuleFollowupSession => !!s);
  const meta = JSON.stringify({
    program_id: input.programId ?? null,
    module_id: input.moduleId ?? null,
    horario_id: input.horarioId ?? null,
    sessions,
  });

  const existing = get<ModuleFollowupRow>('SELECT * FROM module_followups WHERE ref = ?', ref);
  if (!existing) {
    const id = run(
      `INSERT INTO module_followups
        (ref, assigned_to, created_by, title, program, module, session_at, session_label, details, link,
         status, seen_at, done_at, done_by, meta, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
      ref,
      user.id,
      title,
      program,
      module,
      clean(input.sessionAt, 80),
      sessionLabel,
      details,
      link,
      status,
      status === 'done' ? now : null,
      meta,
      now,
      now,
    ).lastInsertRowid;
    return { id, created: true, assignedTo: user.id };
  }

  run(
    `UPDATE module_followups SET assigned_to = ?, title = ?, program = ?, module = ?, session_at = ?,
       session_label = ?, details = ?, link = ?, status = ?, done_at = ?, meta = ?, updated_at = ?
     WHERE id = ?`,
    user.id,
    title,
    program,
    module,
    clean(input.sessionAt, 80),
    sessionLabel,
    details,
    link,
    status,
    status === 'done' ? existing.done_at ?? now : null,
    meta,
    now,
    existing.id,
  );
  return { id: existing.id, created: false, assignedTo: user.id };
}

function whereFor(user: UserRow, status: string): { sql: string; params: unknown[] } {
  const where = ['1 = 1'];
  const params: unknown[] = [];
  if (!esamEsAdmin(user)) {
    where.push('f.assigned_to = ?');
    params.push(user.id);
  }
  if (status === 'pending') where.push("f.status = 'pending'");
  else if (status === 'done') where.push("f.status = 'done'");
  return { sql: where.join(' AND '), params };
}

/** Seguimientos visibles para el usuario: los suyos o todos si es Super Admin. */
export function listModuleFollowups(user: UserRow, opts: { status?: string | null } = {}): ModuleFollowupDTO[] {
  const status = opts.status === 'done' || opts.status === 'all' ? opts.status : 'pending';
  const where = whereFor(user, status);
  return all<ModuleFollowupRow & { assigned_name: string | null }>(
    `SELECT f.*, COALESCE(NULLIF(u.name, ''), u.username, u.email) AS assigned_name
       FROM module_followups f
       LEFT JOIN users u ON u.id = f.assigned_to
      WHERE ${where.sql}
      ORDER BY (f.status = 'done'), COALESCE(f.session_at, f.created_at) DESC, f.id DESC`,
    ...where.params,
  ).map(mapFollowup);
}

/** Cantidad de seguimientos pendientes para el contador de /notes. */
export function pendingModuleFollowups(user: UserRow): number {
  const where = whereFor(user, 'pending');
  return get<{ c: number }>(`SELECT COUNT(*) AS c FROM module_followups f WHERE ${where.sql}`, ...where.params)?.c ?? 0;
}

/** Marca un seguimiento como atendido. Solo su responsable o un Super Admin. */
export function markModuleFollowupDone(id: number, user: UserRow): ModuleFollowupDTO {
  const row = get<ModuleFollowupRow>('SELECT * FROM module_followups WHERE id = ?', id);
  if (!row) throw new ModuleFollowupError('Seguimiento no encontrado.', 404);
  if (!esamEsAdmin(user) && row.assigned_to !== user.id) {
    throw new ModuleFollowupError('No tenés acceso a este seguimiento.', 403);
  }
  const now = nowIso();
  run(
    `UPDATE module_followups SET status = 'done', done_at = COALESCE(done_at, ?), done_by = ?, updated_at = ?
      WHERE id = ?`,
    now,
    user.id,
    now,
    id,
  );
  return listModuleFollowups(user, { status: 'all' }).find((x) => x.id === id)!;
}
