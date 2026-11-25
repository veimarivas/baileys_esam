import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { findById, type UserRow } from '../auth/users.js';
import { alcanceLeads, cargoDe, DIAS_SIN_MOVIMIENTO, directosDe, esControlDeSedes, jefeVisible, sedesDe } from './organigrama.js';
import { esamEsAdmin } from '../auth/users.js';
import { notify } from './notifications.js';
import { personTagsByKeys } from './person.js';
import { ETAPAS, getLead, type Etapa, type LeadRow } from './leads.js';

/**
 * Lo que muestra /leads (PLAN_ORGANIGRAMA.md, L3). TODA consulta pasa por
 * `alcanceLeads`: un lead fuera del alcance de quien mira no existe para él.
 */

export interface FiltrosLeads {
  /** Ver solo los de una persona (tiene que estar dentro del alcance). */
  persona?: number | null;
  /** Ver los de una persona Y su gente (p. ej. un supervisor y sus asesores). */
  equipo?: number | null;
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
  /** Hay un comentario de un jefe que el dueño no leyó. */
  comentario_nuevo: boolean;
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
  if (f.equipo && alcance && !alcance.includes(f.equipo)) return { tarjetas: [], truncado: false };

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
  if (f.equipo) {
    const jefe = findById(f.equipo);
    const suyos = jefe ? alcanceLeads(jefe) : [];
    if (suyos) {
      donde.push(`l.owner_user_id IN (${suyos.length ? suyos.map(() => '?').join(',') : 'NULL'})`);
      params.push(...suyos);
    }
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
  // Comentarios de jefes que el dueño todavía no leyó (solo le importan a él).
  const propios = lista.filter((l) => l.owner_user_id === viewer.id).map((l) => l.id);
  const sinLeer = new Set(propios.length
    ? all<{ lead_id: number }>(
        `SELECT DISTINCT lead_id FROM lead_eventos
          WHERE tipo = 'comentario' AND leido_at IS NULL AND user_id <> ? AND lead_id IN (${propios.map(() => '?').join(',')})`,
        viewer.id,
        ...propios,
      ).map((r) => r.lead_id)
    : []);

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
        comentario_nuevo: sinLeer.has(l.id),
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
  eventos: Array<{ tipo: string; texto: string | null; de: string | null; a: string | null; created_at: string; autor: string | null; user_id: number | null }>;
}

/** Ficha de un lead, o undefined si no existe o quien mira no lo puede ver. */
export function detalleLead(viewer: UserRow, id: number, ahora: Date = new Date()): DetalleLead | undefined {
  const lead = getLead(id);
  if (!lead || !leadVisible(viewer, lead)) return undefined;

  const tarjeta = listarLeads(viewer, { id }, ahora).tarjetas[0];
  if (!tarjeta) return undefined;

  // El dueño abrió su lead: los comentarios de sus jefes quedan leídos.
  if (lead.owner_user_id === viewer.id) {
    run("UPDATE lead_eventos SET leido_at = ? WHERE lead_id = ? AND tipo = 'comentario' AND leido_at IS NULL AND user_id <> ?", nowIso(), id, viewer.id);
  }

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

  const eventos = all<{ tipo: string; texto: string | null; de: string | null; a: string | null; created_at: string; autor: string | null; user_id: number | null }>(
    `SELECT e.user_id, e.tipo, e.texto, e.de, e.a, e.created_at, COALESCE(NULLIF(u.name, ''), u.username) AS autor
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

// ── Comentarios (L4) ───────────────────────────────────────────────────────

/**
 * Comentario en un lead. Lo puede dejar quien lo ve (el dueño o cualquier
 * jefe por encima). Avisa al dueño; si comenta el dueño, avisa a los jefes
 * que ya habían comentado ese lead (así la conversación sigue).
 */
export function comentarLead(actor: UserRow, leadId: number, texto: string): void {
  const limpio = String(texto ?? '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
  if (!limpio) throw new Error('Escribí el comentario.');
  const lead = getLead(leadId);
  if (!lead || !leadVisible(actor, lead)) throw new Error('Lead no encontrado.');

  run(
    "INSERT INTO lead_eventos (lead_id, user_id, tipo, texto, created_at, leido_at) VALUES (?, ?, 'comentario', ?, ?, ?)",
    leadId,
    actor.id,
    limpio,
    nowIso(),
    // Lo que escribe el dueño no le queda «sin leer» a él mismo.
    actor.id === lead.owner_user_id ? nowIso() : null,
  );

  const nombre = listarLeads(actor, { id: leadId }).tarjetas[0]?.nombre ?? 'un lead';
  const quien = actor.name ?? actor.username ?? 'Alguien';
  const destinatarios = actor.id === lead.owner_user_id
    ? all<{ user_id: number }>(
        "SELECT DISTINCT user_id FROM lead_eventos WHERE lead_id = ? AND tipo = 'comentario' AND user_id IS NOT NULL AND user_id <> ?",
        leadId,
        actor.id,
      ).map((r) => r.user_id)
    : [lead.owner_user_id];

  notify(destinatarios, {
    kind: 'lead_comment',
    actorId: actor.id,
    title: actor.id === lead.owner_user_id ? `${quien} respondió sobre ${nombre}` : `${quien} comentó tu lead ${nombre}`,
    body: limpio,
    link: `/leads/${leadId}`,
  });
}

// ── «Mi equipo» (L4) ───────────────────────────────────────────────────────

export interface FilaEquipo {
  id: number;
  nombre: string;
  cargo: string | null;
  /** Tiene gente a cargo (se puede bajar a ver su equipo). */
  conEquipo: boolean;
  porEtapa: Record<Etapa, number>;
  total: number;
  abiertos: number;
  /** Inscritos sobre el total de leads, en % (null si no tiene leads). */
  conversion: number | null;
  /** Nuevos que llegaron hace más de 24 h y nadie les escribió. */
  sinContactar24h: number;
  sinMovimiento: number;
}

function cifras(ids: number[], ahora: Date, sedeId: number | null = null): Omit<FilaEquipo, 'id' | 'nombre' | 'cargo' | 'conEquipo'> {
  const porEtapa = Object.fromEntries(ETAPAS.map((e) => [e, 0])) as Record<Etapa, number>;
  if (!ids.length) return { porEtapa, total: 0, abiertos: 0, conversion: null, sinContactar24h: 0, sinMovimiento: 0 };
  const lista = ids.map(() => '?').join(',');
  const enSede = sedeId ? ' AND sede_id = ?' : '';
  const extra = sedeId ? [sedeId] : [];
  for (const r of all<{ etapa: Etapa; n: number }>(`SELECT etapa, COUNT(*) AS n FROM leads WHERE owner_user_id IN (${lista})${enSede} GROUP BY etapa`, ...ids, ...extra)) {
    if (r.etapa in porEtapa) porEtapa[r.etapa] = r.n;
  }
  const hace24h = new Date(ahora.getTime() - 86_400_000).toISOString();
  const alertas = get<{ sin_contactar: number; sin_movimiento: number }>(
    `SELECT
       SUM(CASE WHEN etapa = 'nuevo' AND ultimo_contacto_at IS NULL AND created_at < ? THEN 1 ELSE 0 END) AS sin_contactar,
       SUM(CASE WHEN etapa NOT IN ('no_interesado','inscrito') AND ultima_actividad_at < ? THEN 1 ELSE 0 END) AS sin_movimiento
       FROM leads WHERE owner_user_id IN (${lista})${enSede}`,
    hace24h,
    limiteSinMovimiento(ahora),
    ...ids,
    ...extra,
  );
  const total = ETAPAS.reduce((n, e) => n + porEtapa[e], 0);
  return {
    porEtapa,
    total,
    abiertos: total - porEtapa.no_interesado - porEtapa.inscrito,
    conversion: total ? Math.round((porEtapa.inscrito / total) * 100) : null,
    sinContactar24h: alertas?.sin_contactar ?? 0,
    sinMovimiento: alertas?.sin_movimiento ?? 0,
  };
}

/**
 * Las personas que dependen directo de `sobreId` (por defecto, de quien
 * mira), cada una con las cifras de TODO su equipo. `sobreId` tiene que estar
 * dentro del alcance de quien mira.
 */
export function equipoDe(viewer: UserRow, sobreId: number = viewer.id, ahora: Date = new Date(), sedeId: number | null = null): {
  sobre: { id: number; nombre: string; cargo: string | null };
  filas: FilaEquipo[];
  total: Omit<FilaEquipo, 'id' | 'nombre' | 'cargo' | 'conEquipo'>;
  ruta: Array<{ id: number; nombre: string }>;
} | undefined {
  const alcance = alcanceLeads(viewer);
  if (alcance && !alcance.includes(sobreId)) return undefined;
  const sobre = findById(sobreId);
  if (!sobre) return undefined;

  const directos = directosDe(sobreId, sedeId)
    .filter((u) => !alcance || alcance.includes(u.id))
    // Solo Marketing (Q5): el Gerente General también tiene a cargo otras áreas.
    .filter((u) => cargoDe(u)?.area === 'Marketing');

  const filas = directos.map((u) => {
    const suyos = alcanceLeads(u) ?? [u.id];
    return {
      id: u.id,
      nombre: u.name ?? u.username ?? '—',
      cargo: cargoDe(u)?.name ?? null,
      conEquipo: directosDe(u.id, sedeId).length > 0,
      ...cifras(suyos, ahora, sedeId),
    };
  });

  // Lo de la persona de arriba más su gente (lo propio del jefe también cuenta).
  const todos = alcanceLeads(sobre) ?? [sobre.id];
  const total = cifras(alcance ? todos.filter((id) => alcance.includes(id)) : todos, ahora, sedeId);

  // Migas: de quien mira hasta `sobre`, subiendo por los jefes.
  const ruta: Array<{ id: number; nombre: string }> = [];
  let actual: UserRow | undefined = sobre;
  for (let i = 0; actual && i < 20; i++) {
    ruta.unshift({ id: actual.id, nombre: actual.name ?? actual.username ?? '—' });
    if (actual.id === viewer.id) break;
    const jefe = jefeVisible(actual.id, alcance);
    if (!jefe) break;
    actual = findById(jefe);
  }

  return { sobre: { id: sobre.id, nombre: sobre.name ?? sobre.username ?? '—', cargo: cargoDe(sobre)?.name ?? null }, filas, total, ruta };
}

/** ¿Tiene gente a cargo (o ve una sede entera)? Para mostrar «Mi equipo». */
export function tieneEquipo(viewer: UserRow): boolean {
  const alcance = alcanceLeads(viewer);
  return alcance === null || alcance.length > 1;
}

/** Para Super Admin y Control de Sedes: el Gerente General de cada sede (desde ahí baja a su equipo). */
export function gerentesDeSede(): Array<{ id: number; nombre: string; sede: string; sede_id: number }> {
  return all<{ id: number; nombre: string; sede: string; sede_id: number }>(
    `SELECT u.id, COALESCE(NULLIF(u.name, ''), u.username) AS nombre, s.name AS sede, s.id AS sede_id
       FROM sede_miembros m JOIN users u ON u.id = m.user_id JOIN sedes s ON s.id = m.sede_id
      WHERE u.esam_autorizado = 1 AND u.esam_roles LIKE '%"Gerente General"%'
      ORDER BY s.name COLLATE NOCASE, nombre COLLATE NOCASE`,
  );
}

/** Mira todas las sedes (elige la sede primero en «Mi equipo»). */
export function veTodasLasSedes(viewer: UserRow): boolean {
  return esamEsAdmin(viewer) || esControlDeSedes(viewer);
}

/** Sedes de quien mira, si son varias (para filtrar «Mi equipo» por sede). */
export function sedesPropias(viewer: UserRow): Array<{ sede_id: number; nombre: string }> {
  return sedesDe(viewer.id).map(({ sede_id, nombre }) => ({ sede_id, nombre }));
}
