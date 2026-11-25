import { all, get } from '../db/index.js';
import type { UserRow } from '../auth/users.js';
import { alcanceLeads, DIAS_SIN_MOVIMIENTO } from './organigrama.js';
import { personTagsByKeys } from './person.js';
import { ETAPAS, getLead, type Etapa, type LeadRow } from './leads.js';

/**
 * Lo que muestra /leads (PLAN_ORGANIGRAMA.md, L3). TODA consulta pasa por
 * `alcanceLeads`: un lead fuera del alcance de quien mira no existe para él.
 */

export interface FiltrosLeads {
  /** Ver solo los de una persona (tiene que estar dentro del alcance). */
  persona?: number | null;
  programa?: string | null;
  filtro?: 'sin_contactar' | 'sin_movimiento' | null;
  origen?: 'prospecto' | 'linea' | null;
  q?: string | null;
  /** Uso interno: un lead puntual (la ficha). */
  id?: number | null;
}

export interface TarjetaLead {
  id: number;
  nombre: string;
  telefono: string | null;
  programa: string | null;
  origen: 'prospecto' | 'linea';
  etapa: Etapa;
  owner_user_id: number;
  owner_name: string;
  chat_id: string | null;
  ultimo_contacto_at: string | null;
  ultima_actividad_at: string;
  sin_contactar: boolean;
  sin_movimiento: boolean;
  propio: boolean;
}

const LIMITE = 400;

function limiteSinMovimiento(ahora: Date): string {
  return new Date(ahora.getTime() - DIAS_SIN_MOVIMIENTO * 86_400_000).toISOString();
}

/** ¿Quien mira puede ver este lead? */
export function leadVisible(viewer: UserRow, lead: Pick<LeadRow, 'owner_user_id'>): boolean {
  const alcance = alcanceLeads(viewer);
  return alcance === null || alcance.includes(lead.owner_user_id);
}

export function listarLeads(viewer: UserRow, f: FiltrosLeads = {}, ahora: Date = new Date()): { tarjetas: TarjetaLead[]; truncado: boolean } {
  const alcance = alcanceLeads(viewer);
  if (f.persona && alcance && !alcance.includes(f.persona)) return { tarjetas: [], truncado: false };

  const donde: string[] = [];
  const params: unknown[] = [];
  if (alcance) {
    donde.push(`l.owner_user_id IN (${alcance.map(() => '?').join(',')})`);
    params.push(...alcance);
  }
  if (f.persona) {
    donde.push('l.owner_user_id = ?');
    params.push(f.persona);
  }
  if (f.id) {
    donde.push('l.id = ?');
    params.push(f.id);
  }
  if (f.programa) {
    donde.push('l.programa = ?');
    params.push(f.programa);
  }
  if (f.origen) {
    donde.push('l.origen = ?');
    params.push(f.origen);
  }
  const limite = limiteSinMovimiento(ahora);
  if (f.filtro === 'sin_contactar') donde.push("l.etapa = 'nuevo' AND l.ultimo_contacto_at IS NULL");
  if (f.filtro === 'sin_movimiento') {
    donde.push("l.etapa NOT IN ('no_interesado','inscrito') AND l.ultima_actividad_at < ?");
    params.push(limite);
  }
  const q = (f.q ?? '').trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    donde.push(`(c.name LIKE ? OR l.phone_key LIKE ? OR l.programa LIKE ? OR pn.full_name LIKE ?)`);
    params.push(like, like, like, like);
  }

  const filas = all<LeadRow & { owner_name: string | null; contact_name: string | null; chat_id: string | null; phone: string | null }>(
    `SELECT l.*, COALESCE(NULLIF(u.name, ''), u.username) AS owner_name, c.name AS contact_name, c.chat_id, c.phone
       FROM leads l
       JOIN users u ON u.id = l.owner_user_id
       LEFT JOIN contacts c ON c.id = l.contact_id
       LEFT JOIN person_names pn ON pn.phone_key = l.phone_key
      ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''}
      ORDER BY l.ultima_actividad_at DESC
      LIMIT ${LIMITE + 1}`,
    ...params,
  );

  const truncado = filas.length > LIMITE;
  const lista = filas.slice(0, LIMITE);
  const personas = personTagsByKeys(lista.map((l) => l.phone_key));

  return {
    truncado,
    tarjetas: lista.map((l) => {
      const telefono = l.phone_key.startsWith('lid:') ? null : `+${l.phone_key}`;
      const abierto = l.etapa !== 'no_interesado' && l.etapa !== 'inscrito';
      return {
        id: l.id,
        nombre: personas.get(l.phone_key)?.full_name || l.contact_name || telefono || 'Sin nombre',
        telefono,
        programa: l.programa,
        origen: l.origen,
        etapa: l.etapa,
        owner_user_id: l.owner_user_id,
        owner_name: l.owner_name ?? '—',
        chat_id: l.chat_id,
        ultimo_contacto_at: l.ultimo_contacto_at,
        ultima_actividad_at: l.ultima_actividad_at,
        sin_contactar: l.etapa === 'nuevo' && !l.ultimo_contacto_at,
        sin_movimiento: abierto && l.ultima_actividad_at < limite,
        propio: l.owner_user_id === viewer.id,
      };
    }),
  };
}

/** Programas de los leads que ve quien mira (para el selector). */
export function programasVisibles(viewer: UserRow): string[] {
  const alcance = alcanceLeads(viewer);
  return all<{ programa: string }>(
    `SELECT DISTINCT programa FROM leads
      WHERE programa IS NOT NULL AND programa <> ''
      ${alcance ? `AND owner_user_id IN (${alcance.map(() => '?').join(',')})` : ''}
      ORDER BY programa COLLATE NOCASE`,
    ...(alcance ?? []),
  ).map((r) => r.programa);
}

export function agruparPorEtapa(tarjetas: TarjetaLead[]): Record<Etapa, TarjetaLead[]> {
  const grupos = Object.fromEntries(ETAPAS.map((e) => [e, [] as TarjetaLead[]])) as Record<Etapa, TarjetaLead[]>;
  for (const t of tarjetas) grupos[t.etapa].push(t);
  return grupos;
}

export interface DetalleLead {
  lead: LeadRow;
  tarjeta: TarjetaLead;
  mensajes: Array<{ direction: 'in' | 'out'; body: string | null; content_type: string; occurred_at: string }>;
  eventos: Array<{ tipo: string; texto: string | null; de: string | null; a: string | null; created_at: string; autor: string | null }>;
}

/** Ficha de un lead, o undefined si no existe o quien mira no lo puede ver. */
export function detalleLead(viewer: UserRow, id: number, ahora: Date = new Date()): DetalleLead | undefined {
  const lead = getLead(id);
  if (!lead || !leadVisible(viewer, lead)) return undefined;

  const tarjeta = listarLeads(viewer, { id }, ahora).tarjetas[0];
  if (!tarjeta) return undefined;

  // La conversación con esa persona en la línea del dueño (los últimos 40 mensajes).
  const mensajes = all<{ direction: 'in' | 'out'; body: string | null; content_type: string; occurred_at: string }>(
    `SELECT m.direction, m.body, m.content_type, m.occurred_at
       FROM messages m
       JOIN contacts c ON c.session_id = m.session_id AND c.chat_id = m.chat_id
      WHERE m.session_id = ? AND c.phone_key = ?
      ORDER BY m.occurred_at DESC, m.id DESC
      LIMIT 40`,
    lead.session_id,
    lead.phone_key,
  ).reverse();

  const eventos = all<{ tipo: string; texto: string | null; de: string | null; a: string | null; created_at: string; autor: string | null }>(
    `SELECT e.tipo, e.texto, e.de, e.a, e.created_at, COALESCE(NULLIF(u.name, ''), u.username) AS autor
       FROM lead_eventos e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.lead_id = ?
      ORDER BY e.id DESC`,
    id,
  );

  return { lead, tarjeta, mensajes, eventos };
}

/** Personas cuyo pipeline puede abrir quien mira (para el selector de L4). */
export function personasVisibles(viewer: UserRow): Array<{ id: number; nombre: string }> {
  const alcance = alcanceLeads(viewer);
  const filas = all<{ id: number; nombre: string }>(
    `SELECT DISTINCT u.id, COALESCE(NULLIF(u.name, ''), u.username) AS nombre
       FROM leads l JOIN users u ON u.id = l.owner_user_id
      ${alcance ? `WHERE u.id IN (${alcance.map(() => '?').join(',')})` : ''}
      ORDER BY nombre COLLATE NOCASE`,
    ...(alcance ?? []),
  );
  return filas;
}

export function contarLeads(viewer: UserRow): number {
  const alcance = alcanceLeads(viewer);
  return get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM leads ${alcance ? `WHERE owner_user_id IN (${alcance.map(() => '?').join(',')})` : ''}`,
    ...(alcance ?? []),
  )?.c ?? 0;
}
