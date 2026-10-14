import path from 'node:path';
import { all, get, run } from '../db/index.js';
import { nowIso, delay } from '../util/async.js';
import { config } from '../config.js';
import { Pacing } from './pacing.js';
import {
  batchDeliveryRate,
  hoursSinceLastBatchSend,
  unansweredStreak,
  countNewContactsToday,
  getPolicy,
  isNewContact,
  limitState,
  pacingOptionsFor,
  resetTrust,
  type LimitState,
} from './anti-ban.js';
import { recomputeHealth } from './health.js';
import { isQuarantined, quarantineAndRotate, rotateBatches } from './session-pool.js';
import { isBlocked, looksLikeBlock, markBlocked } from './optout.js';
import { mediaExists, readMedia } from './media.js';
import { typeForMime } from './phone.js';
import { audit } from './webhooks.js';
import { logger } from '../logger.js';
import type { BatchItemRow, BatchRow, OutboundSender, SessionRow } from '../types.js';

/** Fallos de envío consecutivos por defecto antes de la cuarentena (la política lo ajusta). */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Resultado de `onWhatsApp` por número (evita consultar dos veces el mismo). */
const numberCheckCache = new Map<string, { exists: boolean; at: number }>();

/**
 * Procesa los lotes en segundo plano respetando el pacing anti-baneo.
 * Un solo worker recorre la cola para no saturar la sesión.
 */
export class BatchRunner {
  private queue: number[] = [];
  private processing = false;
  /** Lotes pausados que se están esperando (para retomarlos automáticamente). */
  private waiting = new Set<number>();
  /** Fallos de envío consecutivos por sesión (para cuarentena automática). */
  private consecutiveFailures = new Map<string, number>();

  constructor(private readonly sender: OutboundSender) {}

  /** Encola un lote para procesar. */
  enqueue(batchId: number): void {
    if (!this.queue.includes(batchId)) this.queue.push(batchId);
    void this.pump();
  }

  /** Reanuda lotes que quedaron `running` o `scheduled` tras un reinicio. */
  resumePending(): void {
    const rows = all<{ id: number }>(
      "SELECT id FROM batches WHERE status IN ('running', 'scheduled') ORDER BY id",
    );
    for (const row of rows) this.enqueue(row.id);
    if (rows.length) logger.info({ count: rows.length }, 'Lotes reanudados tras reinicio');
  }

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        await this.run(id);
      }
    } finally {
      this.processing = false;
    }
  }

  private async run(batchId: number): Promise<void> {
    let batch = get<BatchRow>('SELECT * FROM batches WHERE id = ?', batchId);
    if (!batch) return;
    if (batch.status === 'cancelled' || batch.status === 'done') return;

    if (!batch.started_at) {
      run("UPDATE batches SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), batchId);
    }

    const sessionId = batch.session_id ?? '';

    // Si la sesión está en cuarentena, rotar el lote a otra sana del pool.
    if (sessionId && isQuarantined(sessionId)) {
      const rot = rotateBatches(sessionId, (id) => this.enqueue(id));
      if (rot.moved > 0) {
        logger.info({ batch: batchId, from: sessionId, to: rot.to }, 'Lote rotado a una sesión sana');
        return; // se reprocesa con la nueva sesión (ya encolado)
      }
      pauseBatch(batchId, 'Sesión en cuarentena y sin reemplazo sano en el pool');
      recomputeHealth(sessionId);
      return;
    }

    const session = get<SessionRow>('SELECT * FROM sessions WHERE id = ?', sessionId) ?? null;
    const policy = getPolicy(sessionId);
    const meta = parseMeta(batch.meta);
    const programKey = meta.programaId != null ? String(meta.programaId) : meta.programa ?? undefined;

    const pacing = new Pacing(
      sessionId,
      pacingOptionsFor(sessionId, policy, session, config.pacing.programCooldownMinutes),
    );

    const pending = getPendingItems(batchId);

    // Estado de límites (diario/horario/warm-up) recalculado al cambiar de hora.
    let limits: LimitState | null = policy.active ? limitState(sessionId, policy, session) : null;
    let hourBucket = Math.floor(Date.now() / 3_600_000);
    let sinceHealthRefresh = 0;
    // Envíos efectivos en esta corrida (para jitter/pausas por fatiga).
    let sentInRun = 0;
    let newContactsToday = policy.active ? countNewContactsToday(sessionId) : 0;
    const maxFailures = Math.max(1, policy.max_consecutive_failures || MAX_CONSECUTIVE_FAILURES);

    for (let i = 0; i < pending.length; i++) {
      // Estado del lote: pausa/cancelación se respetan en cada iteración.
      batch = get<BatchRow>('SELECT * FROM batches WHERE id = ?', batchId)!;
      if (!batch || batch.status === 'cancelled') break;

      if (batch.status === 'paused') {
        this.waiting.add(batchId);
        await delay(5000);
        i--; // reintentar la misma posición al reanudar
        continue;
      }
      this.waiting.delete(batchId);

      const item = get<BatchItemRow>('SELECT * FROM batch_items WHERE id = ?', pending[i].id);
      if (!item || item.status !== 'pending') continue;

      // ── Límites diarios / horarios / warm-up ────────────────────────────────
      if (limits) {
        const bucket = Math.floor(Date.now() / 3_600_000);
        if (bucket !== hourBucket) {
          limits = limitState(sessionId, policy, session);
          hourBucket = bucket;
        }
        if (limits.dailyRemaining <= 0) {
          pauseBatch(batchId, `Límite diario alcanzado (${limits.dailyLimit} mensajes). Se reanuda manualmente.`);
          logger.warn({ batch: batchId, sessionId, limit: limits.dailyLimit }, 'Lote pausado por límite diario');
          recomputeHealth(sessionId);
          return;
        }
        if (limits.hourlyRemaining <= 0) {
          const waitSeconds = secondsUntilNextHour();
          logger.info({ batch: batchId, sessionId, waitSeconds }, 'Lote en espera por límite horario');
          setWaiting(batchId, `Límite por hora alcanzado (${limits.hourlyLimit} mensajes)`, waitSeconds * 1000);
          await delay(waitSeconds * 1000);
          setWaiting(batchId, null);
          limits = limitState(sessionId, policy, session);
          hourBucket = Math.floor(Date.now() / 3_600_000);
        }
      }

      if (isBlocked(item.chat_id)) {
        updateItem(item.id, 'skipped', 'Número en lista de no enviar (opt-out/bloqueado)', null);
        recount(batchId);
        continue;
      }

      // ── Protección del contacto: no repetir campañas ni insistir ──────────
      if (policy.active && policy.recontact_cooldown_hours > 0) {
        const hours = hoursSinceLastBatchSend(sessionId, item.chat_id);
        if (hours !== null && hours < policy.recontact_cooldown_hours) {
          updateItem(item.id, 'skipped', `Recibió un envío masivo hace ${Math.max(1, Math.round(hours))} h (espera mínima: ${policy.recontact_cooldown_hours} h)`, null);
          recount(batchId);
          continue;
        }
      }
      if (policy.active && policy.max_unanswered > 0) {
        const streak = unansweredStreak(sessionId, item.chat_id);
        if (streak >= policy.max_unanswered) {
          updateItem(item.id, 'skipped', `Ya tiene ${streak} mensajes sin responder (máximo: ${policy.max_unanswered})`, null);
          recount(batchId);
          continue;
        }
      }

      // ── Contactos nuevos (en frío): tope diario y verificación del número ──
      const firstContact = policy.active && isNewContact(sessionId, item.chat_id);
      if (firstContact && policy.new_contacts_daily_limit > 0 && newContactsToday >= policy.new_contacts_daily_limit) {
        pauseBatch(
          batchId,
          `Tope de contactos nuevos por día alcanzado (${policy.new_contacts_daily_limit}). Escribir en frío a muchos números provoca reportes; se reanuda manualmente.`,
        );
        logger.warn({ batch: batchId, sessionId, limit: policy.new_contacts_daily_limit }, 'Lote pausado por tope de contactos nuevos');
        recomputeHealth(sessionId);
        return;
      }
      if (firstContact && policy.verify_numbers && !item.chat_id.endsWith('@g.us') && this.sender.checkNumber) {
        const exists = await this.numberExists(sessionId, item.chat_id);
        if (exists === false) {
          updateItem(item.id, 'skipped', 'El número no tiene WhatsApp (verificación anti-baneo)', null);
          recount(batchId);
          continue;
        }
      }

      // Ritmo humano: enfriamiento, jitter o pausa por fatiga, calculado en cada
      // envío para que una espera previa no deje los siguientes en ráfaga.
      const waitMs = pacing.delayBeforeMs(sentInRun, programKey);
      if (waitMs > 0) {
        // Solo se informan las esperas largas (calentamiento, pausas por fatiga).
        if (waitMs >= 20_000) setWaiting(batchId, 'Ritmo anti-baneo entre mensajes', waitMs);
        await delay(waitMs);
        if (waitMs >= 20_000) setWaiting(batchId, null);
      }
      // Fuera de ventana: esperar al próximo hueco (y volver a validar el lote).
      if (pacing.enabled() && !pacing.isWithinWindow()) {
        const windowWait = pacing.secondsUntilNextWindow() * 1000;
        setWaiting(batchId, 'Fuera del horario de envío', windowWait);
        await delay(windowWait);
        setWaiting(batchId, null);
        i--;
        continue;
      }
      const fresh = get<BatchRow>('SELECT status FROM batches WHERE id = ?', batchId);
      if (!fresh || fresh.status === 'cancelled') break;
      if (fresh.status === 'paused') {
        i--;
        continue;
      }

      try {
        const messageId = await this.sendItem(sessionId, item);
        updateItem(item.id, 'sent', null, messageId ?? null);
        if (messageId) run("UPDATE messages SET origin = 'batch' WHERE wa_message_id = ?", messageId);
        this.sender.tagConversation?.(sessionId, item.chat_id, {
          contactName: item.contact_name,
          programa: meta.programa,
          programaId: meta.programaId,
        });
        this.consecutiveFailures.set(sessionId, 0);
        sentInRun++;
        if (firstContact) newContactsToday++;
        if (limits) {
          limits.dailyUsed += 1;
          limits.dailyRemaining = Math.max(0, limits.dailyRemaining - 1);
          limits.hourlyUsed += 1;
          limits.hourlyRemaining = Math.max(0, limits.hourlyRemaining - 1);
        }
        if (++sinceHealthRefresh >= 10) {
          sinceHealthRefresh = 0;
          const health = recomputeHealth(sessionId);
          // Bloqueos y bajas por encima del umbral: frenar antes de que WhatsApp lo haga.
          if (policy.active && health.health === 'red' && health.sent_24h >= 20 && health.report_rate >= policy.block_rate_threshold) {
            pauseBatch(
              batchId,
              `Demasiados bloqueos y bajas en 24 h (${(health.report_rate * 100).toFixed(1)}% ≥ ${(policy.block_rate_threshold * 100).toFixed(1)}%). Revisá el mensaje y la lista antes de reanudar.`,
            );
            logger.warn({ batch: batchId, sessionId, rate: health.report_rate }, 'Lote pausado por bloqueos y bajas');
            recount(batchId);
            return;
          }
          // Entregabilidad del lote en caída = señal temprana de reportes/bloqueos.
          if (policy.active && policy.auto_pause_low_delivery) {
            const d = batchDeliveryRate(batchId);
            if (d.sent >= 20 && d.rate < policy.health_delivery_threshold) {
              pauseBatch(
                batchId,
                `Entregabilidad baja en el lote (${Math.round(d.rate * 100)}% < ${Math.round(policy.health_delivery_threshold * 100)}%). Revisá la lista antes de reanudar.`,
              );
              logger.warn({ batch: batchId, sessionId, rate: d.rate }, 'Lote pausado por entregabilidad baja');
              recount(batchId);
              return;
            }
          }
        }
      } catch (err) {
        const message = (err as Error).message;
        logger.warn({ item: item.id, err: message }, 'Fallo el envío del destinatario');
        if (looksLikeBlock(message)) {
          // Bloqueo/reporte: se marca el destino y se reinicia la confianza.
          markBlocked(item.chat_id, `Bloqueo detectado al enviar: ${message}`, sessionId);
          resetTrust(sessionId);
          updateItem(item.id, 'failed', `Bloqueado: ${message}`, null);
          recomputeHealth(sessionId, { lastError: message });
        } else {
          updateItem(item.id, 'failed', message, null);
        }

        // Cuarentena automática tras demasiados fallos consecutivos.
        const fails = (this.consecutiveFailures.get(sessionId) ?? 0) + 1;
        this.consecutiveFailures.set(sessionId, fails);
        if (fails >= maxFailures) {
          this.consecutiveFailures.set(sessionId, 0);
          const rot = quarantineAndRotate(
            sessionId,
            (id) => this.enqueue(id),
            `${fails} fallos consecutivos de envío`,
          );
          logger.warn({ sessionId, moved: rot.moved, to: rot.to }, 'Sesión en cuarentena por fallos consecutivos');
          recount(batchId);
          if (rot.moved > 0) return; // el lote ya quedó encolado en la sesión sana
          pauseBatch(batchId, 'Sesión en cuarentena y sin reemplazo sano en el pool');
          recomputeHealth(sessionId);
          return;
        }
      }
      recount(batchId);
    }

    finalize(batchId);
    if (policy.active) recomputeHealth(sessionId);
  }

  /**
   * ¿El número tiene WhatsApp? Cachea el resultado 24 h. `null` si no se pudo
   * verificar (en ese caso se envía igual para no frenar el lote).
   */
  private async numberExists(sessionId: string, chatId: string): Promise<boolean | null> {
    const digits = chatId.replace(/@.*$/, '').replace(/\D+/g, '');
    if (!digits) return null;
    const cached = numberCheckCache.get(digits);
    if (cached && Date.now() - cached.at < 86_400_000) return cached.exists;
    try {
      const result = await this.sender.checkNumber!(sessionId, digits);
      numberCheckCache.set(digits, { exists: result.exists, at: Date.now() });
      return result.exists;
    } catch (err) {
      logger.warn({ sessionId, chatId, err: (err as Error).message }, 'No se pudo verificar el número');
      return null;
    }
  }

  private async sendItem(sessionId: string, item: BatchItemRow): Promise<string | undefined> {
    if (item.media_path && mediaExists(item.media_path)) {
      const type = item.content_type ?? typeForMime(item.media_mime ?? '');
      const result = await this.sender.sendMedia(sessionId, item.chat_id, {        type,
        contents: readMedia(item.media_path),
        mimetype: item.media_mime ?? 'application/octet-stream',
        filename: path.basename(item.media_path),
        caption: item.body ?? undefined,
        ptt: type === 'audio',
      });
      return result.messageId;
    }

    const result = await this.sender.sendText(sessionId, item.chat_id, item.body ?? '');
    return result.messageId;
  }
}

function secondsUntilNextHour(): number {
  const now = new Date();
  const seconds = (60 - now.getMinutes()) * 60 - now.getSeconds();
  return Math.max(30, seconds);
}

/**
 * Motivo y hora estimada de una espera larga del lote (`meta.waiting`), para
 * que quien envía sepa por qué no avanza. `null` la limpia.
 */
function setWaiting(batchId: number, reason: string | null, waitMs = 0): void {
  const batch = get<BatchRow>('SELECT meta FROM batches WHERE id = ?', batchId);
  if (!batch) return;
  let meta: Record<string, unknown> = {};
  try {
    meta = batch.meta ? (JSON.parse(batch.meta) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  if (reason) meta.waiting = { reason, until: new Date(Date.now() + waitMs).toISOString() };
  else delete meta.waiting;
  run('UPDATE batches SET meta = ? WHERE id = ?', JSON.stringify(meta), batchId);
}

/** Pausa un lote guardando el motivo en `meta.anti_ban_pause`. */
function pauseBatch(batchId: number, reason: string): void {
  const batch = get<BatchRow>('SELECT * FROM batches WHERE id = ?', batchId);
  if (!batch || batch.status === 'cancelled' || batch.status === 'done') return;
  let meta: Record<string, unknown> = {};
  try {
    meta = batch.meta ? (JSON.parse(batch.meta) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  meta.anti_ban_pause = reason;
  run("UPDATE batches SET status = 'paused', meta = ?, updated_at = ? WHERE id = ?", JSON.stringify(meta), nowIso(), batchId);
  audit('batch.paused', { batch_id: batchId, reason });
}

function parseMeta(raw: string | null): { programa: string | null; programaId: number | null } {
  if (!raw) return { programa: null, programaId: null };
  try {
    const parsed = JSON.parse(raw);
    return {
      programa: typeof parsed?.programa === 'string' ? parsed.programa : null,
      programaId: typeof parsed?.programa_id === 'number' ? parsed.programa_id : null,
    };
  } catch {
    return { programa: null, programaId: null };
  }
}

function getPendingItems(batchId: number): BatchItemRow[] {
  return all<BatchItemRow>(
    "SELECT * FROM batch_items WHERE batch_id = ? AND status = 'pending' ORDER BY id",
    batchId,
  );
}

function updateItem(id: number, status: string, error: string | null, messageId: string | null): void {
  run(
    'UPDATE batch_items SET status = ?, error = ?, message_id = COALESCE(?, message_id), updated_at = ? WHERE id = ?',
    status,
    error,
    messageId,
    nowIso(),
    id,
  );
}

/** Recalcula contadores del lote. */
export function recount(batchId: number): void {
  const counts = get<{ sent: number; failed: number; skipped: number; pending: number; total: number }>(
    `SELECT
       SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       COUNT(*) AS total
     FROM batch_items WHERE batch_id = ?`,
    batchId,
  );
  run(
    'UPDATE batches SET sent = ?, failed = ?, skipped = ?, updated_at = ? WHERE id = ?',
    counts?.sent ?? 0,
    counts?.failed ?? 0,
    counts?.skipped ?? 0,
    nowIso(),
    batchId,
  );
}

function finalize(batchId: number): void {
  const batch = get<BatchRow>('SELECT * FROM batches WHERE id = ?', batchId);
  if (!batch || batch.status === 'cancelled') return;
  recount(batchId);
  const fresh = get<BatchRow>('SELECT * FROM batches WHERE id = ?', batchId)!;
  const processed = fresh.sent + fresh.failed + fresh.skipped;
  if (processed >= fresh.total || fresh.status === 'paused') {
    if (processed >= fresh.total) {
      run("UPDATE batches SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), batchId);
      audit('batch.done', { batch_id: batchId, sent: fresh.sent, failed: fresh.failed, skipped: fresh.skipped });
    }
  }
}
