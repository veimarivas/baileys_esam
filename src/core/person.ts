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

/**
 * Registra (o borra, con `null`) el nombre de una persona escrito a mano en el
 * panel. Sirve para los contactos de los que cronogramas no mandó datos.
 */
export function setPersonName(key: string, fullName: string | null, userId: number | null): void {
  const name = (fullName ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) {
    run('DELETE FROM person_names WHERE phone_key = ?', key);
    return;
  }
  run(
    `INSERT INTO person_names (phone_key, full_name, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(phone_key) DO UPDATE SET full_name = excluded.full_name, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    key,
    name,
    userId,
    nowIso(),
  );
}

export interface PersonTags {
  /** Nombre completo: el más reciente entre el de cronogramas y el registrado a mano. */
  full_name: string | null;
  /** De dónde sale el nombre: un envío de cronogramas o el panel. */
  name_source?: 'cronogramas' | 'manual' | null;
  /** Quién lo registró (solo si es manual). */
  name_by?: string | null;
  /** Programas, del más reciente al más antiguo. */
  programas: string[];
}

/** Nombre y programas de varias personas por número (una consulta). */
export function personTagsByKeys(keys: Array<string | null | undefined>): Map<string, PersonTags> {
  const map = new Map<string, PersonTags>();
  const list = [...new Set(keys.filter((k): k is string => !!k))];
  if (!list.length) return map;
  const inList = list.map(() => '?').join(',');
  const rows = all<{ phone_key: string; programa: string; full_name: string | null; last_at: string }>(
    `SELECT phone_key, programa, full_name, last_at FROM person_programs
      WHERE phone_key IN (${inList})
      ORDER BY last_at DESC`,
    ...list,
  );
  const nameAt = new Map<string, string>();
  for (const r of rows) {
    const t = map.get(r.phone_key) ?? { full_name: null, name_source: null, name_by: null, programas: [] };
    if (!t.full_name && r.full_name) {
      t.full_name = r.full_name;
      t.name_source = 'cronogramas';
      nameAt.set(r.phone_key, r.last_at);
    }
    if (!t.programas.includes(r.programa)) t.programas.push(r.programa);
    map.set(r.phone_key, t);
  }
  const manual = all<{ phone_key: string; full_name: string; updated_at: string; by_name: string | null }>(
    `SELECT pn.phone_key, pn.full_name, pn.updated_at, COALESCE(NULLIF(u.name, ''), u.username) AS by_name
       FROM person_names pn LEFT JOIN users u ON u.id = pn.updated_by
      WHERE pn.phone_key IN (${inList})`,
    ...list,
  );
  for (const m of manual) {
    const t = map.get(m.phone_key) ?? { full_name: null, name_source: null, name_by: null, programas: [] };
    // Gana el más reciente: un envío posterior de cronogramas corrige al manual y viceversa.
    if (!t.full_name || (nameAt.get(m.phone_key) ?? '') <= m.updated_at) {
      t.full_name = m.full_name;
      t.name_source = 'manual';
      t.name_by = m.by_name;
    }
    map.set(m.phone_key, t);
  }
  return map;
}
