import { all } from '../db/index.js';
import type { Period } from './followup.js';

/**
 * Actividad de envíos masivos: quién pide los lotes, cuántas veces por día,
 * cuántos mensajes lleva cada uno y cómo terminaron. Base de la pestaña
 * «Envíos masivos» de /reports.
 *
 * La persona que pide el lote sale del `meta` del lote: `solicitado_por_id`
 * (usuario de cronogramas) / `solicitado_por`, o `account` (dueño de la línea en
 * la integración). Los recordatorios automáticos y los del panel se agrupan
 * aparte para no confundirlos con una persona.
 */

export interface MassBatch {
  id: number;
  name: string;
  status: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Día local (AAAA-MM-DD) y hora local (HH:MM) del pedido. */
  day: string;
  time: string;
  durationMs: number | null;
  linePhone: string | null;
  lineOwner: string | null;
  programa: string | null;
  tipo: string | null;
  origen: string;
  requesterKey: string;
  requesterName: string;
  area: string | null;
}

export interface MassRequester {
  key: string;
  name: string;
  area: string | null;
  batches: number;
  messages: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
  daysActive: number;
  /** Promedio de lotes por día con actividad. */
  avgPerDay: number;
  maxPerDay: number;
  maxDay: string | null;
  avgPerBatch: number;
  maxPerBatch: number;
  lines: string[];
  programas: string[];
  firstAt: string | null;
  lastAt: string | null;
  /** Lotes y mensajes por día (AAAA-MM-DD). */
  byDay: Record<string, { batches: number; messages: number }>;
}

export interface MassActivity {
  batches: MassBatch[];
  requesters: MassRequester[];
  days: string[];
  totals: {
    batches: number;
    messages: number;
    sent: number;
    failed: number;
    requesters: number;
    daysActive: number;
    busiestDay: { day: string; batches: number; messages: number } | null;
  };
}

interface Row {
  id: number;
  name: string | null;
  status: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  meta: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  line_phone: string | null;
  line_owner: string | null;
  line_name: string | null;
}

function parseMeta(raw: string | null): Record<string, any> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, any>) : {};
  } catch {
    return {};
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function origin(meta: Record<string, any>): string {
  if (meta.origen === 'recordatorio_automatico') return 'Recordatorio automático';
  if (meta.origen_sistema === 'cronogramas' || meta.source === 'integration') return 'Cronogramas';
  if (meta.source === 'csv') return 'Importación CSV';
  return 'Panel';
}

/** Lotes del período (por fecha de pedido) en las líneas del alcance. */
export function massActivity(scope: string[] | null, period: Pick<Period, 'fromIso' | 'toIso'>): MassActivity {
  if (scope && scope.length === 0) {
    return { batches: [], requesters: [], days: [], totals: { batches: 0, messages: 0, sent: 0, failed: 0, requesters: 0, daysActive: 0, busiestDay: null } };
  }
  const where = ['b.created_at >= ?', 'b.created_at < ?'];
  const params: unknown[] = [period.fromIso, period.toIso];
  if (scope) {
    where.push(`b.session_id IN (${scope.map(() => '?').join(',')})`);
    params.push(...scope);
  }
  const rows = all<Row>(
    `SELECT b.id, b.name, b.status, b.total, b.sent, b.failed, b.skipped, b.meta, b.created_at, b.started_at, b.finished_at,
            COALESCE(s.phone, s.expected_phone) AS line_phone, s.owner_name AS line_owner, s.name AS line_name
       FROM batches b LEFT JOIN sessions s ON s.id = b.session_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.created_at DESC, b.id DESC`,
    ...params,
  );

  // Nombres de quienes piden por cuenta (owner_uid de la integración).
  const users = new Map(
    all<{ source_uid: string | null; name: string | null; username: string | null; esam_area: string | null }>(
      'SELECT source_uid, name, username, esam_area FROM users WHERE source_uid IS NOT NULL',
    ).map((u) => [String(u.source_uid), u]),
  );

  const batches: MassBatch[] = rows.map((r) => {
    const meta = parseMeta(r.meta);
    const created = new Date(r.created_at);
    const org = origin(meta);
    const uid = meta.solicitado_por_id != null ? String(meta.solicitado_por_id) : meta.account != null ? String(meta.account) : null;
    const u = uid ? users.get(uid) : undefined;
    let key: string;
    let name: string;
    if (org === 'Recordatorio automático') {
      key = 'auto';
      name = 'Recordatorios automáticos';
    } else if (uid || meta.solicitado_por) {
      key = uid ? `u:${uid}` : `n:${String(meta.solicitado_por).toLowerCase()}`;
      name = String(meta.solicitado_por ?? u?.name ?? u?.username ?? `Usuario ${uid}`);
    } else {
      key = org === 'Panel' || org === 'Importación CSV' ? 'panel' : 'sys';
      name = org === 'Panel' || org === 'Importación CSV' ? 'Panel / CSV' : 'Sin identificar';
    }
    const start = r.started_at ? new Date(r.started_at).getTime() : null;
    const end = r.finished_at ? new Date(r.finished_at).getTime() : null;
    return {
      id: r.id,
      name: r.name ?? `Lote #${r.id}`,
      status: r.status,
      total: Number(r.total) || 0,
      sent: Number(r.sent) || 0,
      failed: Number(r.failed) || 0,
      skipped: Number(r.skipped) || 0,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      day: localDay(created),
      time: localTime(created),
      durationMs: start && end && end >= start ? end - start : null,
      linePhone: r.line_phone,
      lineOwner: r.line_owner ?? r.line_name,
      programa: meta.programa ? String(meta.programa) : null,
      tipo: meta.tipo ? String(meta.tipo) : meta.category ? String(meta.category) : null,
      origen: org,
      requesterKey: key,
      requesterName: name,
      area: meta.area ? String(meta.area) : u?.esam_area ?? null,
    };
  });

  const map = new Map<string, MassRequester>();
  for (const b of batches) {
    let r = map.get(b.requesterKey);
    if (!r) {
      r = {
        key: b.requesterKey, name: b.requesterName, area: b.area, batches: 0, messages: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0,
        daysActive: 0, avgPerDay: 0, maxPerDay: 0, maxDay: null, avgPerBatch: 0, maxPerBatch: 0, lines: [], programas: [],
        firstAt: null, lastAt: null, byDay: {},
      };
      map.set(b.requesterKey, r);
    }
    r.batches++;
    r.messages += b.total;
    r.sent += b.sent;
    r.failed += b.failed;
    r.skipped += b.skipped;
    if (b.status === 'cancelled') r.cancelled++;
    r.maxPerBatch = Math.max(r.maxPerBatch, b.total);
    if (!r.area && b.area) r.area = b.area;
    const line = b.linePhone ? `${b.linePhone}${b.lineOwner ? ` · ${b.lineOwner}` : ''}` : null;
    if (line && !r.lines.includes(line)) r.lines.push(line);
    if (b.programa && !r.programas.includes(b.programa)) r.programas.push(b.programa);
    if (!r.firstAt || b.createdAt < r.firstAt) r.firstAt = b.createdAt;
    if (!r.lastAt || b.createdAt > r.lastAt) r.lastAt = b.createdAt;
    const d = (r.byDay[b.day] ??= { batches: 0, messages: 0 });
    d.batches++;
    d.messages += b.total;
  }
  const requesters = [...map.values()].map((r) => {
    const days = Object.entries(r.byDay);
    r.daysActive = days.length;
    const top = days.sort((x, y) => y[1].batches - x[1].batches || y[1].messages - x[1].messages)[0];
    r.maxPerDay = top ? top[1].batches : 0;
    r.maxDay = top ? top[0] : null;
    r.avgPerDay = r.daysActive ? Math.round((r.batches / r.daysActive) * 10) / 10 : 0;
    r.avgPerBatch = r.batches ? Math.round(r.messages / r.batches) : 0;
    return r;
  }).sort((x, y) => y.batches - x.batches || y.messages - x.messages || x.name.localeCompare(y.name));

  const byDay = new Map<string, { batches: number; messages: number }>();
  for (const b of batches) {
    const d = byDay.get(b.day) ?? { batches: 0, messages: 0 };
    d.batches++;
    d.messages += b.total;
    byDay.set(b.day, d);
  }
  const busiest = [...byDay.entries()].sort((x, y) => y[1].batches - x[1].batches || y[1].messages - x[1].messages)[0];

  return {
    batches,
    requesters,
    days: [...byDay.keys()].sort().reverse(),
    totals: {
      batches: batches.length,
      messages: batches.reduce((s, b) => s + b.total, 0),
      sent: batches.reduce((s, b) => s + b.sent, 0),
      failed: batches.reduce((s, b) => s + b.failed, 0),
      requesters: requesters.length,
      daysActive: byDay.size,
      busiestDay: busiest ? { day: busiest[0], ...busiest[1] } : null,
    },
  };
}

/** CSV de la actividad de envíos masivos (resumen por persona + registro de lotes). */
export function massActivityCsv(a: MassActivity, label: string): string {
  const q = (x: unknown) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const local = (iso: string | null) => (iso ? `${localDay(new Date(iso))} ${localTime(new Date(iso))}` : '');
  const lines: string[] = [q(`Envíos masivos · ${label}`), ''];
  lines.push(['Persona', 'Área', 'Lotes', 'Días con envíos', 'Lotes por día (prom.)', 'Máx. lotes en un día', 'Día con más lotes', 'Mensajes', 'Enviados', 'Fallidos', 'Mensajes por lote (prom.)', 'Lote más grande', 'Cancelados', 'Líneas', 'Último envío'].map(q).join(','));
  for (const r of a.requesters) {
    lines.push([r.name, r.area ?? '', r.batches, r.daysActive, r.avgPerDay, r.maxPerDay, r.maxDay ?? '', r.messages, r.sent, r.failed, r.avgPerBatch, r.maxPerBatch, r.cancelled, r.lines.join(' | '), local(r.lastAt)].map(q).join(','));
  }
  lines.push('');
  lines.push(['Día', 'Hora', 'Lote', 'Nombre', 'Persona', 'Línea', 'Programa', 'Tipo', 'Origen', 'Estado', 'Mensajes', 'Enviados', 'Fallidos', 'Omitidos', 'Duración (min)'].map(q).join(','));
  for (const b of a.batches) {
    lines.push([b.day, b.time, b.id, b.name, b.requesterName, `${b.linePhone ?? ''} ${b.lineOwner ?? ''}`.trim(), b.programa ?? '', b.tipo ?? '', b.origen, b.status, b.total, b.sent, b.failed, b.skipped,
      b.durationMs != null ? Math.round(b.durationMs / 60000) : ''].map(q).join(','));
  }
  return '﻿' + lines.join('\r\n');
}
