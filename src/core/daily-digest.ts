import { all, get } from '../db/index.js';
import { esamEsAdmin, sessionScopeFor, type UserRow } from '../auth/users.js';
import { getConfig, setConfig } from './config-store.js';
import { batchesEngagement, COBRANZA_TIPOS } from './batch-engagement.js';
import { massActivity } from './mass-activity.js';
import { pendingReplies, resolvePeriod } from './followup.js';
import { lineVerdict } from './line-verdict.js';
import { notify } from './notifications.js';
import type { SessionRow } from '../types.js';

/**
 * Resumen diario: cada mañana (DIGEST_TIME, 07:30 hora de Bolivia) llega a la
 * campana (y por push a la app) lo que pasó ayer y lo que espera hoy:
 * envíos masivos con lectura y respuestas, respuestas a cobranzas, tareas
 * vencidas, chats sin responder y líneas en amarillo o rojo.
 *
 * El Super Admin recibe el de todas las líneas; cada usuario, el de su línea y
 * solo si hay algo que contar.
 */

export interface Digest {
  day: string;
  batches: number;
  sent: number;
  readRate: number | null;
  replied: number;
  cobranza: { pagado: number; comprobante: number; no_puede: number };
  overdueNotes: number;
  unanswered: number;
  lines: Array<{ name: string; level: 'yellow' | 'red'; reason: string }>;
}

/** Arma el resumen de ayer para un alcance de líneas (null = todas). */
export function buildDigest(sessionIds: string[] | null, userId: number | null = null): Digest {
  const yesterday = resolvePeriod({ period: 'yesterday' }, 'yesterday');
  const mass = massActivity(sessionIds, yesterday);
  const cobranzaIds = mass.batches.filter((b) => b.sent > 0 && COBRANZA_TIPOS.has(String(b.tipo ?? '').toLowerCase())).map((b) => b.id);
  const cobranza = { pagado: 0, comprobante: 0, no_puede: 0 };
  for (const s of batchesEngagement(cobranzaIds).values()) {
    cobranza.pagado += s.kinds.pagado;
    cobranza.comprobante += s.kinds.comprobante;
    cobranza.no_puede += s.kinds.no_puede;
  }

  // Tareas vencidas: de la persona (propias o derivadas) o, para el admin, todas.
  const overdueNotes = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM contact_notes n
      WHERE n.deleted_at IS NULL AND n.done_at IS NULL AND n.due_at < date('now','localtime')
        ${userId ? 'AND (n.assigned_to = ? OR (n.assigned_to IS NULL AND n.user_id = ?))' : ''}`,
    ...(userId ? [userId, userId] : []),
  )?.c ?? 0;

  const sessions = all<SessionRow>('SELECT * FROM sessions');
  const lines: Digest['lines'] = [];
  for (const s of sessions) {
    if (sessionIds && !sessionIds.includes(s.id)) continue;
    try {
      const v = lineVerdict(s);
      if (v.level !== 'green') lines.push({ name: s.owner_name ?? s.name, level: v.level, reason: v.reasons[0] ?? v.title });
    } catch {
      // una línea con datos raros no frena el resumen
    }
  }

  return {
    day: yesterday.from,
    batches: mass.totals.batches,
    sent: mass.totals.sent,
    readRate: mass.totals.tracked ? Math.round((mass.totals.read / mass.totals.tracked) * 100) : null,
    replied: mass.totals.replied,
    cobranza,
    overdueNotes: Number(overdueNotes),
    unanswered: pendingReplies({ sessionIds, sessionId: null }, { limit: 1 }).total,
    lines,
  };
}

/** Texto corto del resumen (una idea por línea). Null si no hay nada que contar. */
export function digestText(d: Digest): string | null {
  const parts: string[] = [];
  if (d.batches) {
    parts.push(`Envíos de ayer: ${d.batches} lote(s), ${d.sent} mensajes${d.readRate !== null ? `, ${d.readRate}% leídos` : ''}, ${d.replied} respuesta(s).`);
  }
  const c = d.cobranza;
  if (c.pagado + c.comprobante + c.no_puede > 0) {
    parts.push(`Cobranzas: ${c.pagado} dicen que pagaron, ${c.comprobante} enviaron comprobante, ${c.no_puede} piden plazo.`);
  }
  if (d.overdueNotes) parts.push(`${d.overdueNotes} tarea(s) vencida(s).`);
  if (d.unanswered) parts.push(`${d.unanswered} chat(s) esperan respuesta.`);
  for (const l of d.lines.slice(0, 3)) parts.push(`Línea ${l.name} en ${l.level === 'red' ? 'rojo' : 'amarillo'}: ${l.reason}`);
  if (d.lines.length > 3) parts.push(`… y ${d.lines.length - 3} línea(s) más con alertas.`);
  return parts.length ? parts.join('\n') : null;
}

/** Envía el resumen a cada usuario. Devuelve cuántos avisos creó. */
export function sendDailyDigests(users: UserRow[]): number {
  let sent = 0;
  for (const u of users) {
    if (u.source === 'cronogramas' && !u.esam_autorizado) continue;
    const admin = esamEsAdmin(u);
    const scope = admin ? null : sessionScopeFor(u);
    if (scope && scope.length === 0) continue;
    const d = buildDigest(scope, admin ? null : u.id);
    const text = digestText(d);
    if (!text) continue;
    notify([u.id], {
      kind: 'daily_digest',
      title: admin ? 'Resumen de ayer · todas las líneas' : 'Resumen de ayer',
      body: text,
      link: admin ? '/reports?period=yesterday' : '/notes',
    });
    sent++;
  }
  return sent;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Revisa cada 5 minutos si ya es la hora del resumen y no se envió hoy. */
export function startDailyDigestWorker(listUsers: () => UserRow[]): void {
  const [hh, mm] = (process.env.DIGEST_TIME?.trim() || '07:30').split(':').map((x) => Number(x) || 0);
  const tick = () => {
    try {
      const now = new Date();
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return;
      if (getConfig('daily_digest_sent') === today) return;
      setConfig('daily_digest_sent', today);
      sendDailyDigests(listUsers());
    } catch {
      // un fallo del resumen no debe afectar al servicio
    }
  };
  setTimeout(tick, 120_000);
  setInterval(tick, 5 * 60_000);
}
