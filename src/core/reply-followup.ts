import { all, get } from '../db/index.js';
import { addNote, getOrCreateContact } from './contacts.js';
import { createTag } from './note-tags.js';
import { notify } from './notifications.js';
import { batchEngagement, COBRANZA_TIPOS, REPLY_KIND_LABEL, REPLY_WINDOW_HOURS, type ReplyKind } from './batch-engagement.js';

/**
 * Seguimiento de las respuestas a las cobranzas: cuando alguien contesta un
 * envío de cuotas con «ya pagué», un comprobante o «no puedo pagar», se crea una
 * tarea para quien pidió el envío (Contabilidad), con la respuesta y el lote.
 *
 * - Una tarea por respuesta (se reconoce por `source_message_id`).
 * - Las consultas y otras respuestas no generan tarea: ya llegan a Conversaciones.
 * - Revisa los lotes de cobranza de los últimos días cada 10 minutos.
 */

export const FOLLOWUP_KINDS: ReplyKind[] = ['pagado', 'comprobante', 'no_puede'];
const TAG = 'Respuesta a cobranza';
const LOOKBACK_DAYS = 4;

function tagId(): number {
  const row = get<{ id: number }>('SELECT id FROM note_tags WHERE name = ? COLLATE NOCASE', TAG);
  return row ? row.id : createTag({ name: TAG, color: '#0ea5e9' }).id;
}

function safeMeta(raw: string | null): Record<string, any> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/** Usuario del panel que pidió el lote (o, si no se sabe, el dueño de la línea). */
function requesterUserId(meta: Record<string, any>, sessionId: string): number | null {
  const uid = meta.solicitado_por_id ?? meta.account;
  if (uid != null) {
    const u = get<{ id: number }>('SELECT id FROM users WHERE source_uid = ? LIMIT 1', String(uid));
    if (u) return u.id;
  }
  return get<{ id: number }>(
    `SELECT u.id FROM users u JOIN sessions s ON s.owner_uid = u.source_uid OR CAST(u.id AS TEXT) = s.owner_uid WHERE s.id = ? LIMIT 1`,
    sessionId,
  )?.id ?? null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Crea las tareas pendientes. Devuelve cuántas creó. */
export function createReplyFollowups(now = new Date()): number {
  const since = new Date(now.getTime() - (LOOKBACK_DAYS * 24 + REPLY_WINDOW_HOURS) * 3600_000).toISOString();
  const batches = all<{ id: number; name: string | null; session_id: string | null; meta: string | null }>(
    `SELECT id, name, session_id, meta FROM batches WHERE created_at >= ? AND sent > 0 AND session_id IS NOT NULL ORDER BY id`,
    since,
  );
  let created = 0;
  for (const b of batches) {
    const meta = safeMeta(b.meta);
    if (!COBRANZA_TIPOS.has(String(meta.tipo ?? '')) || !b.session_id) continue;
    const assignee = requesterUserId(meta, b.session_id);
    if (!assignee) continue;
    for (const e of batchEngagement(b.id).values()) {
      const r = e.reply;
      if (!r || !FOLLOWUP_KINDS.includes(r.kind)) continue;
      if (get('SELECT 1 FROM contact_notes WHERE source_message_id = ? LIMIT 1', r.messageId)) continue;
      const contact = getOrCreateContact(b.session_id, e.chatId);
      const said = r.body?.trim() ? `«${r.body.trim().slice(0, 500)}»` : r.contentType === 'image' ? '(envió una imagen)' : r.contentType === 'document' ? '(envió un documento)' : '(sin texto)';
      const text = [
        `Respuesta a cobranza · ${REPLY_KIND_LABEL[r.kind]}`,
        said,
        '',
        `Lote #${b.id}${b.name ? ` · ${b.name}` : ''}${meta.programa ? ` · ${meta.programa}` : ''}`,
        r.kind === 'no_puede' ? 'Comunicarse para acordar el pago.' : 'Verificar el pago y registrarlo en cronogramas.',
      ].join('\n');
      const note = addNote(contact.id, null, text, null, today(), [tagId()], false, { assignedTo: assignee, sourceMessageId: r.messageId });
      const who = contact.name || `+${String(e.chatId).replace(/@.*$/, '')}`;
      notify([assignee], {
        kind: 'batch_reply',
        noteId: note.id,
        title: `${who} respondió a la cobranza: ${REPLY_KIND_LABEL[r.kind].toLowerCase()}`,
        body: `${said.slice(0, 200)} · Lote #${b.id}`,
        link: `/notes?nota=${note.id}`,
      });
      created++;
    }
  }
  return created;
}

export function startReplyFollowupWorker(): void {
  const tick = () => {
    try {
      createReplyFollowups();
    } catch {
      // un fallo de la revisión no debe afectar al servicio
    }
  };
  setTimeout(tick, 90_000);
  setInterval(tick, 10 * 60_000);
}
