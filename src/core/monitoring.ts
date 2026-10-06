import { all, get } from '../db/index.js';

export interface UserStat {
  id: string;
  name: string;
  total: number;
  byTipo: Record<string, number>;
}

export interface ProgramaStat {
  programa: string;
  total: number;
  byTipo: Record<string, number>;
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

/** Fila de actividad por usuario (seguimiento y control de mensajes). */
export interface ActivityRow {
  uid: string;
  name: string;
  phone: string | null;
  area: string | null;
  apartado: string;
  cronogramas: number;
  panel: number;
  total: number;
}

export interface ActivityData {
  from: string;
  to: string;
  rows: ActivityRow[];
  totals: { cronogramas: number; panel: number; total: number };
}

/** Aplica día/mes sobre el rango; devuelve `[from, to]`. */
function resolveRange(filters: MonitoringFilters): { from: string; to: string } {
  const day = (filters.day ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return { from: day, to: day };
  if (/^\d{4}-\d{2}$/.test(day)) {
    const [y, m] = day.split('-').map((n) => parseInt(n, 10));
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 0));
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

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function emptyUser(id: string, name: string): UserStat {
  return { id, name, total: 0, byTipo: {} };
}

/**
 * Agrega los envíos entre `from` y `to` (YYYY-MM-DD) con filtros opcionales por
 * programa, usuario, área y tipo.
 */
export function monitoringData(filters: MonitoringFilters = {}, chartDays = 14): MonitoringData {
  const { from, to } = resolveRange(filters);
  const byTipoFilter = (filters.tipo ?? '').trim();
  const byProgramaFilter = (filters.programa ?? '').trim();
  const byAreaFilter = (filters.area ?? '').trim();
  const byAccountFilter = (filters.account ?? '').trim();

  // Nombres de usuario: se muestra el nombre de usuario (login) del panel; si
  // falta, cae al nombre completo. Se indexa por source_uid y por id local.
  const nameByUid = new Map<string, string>();
  for (const u of all<{ id: number; source_uid: string | null; name: string | null; username: string | null }>(
    'SELECT id, source_uid, name, username FROM users',
  )) {
    const label = u.username ?? u.name ?? null;
    if (u.source_uid) nameByUid.set(String(u.source_uid), label ?? `Usuario ${u.source_uid}`);
    nameByUid.set(String(u.id), label ?? `Usuario ${u.id}`);
  }
  // Sesión -> dueño y nombre (los lotes de cronogramas no traen `meta.account`,
  // pero sí la sesión, que es la del usuario que envió).
  const sessionOwner = new Map<string, { uid: string | null; name: string | null }>();
  for (const s of all<{ id: string; owner_uid: string | null; owner_name: string | null }>(
    'SELECT id, owner_uid, owner_name FROM sessions',
  )) {
    sessionOwner.set(s.id, { uid: s.owner_uid, name: s.owner_name });
    if (s.owner_uid && !nameByUid.has(String(s.owner_uid))) {
      nameByUid.set(String(s.owner_uid), s.owner_name ?? `Cuenta ${s.owner_uid}`);
    }
  }
  const userLabel = (acc: string) => nameByUid.get(acc) ?? `Usuario ${acc}`;
  // Cuenta de un lote: `meta.account` si viene; si no, el dueño de su sesión.
  const accountOfBatch = (meta: Record<string, unknown>, sessionId: string | null): string => {
    if (meta.account != null && String(meta.account).trim() !== '') return String(meta.account);
    const owner = sessionId ? sessionOwner.get(sessionId)?.uid : null;
    return owner ? String(owner) : 'principal';
  };

  // Opciones de filtro (sobre todos los lotes, sin filtrar).
  const optProgramas = new Set<string>();
  const optAreas = new Set<string>();
  const optUsers = new Map<string, string>();
  const optTipos = new Set<string>(['participantes', 'grupo', 'cobranza', 'notas', 'inbox']);
  for (const b of all<{ meta: string | null; session_id: string | null }>('SELECT meta, session_id FROM batches')) {
    const m = parseMeta(b.meta);
    if (m.programa) optProgramas.add(String(m.programa));
    if (m.area) optAreas.add(String(m.area));
    const acc = accountOfBatch(m, b.session_id);
    optUsers.set(acc, acc === 'principal' ? 'Gestión (principal)' : userLabel(acc));
  }

  const byTipo = new Map<string, number>();
  const byUser = new Map<string, UserStat>();
  const byProg = new Map<string, ProgramaStat>();
  const byDay = new Map<string, { cronogramas: number; esam: number }>();
  let cronogramas = 0;
  let esam = 0;
  let failed = 0;

  const rows = all<{ meta: string | null; session_id: string | null; status: string; day: string; c: number }>(
    `SELECT b.meta AS meta, b.session_id AS session_id, bi.status AS status, substr(bi.updated_at, 1, 10) AS day, COUNT(*) AS c
     FROM batch_items bi JOIN batches b ON b.id = bi.batch_id
     GROUP BY b.id, bi.status, day`,
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
    if (byAreaFilter && area !== byAreaFilter) continue;
    if (byAccountFilter && acc !== byAccountFilter) continue;

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

    const user = byUser.get(acc) ?? emptyUser(acc, acc === 'principal' ? 'Gestión (principal)' : userLabel(acc));
    user.total += row.c;
    user.byTipo[tipo] = (user.byTipo[tipo] ?? 0) + row.c;
    byUser.set(acc, user);

    const prog = byProg.get(programa) ?? { programa, total: 0, byTipo: {} };
    prog.total += row.c;
    prog.byTipo[tipo] = (prog.byTipo[tipo] ?? 0) + row.c;
    byProg.set(programa, prog);
  }

  // Bandeja/panel de ESAM (solo si no hay filtros que no apliquen a la bandeja).
  const inboxAllowed =
    (!byTipoFilter || byTipoFilter === 'inbox') && !byProgramaFilter && !byAreaFilter && !byAccountFilter;
  if (inboxAllowed) {
    const inboxRows = all<{ day: string; session_id: string | null; c: number }>(
      `SELECT substr(m.occurred_at, 1, 10) AS day, m.session_id AS session_id, COUNT(*) AS c
       FROM messages m
       WHERE m.direction = 'out' AND m.origin = 'panel' AND m.occurred_at >= ?
         AND substr(m.occurred_at, 1, 10) <= ?
         AND NOT EXISTS (SELECT 1 FROM batch_items bi WHERE bi.message_id = m.wa_message_id)
       GROUP BY day, m.session_id`,
      `${from}T00:00:00.000Z`,
      to,
    );
    for (const row of inboxRows) {
      if (!row.day) continue;
      esam += row.c;
      byTipo.set('inbox', (byTipo.get('inbox') ?? 0) + row.c);
      const bucket = byDay.get(row.day) ?? { cronogramas: 0, esam: 0 };
      bucket.esam += row.c;
      byDay.set(row.day, bucket);
      // Se atribuye al dueño de la sesión desde la que se escribió.
      const acc = (row.session_id ? sessionOwner.get(row.session_id)?.uid : null) ?? 'principal';
      const user = byUser.get(acc) ?? emptyUser(acc, acc === 'principal' ? 'Gestión (principal)' : userLabel(acc));
      user.total += row.c;
      user.byTipo.inbox = (user.byTipo.inbox ?? 0) + row.c;
      byUser.set(acc, user);
    }
  }

  const received =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM messages
       WHERE direction = 'in' AND substr(occurred_at, 1, 10) >= ? AND substr(occurred_at, 1, 10) <= ?`,
      from,
      to,
    )?.c ?? 0;

  // Serie continua entre las fechas del rango (máximo 31 puntos).
  const series: Array<{ day: string; cronogramas: number; esam: number }> = [];
  const startMs = Date.parse(`${from}T00:00:00.000Z`);
  const endMs = Date.parse(`${to}T00:00:00.000Z`);
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    const key = dayKey(new Date(ms));
    const v = byDay.get(key) ?? { cronogramas: 0, esam: 0 };
    series.push({ day: key, cronogramas: v.cronogramas, esam: v.esam });
  }
  const recent = series.length > chartDays ? series.slice(series.length - chartDays) : series;

  const tipos = [...byTipo.entries()]
    .map(([tipo, total]) => ({ tipo, label: TIPO_LABELS[tipo] ?? tipo, total }))
    .sort((a, b) => b.total - a.total);

  return {
    from,
    to,
    totals: { cronogramas, esam, failed, received },
    byTipo: tipos,
    byUser: [...byUser.values()].sort((a, b) => b.total - a.total).slice(0, 30),
    byPrograma: [...byProg.values()].sort((a, b) => b.total - a.total).slice(0, 30),
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
 * Seguimiento de mensajes por usuario: cuántos envió desde cronogramas y cuántos
 * escribió desde el panel (baileys_esam), con su número de WhatsApp y apartado.
 * Filtra por rango/día/mes, usuario, apartado y sesión (alcance del usuario).
 */
export function activityData(filters: MonitoringFilters = {}, sessionIds: string[] | null = null): ActivityData {
  const { from, to } = resolveRange(filters);
  const byAccountFilter = (filters.account ?? '').trim();
  const byAreaFilter = (filters.area ?? '').trim();

  const sessionById = new Map<string, { phone: string | null; area: string | null; owner_uid: string | null }>();
  for (const s of all<{ id: string; phone: string | null; expected_phone: string | null; area: string | null; owner_uid: string | null }>(
    'SELECT id, phone, expected_phone, area, owner_uid FROM sessions',
  )) {
    sessionById.set(s.id, { phone: s.phone ?? s.expected_phone ?? null, area: s.area ?? null, owner_uid: s.owner_uid ?? null });
  }

  // Se muestra el nombre de usuario (login) del panel; si falta, el nombre real.
  const nameByUid = new Map<string, string>();
  const localNameById = new Map<string, string>();
  for (const u of all<{ id: number; source_uid: string | null; name: string | null; username: string | null }>(
    'SELECT id, source_uid, name, username FROM users',
  )) {
    const label = u.username ?? u.name ?? null;
    if (u.source_uid) nameByUid.set(String(u.source_uid), label ?? `Usuario ${u.source_uid}`);
    if (label) localNameById.set(String(u.id), label);
  }
  for (const s of all<{ owner_uid: string | null; owner_name: string | null }>(
    'SELECT owner_uid, owner_name FROM sessions',
  )) {
    if (s.owner_uid && !nameByUid.has(String(s.owner_uid))) {
      nameByUid.set(String(s.owner_uid), s.owner_name ?? `Cuenta ${s.owner_uid}`);
    }
  }

  const rows = new Map<string, ActivityRow>();
  const ensure = (uid: string, opts: { name?: string | null; phone?: string | null; area?: string | null }): ActivityRow => {
    let row = rows.get(uid);
    if (!row) {
      row = {
        uid,
        name: opts.name || nameByUid.get(uid) || (uid === 'principal' ? 'Gestión (principal)' : `Usuario ${uid}`),
        phone: opts.phone ?? null,
        area: opts.area ?? null,
        apartado: apartadoLabel(opts.area),
        cronogramas: 0,
        panel: 0,
        total: 0,
      };
      rows.set(uid, row);
    } else {
      if (!row.phone && opts.phone) row.phone = opts.phone;
      if (!row.area && opts.area) { row.area = opts.area; row.apartado = apartadoLabel(opts.area); }
    }
    return row;
  };

  // 1) Envíos de lotes (cronogramas y panel) confirmados como 'sent'.
  const batchRows = all<{ meta: string | null; status: string; session_id: string | null; day: string; c: number }>(
    `SELECT b.meta AS meta, b.session_id AS session_id, bi.status AS status, substr(bi.updated_at, 1, 10) AS day, COUNT(*) AS c
     FROM batch_items bi JOIN batches b ON b.id = bi.batch_id
     WHERE bi.status = 'sent'
     GROUP BY b.id, bi.status, day`,
  );
  for (const r of batchRows) {
    if (!r.day || r.day < from || r.day > to) continue;
    const meta = parseMeta(r.meta);
    const isCron = meta.source === 'integration';
    const acc = meta.account == null ? 'principal' : String(meta.account);
    const sess = r.session_id ? sessionById.get(r.session_id) : undefined;
    const area = String(meta.area ?? sess?.area ?? '').trim() || null;
    if (byAccountFilter && acc !== byAccountFilter) continue;
    if (byAreaFilter && apartadoLabel(area) !== byAreaFilter) continue;
    const row = ensure(acc, { name: nameByUid.get(acc) ?? null, phone: sess?.phone ?? null, area });
    if (isCron) row.cronogramas += r.c; else row.panel += r.c;
    row.total += r.c;
  }

  // 2) Mensajes escritos desde el panel (bandeja), atribuidos a su agente.
  const panelRows = all<{ sender_uid: number | null; session_id: string | null; day: string; c: number }>(
    `SELECT m.sender_uid AS sender_uid, m.session_id AS session_id, substr(m.occurred_at, 1, 10) AS day, COUNT(*) AS c
     FROM messages m
     WHERE m.direction = 'out' AND m.origin = 'panel' AND m.occurred_at >= ? AND substr(m.occurred_at, 1, 10) <= ?
       AND NOT EXISTS (SELECT 1 FROM batch_items bi WHERE bi.message_id = m.wa_message_id)
     GROUP BY m.sender_uid, m.session_id, day`,
    `${from}T00:00:00.000Z`,
    to,
  );
  for (const r of panelRows) {
    if (!r.day) continue;
    if (sessionIds && r.session_id && !sessionIds.includes(r.session_id)) continue;
    const uid = r.sender_uid != null ? String(r.sender_uid) : 'principal';
    const sess = r.session_id ? sessionById.get(r.session_id) : undefined;
    if (byAccountFilter && uid !== byAccountFilter && (sess?.owner_uid ?? '') !== byAccountFilter) continue;
    if (byAreaFilter && apartadoLabel(sess?.area) !== byAreaFilter) continue;
    const row = ensure(uid, { name: localNameById.get(uid) ?? null, phone: sess?.phone ?? null, area: sess?.area ?? null });
    row.panel += r.c;
    row.total += r.c;
  }

  const list = [...rows.values()].sort((a, b) => b.total - a.total);
  const totals = list.reduce(
    (acc, r) => ({ cronogramas: acc.cronogramas + r.cronogramas, panel: acc.panel + r.panel, total: acc.total + r.total }),
    { cronogramas: 0, panel: 0, total: 0 },
  );
  return { from, to, rows: list, totals };
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
