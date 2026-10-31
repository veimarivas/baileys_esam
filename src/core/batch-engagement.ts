import { all, get } from '../db/index.js';

/**
 * Respuestas y acuses de los envíos masivos: de cada destinatario de un lote,
 * si el mensaje se entregó, si se leyó y si la persona respondió (y qué dijo).
 *
 * - El acuse sale del mensaje guardado (`messages.status`, por `wa_message_id`).
 * - Una respuesta es el primer mensaje entrante del mismo chat, en la misma
 *   línea, dentro de las 48 h posteriores al envío y antes del siguiente envío
 *   masivo a ese chat (así una respuesta no se cuenta para dos lotes).
 * - En las cobranzas, la respuesta se clasifica («ya pagué», comprobante, «no
 *   puedo pagar», consulta, baja) para darle seguimiento en Contabilidad.
 */

export const REPLY_WINDOW_HOURS = 48;

export type ReplyKind = 'pagado' | 'comprobante' | 'no_puede' | 'consulta' | 'baja' | 'otro';

export const REPLY_KIND_LABEL: Record<ReplyKind, string> = {
  pagado: 'Dice que ya pagó',
  comprobante: 'Envió un comprobante',
  no_puede: 'No puede pagar / pide plazo',
  consulta: 'Hace una consulta',
  baja: 'Pide no recibir mensajes',
  otro: 'Otra respuesta',
};

/** Tipos de lote que son cobranzas (los que se clasifican y generan tareas). */
export const COBRANZA_TIPOS = new Set(['cobranza', 'cuotas', 'contable']);

/** `unknown`: se envió pero no se encontró el mensaje guardado (sin acuse que mirar). */
export type Ack = 'sent' | 'delivered' | 'read' | 'failed' | 'unknown' | null;

export interface ItemReply {
  messageId: number;
  at: string;
  body: string | null;
  contentType: string;
  kind: ReplyKind;
  minutes: number;
}

export interface ItemEngagement {
  itemId: number;
  chatId: string;
  /** Acuse del mensaje (null si no se envió o no se encontró el mensaje). */
  ack: Ack;
  sentAt: string | null;
  reply: ItemReply | null;
}

export interface EngagementSummary {
  sent: number;
  /** Enviados con acuse conocido: base de los porcentajes de entrega y lectura. */
  tracked: number;
  delivered: number;
  read: number;
  replied: number;
  deliveredRate: number | null;
  readRate: number | null;
  replyRate: number | null;
  /** Mediana de minutos hasta la respuesta. */
  medianReplyMinutes: number | null;
  kinds: Record<ReplyKind, number>;
}

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Clasifica una respuesta a una cobranza por su texto (o por ser una imagen/PDF). */
export function classifyReply(body: string | null | undefined, contentType = 'text'): ReplyKind {
  const t = strip(String(body ?? '')).replace(/\s+/g, ' ').trim();
  if (/\b(stop|darme de baja|dar de baja|no me (escriban|manden|envien|molesten)|dejen de (escribir|enviar|mandar)|no quiero recibir)\b/.test(t)) return 'baja';
  if (/\bno (puedo|podre|voy a poder|podria|tengo (dinero|plata|como))\b|\b(prorroga|mas plazo|un plazo|mas tiempo|mas adelante|fin de mes|la (proxima|otra) semana|el (proximo|otro) mes|cuando cobre|cuando me paguen)\b/.test(t)) {
    return 'no_puede';
  }
  if (contentType === 'image' || contentType === 'document') return 'comprobante';
  if (/\b(ya )?(pague|pagado|cancele|cancelado|deposite|depositado|transferi|transferido|abone|realice el pago|hice el pago|hice la transferencia|ya esta pagad[oa]|adjunto (el )?comprobante|le envio (el )?comprobante|comprobante)\b/.test(t)) {
    return 'pagado';
  }
  if (t.includes('?') || /\b(cuanto|cuando|como|donde|cual|numero de cuenta|a que cuenta|me (pasa|envia|manda) (el )?qr|informacion|consulta)\b/.test(t)) return 'consulta';
  return 'otro';
}

function ackOf(itemStatus: string, msgStatus: string | null): Ack {
  if (itemStatus !== 'sent') return itemStatus === 'failed' ? 'failed' : null;
  if (msgStatus === null) return 'unknown';
  if (msgStatus === 'read' || msgStatus === 'played') return 'read';
  if (msgStatus === 'delivered') return 'delivered';
  if (msgStatus === 'failed') return 'failed';
  return 'sent';
}

const addHours = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * 3600_000).toISOString();

/** Acuse y respuesta de cada destinatario de un lote (clave: id del item). */
export function batchEngagement(batchId: number, windowHours = REPLY_WINDOW_HOURS): Map<number, ItemEngagement> {
  const out = new Map<number, ItemEngagement>();
  const batch = get<{ session_id: string | null; meta: string | null }>('SELECT session_id, meta FROM batches WHERE id = ?', batchId);
  if (!batch?.session_id) return out;
  const items = all<{ id: number; chat_id: string; status: string; updated_at: string | null; message_id: string | null; m_status: string | null; m_at: string | null }>(
    // Por id de WhatsApp en cualquier línea: un lote rotado pudo salir por otra.
    `SELECT bi.id, bi.chat_id, bi.status, bi.updated_at, bi.message_id,
            (SELECT m.status FROM messages m WHERE m.wa_message_id = bi.message_id AND m.direction = 'out' LIMIT 1) AS m_status,
            (SELECT m.occurred_at FROM messages m WHERE m.wa_message_id = bi.message_id AND m.direction = 'out' LIMIT 1) AS m_at
       FROM batch_items bi
      WHERE bi.batch_id = ?
      ORDER BY bi.id`,
    batchId,
  );
  let from: string | null = null;
  let to: string | null = null;
  for (const it of items) {
    const sentAt = it.status === 'sent' ? it.m_at ?? it.updated_at : null;
    out.set(it.id, { itemId: it.id, chatId: it.chat_id, ack: ackOf(it.status, it.m_status), sentAt, reply: null });
    if (sentAt) {
      if (!from || sentAt < from) from = sentAt;
      if (!to || sentAt > to) to = sentAt;
    }
  }
  if (!from || !to) return out;
  const until = addHours(to, windowHours);
  const chats = `SELECT chat_id FROM batch_items WHERE batch_id = ? AND status = 'sent'`;

  // Mensajes entrantes de esos chats en la ventana, del más viejo al más nuevo.
  const inbound = all<{ id: number; chat_id: string; occurred_at: string; body: string | null; content_type: string }>(
    `SELECT id, chat_id, occurred_at, body, content_type FROM messages
      WHERE session_id = ? AND direction = 'in' AND occurred_at > ? AND occurred_at <= ? AND chat_id IN (${chats})
      ORDER BY occurred_at, id`,
    batch.session_id, from, until, batchId,
  );
  // Envíos masivos posteriores a los mismos chats: cortan la ventana.
  const own = new Set(items.map((i) => i.message_id).filter(Boolean));
  const laterSends = all<{ chat_id: string; occurred_at: string; wa_message_id: string | null }>(
    `SELECT chat_id, occurred_at, wa_message_id FROM messages
      WHERE session_id = ? AND direction = 'out' AND origin = 'batch' AND occurred_at > ? AND occurred_at <= ? AND chat_id IN (${chats})
      ORDER BY occurred_at`,
    batch.session_id, from, until, batchId,
  ).filter((m) => !m.wa_message_id || !own.has(m.wa_message_id));

  const byChat = <T extends { chat_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) (m.get(r.chat_id) ?? m.set(r.chat_id, []).get(r.chat_id)!).push(r);
    return m;
  };
  const inByChat = byChat(inbound);
  const sendsByChat = byChat(laterSends);
  const cobranza = COBRANZA_TIPOS.has(String(safeMeta(batch.meta).tipo ?? ''));

  for (const e of out.values()) {
    if (!e.sentAt) continue;
    const next = sendsByChat.get(e.chatId)?.find((s) => s.occurred_at > e.sentAt!)?.occurred_at;
    const limit = next && next < addHours(e.sentAt, windowHours) ? next : addHours(e.sentAt, windowHours);
    const r = inByChat.get(e.chatId)?.find((m) => m.occurred_at > e.sentAt! && m.occurred_at <= limit);
    if (!r) continue;
    e.reply = {
      messageId: r.id,
      at: r.occurred_at,
      body: r.body,
      contentType: r.content_type,
      kind: cobranza ? classifyReply(r.body, r.content_type) : 'otro',
      minutes: Math.max(0, Math.round((new Date(r.occurred_at).getTime() - new Date(e.sentAt).getTime()) / 60000)),
    };
  }
  return out;
}

export function summarizeEngagement(items: Iterable<ItemEngagement>): EngagementSummary {
  const kinds: Record<ReplyKind, number> = { pagado: 0, comprobante: 0, no_puede: 0, consulta: 0, baja: 0, otro: 0 };
  let sent = 0, tracked = 0, delivered = 0, read = 0, replied = 0;
  const mins: number[] = [];
  for (const e of items) {
    if (!e.sentAt) continue;
    sent++;
    if (e.ack !== 'unknown' || e.reply) tracked++;
    if (e.ack === 'delivered' || e.ack === 'read') delivered++;
    if (e.ack === 'read') read++;
    if (e.reply) {
      replied++;
      // Quien responde también recibió y leyó, aunque el acuse no haya llegado.
      if (e.ack !== 'delivered' && e.ack !== 'read') delivered++;
      if (e.ack !== 'read') read++;
      kinds[e.reply.kind]++;
      mins.push(e.reply.minutes);
    }
  }
  mins.sort((a, b) => a - b);
  const pct = (n: number, base: number) => (base ? Math.round((n / base) * 100) : null);
  return {
    sent,
    tracked,
    delivered,
    read,
    replied,
    deliveredRate: pct(delivered, tracked),
    readRate: pct(read, tracked),
    replyRate: pct(replied, sent),
    medianReplyMinutes: mins.length ? mins[Math.floor(mins.length / 2)] : null,
    kinds,
  };
}

/** Resumen de varios lotes de una vez (lista de Lotes y Reportes). */
export function batchesEngagement(batchIds: number[]): Map<number, EngagementSummary> {
  const out = new Map<number, EngagementSummary>();
  for (const id of batchIds) out.set(id, summarizeEngagement(batchEngagement(id).values()));
  return out;
}

function safeMeta(raw: string | null): Record<string, any> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, any>) : {};
  } catch {
    return {};
  }
}
