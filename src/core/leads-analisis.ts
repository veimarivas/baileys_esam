import { all } from '../db/index.js';
import type { UserRow } from '../auth/users.js';
import { alcanceLeads, DIAS_SIN_MOVIMIENTO } from './organigrama.js';
import { ETAPAS, type Etapa } from './leads.js';

/**
 * Análisis de leads (/leads/analisis). Lo que se cuenta lo recorta
 * `alcanceLeads`: el personal de Control de Sedes y el Super Admin ven todas
 * las sedes; un gerente, sus sedes; un supervisor, su equipo.
 */

export type Periodo = '30d' | '90d' | '12m' | 'todo';
export const PERIODOS: Array<{ clave: Periodo; label: string }> = [
  { clave: '30d', label: 'Últimos 30 días' },
  { clave: '90d', label: 'Últimos 90 días' },
  { clave: '12m', label: 'Últimos 12 meses' },
  { clave: 'todo', label: 'Todo' },
];

export interface FiltrosAnalisis {
  periodo: Periodo;
  sede?: number | null;
  programa?: string | null;
}

export interface Analisis {
  kpis: { total: number; abiertos: number; inscritos: number; conversion: number | null; sinContactar24h: number; sinMovimiento: number };
  embudo: Record<Etapa, number>;
  semanas: Array<{ semana: string; prospecto: number; linea: number }>;
  sedes: Array<{ sede_id: number | null; sede: string; porEtapa: Record<Etapa, number>; total: number; conversion: number | null }>;
  programas: Array<{ programa: string; total: number; inscritos: number }>;
  asesores: Array<{ id: number; nombre: string; sede: string; total: number; inscritos: number; conversion: number | null; sinContactar24h: number }>;
  origen: { prospecto: number; linea: number };
  sedesDisponibles: Array<{ id: number; nombre: string }>;
  programasDisponibles: string[];
}

function desde(periodo: Periodo, ahora: Date): string | null {
  const dias = periodo === '30d' ? 30 : periodo === '90d' ? 90 : periodo === '12m' ? 365 : null;
  return dias ? new Date(ahora.getTime() - dias * 86_400_000).toISOString() : null;
}

const pct = (a: number, b: number): number | null => (b ? Math.round((a / b) * 100) : null);

/** Lunes (AAAA-MM-DD) de la semana de una fecha ISO, en hora de Bolivia. */
function lunes(iso: string): string {
  const d = new Date(new Date(iso).getTime() - 4 * 3_600_000);
  const dia = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dia);
  return d.toISOString().slice(0, 10);
}

export function analizarLeads(viewer: UserRow, f: FiltrosAnalisis, ahora: Date = new Date()): Analisis {
  const alcance = alcanceLeads(viewer);
  const base: string[] = [];
  const params: unknown[] = [];
  if (alcance) {
    base.push(`l.owner_user_id IN (${alcance.map(() => '?').join(',')})`);
    params.push(...alcance);
  }
  const alcanceSql = base.join(' AND ');
  const alcanceParams = [...params];

  const inicio = desde(f.periodo, ahora);
  if (inicio) {
    base.push('l.created_at >= ?');
    params.push(inicio);
  }
  if (f.sede) {
    base.push('l.sede_id = ?');
    params.push(f.sede);
  }
  if (f.programa) {
    base.push('l.programa = ?');
    params.push(f.programa);
  }
  const where = base.length ? `WHERE ${base.join(' AND ')}` : '';

  const filas = all<{
    owner_user_id: number; owner: string; sede_id: number | null; sede: string | null; etapa: Etapa; origen: 'prospecto' | 'linea';
    programa: string | null; created_at: string; ultimo_contacto_at: string | null; ultima_actividad_at: string;
  }>(
    `SELECT l.owner_user_id, COALESCE(NULLIF(u.name, ''), u.username) AS owner, l.sede_id, s.name AS sede, l.etapa, l.origen,
            l.programa, l.created_at, l.ultimo_contacto_at, l.ultima_actividad_at
       FROM leads l JOIN users u ON u.id = l.owner_user_id LEFT JOIN sedes s ON s.id = l.sede_id
      ${where}`,
    ...params,
  );

  const hace24h = new Date(ahora.getTime() - 86_400_000).toISOString();
  const sinMov = new Date(ahora.getTime() - DIAS_SIN_MOVIMIENTO * 86_400_000).toISOString();
  const cero = (): Record<Etapa, number> => Object.fromEntries(ETAPAS.map((e) => [e, 0])) as Record<Etapa, number>;
  const abierto = (e: Etapa) => e !== 'no_interesado' && e !== 'inscrito';
  const sinContactar = (r: (typeof filas)[number]) => r.etapa === 'nuevo' && !r.ultimo_contacto_at && r.created_at < hace24h;

  const embudo = cero();
  const origen = { prospecto: 0, linea: 0 };
  const porSede = new Map<string, { sede_id: number | null; sede: string; porEtapa: Record<Etapa, number> }>();
  const porPrograma = new Map<string, { total: number; inscritos: number }>();
  const porAsesor = new Map<number, { id: number; nombre: string; sede: string; total: number; inscritos: number; sinContactar24h: number }>();
  const porSemana = new Map<string, { prospecto: number; linea: number }>();
  let sinContactar24h = 0;
  let sinMovimiento = 0;

  for (const r of filas) {
    embudo[r.etapa] += 1;
    origen[r.origen] += 1;
    if (sinContactar(r)) sinContactar24h += 1;
    if (abierto(r.etapa) && r.ultima_actividad_at < sinMov) sinMovimiento += 1;

    const claveSede = String(r.sede_id ?? 'sin');
    const sede = porSede.get(claveSede) ?? { sede_id: r.sede_id, sede: r.sede ?? 'Sin sede', porEtapa: cero() };
    sede.porEtapa[r.etapa] += 1;
    porSede.set(claveSede, sede);

    const prog = r.programa?.trim() || 'Sin programa';
    const p = porPrograma.get(prog) ?? { total: 0, inscritos: 0 };
    p.total += 1;
    if (r.etapa === 'inscrito') p.inscritos += 1;
    porPrograma.set(prog, p);

    const a = porAsesor.get(r.owner_user_id) ?? { id: r.owner_user_id, nombre: r.owner, sede: r.sede ?? 'Sin sede', total: 0, inscritos: 0, sinContactar24h: 0 };
    a.total += 1;
    if (r.etapa === 'inscrito') a.inscritos += 1;
    if (sinContactar(r)) a.sinContactar24h += 1;
    porAsesor.set(r.owner_user_id, a);

    const semana = lunes(r.created_at);
    const w = porSemana.get(semana) ?? { prospecto: 0, linea: 0 };
    w[r.origen] += 1;
    porSemana.set(semana, w);
  }

  // Semanas seguidas (con ceros) para que la línea no salte huecos.
  const semanas: Analisis['semanas'] = [];
  const claves = [...porSemana.keys()].sort();
  if (claves.length) {
    const ultima = lunes(ahora.toISOString());
    const primera = inicio ? lunes(inicio) : claves[0];
    for (let d = new Date(`${primera}T12:00:00Z`); d.toISOString().slice(0, 10) <= ultima && semanas.length < 60; d.setUTCDate(d.getUTCDate() + 7)) {
      const k = d.toISOString().slice(0, 10);
      semanas.push({ semana: k, ...(porSemana.get(k) ?? { prospecto: 0, linea: 0 }) });
    }
  }

  const total = filas.length;
  const sedesDisponibles = all<{ id: number; nombre: string }>(
    `SELECT DISTINCT s.id, s.name AS nombre FROM leads l JOIN sedes s ON s.id = l.sede_id
      ${alcanceSql ? `WHERE ${alcanceSql}` : ''} ORDER BY s.name COLLATE NOCASE`,
    ...alcanceParams,
  );
  const programasDisponibles = all<{ programa: string }>(
    `SELECT DISTINCT l.programa FROM leads l WHERE l.programa IS NOT NULL AND l.programa <> ''
      ${alcanceSql ? `AND ${alcanceSql}` : ''} ORDER BY l.programa COLLATE NOCASE`,
    ...alcanceParams,
  ).map((r) => r.programa);

  return {
    kpis: {
      total,
      abiertos: total - embudo.no_interesado - embudo.inscrito,
      inscritos: embudo.inscrito,
      conversion: pct(embudo.inscrito, total),
      sinContactar24h,
      sinMovimiento,
    },
    embudo,
    semanas,
    sedes: [...porSede.values()]
      .map((s) => {
        const t = ETAPAS.reduce((n, e) => n + s.porEtapa[e], 0);
        return { ...s, total: t, conversion: pct(s.porEtapa.inscrito, t) };
      })
      .sort((a, b) => b.total - a.total),
    programas: [...porPrograma.entries()]
      .map(([programa, v]) => ({ programa, ...v }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10),
    asesores: [...porAsesor.values()]
      .map((a) => ({ ...a, conversion: pct(a.inscritos, a.total) }))
      .sort((a, b) => b.inscritos - a.inscritos || b.total - a.total)
      .slice(0, 15),
    origen,
    sedesDisponibles,
    programasDisponibles,
  };
}
