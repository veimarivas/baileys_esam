import { all, get } from '../db/index.js';
import { listAllNotes, noteStats, type GlobalNote, type NoteStats } from './contacts.js';

/**
 * Métricas de atención para /monitoring (operación del día) y /reports
 * (análisis del período): conversaciones esperando respuesta, tiempo de primera
 * respuesta, actividad por usuario, seguimientos de notas y estado de números.
 *
 * Fechas: los rangos se interpretan en la hora local del servidor y se
 * comparan contra `occurred_at` (ISO en UTC).
 */

// ── Período ───────────────────────────────────────────────────────────────────

export type PeriodPreset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';

export interface Period {
  preset: PeriodPreset;
  /** Día inicial y final inclusive (AAAA-MM-DD, hora local). */
  from: string;
  to: string;
  /** Límites ISO (UTC) para comparar con `occurred_at`: [fromIso, toIso). */
  fromIso: string;
  toIso: string;
  label: string;
  days: number;
}

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  today: 'Hoy',
  yesterday: 'Ayer',
  '7d': 'Últimos 7 días',
  '30d': 'Últimos 30 días',
  month: 'Este mes',
  custom: 'Personalizado',
};

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Período a partir de la query (`period`, `from`, `to`). */
export function resolvePeriod(q: { period?: string; from?: string; to?: string }, fallback: PeriodPreset): Period {
  const today = parseYmd(ymd(new Date()))!;
  let preset = (Object.keys(PERIOD_LABELS) as PeriodPreset[]).includes(q.period as PeriodPreset)
    ? (q.period as PeriodPreset)
    : fallback;
  let start = today;
  let end = today;
  const customFrom = parseYmd(q.from ?? '');
  const customTo = parseYmd(q.to ?? '');
  if (preset === 'custom' || (customFrom && !q.period)) {
    preset = 'custom';
    start = customFrom ?? addDays(today, -29);
    end = customTo ?? today;
    if (end < start) [start, end] = [end, start];
    if ((end.getTime() - start.getTime()) / 86_400_000 > 366) start = addDays(end, -366);
  } else if (preset === 'yesterday') {
    start = end = addDays(today, -1);
  } else if (preset === '7d') {
    start = addDays(today, -6);
  } else if (preset === '30d') {
    start = addDays(today, -29);
  } else if (preset === 'month') {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
  }
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const label =
    preset === 'custom' || preset === 'month'
      ? `${start.toLocaleDateString('es-BO')} – ${end.toLocaleDateString('es-BO')}`
      : PERIOD_LABELS[preset];
  return {
    preset,
    from: ymd(start),
    to: ymd(end),
    fromIso: start.toISOString(),
    toIso: addDays(end, 1).toISOString(),
    label,
    days,
  };
}

/** Día local (AAAA-MM-DD) de un instante ISO. */
export function localDay(iso: string): string {
  return ymd(new Date(iso));
}

// ── Alcance ───────────────────────────────────────────────────────────────────

export interface Scope {
  /** `null` = todas las sesiones; `[]` = ninguna. */
  sessionIds: string[] | null;
  /** Filtro opcional a una sola sesión (número). */
  sessionId?: string | null;
}

/** Sesiones efectivas: el filtro dentro del alcance del usuario. */
function effectiveSessions(scope: Scope): string[] | null {
  if (scope.sessionId) {
    if (scope.sessionIds && !scope.sessionIds.includes(scope.sessionId)) return [];
    return [scope.sessionId];
  }
  return scope.sessionIds;
}

function sessionClause(scope: Scope, column: string, params: unknown[]): string {
  const ids = effectiveSessions(scope);
  if (ids === null) return '1';
  if (!ids.length) return '0';
  params.push(...ids);
  return `${column} IN (${ids.map(() => '?').join(',')})`;
}

const INDIVIDUAL = (alias: string) =>
  `${alias}.chat_id NOT LIKE '%@g.us' AND ${alias}.chat_id NOT LIKE '%@broadcast' AND ${alias}.chat_id NOT LIKE '%@newsletter'`;

// ── Pendientes de respuesta ───────────────────────────────────────────────────

export interface PendingReply {
  sessionId: string;
  chatId: string;
  name: string | null;
  phone: string | null;
  lastText: string | null;
  lastAt: string;
  waitingSince: string;
  waitingMinutes: number;
  unread: number;
  openNotes: number;
  sessionLabel: string;
}

/**
 * Chats individuales cuyo último mensaje es del contacto (nadie respondió),
 * con actividad en los últimos `maxAgeDays` días. El más antiguo primero.
 */
export function pendingReplies(scope: Scope, opts: { maxAgeDays?: number; limit?: number } = {}): { total: number; rows: PendingReply[] } {
  const since = new Date(Date.now() - (opts.maxAgeDays ?? 7) * 86_400_000).toISOString();
  const params: unknown[] = [];
  const where = `${INDIVIDUAL('c')} AND c.last_direction = 'in' AND c.last_message_at >= ? AND ${sessionClause(scope, 'c.session_id', (params.push(since), params))}`;
  const total = get<{ c: number }>(`SELECT COUNT(*) AS c FROM conversations c WHERE ${where}`, ...params)?.c ?? 0;
  const rows = all<{
    session_id: string;
    chat_id: string;
    name: string | null;
    phone: string | null;
    last_message_text: string | null;
    last_message_at: string;
    unread_count: number;
    waiting_since: string | null;
    open_notes: number;
    s_phone: string | null;
    s_owner: string | null;
    s_name: string;
  }>(
    `SELECT c.session_id, c.chat_id, COALESCE(ct.name, c.contact_name) AS name, ct.phone,
            c.last_message_text, c.last_message_at, c.unread_count,
            (SELECT MIN(m.occurred_at) FROM messages m
              WHERE m.session_id = c.session_id AND m.chat_id = c.chat_id AND m.direction = 'in'
                AND m.occurred_at > COALESCE((SELECT MAX(o.occurred_at) FROM messages o
                                               WHERE o.session_id = c.session_id AND o.chat_id = c.chat_id
                                                 AND o.direction = 'out'), '')) AS waiting_since,
            (SELECT COUNT(*) FROM contact_notes n JOIN contacts p ON p.id = n.contact_id
              WHERE (p.id = ct.id OR (ct.phone_key IS NOT NULL AND p.phone_key = ct.phone_key))
                AND n.done_at IS NULL AND n.deleted_at IS NULL) AS open_notes,
            s.phone AS s_phone, s.owner_name AS s_owner, s.name AS s_name
       FROM conversations c
       LEFT JOIN contacts ct ON ct.session_id = c.session_id AND ct.chat_id = c.chat_id
       LEFT JOIN sessions s ON s.id = c.session_id
      WHERE ${where}
      ORDER BY waiting_since ASC
      LIMIT ?`,
    ...params,
    opts.limit ?? 100,
  );
  const now = Date.now();
  return {
    total,
    rows: rows.map((r) => {
      const waitingSince = r.waiting_since ?? r.last_message_at;
      return {
        sessionId: r.session_id,
        chatId: r.chat_id,
        name: r.name,
        phone: r.phone ?? r.chat_id.split('@')[0],
        lastText: r.last_message_text,
        lastAt: r.last_message_at,
        waitingSince,
        waitingMinutes: Math.max(0, Math.round((now - Date.parse(waitingSince)) / 60_000)),
        unread: r.unread_count,
        openNotes: r.open_notes,
        sessionLabel: r.s_owner ?? r.s_phone ?? r.s_name,
      };
    }),
  };
}

// ── Atención en el período ────────────────────────────────────────────────────

export interface ResponderStat {
  key: string;
  name: string;
  responses: number;
  chats: number;
  avgFirstResponseMin: number | null;
}

export interface AttentionData {
  received: number;
  receivedChats: number;
  sent: { panel: number; phone: number; batch: number; total: number };
  attendedChats: number;
  newChats: number;
  /** Turnos del contacto (mensaje que espera respuesta) que empezaron en el período. */
  episodes: number;
  answered: number;
  medianMin: number | null;
  avgMin: number | null;
  within15: number;
  within60: number;
  byDay: Array<{ day: string; received: number; sent: number; medianMin: number | null }>;
  byHour: Array<{ hour: number; received: number; sent: number }>;
  responders: ResponderStat[];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/**
 * Atención del período. Un "turno" empieza con un mensaje del contacto que no
 * sigue a otro del contacto; termina con la primera respuesta manual (panel o
 * teléfono — los lotes no cuentan como respuesta). Las respuestas se buscan
 * hasta 3 días después del período.
 */
export function attentionData(scope: Scope, period: Period): AttentionData {
  const params: unknown[] = [];
  const sessWhere = sessionClause(scope, 'm.session_id', params);
  const respondUntil = new Date(Math.min(Date.now(), Date.parse(period.toIso) + 3 * 86_400_000)).toISOString();

  // Usuarios (para nombrar a quien respondió desde el panel).
  const userName = new Map<string, string>();
  for (const u of all<{ id: number; name: string | null; username: string | null }>('SELECT id, name, username FROM users')) {
    userName.set(String(u.id), u.name ?? u.username ?? `Usuario ${u.id}`);
  }

  const rows = all<{
    session_id: string;
    chat_id: string;
    direction: string;
    origin: string | null;
    sender_uid: number | null;
    occurred_at: string;
  }>(
    `SELECT m.session_id, m.chat_id, m.direction, m.origin, m.sender_uid, m.occurred_at
       FROM messages m
      WHERE m.occurred_at >= ? AND m.occurred_at < ? AND ${INDIVIDUAL('m')} AND ${sessWhere}
      ORDER BY m.session_id, m.chat_id, m.occurred_at, m.id`,
    period.fromIso,
    respondUntil,
    ...params,
  );

  const inPeriod = (iso: string) => iso >= period.fromIso && iso < period.toIso;
  const isReply = (r: { direction: string; origin: string | null }) => r.direction === 'out' && r.origin !== 'batch';

  const dayMap = new Map<string, { received: number; sent: number; times: number[] }>();
  for (let d = parseYmd(period.from)!; ymd(d) <= period.to; d = addDays(d, 1)) {
    dayMap.set(ymd(d), { received: 0, sent: 0, times: [] });
  }
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, received: 0, sent: 0 }));
  const sent = { panel: 0, phone: 0, batch: 0, total: 0 };
  const receivedChats = new Set<string>();
  const attended = new Set<string>();
  const responderMap = new Map<string, { responses: number; chats: Set<string>; times: number[] }>();
  const allTimes: number[] = [];
  let received = 0;
  let episodes = 0;
  let answered = 0;
  let within15 = 0;
  let within60 = 0;

  let prevKey = '';
  let prevDir = '';
  let openSince: string | null = null;
  const responderKey = (r: { origin: string | null; sender_uid: number | null }) =>
    r.origin === 'panel' && r.sender_uid != null ? String(r.sender_uid) : r.origin === 'panel' ? 'panel' : 'phone';

  for (const r of rows) {
    const chatKey = `${r.session_id}|${r.chat_id}`;
    if (chatKey !== prevKey) {
      prevKey = chatKey;
      prevDir = '';
      openSince = null;
    }
    const counted = inPeriod(r.occurred_at);
    const day = localDay(r.occurred_at);
    if (r.direction === 'in') {
      if (counted) {
        received++;
        receivedChats.add(chatKey);
        const b = dayMap.get(day);
        if (b) b.received++;
        hours[new Date(r.occurred_at).getHours()].received++;
        if (prevDir !== 'in' && !openSince) {
          openSince = r.occurred_at;
          episodes++;
        }
      }
    } else {
      if (counted) {
        sent.total++;
        if (r.origin === 'batch') sent.batch++;
        else if (r.origin === 'panel') sent.panel++;
        else sent.phone++;
        const b = dayMap.get(day);
        if (b) b.sent++;
        hours[new Date(r.occurred_at).getHours()].sent++;
      }
      if (isReply(r)) {
        const key = responderKey(r);
        if (counted) {
          attended.add(chatKey);
          const st = responderMap.get(key) ?? { responses: 0, chats: new Set<string>(), times: [] };
          st.responses++;
          st.chats.add(chatKey);
          responderMap.set(key, st);
        }
        if (openSince) {
          const minutes = (Date.parse(r.occurred_at) - Date.parse(openSince)) / 60_000;
          answered++;
          allTimes.push(minutes);
          if (minutes <= 15) within15++;
          if (minutes <= 60) within60++;
          dayMap.get(localDay(openSince))?.times.push(minutes);
          const st = responderMap.get(key) ?? { responses: 0, chats: new Set<string>(), times: [] };
          st.times.push(minutes);
          responderMap.set(key, st);
          openSince = null;
        }
      }
    }
    prevDir = r.direction;
  }

  // Contactos nuevos: chats cuyo PRIMER mensaje cae en el período (no la fecha
  // en que se guardó la conversación, que cambia con cada sincronización).
  const newParams: unknown[] = [];
  const newWhere = sessionClause(scope, 'm.session_id', newParams);
  const newChats =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM (
         SELECT MIN(m.occurred_at) AS first_at FROM messages m
          WHERE ${INDIVIDUAL('m')} AND ${newWhere}
          GROUP BY m.session_id, m.chat_id
       ) WHERE first_at >= ? AND first_at < ?`,
      ...newParams,
      period.fromIso,
      period.toIso,
    )?.c ?? 0;

  const avg = allTimes.length ? Math.round(allTimes.reduce((a, b) => a + b, 0) / allTimes.length) : null;
  return {
    received,
    receivedChats: receivedChats.size,
    sent,
    attendedChats: attended.size,
    newChats,
    episodes,
    answered,
    medianMin: median(allTimes),
    avgMin: avg,
    within15,
    within60,
    byDay: [...dayMap.entries()].map(([d, v]) => ({ day: d, received: v.received, sent: v.sent, medianMin: median(v.times) })),
    byHour: hours,
    responders: [...responderMap.entries()]
      .map(([key, v]) => ({
        key,
        name: key === 'phone' ? 'Desde el teléfono' : key === 'panel' ? 'Panel (sin usuario)' : userName.get(key) ?? `Usuario ${key}`,
        responses: v.responses,
        chats: v.chats.size,
        avgFirstResponseMin: v.times.length ? Math.round(v.times.reduce((a, b) => a + b, 0) / v.times.length) : null,
      }))
      .sort((a, b) => b.responses - a.responses),
  };
}

// ── Notas de seguimiento ──────────────────────────────────────────────────────

export interface NotesFollowup {
  stats: NoteStats;
  overdue: GlobalNote[];
  today: GlobalNote[];
  createdInPeriod: number;
  resolvedInPeriod: number;
}

export function notesFollowup(scope: Scope, period: Period | null, limit = 6): NotesFollowup {
  const sessionIds = effectiveSessions(scope);
  const counts = { created: 0, resolved: 0 };
  if (period) {
    const p: unknown[] = [];
    const sw = sessionClause(scope, 'ct.session_id', p);
    const row = get<{ created: number; resolved: number }>(
      `SELECT SUM(CASE WHEN n.created_at >= ? AND n.created_at < ? THEN 1 ELSE 0 END) AS created,
              SUM(CASE WHEN n.done_at >= ? AND n.done_at < ? THEN 1 ELSE 0 END) AS resolved
         FROM contact_notes n JOIN contacts ct ON ct.id = n.contact_id WHERE n.deleted_at IS NULL AND ${sw}`,
      period.fromIso,
      period.toIso,
      period.fromIso,
      period.toIso,
      ...p,
    );
    counts.created = Number(row?.created ?? 0);
    counts.resolved = Number(row?.resolved ?? 0);
  }
  return {
    stats: noteStats({ sessionIds }),
    overdue: listAllNotes({ status: 'overdue', orderBy: 'due', sessionIds, limit }),
    today: listAllNotes({ status: 'today', orderBy: 'due', sessionIds, limit }),
    createdInPeriod: counts.created,
    resolvedInPeriod: counts.resolved,
  };
}

// ── Desempeño por usuario (reportes) ──────────────────────────────────────────

export interface UserPerformance {
  id: number;
  name: string;
  responses: number;
  chats: number;
  avgFirstResponseMin: number | null;
  notesCreated: number;
  notesResolved: number;
  notesOverdue: number;
}

/** Combina las respuestas por usuario con su trabajo sobre notas. */
export function userPerformance(scope: Scope, period: Period, attention: AttentionData): UserPerformance[] {
  const p: unknown[] = [];
  const sw = sessionClause(scope, 'ct.session_id', p);
  const notes = all<{ uid: number; created: number; resolved: number; overdue: number }>(
    `SELECT u.id AS uid,
            (SELECT COUNT(*) FROM contact_notes n JOIN contacts ct ON ct.id = n.contact_id
              WHERE n.deleted_at IS NULL AND n.user_id = u.id AND n.created_at >= ? AND n.created_at < ? AND ${sw}) AS created,
            (SELECT COUNT(*) FROM contact_notes n JOIN contacts ct ON ct.id = n.contact_id
              WHERE n.deleted_at IS NULL AND n.done_by = u.id AND n.done_at >= ? AND n.done_at < ? AND ${sw}) AS resolved,
            (SELECT COUNT(*) FROM contact_notes n JOIN contacts ct ON ct.id = n.contact_id
              WHERE n.deleted_at IS NULL AND n.user_id = u.id AND n.done_at IS NULL AND n.due_at < date('now','localtime') AND ${sw}) AS overdue
       FROM users u`,
    period.fromIso,
    period.toIso,
    ...p,
    period.fromIso,
    period.toIso,
    ...p,
    ...p,
  );
  const names = new Map(
    all<{ id: number; name: string | null; username: string | null }>('SELECT id, name, username FROM users').map((u) => [
      u.id,
      u.name ?? u.username ?? `Usuario ${u.id}`,
    ]),
  );
  const byResponder = new Map(attention.responders.map((r) => [r.key, r]));
  return notes
    .map((n) => {
      const r = byResponder.get(String(n.uid));
      return {
        id: n.uid,
        name: names.get(n.uid) ?? `Usuario ${n.uid}`,
        responses: r?.responses ?? 0,
        chats: r?.chats ?? 0,
        avgFirstResponseMin: r?.avgFirstResponseMin ?? null,
        notesCreated: Number(n.created ?? 0),
        notesResolved: Number(n.resolved ?? 0),
        notesOverdue: Number(n.overdue ?? 0),
      };
    })
    .filter((u) => u.responses || u.notesCreated || u.notesResolved || u.notesOverdue)
    .sort((a, b) => b.responses - a.responses || b.notesResolved - a.notesResolved);
}

// ── Números (sesiones) ────────────────────────────────────────────────────────

export interface SessionActivity {
  id: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  receivedToday: number;
  sentToday: number;
}

/** Última actividad y volumen de hoy por sesión (detecta números "sordos"). */
export function sessionActivity(scope: Scope): Map<string, SessionActivity> {
  const p: unknown[] = [];
  const startToday = parseYmd(ymd(new Date()))!.toISOString();
  const sw = sessionClause(scope, 'm.session_id', p);
  const rows = all<{ id: string; li: string | null; lo: string | null; rt: number; st: number }>(
    `SELECT m.session_id AS id,
            MAX(CASE WHEN m.direction = 'in' THEN m.occurred_at END) AS li,
            MAX(CASE WHEN m.direction = 'out' THEN m.occurred_at END) AS lo,
            SUM(CASE WHEN m.direction = 'in' AND m.occurred_at >= ? THEN 1 ELSE 0 END) AS rt,
            SUM(CASE WHEN m.direction = 'out' AND m.occurred_at >= ? THEN 1 ELSE 0 END) AS st
       FROM messages m WHERE ${sw} GROUP BY m.session_id`,
    startToday,
    startToday,
    ...p,
  );
  return new Map(
    rows.map((r) => [r.id, { id: r.id, lastInboundAt: r.li, lastOutboundAt: r.lo, receivedToday: Number(r.rt ?? 0), sentToday: Number(r.st ?? 0) }]),
  );
}

export interface DeliveryStats {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  rate: number | null;
  readRate: number | null;
}

/**
 * Entregabilidad de los mensajes que envió el SISTEMA en el período (panel,
 * lotes, cronogramas, API). Los escritos desde el teléfono o recuperados del
 * historial no reciben acuse en el gateway y la distorsionarían.
 */
export function deliveryStats(scope: Scope, period: Period): DeliveryStats {
  const p: unknown[] = [period.fromIso, period.toIso];
  const sw = sessionClause(scope, 'm.session_id', p);
  const r = get<{ sent: number; delivered: number; read: number; failed: number }>(
    `SELECT COUNT(*) AS sent,
            SUM(CASE WHEN m.status IN ('delivered','read','played') THEN 1 ELSE 0 END) AS delivered,
            SUM(CASE WHEN m.status IN ('read','played') THEN 1 ELSE 0 END) AS read,
            SUM(CASE WHEN m.status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM messages m
      WHERE m.direction = 'out' AND COALESCE(m.origin, '') <> 'phone'
        AND m.occurred_at >= ? AND m.occurred_at < ? AND ${sw}`,
    ...p,
  );
  const sent = Number(r?.sent ?? 0);
  const delivered = Number(r?.delivered ?? 0);
  const read = Number(r?.read ?? 0);
  return {
    sent,
    delivered,
    read,
    failed: Number(r?.failed ?? 0),
    rate: sent ? Math.round((delivered / sent) * 100) : null,
    readRate: sent ? Math.round((read / sent) * 100) : null,
  };
}

/** Minutos en texto corto: "12 min", "3 h 05 min", "2 d 4 h". */
export function fmtMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return '—';
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}

/** Período inmediatamente anterior y de la misma duración (para comparar). */
export function previousPeriod(p: Period): Period {
  const start = parseYmd(p.from)!;
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(p.days - 1));
  return {
    preset: 'custom',
    from: ymd(prevStart),
    to: ymd(prevEnd),
    fromIso: prevStart.toISOString(),
    toIso: addDays(prevEnd, 1).toISOString(),
    label: `${prevStart.toLocaleDateString('es-BO')} – ${prevEnd.toLocaleDateString('es-BO')}`,
    days: p.days,
  };
}

export interface ProtectionStats {
  /** Destinatarios que los lotes omitieron, por motivo. */
  skipped: Array<{ key: string; label: string; count: number }>;
  skippedTotal: number;
  /** Lotes pausados por el motor en el período. */
  pausedBatches: number;
  /** Bloqueos y pedidos de baja originados en las líneas del alcance. */
  blocks: number;
  optouts: number;
}

const SKIP_REASONS: Array<{ key: string; label: string; match: RegExp }> = [
  { key: 'optout', label: 'En la lista negra (baja o bloqueo)', match: /lista de no enviar|opt-out|bloquead/i },
  { key: 'recent', label: 'Recibió otra campaña hace poco', match: /envío masivo hace/i },
  { key: 'unanswered', label: 'Demasiados mensajes sin respuesta', match: /sin responder/i },
  { key: 'nowa', label: 'El número no tiene WhatsApp', match: /no tiene WhatsApp/i },
  { key: 'duplicate', label: 'Duplicado o ya enviado', match: /duplicad|ya enviad|repetid/i },
];

/**
 * Lo que frenó la protección anti-baneo en el período: destinatarios omitidos
 * por los lotes (con su motivo), lotes pausados y bloqueos/bajas.
 */
export function protectionStats(scope: Scope, period: Period): ProtectionStats {
  const p: unknown[] = [period.fromIso, period.toIso];
  const sw = sessionClause(scope, 'b.session_id', p);
  const rows = all<{ error: string | null; c: number }>(
    `SELECT bi.error, COUNT(*) AS c FROM batch_items bi JOIN batches b ON b.id = bi.batch_id
      WHERE bi.status = 'skipped' AND bi.updated_at >= ? AND bi.updated_at < ? AND ${sw}
      GROUP BY bi.error`,
    ...p,
  );
  const counts = new Map<string, number>();
  let other = 0;
  for (const r of rows) {
    const reason = SKIP_REASONS.find((x) => x.match.test(r.error ?? ''));
    if (reason) counts.set(reason.key, (counts.get(reason.key) ?? 0) + Number(r.c));
    else other += Number(r.c);
  }
  const skipped = SKIP_REASONS.map((x) => ({ key: x.key, label: x.label, count: counts.get(x.key) ?? 0 })).filter((x) => x.count);
  if (other) skipped.push({ key: 'other', label: 'Otros motivos', count: other });

  const ids = effectiveSessions(scope);
  const auditRows = all<{ context: string | null }>(
    "SELECT context FROM audit_logs WHERE action = 'batch.paused' AND created_at >= ? AND created_at < ?",
    period.fromIso,
    period.toIso,
  );
  let pausedBatches = auditRows.length;
  if (ids !== null) {
    // batch.paused guarda el lote: se filtra por la línea del lote.
    const allowed = new Set(ids);
    pausedBatches = auditRows.filter((r) => {
      try {
        const id = Number((JSON.parse(r.context ?? '{}') as { batch_id?: number }).batch_id);
        const b = get<{ session_id: string | null }>('SELECT session_id FROM batches WHERE id = ?', id);
        return !!b?.session_id && allowed.has(b.session_id);
      } catch {
        return false;
      }
    }).length;
  }

  const op: unknown[] = [period.fromIso, period.toIso];
  const osw = sessionClause(scope, 'o.session_id', op);
  const o = get<{ blocks: number; optouts: number }>(
    `SELECT SUM(CASE WHEN o.source = 'blocked' THEN 1 ELSE 0 END) AS blocks,
            SUM(CASE WHEN o.source = 'reply' THEN 1 ELSE 0 END) AS optouts
       FROM optouts o WHERE o.created_at >= ? AND o.created_at < ? AND ${osw}`,
    ...op,
  );
  return {
    skipped,
    skippedTotal: skipped.reduce((a, x) => a + x.count, 0),
    pausedBatches,
    blocks: Number(o?.blocks ?? 0),
    optouts: Number(o?.optouts ?? 0),
  };
}
