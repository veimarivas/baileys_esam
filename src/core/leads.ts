import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { displayPhoneNumber, resolveChatId } from './lid.js';
import { phoneKeyOf } from './person.js';

/**
 * Leads de marketing (PLAN_ORGANIGRAMA.md, L2). Un lead por persona y asesor
 * (`UNIQUE(owner_user_id, phone_key)`), de dos orígenes:
 *
 * - `prospecto`: registrado en cronogramas (llega por `prospects.ts`).
 * - `linea`: alguien escribe POR PRIMERA VEZ, en vivo, a la línea de una
 *   persona de Marketing. El historial que se baja al vincular un número
 *   nunca crea leads (serían años de chats viejos).
 *
 * Los mensajes (de ida y de vuelta, en vivo o del historial) solo actualizan
 * la actividad de leads que ya existen. Nada de esto puede romper la
 * recepción de mensajes: quien llama lo envuelve en try/catch.
 */

export const ETAPAS = ['nuevo', 'contactado', 'interesado', 'no_interesado', 'inscrito'] as const;
export type Etapa = (typeof ETAPAS)[number];

export const ETAPA_LABEL: Record<Etapa, string> = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  interesado: 'Interesado',
  no_interesado: 'No interesado',
  inscrito: 'Inscrito',
};

export function esEtapa(valor: unknown): valor is Etapa {
  return typeof valor === 'string' && (ETAPAS as readonly string[]).includes(valor);
}

export interface LeadRow {
  id: number;
  sede_id: number | null;
  owner_user_id: number;
  session_id: string;
  contact_id: number | null;
  phone_key: string;
  origen: 'prospecto' | 'linea';
  prospect_ref: string | null;
  programa: string | null;
  etapa: Etapa;
  ultimo_contacto_at: string | null;
  ultima_actividad_at: string;
  created_at: string;
  updated_at: string;
}

interface DuenoDeLinea {
  userId: number;
  sedeId: number | null;
  marketing: boolean;
}

/** Usuario dueño de una línea (`sessions.owner_uid` = `source_uid` o el id local). */
export function duenoDeLinea(sessionId: string): DuenoDeLinea | null {
  const fila = get<{ user_id: number; sede_id: number | null; user_area: string | null; line_area: string | null }>(
    `SELECT u.id AS user_id, COALESCE(u.sede_id, s.sede_id) AS sede_id, u.esam_area AS user_area, s.area AS line_area
       FROM sessions s
       JOIN users u ON u.source_uid = s.owner_uid OR CAST(u.id AS TEXT) = s.owner_uid
      WHERE s.id = ?
      ORDER BY (u.source_uid = s.owner_uid) DESC
      LIMIT 1`,
    sessionId,
  );
  if (!fila) return null;
  const area = (fila.user_area || fila.line_area || '').toLowerCase();
  return { userId: fila.user_id, sedeId: fila.sede_id, marketing: area === 'marketing' };
}

/** Clave de la persona de un chat individual; null para grupos, estados y canales. */
export function claveDeChat(chatId: string): string | null {
  const id = resolveChatId(chatId);
  if (!id || id.endsWith('@g.us') || id.endsWith('@broadcast') || id.endsWith('@newsletter') || id === 'status@broadcast') return null;
  const telefono = displayPhoneNumber(id);
  if (telefono) return phoneKeyOf(telefono);
  // `@lid` sin número conocido: igual es una persona; se la identifica por su LID.
  const lid = id.replace(/@.*$/, '').replace(/\D+/g, '');
  return lid ? `lid:${lid}` : null;
}

/** ¿El número es de alguien del equipo? Un colega que escribe no es un lead. */
function esDelEquipo(clave: string): boolean {
  if (clave.startsWith('lid:')) return false;
  return !!get<{ id: number }>(
    `SELECT id FROM users WHERE esam_numero IS NOT NULL AND (esam_numero = ? OR esam_numero = SUBSTR(?, 4)) LIMIT 1`,
    clave,
    clave,
  );
}

function evento(leadId: number, userId: number | null, tipo: string, extra: { texto?: string | null; de?: string | null; a?: string | null } = {}): void {
  run(
    'INSERT INTO lead_eventos (lead_id, user_id, tipo, texto, de, a, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    leadId,
    userId,
    tipo,
    extra.texto ?? null,
    extra.de ?? null,
    extra.a ?? null,
    nowIso(),
  );
}

export function getLead(id: number): LeadRow | undefined {
  return get<LeadRow>('SELECT * FROM leads WHERE id = ?', id);
}

function leadDe(ownerId: number, clave: string): LeadRow | undefined {
  return get<LeadRow>('SELECT * FROM leads WHERE owner_user_id = ? AND phone_key = ?', ownerId, clave);
}

/**
 * Primer mensaje EN VIVO de una persona a la línea de alguien de Marketing:
 * nace un lead «Nuevo». Devuelve el id del lead creado, o null si no corresponde.
 */
export function crearLeadDesdeLinea(sessionId: string, chatId: string, ocurrio: string = nowIso()): number | null {
  const clave = claveDeChat(chatId);
  if (!clave) return null;
  const dueno = duenoDeLinea(sessionId);
  if (!dueno?.marketing) return null;
  if (leadDe(dueno.userId, clave)) return null;
  if (esDelEquipo(clave)) return null;

  const contacto = get<{ id: number }>('SELECT id FROM contacts WHERE session_id = ? AND chat_id = ?', sessionId, resolveChatId(chatId));
  const now = nowIso();
  const res = run(
    `INSERT OR IGNORE INTO leads (sede_id, owner_user_id, session_id, contact_id, phone_key, origen, etapa, ultima_actividad_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'linea', 'nuevo', ?, ?, ?)`,
    dueno.sedeId,
    dueno.userId,
    sessionId,
    contacto?.id ?? null,
    clave,
    ocurrio,
    now,
    now,
  );
  if (!res.changes) return null;
  evento(res.lastInsertRowid, null, 'creado', { texto: 'Escribió por primera vez a la línea.' });
  return res.lastInsertRowid;
}

/**
 * Un mensaje en la conversación: actualiza la actividad del lead (si existe).
 * Un mensaje de la línea hacia la persona cuenta además como «contactado».
 */
export function registrarActividadLead(sessionId: string, chatId: string, direccion: 'in' | 'out', ocurrio: string): void {
  const clave = claveDeChat(chatId);
  if (!clave) return;
  const dueno = duenoDeLinea(sessionId);
  if (!dueno) return;
  run(
    `UPDATE leads SET
        ultima_actividad_at = CASE WHEN ? > ultima_actividad_at THEN ? ELSE ultima_actividad_at END,
        ultimo_contacto_at = CASE WHEN ? = 'out' AND (ultimo_contacto_at IS NULL OR ? > ultimo_contacto_at) THEN ? ELSE ultimo_contacto_at END
      WHERE owner_user_id = ? AND phone_key = ?`,
    ocurrio,
    ocurrio,
    direccion,
    ocurrio,
    ocurrio,
    dueno.userId,
    clave,
  );
}

/** Estado de cronogramas → etapa del lead (son las mismas cinco). */
export function etapaDeProspecto(estado: string | null | undefined): Etapa {
  return esEtapa(estado) ? estado : 'nuevo';
}

export interface ProspectoParaLead {
  ref: string;
  ownerUserId: number;
  sessionId: string;
  clave: string;
  contactId: number | null;
  programa: string | null;
  estado: string;
  /** El estado cambió en cronogramas (o el prospecto es nuevo): mover la etapa. */
  estadoCambio: boolean;
}

/**
 * Prospecto creado o actualizado en cronogramas → su lead. Si la persona ya
 * era lead por la línea, se le suma la referencia del prospecto (no se duplica).
 * La etapa solo se toca cuando cambia el estado en cronogramas: lo que el
 * asesor movió a mano se respeta mientras el estado siga igual.
 */
export function sincronizarProspecto(p: ProspectoParaLead): number {
  const etapa = etapaDeProspecto(p.estado);
  const now = nowIso();
  const sede = get<{ sede_id: number | null }>('SELECT sede_id FROM users WHERE id = ?', p.ownerUserId)?.sede_id ?? null;
  const actual = leadDe(p.ownerUserId, p.clave);

  if (!actual) {
    const id = run(
      `INSERT INTO leads (sede_id, owner_user_id, session_id, contact_id, phone_key, origen, prospect_ref, programa, etapa, ultima_actividad_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'prospecto', ?, ?, ?, ?, ?, ?)`,
      sede,
      p.ownerUserId,
      p.sessionId,
      p.contactId,
      p.clave,
      p.ref,
      p.programa,
      etapa,
      now,
      now,
      now,
    ).lastInsertRowid;
    evento(id, null, 'creado', { texto: 'Registrado como prospecto en cronogramas.' });
    return id;
  }

  run(
    `UPDATE leads SET origen = 'prospecto', prospect_ref = ?, programa = COALESCE(?, programa),
        contact_id = COALESCE(contact_id, ?), updated_at = ? WHERE id = ?`,
    p.ref,
    p.programa,
    p.contactId,
    now,
    actual.id,
  );
  if (p.estadoCambio && actual.etapa !== etapa) {
    run('UPDATE leads SET etapa = ?, ultima_actividad_at = ?, updated_at = ? WHERE id = ?', etapa, now, now, actual.id);
    evento(actual.id, null, 'etapa', { de: actual.etapa, a: etapa, texto: 'Cambió el estado en cronogramas.' });
  }
  return actual.id;
}

/**
 * El prospecto se eliminó en cronogramas. Si el lead existe solo por ser
 * prospecto y nadie le escribió, se borra; si ya hubo conversación por la
 * línea, queda como lead de la línea.
 */
export function quitarProspecto(ref: string): void {
  for (const lead of all<LeadRow>('SELECT * FROM leads WHERE prospect_ref = ?', ref)) {
    if (lead.ultimo_contacto_at === null) {
      run('DELETE FROM leads WHERE id = ?', lead.id);
    } else {
      run("UPDATE leads SET origen = 'linea', prospect_ref = NULL, updated_at = ? WHERE id = ?", nowIso(), lead.id);
      evento(lead.id, null, 'origen', { texto: 'El prospecto se eliminó en cronogramas; queda como lead de la línea.' });
    }
  }
}

/**
 * El asesor dueño mueve su lead de etapa (los jefes solo miran y comentan).
 * Lanza Error con un mensaje para mostrar si no corresponde.
 */
export function moverEtapa(userId: number, leadId: number, etapa: string): LeadRow {
  const lead = getLead(leadId);
  if (!lead || lead.owner_user_id !== userId) throw new Error('Lead no encontrado.');
  if (!esEtapa(etapa)) throw new Error('Etapa no válida.');
  if (lead.etapa === etapa) return lead;
  const now = nowIso();
  run('UPDATE leads SET etapa = ?, ultima_actividad_at = ?, updated_at = ? WHERE id = ?', etapa, now, now, lead.id);
  evento(lead.id, userId, 'etapa', { de: lead.etapa, a: etapa });
  return getLead(lead.id)!;
}
