import { all, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { logger } from '../logger.js';
import { panelBus } from '../panel/events.js';

/**
 * Recordatorios de tareas con hora: cuando llega la fecha y hora de una nota
 * pendiente, se avisa en vivo a su responsable (o a su autor si no tiene). Cada
 * nota avisa una sola vez (`reminded_at`); posponerla lo vuelve a habilitar.
 */

/** Avisos más viejos que esto (p. ej. el servidor estuvo apagado) no se muestran:
 * quedan en el resumen del día como vencidos. */
const MAX_LATE_HOURS = 12;

interface DueRow {
  id: number;
  note_text: string | null;
  audio_path: string | null;
  due_at: string;
  due_time: string;
  user_id: number | null;
  assigned_to: number | null;
  session_id: string;
  chat_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  late: number;
}

export function checkNoteReminders(): number {
  const due = all<DueRow>(
    `SELECT n.id, n.note_text, n.audio_path, n.due_at, n.due_time, n.user_id, n.assigned_to,
            ct.session_id, ct.chat_id, ct.name AS contact_name, ct.phone AS contact_phone,
            (julianday('now','localtime') - julianday(n.due_at || ' ' || n.due_time)) * 24 > ${MAX_LATE_HOURS} AS late
       FROM contact_notes n JOIN contacts ct ON ct.id = n.contact_id
      WHERE n.deleted_at IS NULL AND n.done_at IS NULL AND n.reminded_at IS NULL
        AND n.due_at IS NOT NULL AND n.due_time IS NOT NULL
        AND n.due_at || ' ' || n.due_time <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')
      LIMIT 200`,
  );
  for (const n of due) {
    run('UPDATE contact_notes SET reminded_at = ? WHERE id = ?', nowIso(), n.id);
    const userId = n.assigned_to ?? n.user_id;
    if (!userId || n.late) continue;
    const text = n.note_text ? n.note_text.slice(0, 200) : 'Nota de voz';
    panelBus.publish('reminder', {
      // Privado: solo lo recibe esta persona (lleva el texto de la nota).
      private: true,
      userIds: [userId],
      noteId: n.id,
      text,
      dueAt: n.due_at,
      dueTime: n.due_time,
      sessionId: n.session_id,
      chatId: n.chat_id,
      contact: n.contact_name || n.contact_phone || n.chat_id.split('@')[0],
    });
  }
  return due.length;
}

export function startNoteReminderWorker(): NodeJS.Timeout {
  const tick = () => {
    try {
      checkNoteReminders();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Error al revisar recordatorios de notas');
    }
  };
  setTimeout(tick, 15_000);
  return setInterval(tick, 30_000);
}
