import { get } from '../db/index.js';
import { getPolicy, limitState } from './anti-ban.js';
import { getConfig } from './config-store.js';
import { sessionUsage } from './anti-ban-monitor.js';
import { getHealth, recomputeHealth, SETTLE_MINUTES, SYSTEM_OUT_SQL, type HealthRow } from './health.js';
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
    /** Mensajes del sistema con más de 15 min (base de la entrega). */
    measured: number;
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface QuarantineInfo {
  reason: string;
  since: string | null;
  /** ¿Se ve sana como para liberarla? */
  canRelease: boolean;
  advice: string;
}

const fmtWhen = (iso: string) => new Date(iso).toLocaleString('es-BO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Motivo y momento de la cuarentena. Las anteriores a guardar el motivo se
 * recuperan del registro de auditoría. Recomienda liberar cuando la línea ya
 * está conectada, sin bloqueos en 24 h y sin entrega baja.
 */
export function quarantineInfo(session: SessionRow, health: HealthRow, deliveryThreshold: number, measured: number): QuarantineInfo {
  let reason = health.quarantine_reason;
  let since = health.quarantine_at;
  if (!reason) {
    const log = get<{ context: string | null; created_at: string }>(
      `SELECT context, created_at FROM audit_logs WHERE action = 'anti_ban.quarantine' AND json_extract(context, '$.session_id') = ?
        AND json_extract(context, '$.quarantine') = 1 ORDER BY id DESC LIMIT 1`,
      session.id,
    );
    try {
      reason = log?.context ? (JSON.parse(log.context) as { reason?: string }).reason ?? null : null;
    } catch {
      reason = null;
    }
    since ??= log?.created_at ?? null;
  }
  const label = (reason || 'motivo no registrado').replace(/\.$/, '');
  const hours = since ? (Date.now() - Date.parse(since)) / 3_600_000 : null;
  const deliveryOk = measured < 5 || health.delivery_rate >= deliveryThreshold;
  const problems: string[] = [];
  if (session.status !== 'ready') problems.push('vincular de nuevo el número (está desconectado)');
  if (health.blocked_24h > 0) problems.push(`esperar: hubo ${health.blocked_24h} bloqueo(s) o baja(s) en 24 h`);
  if (!deliveryOk) problems.push('revisar la lista: la entrega está baja');
  const canRelease = problems.length === 0;
  const byFailures = /fallos/i.test(label);
  const advice = canRelease
    ? `Se ve sana${hours !== null ? ` (lleva ${hours < 1 ? 'menos de 1 h' : `${Math.round(hours)} h`} en cuarentena)` : ''}: está conectada, sin bloqueos y sin entrega baja. ${byFailures ? 'Antes de liberarla, mirá en Lotes el error de los envíos que fallaron (número inválido, sin conexión…). ' : ''}El Super Admin puede liberarla en Anti-Baneo › detalle de la línea; los envíos pausados se reanudan desde Lotes.`
    : `Antes de liberarla hay que ${problems.join('; ')}. Después, el Super Admin la libera en Anti-Baneo › detalle de la línea.`;
  return { reason: label, since, canRelease, advice };
}

/** Mensajes que WhatsApp no pudo descifrar en 24 h (lo registra la conexión). */
export function decryptFailures(sessionId: string): { count: number; fromPhone: number } | null {
  const raw = getConfig(`decrypt_failures:${sessionId}`);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { count: number; from_phone: number; last_at: string };
    if (!d.last_at || Date.now() - Date.parse(d.last_at) > 86_400_000 || !d.count) return null;
    return { count: Number(d.count) || 0, fromPhone: Number(d.from_phone) || 0 };
  } catch {
    return null;
  }
}

const DAY_NAMES = ['', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

/** «lun a sáb», «todos los días» o «lun, mié, vie». */
function daysLabel(days: number[]): string {
  const d = [...new Set(days)].filter((x) => x >= 1 && x <= 7).sort((a, b) => a - b);
  if (d.length === 7 || !d.length) return 'todos los días';
  const consecutive = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return consecutive && d.length > 2 ? `${DAY_NAMES[d[0]]} a ${DAY_NAMES[d[d.length - 1]]}` : d.map((x) => DAY_NAMES[x]).join(', ');
}

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
    measured,
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

  // 2. Cuarentena: motivo y desde cuándo, y si ya se puede liberar.
  const q = health.quarantine ? quarantineInfo(session, health, policy.health_delivery_threshold, measured) : null;
  checks.push({
    key: 'quarantine',
    label: 'Cuarentena',
    status: q ? 'bad' : 'ok',
    value: q ? `Sí${q.since ? `, desde ${fmtWhen(q.since)}` : ''}: ${q.reason}` : 'No',
    rule: 'Rojo mientras el número esté en cuarentena. No se levanta sola: la libera el Super Admin.',
    why: 'El sistema la activa cuando varios envíos seguidos fallan (o un administrador la pone a mano), para que WhatsApp no suspenda el número. Mientras dure, los envíos masivos de la línea quedan en pausa y no se crean nuevos.',
    fix: q ? q.advice : null,
  });
  if (q) {
    red.push(`Está en cuarentena: ${q.reason}.`);
    action ??= q.advice;
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

  // 7. Horario de envío, uso de la última hora y contactos nuevos (política de la línea)
  if (policy.active) {
    const usage = sessionUsage(session, policy);
    const days = daysLabel(policy.window_days);
    const hours = `${policy.window_start} a ${policy.window_end}`;
    checks.push({
      key: 'window',
      label: 'Horario de envío',
      status: usage.windowOpen ? 'ok' : 'warn',
      value: usage.windowOpen ? `Abierto (${hours}, ${days})` : `Fuera de horario · ${usage.windowLabel.replace(/^Cerrada · /, '')}`,
      rule: `Amarillo fuera del horario de la política: ${hours}, ${days} (hora de Bolivia).`,
      why: `Los envíos masivos solo salen dentro de ese horario. Fuera de él quedan en espera y salen solos cuando abre: no se pierden. Escribir de noche o en días no hábiles molesta más y aumenta los bloqueos. El ritmo es de ${policy.delay_min_seconds}–${policy.delay_max_seconds} s por mensaje.`,
      fix: usage.windowOpen ? null : `No hace falta hacer nada: lo que envíes ahora queda en espera y sale a partir de las ${policy.window_start}. Evitá escribir a mano a contactos nuevos a esta hora.`,
    });
    if (!usage.windowOpen) yellow.push(`Fuera del horario de envío (${hours}): los masivos salen a partir de las ${policy.window_start}.`);

    if (usage.hourlyLimit > 0) {
      const left = usage.hourlyLimit - usage.hourlyUsed;
      const low = left < usage.hourlyLimit * 0.2;
      checks.push({
        key: 'hourly',
        label: 'Mensajes en la última hora',
        status: low ? 'warn' : 'ok',
        value: `${usage.hourlyUsed} de ${usage.hourlyLimit}`,
        rule: 'Amarillo cuando queda menos del 20% del tope por hora.',
        why: 'Muchos mensajes seguidos en poco tiempo es una señal de envío automático. El motor frena solo al llegar al tope y sigue en la hora siguiente.',
        fix: low ? 'Esperá a que pase la hora: el envío continúa solo, sin perder mensajes.' : null,
      });
      if (low) yellow.push(`Cerca del tope por hora: ${usage.hourlyUsed} de ${usage.hourlyLimit}.`);
    }

    if (usage.newContactsLimit > 0) {
      const near = usage.newContactsToday >= usage.newContactsLimit * 0.8;
      checks.push({
        key: 'new_contacts',
        label: 'Contactos nuevos hoy',
        status: near ? 'warn' : 'ok',
        value: `${usage.newContactsToday} de ${usage.newContactsLimit}`,
        rule: 'Amarillo desde el 80% del máximo diario.',
        why: 'Escribir a números que nunca conversaron con esta línea («en frío») es la causa principal de reportes y suspensiones. Por eso hay un máximo por día.',
        fix: near ? 'Dejá los contactos nuevos restantes para mañana. Priorizá a quienes ya conversaron con la línea.' : null,
      });
      if (near) yellow.push(`Contactos nuevos cerca del máximo: ${usage.newContactsToday} de ${usage.newContactsLimit}.`);
    }
  }

  // 8. Mensajes sin descifrar (aviso de la conexión: no cambia el color)
  const dec = decryptFailures(session.id);
  if (dec) {
    checks.push({
      key: 'decrypt',
      label: 'Mensajes sin descifrar (24 h)',
      status: 'info',
      value: `${dec.count} mensaje(s)${dec.fromPhone ? `, ${dec.fromPhone} del propio teléfono` : ''}`,
      rule: 'No cambia el color: es un aviso de la conexión, no un riesgo de bloqueo.',
      why: 'WhatsApp no pudo descifrar algunos mensajes que llegaron a esta línea, así que no se ven en el panel. Suele pasar justo después de vincular, si el teléfono estuvo mucho tiempo sin internet o si se reinstaló WhatsApp.',
      fix: 'Abrí WhatsApp en el teléfono con internet para que se sincronice. Si los contactos ven «Esperando el mensaje», usá «Reparar cifrado» en Conexión. Si sigue pasando, «Empezar de cero (QR nuevo)»: no borra conversaciones ni notas.',
    });
  }

  // 9. Envíos pausados
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
