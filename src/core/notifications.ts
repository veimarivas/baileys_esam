import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { esamEsAdmin, listUsers } from '../auth/users.js';
import { panelBus } from '../panel/events.js';

/**
 * Notificaciones del panel (campana de la barra superior). Se guardan en la
 * base, así que nadie pierde un aviso por no estar conectado, y se envían en
 * vivo por SSE (`notification`, privado) a quien sí lo está.
 */

export type NotificationKind =
  /** Alguien registró una nota o tarea (para el Super Admin). */
  | 'note_created'
  /** Te derivaron un contacto o una tarea. */
  | 'derived_to_you'
  /** Alguien derivó un contacto a otra persona (para el Super Admin). */
  | 'derived'
  /** Quien recibió la derivación confirmó que se comunicó. */
  | 'contacted'
  /** Una tarea derivada se marcó como resuelta. */
  | 'resolved'
  /** Hay envíos masivos programados esperando tu confirmación. */
  | 'batch_confirm'
  /** Una línea quedó sin conexión (se desvinculó, la bloquearon o se cayó). */
  | 'session_down'
  /** Inconsistencia entre cuentas y líneas (p. ej. una cuenta con la línea de otra área). */
  | 'line_issue'
  /** El anti-baneo pausó un lote (cuarentena, bloqueos, entregabilidad baja…). */
  | 'batch_paused'
  /** Alguien respondió a una cobranza («ya pagué», comprobante, «no puedo pagar»). */
  | 'batch_reply';

export interface NotificationRow {
  id: number;
  user_id: number;
  kind: NotificationKind;
  note_id: number | null;
  actor_id: number | null;
  actor_name: string | null;
  /** Línea a la que se refiere el aviso (solo los avisos de sesión la usan). */
  session_id: string | null;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read_at: string | null;
}

/** Quienes supervisan: el Super Admin de cronogramas y la cuenta local. */
export function supervisorIds(): number[] {
  return listUsers()
    .filter((u) => esamEsAdmin(u) && (u.source === 'local' || !!u.esam_autorizado))
    .map((u) => u.id);
}

export function unreadCount(userId: number): number {
  return get<{ c: number }>('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', userId)?.c ?? 0;
}

/**
 * Crea la misma notificación para varios usuarios (sin duplicados ni el autor)
 * y la empuja en vivo a cada uno con su contador actualizado.
 */
export function notify(
  userIds: Array<number | null | undefined>,
  n: { kind: NotificationKind; noteId?: number | null; actorId?: number | null; sessionId?: string | null; title: string; body?: string | null; link?: string | null },
): void {
  const targets = [...new Set(userIds.filter((id): id is number => !!id && id !== n.actorId))];
  if (!targets.length) return;
  const now = nowIso();
  for (const userId of targets) {
    const created = run(
      `INSERT INTO notifications (user_id, kind, note_id, actor_id, session_id, title, body, link, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      n.kind,
      n.noteId ?? null,
      n.actorId ?? null,
      n.sessionId ?? null,
      n.title.slice(0, 200),
      n.body ? n.body.slice(0, 500) : null,
      n.link ?? null,
      now,
    );
    panelBus.publish('notification', {
      private: true,
      userIds: [userId],
      id: created.lastInsertRowid,
      kind: n.kind,
      noteId: n.noteId ?? null,
      title: n.title.slice(0, 200),
      body: n.body ? n.body.slice(0, 300) : null,
      link: n.link ?? null,
      unread: unreadCount(userId),
    });
  }
}

/**
 * Avisa que una línea se quedó sin conexión. Va al dueño de la línea y al Super
 * Admin, y enlaza a Configuración → Conexión.
 *
 * No repite el aviso mientras el anterior siga sin leer: una conexión que va y
 * viene (o un arranque en frío que reconecta) no debe llenar la campana. El
 * control es por línea, así que dos números caídos generan dos avisos.
 */
export function alertSessionDown(sessionId: string, label: string, reason: string): boolean {
  const pending = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM notifications
      WHERE kind = 'session_down' AND session_id = ? AND read_at IS NULL`,
    sessionId,
  )?.c ?? 0;
  if (pending > 0) return false;

  const owner = get<{ id: number }>(
    `SELECT u.id FROM users u JOIN sessions s ON s.owner_uid = u.source_uid OR CAST(u.id AS TEXT) = s.owner_uid
      WHERE s.id = ? LIMIT 1`,
    sessionId,
  );
  const who = (label || '').trim() || 'una línea';
  notify([owner?.id ?? null, ...supervisorIds()], {
    kind: 'session_down',
    sessionId,
    title: `Se desconectó WhatsApp: ${who}`,
    body: `${(reason || 'Sin detalle.').trim()} Abrí Configuración → Conexión para volver a vincular o reintentar.`,
    link: '/settings',
  });
  return true;
}

export function listNotifications(userId: number, limit = 30): NotificationRow[] {
  return all<NotificationRow>(
    `SELECT n.*, u.name AS actor_name FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
      WHERE n.user_id = ? ORDER BY n.id DESC LIMIT ?`,
    userId,
    Math.min(Math.max(limit, 1), 100),
  );
}

/** Marca como leídas (todas, o las indicadas) las notificaciones del usuario. */
export function markRead(userId: number, ids: number[] | 'all'): number {
  if (ids === 'all') {
    return run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), userId).changes;
  }
  const clean = ids.filter((x) => Number.isFinite(x));
  if (!clean.length) return 0;
  return run(
    `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${clean.map(() => '?').join(',')})`,
    nowIso(),
    userId,
    ...clean,
  ).changes;
}

/** Al abrir una nota, sus avisos pendientes para ese usuario quedan leídos. */
export function markNoteRead(userId: number, noteId: number): number {
  return run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND note_id = ? AND read_at IS NULL', nowIso(), userId, noteId).changes;
}

/**
 * Avisa que el anti-baneo pausó un lote: al dueño de la línea y a quienes
 * supervisan, con el motivo y el enlace al lote. Un aviso por lote mientras
 * siga sin leer.
 */
export function alertBatchPaused(batchId: number, reason: string): boolean {
  const batch = get<{ name: string | null; session_id: string | null }>('SELECT name, session_id FROM batches WHERE id = ?', batchId);
  if (!batch) return false;
  const pending = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM notifications WHERE kind = 'batch_paused' AND link = ? AND read_at IS NULL`,
    `/batches/${batchId}`,
  )?.c ?? 0;
  if (pending > 0) return false;
  const owner = batch.session_id
    ? get<{ id: number }>(
        `SELECT u.id FROM users u JOIN sessions s ON s.owner_uid = u.source_uid OR CAST(u.id AS TEXT) = s.owner_uid
          WHERE s.id = ? LIMIT 1`,
        batch.session_id,
      )
    : undefined;
  notify([owner?.id ?? null, ...supervisorIds()], {
    kind: 'batch_paused',
    sessionId: batch.session_id,
    title: `Envío pausado por el anti-baneo: #${batchId} ${batch.name ?? ''}`.trim(),
    body: reason,
    link: `/batches/${batchId}`,
  });
  return true;
}
