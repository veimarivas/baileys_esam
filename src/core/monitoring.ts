import { all, get } from '../db/index.js';

export interface UserStat {
  id: string;
  name: string;
  total: number;
  byTipo: Record<string, number>;
  /** Lotes con al menos un envío en el período. */
  batches: number;
  /** Tamaño sumado de esos lotes (destinatarios pedidos). */
  batchMessages: number;
  /** Promedio de destinatarios por lote. */
  avgPerBatch: number;
  /** Lote más grande del período. */
  maxBatch: number;
}

export interface ProgramaStat {
  programa: string;
  total: number;
  byTipo: Record<string, number>;
  batches: number;
  batchMessages: number;
  avgPerBatch: number;
  maxBatch: number;
}

export interface MonitoringFilters {
  from?: string;
  to?: string;
  programa?: string;
  account?: string;
  area?: string;
  tipo?: string;
  /** Fecha exacta (YYYY-MM-DD) o mes (YYYY-MM): sobreescribe el rango. */
  day?: string;
}

/** Lote incluido en el detalle de actividad de un usuario. */
export interface ActivityBatch {
  id: number;
  name: string;
  /** Último día/hora local en que el lote envió dentro del período. */
  day: string;
  time: string;
  status: string;
  /** Destinatarios del lote. */
  total: number;
  /** Enviados dentro del período. */
  sent: number;
  failed: number;
  skipped: number;
  programa: string | null;
  tipo: string | null;
  cronograma: boolean;
  linePhone: string | null;
  lineOwner: string | null;
}

export interface ActivityDay {
  day: string;
  cronogramas: number;
  lotes: number;
  bandeja: number;
}

/** Fila de actividad por usuario (seguimiento y control de mensajes). */
export interface ActivityRow {
  uid: string;
  /** Id local del usuario del panel, cuando se pudo resolver. */
  userId: number | null;
  name: string;
  phone: string | null;
  area: string | null;
  apartado: string;
  /** Mensajes confirmados de lotes del sistema de cronogramas. */
  cronogramas: number;
  /** Mensajes confirmados de lotes pedidos desde el panel. */
  lotes: number;
  /** Mensajes escritos directamente en la bandeja. */
  bandeja: number;
  /** Lotes del panel + bandeja (total sin cronogramas). */
  panel: number;
  total: number;
  batches: number;
  cronBatches: number;
  panelBatches: number;
  batchMessages: number;
  avgPerBatch: number;
  maxBatch: number;
  daysActive: number;
  lastAt: string | null;
  byDay: ActivityDay[];
  /** Últimos lotes del usuario, del más reciente al más antiguo. */
  recent: ActivityBatch[];
}

export interface ActivityData {
  from: string;
  to: string;
  rows: ActivityRow[];
  byDay: ActivityDay[];
  totals: {
    cronogramas: number;
    lotes: number;
    bandeja: number;
    panel: number;
    total: number;
    batches: number;
    cronBatches: number;
    panelBatches: number;
    batchMessages: number;
    avgPerBatch: number;
    maxBatch: number;
    users: number;
  };
}

/** Aplica día/mes sobre el rango; devuelve `[from, to]`. */
function resolveRange(filters: MonitoringFilters): { from: string; to: string } {
  const day = (filters.day ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return { from: day, to: day };
  if (/^\d{4}-\d{2}$/.test(day)) {
    const [y, m] = day.split('-').map((n) => parseInt(n, 10));
    // Fechas locales: el rango se compara con `date(..., 'localtime')`.
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0);
    return { from: dayKey(start), to: dayKey(end) };
  }
  return {
    from: filters.from || dayKey(new Date(Date.now() - 29 * 86_400_000)),
    to: filters.to || dayKey(new Date()),
  };
}

export interface MonitoringData {
  from: string;
  to: string;
  totals: { cronogramas: number; esam: number; failed: number; received: number };
  byTipo: Array<{ tipo: string; label: string; total: number }>;
  byUser: UserStat[];
  byPrograma: ProgramaStat[];
  byDay: Array<{ day: string; cronogramas: number; esam: number }>;
  options: {
    programas: string[];
    areas: string[];
    users: Array<{ id: string; name: string }>;
    tipos: Array<{ id: string; label: string }>;
  };
}

/** Etiquetas legibles por tipo de envío (meta.tipo de los lotes de cronogramas). */export const TIPO_LABELS: Record<string, string> = {
  participantes: 'Masivos (programas)',
  grupo: 'Grupos de programa',
  cobranza: 'Seguimiento contable',
  notas: 'Módulos / notas',
  inbox: 'Bandeja ESAM',
  panel: 'Panel ESAM',
  otros: 'Otros',
};

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Día local (AAAA-MM-DD): los rangos de las vistas se expresan en hora local. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDay(iso: string): string {
  return dayKey(new Date(iso));
}

function localTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Días (locales) entre `from` y `to`, inclusive. */
function eachDay(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  const out: string[] = [];
  for (let d = start; !Number.isNaN(d.getTime()) && d <= end && out.length < 400; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    out.push(dayKey(d));
  }
  return out;
}

/**
 * Índice de identidades de usuario. Un mismo usuario puede aparecer como id
 * local (mensajes de la bandeja) o como `source_uid` (lotes de cronogramas):
 * ambas claves se unifican al id local para que las estadísticas no se partan.
 */
interface IdentityIndex {
  labelByKey: Map<string, string>;
  canonicalByKey: Map<string, string>;
  localIdByKey: Map<string, number>;
}

function identityIndex(): IdentityIndex {
  const labelByKey = new Map<string, string>();
  const canonicalByKey = new Map<string, string>();
  const localIdByKey = new Map<string, number>();
  for (const u of all<{ id: number; source_uid: string | null; name: string | null; username: string | null }>(
    'SELECT id, source_uid, name, username FROM users',
  )) {
    const label = u.username ?? u.name ?? `Usuario ${u.id}`;
    for (const key of [String(u.id), u.source_uid ? String(u.source_uid) : null]) {
      if (!key) continue;
      labelByKey.set(key, label);
      canonicalByKey.set(key, String(u.id));
      localIdByKey.set(key, u.id);
    }
  }
  return { labelByKey, canonicalByKey, localIdByKey };
}

function canonicalUid(id: IdentityIndex, key: string | null | undefined): string {
  const raw = String(key ?? '').trim();
  if (!raw) return 'principal';
  return id.canonicalByKey.get(raw) ?? raw;
}

/** Un área coincide por su valor original o por el apartado normalizado. */
function areaMatches(area: string | null | undefined, filter: string): boolean {
  if (!filter) return true;
  const raw = String(area ?? '').trim();
  return raw === filter || apartadoLabel(raw) === filter;
}

function emptyUser(id: string, name: string): UserStat {
  return { id, name, total: 0, byTipo: {}, batches: 0, batchMessages: 0, avgPerBatch: 0, maxBatch: 0 };
}

/** Aplica a una fila las métricas de los lotes acumulados (id -> tamaño). */
function withBatchStats<T extends { batches: number; batchMessages: number; avgPerBatch: number; maxBatch: number }>(row: T, lots: Map<number, number> | undefined): T {
  if (!lots || !lots.size) return row;
  row.batches = lots.size;
  for (const size of lots.values()) {
    row.batchMessages += size;
    row.maxBatch = Math.max(row.maxBatch, size);
  }
  row.avgPerBatch = row.batches ? Math.round(row.batchMessages / row.batches) : 0;
  return row;
}

/**
 * Agrega los envíos entre `from` y `to` (YYYY-MM-DD) con filtros opcionales por
 * programa, usuario, área y tipo.
 */
export function monitoringData(filters: MonitoringFilters = {}, chartDays = 14, sessionIds: string[] | null = null): MonitoringData {
  const { from, to } = resolveRange(filters);
  if (sessionIds !== null && sessionIds.length === 0) {
    return {
      from,
      to,
      totals: { cronogramas: 0, esam: 0, failed: 0, received: 0 },
      byTipo: [],
      byUser: [],
      byPrograma: [],
      byDay: [],
      options: { programas: [], areas: [], users: [], tipos: [] },
    };
  }
  const byTipoFilter = (filters.tipo ?? '').trim();
  const byProgramaFilter = (filters.programa ?? '').trim();
  const byAreaFilter = (filters.area ?? '').trim();
  const byAccountFilter = (filters.account ?? '').trim();
  const ids = identityIndex();
  const sessionSql = sessionIds === null ? '' : ` AND b.session_id IN (${sessionIds.map(() => '?').join(',')})`;
  const inboxSessionSql = sessionIds === null ? '' : ` AND m.session_id IN (${sessionIds.map(() => '?').join(',')})`;

  // Sesión -> dueño y número (los lotes de cronogramas no siempre traen
  // `meta.account`; en ese caso se atribuyen al dueño de la línea).
  const sessionOwner = new Map<string, { uid: string | null; name: string | null }>();
  for (const s of all<{ id: string; owner_uid: string | null; owner_name: string | null }>(
    'SELECT id, owner_uid, owner_name FROM sessions',
  )) {
    sessionOwner.set(s.id, { uid: s.owner_uid, name: s.owner_name });
    if (s.owner_uid && !ids.labelByKey.has(String(s.owner_uid))) {
      ids.labelByKey.set(canonicalUid(ids, s.owner_uid), s.owner_name ?? `Cuenta ${s.owner_uid}`);
    }
  }
  const userLabel = (acc: string) => (acc === 'principal' ? 'Gestión (principal)' : ids.labelByKey.get(acc) ?? `Usuario ${acc}`);
  // Cuenta de un lote: `meta.account` si viene; si no, el dueño de su sesión.
  const accountOfBatch = (meta: Record<string, unknown>, sessionId: string | null): string => {
    const raw = meta.account != null && String(meta.account).trim() !== '' ? String(meta.account) : null;
    const owner = sessionId ? sessionOwner.get(sessionId)?.uid : null;
    return canonicalUid(ids, raw ?? owner);
  };

  // Opciones de filtro (sobre todos los lotes, sin filtrar).
  const optProgramas = new Set<string>();
  const optAreas = new Set<string>();
  const optUsers = new Map<string, string>();
  const optTipos = new Set<string>(['participantes', 'grupo', 'cobranza', 'notas', 'inbox']);
  for (const b of all<{ meta: string | null; session_id: string | null }>(
    `SELECT meta, session_id FROM batches b WHERE 1 = 1${sessionSql}`,
    ...(sessionIds ?? []),
  )) {
    const m = parseMeta(b.meta);
    if (m.programa) optProgramas.add(String(m.programa));
    if (m.area) optAreas.add(String(m.area));
    const acc = accountOfBatch(m, b.session_id);
    optUsers.set(acc, userLabel(acc));
  }

  const byTipo = new Map<string, number>();
  const byUser = new Map<string, UserStat>();
  const byProg = new Map<string, ProgramaStat>();
  const byDay = new Map<string, { cronogramas: number; esam: number }>();
  // Lotes por usuario/programa: id -> destinatarios (se cuenta el lote una vez).
  const userLots = new Map<string, Map<number, number>>();
  const progLots = new Map<string, Map<number, number>>();
  let cronogramas = 0;
  let esam = 0;
  let failed = 0;

  const rows = all<{
    bid: number;
    btotal: number;
    meta: string | null;
    session_id: string | null;
    status: string;
    day: string;
    c: number;
  }>(
    `SELECT b.id AS bid, b.total AS btotal, b.meta AS meta, b.session_id AS session_id,
            bi.status AS status, date(bi.updated_at, 'localtime') AS day, COUNT(*) AS c
     FROM batch_items bi JOIN batches b ON b.id = bi.batch_id
     WHERE 1 = 1${sessionSql}
     GROUP BY b.id, bi.status, day`,
    ...(sessionIds ?? []),
  );

  for (const row of rows) {
    if (!row.day || row.day < from || row.day > to) continue;
    const meta = parseMeta(row.meta);
    const isCron = meta.source === 'integration';
    const tipo = String(meta.tipo ?? (isCron ? 'otros' : 'panel'));
    const acc = accountOfBatch(meta, row.session_id);
    const area = String(meta.area ?? '').trim();
    const programa = String(meta.programa ?? '').trim() || (isCron ? 'Sin programa' : 'Panel ESAM');

    if (byTipoFilter && tipo !== byTipoFilter) continue;
    if (byProgramaFilter && programa !== byProgramaFilter) continue;
    if (byAreaFilter && !areaMatches(area, byAreaFilter)) continue;
    if (byAccountFilter && acc !== canonicalUid(ids, byAccountFilter)) continue;

    if (row.status === 'failed') {
      failed += row.c;
      continue;
    }
    if (row.status !== 'sent') continue;

    const bucket = byDay.get(row.day) ?? { cronogramas: 0, esam: 0 };
    if (isCron) {
      cronogramas += row.c;
      bucket.cronogramas += row.c;
    } else {
      esam += row.c;
      bucket.esam += row.c;
    }
    byDay.set(row.day, bucket);

    byTipo.set(tipo, (byTipo.get(tipo) ?? 0) + row.c);

    const user = byUser.get(acc) ?? emptyUser(acc, userLabel(acc));
    user.total += row.c;
    user.byTipo[tipo] = (user.byTipo[tipo] ?? 0) + row.c;
    byUser.set(acc, user);
    const uLots = userLots.get(acc) ?? new Map<number, number>();
    uLots.set(row.bid, Number(row.btotal) || Number(row.c));
    userLots.set(acc, uLots);

    const prog = byProg.get(programa) ?? { programa, total: 0, byTipo: {}, batches: 0, batchMessages: 0, avgPerBatch: 0, maxBatch: 0 };
    prog.total += row.c;
    prog.byTipo[tipo] = (prog.byTipo[tipo] ?? 0) + row.c;
    byProg.set(programa, prog);
    const pLots = progLots.get(programa) ?? new Map<number, number>();
    pLots.set(row.bid, Number(row.btotal) || Number(row.c));
    progLots.set(programa, pLots);
  }

  // Bandeja/panel de ESAM (solo si no hay filtros que no apliquen a la bandeja).
  const inboxAllowed =
    (!byTipoFilter || byTipoFilter === 'inbox') && !byProgramaFilter && !byAreaFilter && !byAccountFilter;
  if (inboxAllowed) {
    const inboxRows = all<{ day: string; session_id: string | null; c: number }>(
      `SELECT date(m.occurred_at, 'localtime') AS day, m.session_id AS session_id, COUNT(*) AS c
       FROM messages m
       WHERE m.direction = 'out' AND m.origin = 'panel'
         AND date(m.occurred_at, 'localtime') >= ? AND date(m.occurred_at, 'localtime') <= ?
         AND NOT EXISTS (SELECT 1 FROM batch_items bi WHERE bi.message_id = m.wa_message_id)
         ${inboxSessionSql}
       GROUP BY day, m.session_id`,
      from,
      to,
      ...(sessionIds ?? []),
    );
    for (const row of inboxRows) {
      if (!row.day) continue;
      esam += row.c;
      byTipo.set('inbox', (byTipo.get('inbox') ?? 0) + row.c);
      const bucket = byDay.get(row.day) ?? { cronogramas: 0, esam: 0 };
      bucket.esam += row.c;
      byDay.set(row.day, bucket);
      // Se atribuye al dueño de la sesión desde la que se escribió.
      const acc = canonicalUid(ids, row.session_id ? sessionOwner.get(row.session_id)?.uid : null);
      const user = byUser.get(acc) ?? emptyUser(acc, userLabel(acc));
      user.total += row.c;
      user.byTipo.inbox = (user.byTipo.inbox ?? 0) + row.c;
      byUser.set(acc, user);
    }
  }

  const received =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM messages m
       WHERE m.direction = 'in' AND date(m.occurred_at, 'localtime') >= ? AND date(m.occurred_at, 'localtime') <= ?
       ${inboxSessionSql}`,
      from,
      to,
      ...(sessionIds ?? []),
    )?.c ?? 0;

  // Serie continua entre las fechas del rango (máximo 31 puntos).
  const series: Array<{ day: string; cronogramas: number; esam: number }> = [];
  for (const key of eachDay(from, to)) {
    const v = byDay.get(key) ?? { cronogramas: 0, esam: 0 };
    series.push({ day: key, cronogramas: v.cronogramas, esam: v.esam });
  }
  const recent = series.length > chartDays ? series.slice(series.length - chartDays) : series;

  const tipos = [...byTipo.entries()]
    .map(([tipo, total]) => ({ tipo, label: TIPO_LABELS[tipo] ?? tipo, total }))
    .sort((a, b) => b.total - a.total);

  const users = [...byUser.values()]
    .map((u) => withBatchStats(u, userLots.get(u.id)))
    .sort((a, b) => b.total - a.total || b.batches - a.batches)
    .slice(0, 30);
  const programas = [...byProg.values()]
    .map((p) => withBatchStats(p, progLots.get(p.programa)))
    .sort((a, b) => b.total - a.total || b.batches - a.batches)
    .slice(0, 30);

  return {
    from,
    to,
    totals: { cronogramas, esam, failed, received },
    byTipo: tipos,
    byUser: users,
    byPrograma: programas,
    byDay: recent,
    options: {
      programas: [...optProgramas].sort(),
      areas: [...optAreas].sort(),
      users: [...optUsers.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      tipos: [...optTipos].sort().map((t) => ({ id: t, label: TIPO_LABELS[t] ?? t })),
    },
  };
}

/** Normaliza el apartado (área) a académico / contable / otro. */
function apartadoLabel(area: string | null | undefined): string {
  const a = String(area ?? '').trim().toLowerCase();
  if (!a) return 'Sin apartado';
  if (a.includes('contab') || a.includes('cobran') || a.includes('pago')) return 'Contable';
  if (a.includes('academ') || a.includes('program') || a.includes('docen') || a.includes('nota')) return 'Académico';
  return 'Otros';
}

/**
 * Seguimiento de mensajes por usuario: cuántos envió desde el sistema de
 * cronogramas, cuántos desde lotes pedidos en el panel y cuántos escribió en la
 * bandeja. Incluye el detalle de lotes y el desglose diario para que la lectura
 * en /monitoring y /reports no dependa de abrir otra pantalla.
 * Filtra por rango/día/mes, usuario, programa, apartado, tipo y sesión.
 */
export function activityData(filters: MonitoringFilters = {}, sessionIds: string[] | null = null): ActivityData {
  const { from, to } = resolveRange(filters);
  const ids = identityIndex();
  const accountFilterRaw = (filters.account ?? '').trim();
  const accountFilter = accountFilterRaw ? canonicalUid(ids, accountFilterRaw) : '';
  const byAreaFilter = (filters.area ?? '').trim();
  const byProgramaFilter = (filters.programa ?? '').trim();
  const byTipoFilter = (filters.tipo ?? '').trim();

  const emptyTotals: ActivityData['totals'] = {
    cronogramas: 0, lotes: 0, bandeja: 0, panel: 0, total: 0,
    batches: 0, cronBatches: 0, panelBatches: 0, batchMessages: 0, avgPerBatch: 0, maxBatch: 0, users: 0,
  };
  const emptyResult = (): ActivityData => ({ from, to, rows: [], byDay: [], totals: emptyTotals });
  if (sessionIds !== null && sessionIds.length === 0) return emptyResult();

  const sessionById = new Map<
    string,
    { phone: string | null; area: string | null; owner_uid: string | null; owner_name: string | null }
  >();
  for (const s of all<{
    id: string;
    phone: string | null;
    expected_phone: string | null;
    area: string | null;
    owner_uid: string | null;
    owner_name: string | null;
  }>('SELECT id, phone, expected_phone, area, owner_uid, owner_name FROM sessions')) {
    sessionById.set(s.id, {
      phone: s.phone ?? s.expected_phone ?? null,
      area: s.area ?? null,
      owner_uid: s.owner_uid ?? null,
      owner_name: s.owner_name ?? null,
    });
  }
  // Nombre de respaldo cuando la cuenta no está en `users`.
  for (const s of sessionById.values()) {
    if (s.owner_uid && !ids.labelByKey.has(String(s.owner_uid))) {
      ids.labelByKey.set(canonicalUid(ids, s.owner_uid), s.owner_name ?? `Cuenta ${s.owner_uid}`);
    }
  }

  const rows = new Map<string, ActivityRow>();
  const dayMaps = new Map<string, Map<string, ActivityDay>>();
  const globalDays = new Map<string, ActivityDay>();
  const ensure = (
    uid: string,
    opts: { name?: string | null; phone?: string | null; area?: string | null; userId?: number | null },
  ): ActivityRow => {
    let row = rows.get(uid);
    if (!row) {
      row = {
        uid,
        userId: opts.userId ?? ids.localIdByKey.get(uid) ?? null,
        name: opts.name || ids.labelByKey.get(uid) || (uid === 'principal' ? 'Gestión (principal)' : `Usuario ${uid}`),
        phone: opts.phone ?? null,
        area: opts.area ?? null,
        apartado: apartadoLabel(opts.area),
        cronogramas: 0,
        lotes: 0,
        bandeja: 0,
        panel: 0,
        total: 0,
        batches: 0,
        cronBatches: 0,
        panelBatches: 0,
        batchMessages: 0,
        avgPerBatch: 0,
        maxBatch: 0,
        daysActive: 0,
        lastAt: null,
        byDay: [],
        recent: [],
      };
      rows.set(uid, row);
      dayMaps.set(uid, new Map());
    } else {
      if (!row.phone && opts.phone) row.phone = opts.phone;
      if (!row.area && opts.area) {
        row.area = opts.area;
        row.apartado = apartadoLabel(opts.area);
      }
      if (row.userId == null && opts.userId != null) row.userId = opts.userId;
    }
    return row;
  };
  const addDay = (map: Map<string, ActivityDay>, day: string, key: 'cronogramas' | 'lotes' | 'bandeja', n: number) => {
    if (!day || !n) return;
    const bucket = map.get(day) ?? { day, cronogramas: 0, lotes: 0, bandeja: 0 };
    bucket[key] += n;
    map.set(day, bucket);
  };

  // ── 1) Lotes con envíos confirmados (cronogramas y panel) ────────────────────
  const sessionSql = sessionIds === null ? '' : ` AND b.session_id IN (${sessionIds.map(() => '?').join(',')})`;
  const batchRows = all<{
    id: number;
    name: string | null;
    status: string;
    total: number;
    failed: number;
    skipped: number;
    meta: string | null;
    session_id: string | null;
    day: string;
    last_at: string;
    c: number;
  }>(
    `SELECT b.id AS id, b.name AS name, b.status AS status, b.total AS total, b.failed AS failed, b.skipped AS skipped,
            b.meta AS meta, b.session_id AS session_id, date(bi.updated_at, 'localtime') AS day,
            MAX(bi.updated_at) AS last_at, COUNT(*) AS c
       FROM batch_items bi JOIN batches b ON b.id = bi.batch_id
      WHERE bi.status = 'sent' AND date(bi.updated_at, 'localtime') >= ? AND date(bi.updated_at, 'localtime') <= ?
            ${sessionSql}
      GROUP BY b.id, day`,
    from,
    to,
    ...(sessionIds ?? []),
  );
  interface BatchAgg {
    id: number;
    name: string;
    status: string;
    total: number;
    failed: number;
    skipped: number;
    meta: Record<string, unknown>;
    sessionId: string | null;
    sent: number;
    lastAt: string;
    days: Map<string, number>;
  }
  const batches = new Map<number, BatchAgg>();
  for (const r of batchRows) {
    if (!r.day) continue;
    let batch = batches.get(r.id);
    if (!batch) {
      batch = {
        id: r.id,
        name: r.name ?? `Lote #${r.id}`,
        status: r.status,
        total: Number(r.total) || 0,
        failed: Number(r.failed) || 0,
        skipped: Number(r.skipped) || 0,
        meta: parseMeta(r.meta),
        sessionId: r.session_id,
        sent: 0,
        lastAt: r.last_at,
        days: new Map(),
      };
      batches.set(r.id, batch);
    }
    batch.sent += Number(r.c) || 0;
    if (r.last_at && r.last_at > batch.lastAt) batch.lastAt = r.last_at;
    batch.days.set(r.day, (batch.days.get(r.day) ?? 0) + (Number(r.c) || 0));
  }

  for (const batch of batches.values()) {
    const meta = batch.meta;
    const isCron = meta.source === 'integration';
    const tipo = String(meta.tipo ?? (isCron ? 'otros' : 'panel'));
    const sess = batch.sessionId ? sessionById.get(batch.sessionId) : undefined;
    const area = String(meta.area ?? sess?.area ?? '').trim() || null;
    const programa = String(meta.programa ?? '').trim() || null;
    const rawAccount =
      meta.account != null && String(meta.account).trim() !== '' ? String(meta.account) : sess?.owner_uid ?? null;
    const uid = canonicalUid(ids, rawAccount);

    if (accountFilter && uid !== accountFilter) continue;
    if (byAreaFilter && !areaMatches(area, byAreaFilter)) continue;
    if (byProgramaFilter && programa !== byProgramaFilter) continue;
    if (byTipoFilter && tipo !== byTipoFilter) continue;

    const row = ensure(uid, {
      name: ids.labelByKey.get(uid) ?? sess?.owner_name ?? null,
      phone: sess?.phone ?? null,
      area,
      userId: ids.localIdByKey.get(uid) ?? null,
    });
    row.batches += 1;
    if (isCron) row.cronBatches += 1;
    else row.panelBatches += 1;
    const size = batch.total || batch.sent;
    row.batchMessages += size;
    row.maxBatch = Math.max(row.maxBatch, size);
    if (isCron) row.cronogramas += batch.sent;
    else row.lotes += batch.sent;
    row.total += batch.sent;
    if (!row.lastAt || batch.lastAt > row.lastAt) row.lastAt = batch.lastAt;
    const dayMap = dayMaps.get(uid)!;
    for (const [day, c] of batch.days) {
      addDay(dayMap, day, isCron ? 'cronogramas' : 'lotes', c);
      addDay(globalDays, day, isCron ? 'cronogramas' : 'lotes', c);
    }
    row.recent.push({
      id: batch.id,
      name: batch.name,
      day: localDay(batch.lastAt),
      time: localTime(batch.lastAt),
      status: batch.status,
      total: batch.total,
      sent: batch.sent,
      failed: batch.failed,
      skipped: batch.skipped,
      programa,
      tipo,
      cronograma: isCron,
      linePhone: sess?.phone ?? null,
      lineOwner: sess?.owner_name ?? null,
    });
  }

  // ── 2) Mensajes escritos desde la bandeja, atribuidos a su agente ────────────
  const panelAllowed = !byProgramaFilter && (!byTipoFilter || byTipoFilter === 'inbox');
  if (panelAllowed) {
    const panelSessionSql =
      sessionIds === null ? '' : ` AND m.session_id IN (${sessionIds.map(() => '?').join(',')})`;
    const panelRows = all<{ sender_uid: number | null; session_id: string | null; day: string; last_at: string; c: number }>(
      `SELECT COALESCE(m.sender_uid, s.owner_uid) AS sender_uid, m.session_id AS session_id,
              date(m.occurred_at, 'localtime') AS day, MAX(m.occurred_at) AS last_at, COUNT(*) AS c
         FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
        WHERE m.direction = 'out' AND m.origin = 'panel'
          AND date(m.occurred_at, 'localtime') >= ? AND date(m.occurred_at, 'localtime') <= ?
          AND NOT EXISTS (SELECT 1 FROM batch_items bi WHERE bi.message_id = m.wa_message_id)
          ${panelSessionSql}
        GROUP BY sender_uid, m.session_id, day`,
      from,
      to,
      ...(sessionIds ?? []),
    );
    for (const r of panelRows) {
      if (!r.day) continue;
      const sess = r.session_id ? sessionById.get(r.session_id) : undefined;
      if (byAreaFilter && !areaMatches(sess?.area, byAreaFilter)) continue;
      const uid = canonicalUid(ids, r.sender_uid != null ? String(r.sender_uid) : sess?.owner_uid ?? null);
      if (accountFilter && uid !== accountFilter && canonicalUid(ids, sess?.owner_uid) !== accountFilter) continue;
      const row = ensure(uid, {
        name: ids.labelByKey.get(uid) ?? sess?.owner_name ?? null,
        phone: sess?.phone ?? null,
        area: sess?.area ?? null,
        userId: ids.localIdByKey.get(uid) ?? null,
      });
      row.bandeja += r.c;
      row.total += r.c;
      if (r.last_at && (!row.lastAt || r.last_at > row.lastAt)) row.lastAt = r.last_at;
      addDay(dayMaps.get(uid)!, r.day, 'bandeja', r.c);
      addDay(globalDays, r.day, 'bandeja', r.c);
    }
  }

  // ── Totales y orden ─────────────────────────────────────────────────────────
  const list = [...rows.values()].map((row) => {
    row.panel = row.lotes + row.bandeja;
    row.byDay = [...(dayMaps.get(row.uid)?.values() ?? [])].sort((a, b) => a.day.localeCompare(b.day));
    row.daysActive = row.byDay.length;
    row.avgPerBatch = row.batches ? Math.round(row.batchMessages / row.batches) : 0;
    row.recent.sort((a, b) => `${b.day} ${b.time}`.localeCompare(`${a.day} ${a.time}`) || b.id - a.id);
    row.recent = row.recent.slice(0, 8);
    return row;
  });
  list.sort((a, b) => b.total - a.total || b.cronogramas - a.cronogramas || a.name.localeCompare(b.name, 'es'));

  const totals = list.reduce(
    (acc, r) => {
      acc.cronogramas += r.cronogramas;
      acc.lotes += r.lotes;
      acc.bandeja += r.bandeja;
      acc.panel += r.panel;
      acc.total += r.total;
      acc.batches += r.batches;
      acc.cronBatches += r.cronBatches;
      acc.panelBatches += r.panelBatches;
      acc.batchMessages += r.batchMessages;
      acc.maxBatch = Math.max(acc.maxBatch, r.maxBatch);
      return acc;
    },
    { ...emptyTotals, users: list.length },
  );
  totals.avgPerBatch = totals.batches ? Math.round(totals.batchMessages / totals.batches) : 0;

  return {
    from,
    to,
    rows: list,
    byDay: [...globalDays.values()].sort((a, b) => a.day.localeCompare(b.day)),
    totals,
  };
}

export interface ReportsData {
  totals: { enviados: number; entregados: number; leidos: number; fallidos: number; recibidos: number };
  byStatus: Array<{ status: string; total: number }>;
  byTipo: Array<{ tipo: string; label: string; enviados: number }>;
  byPrograma: Array<{ programa: string; enviados: number; fallidos: number }>;
  byDay: Array<{ day: string; enviados: number; recibidos: number }>;
}

/** Reportes de envío/entrega (últimos `days` días) para la vista /reports. */
export function reportsData(days = 30, chartDays = 14): ReportsData {
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  const byStatus = all<{ status: string; c: number }>(
    'SELECT status, COUNT(*) AS c FROM batch_items GROUP BY status',
  ).map((r) => ({ status: r.status, total: r.c }));

  const byTipoMap = new Map<string, number>();
  const byProgMap = new Map<string, { enviados: number; fallidos: number }>();
  const batchRows = all<{ meta: string | null; status: string; c: number }>(
    'SELECT b.meta AS meta, bi.status AS status, COUNT(*) AS c FROM batch_items bi JOIN batches b ON b.id = bi.batch_id GROUP BY b.id, bi.status',
  );
  for (const r of batchRows) {
    const meta = parseMeta(r.meta);
    const isCron = meta.source === 'integration';
    const tipo = String(meta.tipo ?? (isCron ? 'otros' : 'panel'));
    const prog = String(meta.programa ?? '').trim() || (isCron ? 'Sin programa' : 'Panel ESAM');
    const st = byProgMap.get(prog) ?? { enviados: 0, fallidos: 0 };
    if (r.status === 'sent') {
      byTipoMap.set(tipo, (byTipoMap.get(tipo) ?? 0) + r.c);
      st.enviados += r.c;
    } else if (r.status === 'failed') {
      st.fallidos += r.c;
    }
    byProgMap.set(prog, st);
  }

  const msg = get<{ sent: number; delivered: number; read: number; failed: number }>(
    `SELECT
       SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN direction = 'out' AND status IN ('delivered','read','played') THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN direction = 'out' AND status IN ('read','played') THEN 1 ELSE 0 END) AS read,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM messages WHERE occurred_at >= ?`,
    sinceIso,
  );
  const recibidos =
    get<{ c: number }>("SELECT COUNT(*) AS c FROM messages WHERE direction = 'in' AND occurred_at >= ?", sinceIso)?.c ?? 0;

  const outMap = new Map(
    all<{ day: string; c: number }>(
      "SELECT substr(occurred_at, 1, 10) AS day, COUNT(*) AS c FROM messages WHERE direction = 'out' AND occurred_at >= ? GROUP BY day",
      sinceIso,
    ).map((r) => [r.day, r.c]),
  );
  const inMap = new Map(
    all<{ day: string; c: number }>(
      "SELECT substr(occurred_at, 1, 10) AS day, COUNT(*) AS c FROM messages WHERE direction = 'in' AND occurred_at >= ? GROUP BY day",
      sinceIso,
    ).map((r) => [r.day, r.c]),
  );
  const byDay: Array<{ day: string; enviados: number; recibidos: number }> = [];
  for (let i = chartDays - 1; i >= 0; i--) {
    const key = dayKey(new Date(Date.now() - i * 86_400_000));
    byDay.push({ day: key, enviados: outMap.get(key) ?? 0, recibidos: inMap.get(key) ?? 0 });
  }

  return {
    totals: { enviados: msg?.sent ?? 0, entregados: msg?.delivered ?? 0, leidos: msg?.read ?? 0, fallidos: msg?.failed ?? 0, recibidos },
    byStatus,
    byTipo: [...byTipoMap.entries()]
      .map(([tipo, enviados]) => ({ tipo, label: TIPO_LABELS[tipo] ?? tipo, enviados }))
      .sort((a, b) => b.enviados - a.enviados),
    byPrograma: [...byProgMap.entries()]
      .map(([programa, v]) => ({ programa, ...v }))
      .sort((a, b) => b.enviados - a.enviados)
      .slice(0, 12),
    byDay,
  };
}
