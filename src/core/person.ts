import { all, run } from '../db/index.js';
import { nowIso } from '../util/async.js';

/**
 * Datos de la persona que llegan de cronogramas al enviarle un mensaje: su
 * nombre completo y los programas en los que participa. Se guardan por número
 * (`phone_key`), no por línea: así cualquier usuario que la atienda, desde el
 * número que sea, sabe quién es y de qué programa.
 */

/** Teléfono solo con dígitos, con `591` si es local de 8 y sin prefijo `00` (misma regla que `contacts.phone_key`). */
export function phoneKeyOf(value: string | null | undefined): string | null {
  let d = String(value ?? '').replace(/@.*$/, '').replace(/\D+/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 8) d = `591${d}`;
  return d || null;
}

export function tagPerson(
  chatId: string,
  tag: { fullName?: string | null; programa?: string | null; programaId?: number | null; sessionId?: string | null },
): void {
  if (chatId.endsWith('@g.us')) return;
  const key = phoneKeyOf(chatId);
  const programa = (tag.programa ?? '').trim();
  if (!key || !programa) return;
  run(
    `INSERT INTO person_programs (phone_key, programa, programa_id, full_name, session_id, last_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(phone_key, programa) DO UPDATE SET
       programa_id = COALESCE(excluded.programa_id, person_programs.programa_id),
       full_name = COALESCE(excluded.full_name, person_programs.full_name),
       session_id = COALESCE(excluded.session_id, person_programs.session_id),
       last_at = excluded.last_at`,
    key,
    programa,
    tag.programaId ?? null,
    tag.fullName?.trim() || null,
    tag.sessionId ?? null,
    nowIso(),
  );
}

export interface PersonTags {
  /** Nombre completo según cronogramas (el del envío más reciente). */
  full_name: string | null;
  /** Programas, del más reciente al más antiguo. */
  programas: string[];
}

/** Nombre y programas de varias personas por número (una consulta). */
export function personTagsByKeys(keys: Array<string | null | undefined>): Map<string, PersonTags> {
  const map = new Map<string, PersonTags>();
  const list = [...new Set(keys.filter((k): k is string => !!k))];
  if (!list.length) return map;
  const rows = all<{ phone_key: string; programa: string; full_name: string | null }>(
    `SELECT phone_key, programa, full_name FROM person_programs
      WHERE phone_key IN (${list.map(() => '?').join(',')})
      ORDER BY last_at DESC`,
    ...list,
  );
  for (const r of rows) {
    const t = map.get(r.phone_key) ?? { full_name: null, programas: [] };
    if (!t.full_name && r.full_name) t.full_name = r.full_name;
    if (!t.programas.includes(r.programa)) t.programas.push(r.programa);
    map.set(r.phone_key, t);
  }
  return map;
}
