import { get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { panelBus, type PanelEvent } from '../panel/events.js';
import { notify } from './notifications.js';

/**
 * Estado y responsable de cada conversación, para ordenar la atención diaria:
 *
 * - `open` (Por atender), `pending` (En atención), `closed` (Resuelto).
 * - Responsable: un usuario del sistema (`assigned_agent_id`). Al asignarlo se
 *   le avisa en la campana (y por push en la app).
 * - Un chat resuelto vuelve a «Por atender» cuando la persona escribe de nuevo.
 */

export type ConversationStatus = 'open' | 'pending' | 'closed';
export const STATUS_LABEL: Record<ConversationStatus, string> = { open: 'Por atender', pending: 'En atención', closed: 'Resuelto' };

export interface StateChange {
  status?: ConversationStatus;
  /** `null` quita el responsable; `undefined` no lo cambia. */
  assignedTo?: number | null;
}

export interface ConversationState {
  status: ConversationStatus;
  assigned_agent: { id: number; name: string | null } | null;
}

function current(sessionId: string, chatId: string): (ConversationState & { id: number; name: string | null }) | null {
  const row = get<{ id: number; status: string; agent_id: number | null; agent_name: string | null; name: string | null }>(
    `SELECT c.id, c.status, c.assigned_agent_id AS agent_id, COALESCE(u.name, u.username) AS agent_name,
            COALESCE(ct.name, c.contact_name) AS name
       FROM conversations c
       LEFT JOIN users u ON u.id = c.assigned_agent_id
       LEFT JOIN contacts ct ON ct.session_id = c.session_id AND ct.chat_id = c.chat_id
      WHERE c.session_id = ? AND c.chat_id = ?`,
    sessionId,
    chatId,
  );
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: (['open', 'pending', 'closed'].includes(row.status) ? row.status : 'open') as ConversationStatus,
    assigned_agent: row.agent_id ? { id: row.agent_id, name: row.agent_name } : null,
  };
}

/** Cambia estado y/o responsable. Devuelve el estado nuevo (null si el chat no existe). */
export function setConversationState(sessionId: string, chatId: string, change: StateChange, actor: { id: number; name: string | null }): ConversationState | null {
  const before = current(sessionId, chatId);
  if (!before) return null;
  if (change.status && !['open', 'pending', 'closed'].includes(change.status)) throw new Error('Estado inválido.');
  if (change.assignedTo != null && !get('SELECT 1 FROM users WHERE id = ?', change.assignedTo)) throw new Error('Esa persona no existe.');
  const now = nowIso();
  if (change.status && change.status !== before.status) {
    run(
      `UPDATE conversations SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?`,
      change.status,
      change.status === 'closed' ? now : null,
      now,
      before.id,
    );
  }
  if (change.assignedTo !== undefined && change.assignedTo !== (before.assigned_agent?.id ?? null)) {
    run('UPDATE conversations SET assigned_agent_id = ?, updated_at = ? WHERE id = ?', change.assignedTo, now, before.id);
    if (change.assignedTo && change.assignedTo !== actor.id) {
      const who = before.name || `+${chatId.replace(/@.*$/, '')}`;
      notify([change.assignedTo], {
        kind: 'chat_assigned',
        actorId: actor.id,
        sessionId,
        title: `${actor.name ?? 'Alguien'} te asignó el chat de ${who}`,
        body: 'Quedaste como responsable de atenderlo.',
        link: `/conversations/${encodeURIComponent(chatId)}`,
      });
    }
  }
  const after = current(sessionId, chatId)!;
  panelBus.publish('conversation', { sessionId, chatId, status: after.status, assigned_agent: after.assigned_agent });
  return { status: after.status, assigned_agent: after.assigned_agent };
}

/** Un mensaje entrante reabre el chat resuelto (vuelve a «Por atender»). */
export function reopenOnInbound(sessionId: string, chatId: string): boolean {
  const res = run(
    `UPDATE conversations SET status = 'open', closed_at = NULL, updated_at = ? WHERE session_id = ? AND chat_id = ? AND status = 'closed'`,
    nowIso(),
    sessionId,
    chatId,
  );
  return res.changes > 0;
}

let started = false;

export function startConversationStateWorker(): void {
  if (started) return;
  started = true;
  panelBus.on('event', (e: PanelEvent) => {
    const p = e.payload;
    if (e.type !== 'message' || p.direction !== 'in' || p.history) return;
    try {
      reopenOnInbound(String(p.sessionId ?? ''), String(p.chatId ?? ''));
    } catch {
      // no debe afectar la recepción
    }
  });
}
