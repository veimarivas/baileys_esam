import { all, get } from '../db/index.js';
import { config } from '../config.js';
import { countNewContactsToday, limitState, pacingOptionsFor, type AntiBanPolicy } from './anti-ban.js';
import { Pacing } from './pacing.js';
import type { SessionRow } from '../types.js';

/**
 * Datos de seguimiento del panel anti-baneo: cuánto margen le queda hoy a cada
 * línea, si está dentro de su ventana de envío, cómo evolucionó la semana, si
 * los contactos responden, qué lotes frenó el motor y qué hizo (bitácora).
 */

export interface SessionUsage {
  dailyUsed: number;
  dailyLimit: number;
  hourlyUsed: number;
  hourlyLimit: number;
  newContactsToday: number;
  newContactsLimit: number;
  warmupDay: number;
  warmupActive: boolean;
  windowOpen: boolean;
  /** «Abierta hasta las 20:00» / «Cerrada · abre en 3 h 20 min». */
  windowLabel: string;
}

function fmtWait(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function sessionUsage(session: SessionRow, policy: AntiBanPolicy): SessionUsage {
  const limits = limitState(session.id, policy, session);
  const pacing = new Pacing(session.id, pacingOptionsFor(session.id, policy, session, config.pacing.programCooldownMinutes));
  const open = pacing.isWithinWindow();
  return {
    dailyUsed: limits.dailyUsed,
    dailyLimit: limits.dailyLimit,
    hourlyUsed: limits.hourlyUsed,
    hourlyLimit: limits.hourlyLimit,
    newContactsToday: countNewContactsToday(session.id),
    newContactsLimit: policy.new_contacts_daily_limit,
    warmupDay: limits.day,
    warmupActive: limits.active,
    windowOpen: open,
    windowLabel: open
      ? `Abierta hasta las ${policy.window_end}`
      : `Cerrada · abre en ${fmtWait(pacing.secondsUntilNextWindow())}`,
  };
}

export interface TrendDay {
  day: string;
  sent: number;
  delivered: number;
  failed: number;
  blocked: number;
}

/** Últimos 7 días (hora local) de una línea: enviados, entregados, fallidos y bloqueos/bajas. */
export function trend7d(sessionId: string): TrendDay[] {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const msgs = all<{ day: string; sent: number; delivered: number; failed: number }>(
    `SELECT date(occurred_at, 'localtime') AS day,
            SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN direction = 'out' AND status IN ('delivered','read','played') THEN 1 ELSE 0 END) AS delivered,
            SUM(CASE WHEN direction = 'out' AND status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM messages WHERE session_id = ? AND occurred_at >= ? AND COALESCE(origin, '') <> 'phone'
      GROUP BY day`,
    sessionId,
    since,
  );
  const blocks = all<{ day: string; c: number }>(
    `SELECT date(created_at, 'localtime') AS day, COUNT(*) AS c FROM optouts
      WHERE session_id = ? AND source IN ('blocked','reply') AND created_at >= ? GROUP BY day`,
    sessionId,
    since,
  );
  const byDay = new Map(msgs.map((m) => [m.day, m]));
  const blocksByDay = new Map(blocks.map((b) => [b.day, b.c]));
  const out: TrendDay[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const m = byDay.get(key);
    out.push({
      day: key,
      sent: Number(m?.sent ?? 0),
      delivered: Number(m?.delivered ?? 0),
      failed: Number(m?.failed ?? 0),
      blocked: Number(blocksByDay.get(key) ?? 0),
    });
  }
  return out;
}

/**
 * Respuesta a los envíos masivos (7 días): de los contactos que recibieron un
 * lote, cuántos contestaron después. Una tasa baja anticipa reportes.
 */
export function replyRate7d(sessionId: string): { contacted: number; replied: number; rate: number | null } {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const row = get<{ contacted: number; replied: number }>(
    `WITH firsts AS (
       SELECT chat_id, MIN(occurred_at) AS first_out FROM messages
        WHERE session_id = ? AND direction = 'out' AND origin = 'batch' AND occurred_at >= ?
        GROUP BY chat_id
     )
     SELECT COUNT(*) AS contacted,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM messages i
                                   WHERE i.session_id = ? AND i.chat_id = f.chat_id
                                     AND i.direction = 'in' AND i.occurred_at > f.first_out) THEN 1 ELSE 0 END) AS replied
       FROM firsts f`,
    sessionId,
    since,
    sessionId,
  );
  const contacted = Number(row?.contacted ?? 0);
  const replied = Number(row?.replied ?? 0);
  return { contacted, replied, rate: contacted ? replied / contacted : null };
}

export interface PausedBatch {
  id: number;
  name: string | null;
  session_id: string | null;
  reason: string;
  sent: number;
  total: number;
  updated_at: string;
}

/** Lotes que el motor pausó (con su motivo), del más reciente al más viejo. */
export function pausedBatches(limit = 20): PausedBatch[] {
  const rows = all<{ id: number; name: string | null; session_id: string | null; meta: string | null; sent: number; total: number; updated_at: string }>(
    "SELECT id, name, session_id, meta, sent, total, updated_at FROM batches WHERE status = 'paused' ORDER BY updated_at DESC LIMIT ?",
    limit,
  );
  return rows.map((r) => {
    let reason = 'Pausado manualmente';
    try {
      const meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {};
      if (typeof meta.anti_ban_pause === 'string') reason = meta.anti_ban_pause;
    } catch {
      // meta ilegible: se muestra el motivo genérico
    }
    return { id: r.id, name: r.name, session_id: r.session_id, reason, sent: r.sent, total: r.total, updated_at: r.updated_at };
  });
}

export interface AntiBanEvent {
  id: number;
  action: string;
  context: Record<string, unknown>;
  created_at: string;
}

const EVENT_ACTIONS = [
  'anti_ban.policy_updated',
  'anti_ban.policy_cleared',
  'anti_ban.quarantine',
  'anti_ban.trust_reset',
  'anti_ban.rotate',
  'session.rotated',
  'batch.paused',
  'blacklist.added',
  'blacklist.imported',
  'blacklist.removed',
];

/** Bitácora del motor anti-baneo (acciones automáticas y manuales). */
export function antiBanEvents(limit = 40): AntiBanEvent[] {
  return all<{ id: number; action: string; context: string | null; created_at: string }>(
    `SELECT id, action, context, created_at FROM audit_logs
      WHERE action IN (${EVENT_ACTIONS.map(() => '?').join(',')})
      ORDER BY id DESC LIMIT ?`,
    ...EVENT_ACTIONS,
    limit,
  ).map((r) => {
    let context: Record<string, unknown> = {};
    try {
      context = r.context ? (JSON.parse(r.context) as Record<string, unknown>) : {};
    } catch {
      context = {};
    }
    return { id: r.id, action: r.action, context, created_at: r.created_at };
  });
}
