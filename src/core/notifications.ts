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
  | 'resolved';

export interface NotificationRow {
  id: number;
  user_id: number;
  kind: NotificationKind;
  note_id: number | null;
  actor_id: number | null;
  actor_name: string | null;
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
  n: { kind: NotificationKind; noteId?: number | null; actorId?: number | null; title: string; body?: string | null; link?: string | null },
): void {
  const targets = [...new Set(userIds.filter((id): id is number => !!id && id !== n.actorId))];
  if (!targets.length) return;
  const now = nowIso();
  for (const userId of targets) {
    const created = run(
      `INSERT INTO notifications (user_id, kind, note_id, actor_id, title, body, link, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      n.kind,
      n.noteId ?? null,
      n.actorId ?? null,
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
