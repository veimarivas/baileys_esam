import { get } from '../db/index.js';
import { getPolicy, limitState } from './anti-ban.js';
import { getHealth, recomputeHealth, SETTLE_MINUTES, SYSTEM_OUT_SQL } from './health.js';
import type { SessionRow } from '../types.js';

/**
 * Semáforo del número: un veredicto único («¿está sano para enviar?») que junta
 * lo que antes estaba repartido en varias pantallas: conexión, cuarentena,
 * salud de las últimas 24 h, calentamiento, cupo del día y lotes pausados.
 *
 * - rojo: no conviene (o no se puede) enviar ahora → la API no crea lotes nuevos.
 * - amarillo: se puede, con cuidado (calentamiento, cupo bajo, señales de riesgo).
 * - verde: todo en orden.
 *
 * Cada punto revisado va en `checks`, con su valor, el límite, por qué importa
 * y cómo solucionarlo, para que quien envía entienda el color.
 */

export type VerdictLevel = 'green' | 'yellow' | 'red';
export type CheckStatus = 'ok' | 'warn' | 'bad' | 'info';

export interface VerdictCheck {
  key: string;
  label: string;
  status: CheckStatus;
  /** Lo que se midió («96% de 40 mensajes»). */
  value: string;
  /** Cuándo cambia de color («Rojo si baja de 90%»). */
  rule: string;
  /** Por qué importa / qué significa. */
  why: string;
  /** Qué hacer (solo si no está en verde). */
  fix: string | null;
}

export interface LineVerdict {
  level: VerdictLevel;
  title: string;
  reasons: string[];
  action: string | null;
  /** ¿Se pueden crear lotes nuevos desde esta línea? */
  canSend: boolean;
  checks: VerdictCheck[];
  stats: {
    sent24h: number;
    deliveryRate: number | null;
    blocked24h: number;
    dailyUsed: number;
    dailyLimit: number;
    warmupDay: number | null;
    pausedBatches: number;
    /** Mensajes escritos desde el teléfono / WhatsApp Web en 24 h (no cuentan). */
    phone24h: number;
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function lineVerdict(session: SessionRow): LineVerdict {
  const health = recomputeHealth(session.id) ?? getHealth(session.id)!;
  const policy = getPolicy(session.id);
  const limits = policy.active ? limitState(session.id, policy, session) : null;
  const paused = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM batches WHERE session_id = ? AND status = 'paused' AND json_extract(meta, '$.anti_ban_pause') IS NOT NULL`,
    session.id,
  )?.c ?? 0;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const settled = new Date(Date.now() - SETTLE_MINUTES * 60_000).toISOString();
  const phone24h = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND direction = 'out' AND origin = 'phone' AND occurred_at >= ?`,
    session.id,
    since,
  )?.c ?? 0;
  const measured = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND occurred_at >= ? AND occurred_at <= ? AND ${SYSTEM_OUT_SQL}`,
    session.id,
    since,
    settled,
  )?.c ?? 0;

  const stats = {
    sent24h: health.sent_24h,
    deliveryRate: measured >= 5 ? health.delivery_rate : null,
    blocked24h: health.blocked_24h,
    dailyUsed: limits?.dailyUsed ?? 0,
    dailyLimit: limits?.dailyLimit ?? 0,
    warmupDay: limits?.active ? limits.day : null,
    pausedBatches: paused,
    phone24h,
  };

  const checks: VerdictCheck[] = [];
  const red: string[] = [];
  const yellow: string[] = [];
  let action: string | null = null;

  // 1. Conexión
  const connected = session.status === 'ready';
  checks.push({
    key: 'connection',
    label: 'Conexión con WhatsApp',
    status: connected ? 'ok' : 'bad',
    value: connected ? 'Conectada' : 'Sin conexión',
    rule: 'Rojo si la línea no está vinculada.',
    why: 'Sin conexión no sale ni entra ningún mensaje por este número.',
    fix: connected ? null : 'Vinculala desde Conexión escaneando el QR con el teléfono del número.',
  });
  if (!connected) {
    red.push('La línea no está conectada a WhatsApp.');
    action = 'Vinculala desde Conexión escaneando el QR con el teléfono del número.';
  }

  // 2. Cuarentena (el motivo real queda en last_error: status_reason es genérico)
  const qReason = (health.last_error || health.status_reason || 'por el sistema').replace(/\.$/, '');
  checks.push({
    key: 'quarantine',
    label: 'Cuarentena',
    status: health.quarantine ? 'bad' : 'ok',
    value: health.quarantine ? `Sí: ${qReason}` : 'No',
    rule: 'Rojo mientras el número esté en cuarentena.',
    why: 'El sistema la activa ante fallos seguidos o muchos bloqueos, para que WhatsApp no suspenda el número. Mientras dure, los masivos quedan en pausa.',
    fix: health.quarantine ? 'Esperá a que baje la actividad y pedí al Super Admin que la libere en Anti-Baneo (Monitoreo) cuando esté sana.' : null,
  });
  if (health.quarantine) {
    red.push(`Está en cuarentena: ${qReason}.`);
    action ??= 'Esperá a que baje la actividad y pedí al Super Admin que la libere en Anti-Baneo (Monitoreo) cuando esté sana.';
  }

  // 3. Entrega (24 h)
  const thr = policy.health_delivery_threshold;
  const deliveryFix = 'Revisá la lista: quitá los números mal escritos o que no tienen WhatsApp, y evitá escribir en frío a muchos contactos que no te tienen agendado. Si el teléfono estuvo sin internet, conectalo y esperá a que lleguen los acuses.';
  let deliveryStatus: CheckStatus = 'info';
  let deliveryValue = `Pocos mensajes para medir (${measured} enviados por el sistema)`;
  if (measured >= 5) {
    const r = health.delivery_rate;
    deliveryValue = `${pct(r)} entregados de ${measured} mensajes del sistema`;
    deliveryStatus = r < thr ? 'bad' : r < thr + 0.05 ? 'warn' : 'ok';
  }
  checks.push({
    key: 'delivery',
    label: 'Entrega de mensajes (24 h)',
    status: deliveryStatus,
    value: deliveryValue,
    rule: `Rojo si baja de ${pct(thr)}, amarillo por debajo de ${pct(thr + 0.05)}. Se mide desde 5 mensajes.`,
    why: `Mide cuántos de los mensajes que envió el sistema (panel, lotes, cronogramas) llegaron al teléfono del destinatario (✓✓). Si muchos quedan sin entregar, WhatsApp lo toma como envío a números que no existen o que no quieren recibirte. No cuentan los mensajes de grupos, los de los últimos ${SETTLE_MINUTES} minutos (todavía no tienen acuse) ni los que escribís desde el teléfono o WhatsApp Web${phone24h ? ` (${phone24h} hoy)` : ''}: esos no reciben acuse en el sistema.`,
    fix: deliveryStatus === 'bad' || deliveryStatus === 'warn' ? deliveryFix : null,
  });
  if (deliveryStatus === 'bad' && !health.quarantine) {
    red.push(`Entrega baja: ${pct(health.delivery_rate)} de los mensajes del sistema (mínimo ${pct(thr)}).`);
    action ??= deliveryFix;
  } else if (deliveryStatus === 'warn') {
    yellow.push(`Entrega cerca del mínimo: ${pct(health.delivery_rate)} (rojo debajo de ${pct(thr)}).`);
  }

  // 4. Bloqueos y bajas (24 h)
  const bthr = policy.block_rate_threshold;
  const blocked = health.blocked_24h;
  const rate = health.report_rate;
  const blockedStatus: CheckStatus =
    health.sent_24h >= 20 && blocked >= 2 && rate >= bthr ? 'bad' : blocked >= 2 && rate >= bthr / 2 ? 'warn' : 'ok';
  const blockFix = 'Pausá los masivos de hoy. Revisá el texto (que se identifique quién escribe y por qué) y enviá solo a quienes esperan el mensaje. A quien pidió la baja, no le vuelvas a escribir.';
  checks.push({
    key: 'blocks',
    label: 'Bloqueos y pedidos de baja (24 h)',
    status: blockedStatus,
    value: blocked ? `${blocked} (${(rate * 100).toFixed(1)}% de lo enviado)` : 'Ninguno',
    rule: `Rojo con 2 o más y ${pct(bthr)} de lo enviado (desde 20 mensajes); amarillo desde ${(bthr * 50).toFixed(0)}%.`,
    why: 'Cada persona que bloquea el número o responde «no me escriban» es la señal que más pesa para que WhatsApp suspenda una cuenta.',
    fix: blockedStatus === 'ok' ? null : blockFix,
  });
  if (blockedStatus === 'bad' && !health.quarantine) {
    red.push(`Muchos bloqueos y bajas: ${blocked} en 24 h.`);
    action ??= blockFix;
  } else if (blockedStatus === 'warn') {
    yellow.push(`Bloqueos y bajas en aumento: ${blocked} en 24 h.`);
  }

  // 5. Calentamiento
  if (limits?.enabled) {
    checks.push({
      key: 'warmup',
      label: 'Calentamiento del número',
      status: limits.active ? 'warn' : 'ok',
      value: limits.active ? `Día ${limits.day}: hasta ${limits.dailyLimit} mensajes por día` : `Completo (día ${limits.day})`,
      rule: 'Amarillo mientras el número esté en calentamiento.',
      why: 'Un número nuevo o recién vinculado que envía mucho de golpe es lo que WhatsApp más suspende. El límite diario sube solo cada día hasta llegar al normal.',
      fix: limits.active ? 'No hace falta hacer nada: es temporal. Mientras tanto, repartí los envíos grandes en varios días.' : null,
    });
    if (limits.active) yellow.push(`Número en calentamiento (día ${limits.day}): hasta ${limits.dailyLimit} mensajes por día.`);
  }

  // 6. Cupo del día
  if (limits && limits.dailyLimit > 0) {
    const out = limits.dailyRemaining === 0;
    const low = !out && limits.dailyRemaining < limits.dailyLimit * 0.2;
    checks.push({
      key: 'quota',
      label: 'Cupo de hoy',
      status: out || low ? 'warn' : 'ok',
      value: `${limits.dailyUsed} de ${limits.dailyLimit} mensajes usados`,
      rule: 'Amarillo cuando queda menos del 20% o se agotó.',
      why: 'Límite de mensajes del sistema por día para no superar lo que WhatsApp tolera de un número. Los que escribís desde el teléfono o WhatsApp Web no lo gastan. Se renueva a las 00:00 (hora de Bolivia).',
      fix: out ? 'Los envíos pendientes salen solos mañana. Si es urgente, pedí al Super Admin que revise el límite en Anti-Baneo.' : low ? 'Dejá los envíos grandes para mañana o repartilos.' : null,
    });
    if (out) yellow.push(`Cupo del día agotado (${limits.dailyUsed}/${limits.dailyLimit}): los envíos esperan hasta mañana.`);
    else if (low) yellow.push(`Queda poco cupo hoy: ${limits.dailyRemaining} de ${limits.dailyLimit} mensajes.`);
  }

  // 7. Envíos pausados
  checks.push({
    key: 'paused',
    label: 'Envíos pausados por el anti-baneo',
    status: paused > 0 ? 'warn' : 'ok',
    value: paused > 0 ? `${paused} envío(s)` : 'Ninguno',
    rule: 'Amarillo si hay alguno.',
    why: 'El anti-baneo pausa un envío cuando detecta riesgo (bloqueos, entrega baja, cuarentena) en lugar de seguir enviando.',
    fix: paused > 0 ? 'Abrí Lotes, leé el motivo de la pausa y reanudá solo cuando el resto del semáforo esté en verde.' : null,
  });
  if (paused > 0) {
    yellow.push(`${paused} envío(s) pausado(s) por el anti-baneo.`);
    action ??= 'Revisá en Lotes por qué se pausaron antes de reanudarlos.';
  }

  if (red.length) {
    return { level: 'red', title: 'No conviene enviar ahora', reasons: [...red, ...yellow], action, canSend: false, checks, stats };
  }
  if (yellow.length) {
    const first = checks.find((c) => c.status === 'warn');
    return { level: 'yellow', title: 'Se puede enviar, con cuidado', reasons: yellow, action: action ?? first?.fix ?? null, canSend: true, checks, stats };
  }
  return { level: 'green', title: 'Número sano', reasons: ['Conectado, sin cuarentena, buena entrega y con cupo disponible.'], action: null, canSend: true, checks, stats };
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
