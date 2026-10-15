import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { logger } from '../logger.js';
import { audit } from './webhooks.js';
import { notify, supervisorIds } from './notifications.js';
import { esamEsAdmin, type UserRow } from '../auth/users.js';

/**
 * Envíos masivos programados que necesitan confirmación (p. ej. los
 * recordatorios automáticos de cobranza de cronogramas). Llegan en estado
 * `awaiting_confirmation` y NO se envían hasta que el dueño de la línea (o el
 * Super Admin) los confirma. Si nadie confirma en 20 h, se cancelan solos.
 *
 * Varios lotes de una misma programación comparten `meta.confirm_group`: se
 * confirman o cancelan juntos con una sola notificación.
 */

export const AWAITING = 'awaiting_confirmation';
const EXPIRE_HOURS = 20;

export interface ConfirmGroup {
  group: string;
  sessionId: string;
  sessionLabel: string;
  ownerUid: string | null;
  scheduledAt: string | null;
  status: 'pending' | 'confirmed' | 'cancelled' | 'mixed';
  batches: Array<{ id: number; name: string; total: number; status: string }>;
  total: number;
  createdAt: string;
}

/** Deja un lote recién creado esperando confirmación dentro de un grupo. */
export function markAwaiting(batchId: number, group: string, scheduledAt: string | null): void {
  const row = get<{ meta: string | null }>('SELECT meta FROM batches WHERE id = ?', batchId);
  let meta: Record<string, unknown> = {};
  try {
    meta = row?.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  meta.confirm_group = group;
  run(
    'UPDATE batches SET status = ?, scheduled_at = ?, meta = ?, updated_at = ? WHERE id = ?',
    AWAITING,
    scheduledAt,
    JSON.stringify(meta),
    nowIso(),
    batchId,
  );
}

export function getGroup(group: string): ConfirmGroup | null {
  const rows = all<{ id: number; name: string; total: number; status: string; session_id: string; scheduled_at: string | null; created_at: string }>(
    `SELECT id, name, total, status, session_id, scheduled_at, created_at FROM batches
      WHERE json_extract(meta, '$.confirm_group') = ? ORDER BY id`,
    group,
  );
  if (!rows.length) return null;
  const session = get<{ name: string; owner_name: string | null; owner_uid: string | null; phone: string | null; expected_phone: string | null }>(
    'SELECT name, owner_name, owner_uid, phone, expected_phone FROM sessions WHERE id = ?',
    rows[0].session_id,
  );
  const statuses = new Set(rows.map((r) => r.status));
  const status: ConfirmGroup['status'] = statuses.size === 1 && statuses.has(AWAITING)
    ? 'pending'
    : [...statuses].every((s) => s === 'cancelled')
      ? 'cancelled'
      : [...statuses].every((s) => s !== AWAITING && s !== 'cancelled')
        ? 'confirmed'
        : 'mixed';
  return {
    group,
    sessionId: rows[0].session_id,
    sessionLabel: `${session?.owner_name ?? session?.name ?? 'Línea'} · ${session?.phone ?? session?.expected_phone ?? '—'}`,
    ownerUid: session?.owner_uid ?? null,
    scheduledAt: rows[0].scheduled_at,
    status,
    batches: rows.map((r) => ({ id: r.id, name: r.name, total: r.total, status: r.status })),
    total: rows.reduce((s, r) => s + Number(r.total ?? 0), 0),
    createdAt: rows[0].created_at,
  };
}

/** ¿Puede confirmar/cancelar? El dueño de la línea que envía o el Super Admin. */
export function canDecide(user: UserRow, g: ConfirmGroup): boolean {
  if (esamEsAdmin(user)) return true;
  const owner = user.source_uid ?? String(user.id);
  return !!g.ownerUid && g.ownerUid === owner;
}

/** Avisa (campana) al dueño de la línea y al Super Admin que hay que confirmar. */
export function notifyGroup(group: string, description: string | null): void {
  const g = getGroup(group);
  if (!g) return;
  const owner = g.ownerUid ? get<{ id: number }>('SELECT id FROM users WHERE source_uid = ? OR CAST(id AS TEXT) = ?', g.ownerUid, g.ownerUid) : undefined;
  const when = g.scheduledAt ? new Date(g.scheduledAt).toLocaleString('es-BO', { dateStyle: 'short', timeStyle: 'short' }) : 'al confirmar';
  notify([owner?.id ?? null, ...supervisorIds()], {
    kind: 'batch_confirm',
    title: `Confirmá el envío programado: ${g.total} mensaje(s) en ${g.batches.length} lote(s)`,
    body: `${description ? `${description} · ` : ''}Desde ${g.sessionLabel} · ${when}. No se envía hasta que lo confirmes.`,
    link: `/batches/confirm/${encodeURIComponent(group)}`,
  });
}

/** Confirma: los lotes pasan a programados (o arrancan ya si la hora pasó). */
export function confirmGroup(group: string, user: UserRow): number {
  const now = nowIso();
  const changed = run(
    `UPDATE batches SET status = 'scheduled',
            scheduled_at = CASE WHEN scheduled_at IS NULL OR scheduled_at < ? THEN ? ELSE scheduled_at END,
            updated_at = ?
      WHERE status = ? AND json_extract(meta, '$.confirm_group') = ?`,
    now,
    now,
    now,
    AWAITING,
    group,
  ).changes;
  audit('batch.confirmed', { group, by: user.id, batches: changed });
  logger.info({ group, by: user.id, batches: changed }, 'Envío programado confirmado');
  return changed;
}

export function cancelGroup(group: string, user: UserRow | null, reason = 'Cancelado por el usuario'): number {
  const changed = run(
    `UPDATE batches SET status = 'cancelled', updated_at = ?
      WHERE status IN (?, 'scheduled') AND json_extract(meta, '$.confirm_group') = ?`,
    nowIso(),
    AWAITING,
    group,
  ).changes;
  audit('batch.cancelled', { group, by: user?.id ?? null, batches: changed, reason });
  return changed;
}

/** Programaciones sin confirmar por más de 20 h: se cancelan (nunca se envían solas). */
export function expireAwaiting(): number {
  const limit = new Date(Date.now() - EXPIRE_HOURS * 3_600_000).toISOString();
  const changed = run(
    `UPDATE batches SET status = 'cancelled', updated_at = ?
      WHERE status = ? AND created_at < ?`,
    nowIso(),
    AWAITING,
    limit,
  ).changes;
  if (changed) logger.warn({ batches: changed }, 'Envíos programados sin confirmar: cancelados');
  return changed;
}

/** Programaciones pendientes que el usuario puede decidir (para Lotes). */
export function pendingGroupsFor(user: UserRow): ConfirmGroup[] {
  const groups = all<{ g: string }>(
    `SELECT DISTINCT json_extract(meta, '$.confirm_group') AS g FROM batches
      WHERE status = ? AND json_extract(meta, '$.confirm_group') IS NOT NULL`,
    AWAITING,
  ).map((r) => r.g);
  return groups.map(getGroup).filter((g): g is ConfirmGroup => !!g && canDecide(user, g));
}
