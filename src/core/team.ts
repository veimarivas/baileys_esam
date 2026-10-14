import { all } from '../db/index.js';
import { esamAreaLabel, type UserRow } from '../auth/users.js';
import { phoneKeyOf } from './person.js';

/**
 * Equipo: usuarios del sistema con número de WhatsApp (el de cronogramas o el
 * de la línea que tienen vinculada). Cuando uno conversa con un compañero, el
 * chat muestra su nombre y su área en lugar del nombre de WhatsApp.
 */

export interface TeamMember {
  user_id: number;
  name: string;
  area: string;
  /** Número principal (dígitos, con 591). */
  phone: string;
  /** Todos los números conocidos del usuario (`phone_key`). */
  keys: string[];
  /** Su línea en el sistema está conectada. */
  line_ready: boolean;
}

/** Datos del compañero que se adjuntan a una conversación. */
export interface TeamTag {
  user_id: number;
  name: string;
  area: string;
}

const TTL_MS = 60_000;
let cache: { at: number; list: TeamMember[]; byKey: Map<string, TeamMember> } | null = null;

export function invalidateTeam(): void {
  cache = null;
}

function load(): NonNullable<typeof cache> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const users = all<UserRow>(
    `SELECT * FROM users WHERE esam_autorizado = 1 OR source = 'local' OR NULLIF(esam_numero, '') IS NOT NULL`,
  );
  const sessions = all<{ owner_uid: string | null; phone: string | null; expected_phone: string | null; status: string }>(
    'SELECT owner_uid, phone, expected_phone, status FROM sessions WHERE owner_uid IS NOT NULL',
  );
  const toKey = (p: string | null | undefined) => (p && String(p).replace(/\D+/g, '').length >= 8 ? phoneKeyOf(p) : null);
  const list: TeamMember[] = [];
  const byKey = new Map<string, TeamMember>();
  const fromLine: Array<[string, TeamMember]> = [];
  for (const u of users) {
    // Las líneas se asocian por el id de cronogramas; un usuario local no tiene
    // (su id podría coincidir con el de otro usuario de cronogramas).
    const own = u.source === 'local' || !u.source_uid ? [] : sessions.filter((s) => s.owner_uid === u.source_uid);
    const registered = toKey(u.esam_numero);
    const lineKeys = own.flatMap((s) => [toKey(s.phone), toKey(s.expected_phone)]).filter((k): k is string => !!k);
    const keys = [...new Set([registered, ...lineKeys].filter((k): k is string => !!k))];
    if (!keys.length) continue;
    const member: TeamMember = {
      user_id: u.id,
      name: (u.name ?? '').trim() || u.username || u.email || `Usuario ${u.id}`,
      area: esamAreaLabel(u),
      phone: keys[0],
      keys,
      line_ready: own.some((s) => s.status === 'ready'),
    };
    list.push(member);
    if (registered && !byKey.has(registered)) byKey.set(registered, member);
    for (const k of lineKeys) fromLine.push([k, member]);
  }
  // El número registrado en cronogramas manda; el de la línea solo si nadie lo tiene.
  for (const [k, m] of fromLine) if (!byKey.has(k)) byKey.set(k, m);
  list.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  cache = { at: Date.now(), list, byKey };
  return cache;
}

export function teamMembers(): TeamMember[] {
  return load().list;
}

/** Compañero dueño de un número (`phone_key`), si lo hay. */
export function teamTagFor(key: string | null | undefined): TeamTag | null {
  if (!key) return null;
  const m = load().byKey.get(key);
  return m ? { user_id: m.user_id, name: m.name, area: m.area } : null;
}
