import { get } from '../db/index.js';
import { getPolicy, limitState } from './anti-ban.js';
import { getHealth, recomputeHealth } from './health.js';
import type { SessionRow } from '../types.js';

/**
 * Semáforo del número: un veredicto único («¿está sano para enviar?») que junta
 * lo que antes estaba repartido en varias pantallas: conexión, cuarentena,
 * salud de las últimas 24 h, calentamiento, cupo del día y lotes pausados.
 *
 * - rojo: no conviene (o no se puede) enviar ahora → la API no crea lotes nuevos.
 * - amarillo: se puede, con cuidado (calentamiento, cupo bajo, señales de riesgo).
 * - verde: todo en orden.
 */

export type VerdictLevel = 'green' | 'yellow' | 'red';

export interface LineVerdict {
  level: VerdictLevel;
  title: string;
  reasons: string[];
  action: string | null;
  /** ¿Se pueden crear lotes nuevos desde esta línea? */
  canSend: boolean;
  stats: {
    sent24h: number;
    deliveryRate: number | null;
    blocked24h: number;
    dailyUsed: number;
    dailyLimit: number;
    warmupDay: number | null;
    pausedBatches: number;
  };
}

export function lineVerdict(session: SessionRow): LineVerdict {
  const health = getHealth(session.id) ?? recomputeHealth(session.id);
  const policy = getPolicy(session.id);
  const limits = policy.active ? limitState(session.id, policy, session) : null;
  const paused = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM batches WHERE session_id = ? AND status = 'paused' AND json_extract(meta, '$.anti_ban_pause') IS NOT NULL`,
    session.id,
  )?.c ?? 0;

  const stats = {
    sent24h: health.sent_24h,
    deliveryRate: health.sent_24h >= 5 ? health.delivery_rate : null,
    blocked24h: health.blocked_24h,
    dailyUsed: limits?.dailyUsed ?? 0,
    dailyLimit: limits?.dailyLimit ?? 0,
    warmupDay: limits?.active ? limits.day : null,
    pausedBatches: paused,
  };

  const red: string[] = [];
  const yellow: string[] = [];
  let action: string | null = null;

  if (session.status !== 'ready') {
    red.push('La línea no está conectada a WhatsApp.');
    action = 'Vinculala desde Conexión escaneando el QR con el teléfono del número.';
  }
  if (health.quarantine) {
    red.push(`Está en cuarentena: ${health.status_reason ?? 'por el sistema'}.`);
    action ??= 'Esperá a que baje la actividad y pedí al Super Admin que la libere en Anti-Baneo (Monitoreo) cuando esté sana.';
  }
  if (health.health === 'red' && !health.quarantine) {
    red.push(health.status_reason ?? 'Salud en rojo.');
    action ??= 'No envíes masivos hoy. Revisá la lista (números que no tienen WhatsApp o que bloquearon) y el texto del mensaje.';
  }
  if (health.health === 'yellow' && health.status_reason && !/calentamiento/i.test(health.status_reason)) {
    yellow.push(health.status_reason);
  }
  if (limits?.active) {
    yellow.push(`Número en calentamiento (día ${limits.day}): hasta ${limits.dailyLimit} mensajes por día.`);
  }
  if (limits && limits.dailyRemaining === 0) {
    yellow.push(`Cupo del día agotado (${limits.dailyUsed}/${limits.dailyLimit}): los envíos esperan hasta mañana.`);
  } else if (limits && limits.dailyLimit > 0 && limits.dailyRemaining < limits.dailyLimit * 0.2) {
    yellow.push(`Queda poco cupo hoy: ${limits.dailyRemaining} de ${limits.dailyLimit} mensajes.`);
  }
  if (paused > 0) {
    yellow.push(`${paused} envío(s) pausado(s) por el anti-baneo.`);
    action ??= 'Revisá en Lotes por qué se pausaron antes de reanudarlos.';
  }

  if (red.length) {
    return { level: 'red', title: 'No conviene enviar ahora', reasons: [...red, ...yellow], action, canSend: false, stats };
  }
  if (yellow.length) {
    return { level: 'yellow', title: 'Se puede enviar, con cuidado', reasons: yellow, action, canSend: true, stats };
  }
  return { level: 'green', title: 'Número sano', reasons: ['Conectado, sin cuarentena, buena entrega y con cupo disponible.'], action: null, canSend: true, stats };
}

/**
 * ¿Se puede crear un lote desde esta línea? Devuelve el motivo para mostrarle a
 * quien envía (o null si se puede). La desconexión la explica `notReadyMessage`.
 */
export function sendBlockedReason(session: SessionRow): string | null {
  if (session.status !== 'ready') return null;
  const v = lineVerdict(session);
  if (v.canSend) return null;
  return `Tu línea no está en condiciones de enviar masivos: ${v.reasons.join(' ')}${v.action ? ` ${v.action}` : ''}`;
}
