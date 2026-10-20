import { all } from '../db/index.js';

/**
 * Última vez que cada usuario **usó el sistema para trabajar**: envió un
 * mensaje, lanzó un lote o registró una nota. El ingreso al panel se guarda
 * aparte (`users.last_login_at`), así la ficha puede mostrar las dos fechas.
 */

export type UserUseKind = 'message' | 'batch' | 'note';

export interface UserUse {
  at: string;
  kind: UserUseKind;
  /** Texto corto para la columna de actividad y la ficha. */
  label: string;
}

/** Alias usado por las vistas; expresa «actividad registrada del usuario». */
export type UserActivity = UserUse;

export interface UserActivityRef {
  id: number;
  source_uid?: string | null;
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Calcula la última actividad de cada usuario. Los lotes se atribuyen por
 * `meta.account` (el id de cronogramas) o, si falta, por el dueño de la línea.
 * Los envíos masivos sin cuenta ni dueño identificable quedan fuera a propósito:
 * no se puede saber a quién atribuirlos sin inventar datos.
 */
export function lastUseByUser(users: UserActivityRef[]): Map<number, UserUse> {
  const bySource = new Map<string, number>();
  const byId = new Map<string, number>();
  for (const u of users) {
    if (u.source_uid) bySource.set(String(u.source_uid), u.id);
    byId.set(String(u.id), u.id);
  }
  const result = new Map<number, UserUse>();
  const put = (uid: number, use: UserUse) => {
    if (!isIso(use.at) || !byId.has(String(uid))) return;
    const prev = result.get(uid);
    if (!prev || Date.parse(use.at) > Date.parse(prev.at)) result.set(uid, use);
  };

  // Mensajes enviados desde el panel o la app (los del teléfono no tienen uid).
  const messages = all<{ uid: number; at: string }>(
    `SELECT sender_uid AS uid, MAX(occurred_at) AS at
       FROM messages
      WHERE direction = 'out' AND sender_uid IS NOT NULL
      GROUP BY sender_uid`,
  );
  for (const row of messages) put(row.uid, { at: row.at, kind: 'message', label: 'Mensaje enviado' });

  // Notas internas registradas en cualquier línea.
  const notes = all<{ uid: number; at: string }>(
    `SELECT user_id AS uid, MAX(created_at) AS at
       FROM contact_notes
      WHERE user_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY user_id`,
  );
  for (const row of notes) put(row.uid, { at: row.at, kind: 'note', label: 'Nota registrada' });

  // Lotes iniciados: se atribuyen a la cuenta que los pidió o al dueño de la línea.
  const owners = new Map(
    all<{ id: string; owner_uid: string | null }>('SELECT id, owner_uid FROM sessions').map((s) => [s.id, s.owner_uid]),
  );
  const batches = all<{ meta: string | null; session_id: string | null; at: string }>(
    `SELECT meta, session_id, COALESCE(finished_at, started_at, updated_at) AS at
       FROM batches
      WHERE started_at IS NOT NULL`,
  );
  for (const row of batches) {
    const meta = parseMeta(row.meta);
    const raw = meta.account != null && String(meta.account).trim() !== '' ? String(meta.account) : null;
    const account = raw ?? (row.session_id ? owners.get(row.session_id) ?? null : null);
    const uid = account ? bySource.get(account) ?? byId.get(account) : undefined;
    if (uid != null) put(uid, { at: row.at, kind: 'batch', label: 'Envío por lote' });
  }

  return result;
}
