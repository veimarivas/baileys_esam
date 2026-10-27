import { all } from '../db/index.js';

/**
 * Historial de envíos del sistema a una persona: cada mensaje que le llegó por
 * un lote (cobranzas, notas, asistencias, avisos del programa, marketing),
 * desde qué línea, quién lo pidió y si lo recibió (acuse de WhatsApp).
 *
 * Sirve para supervisar que el participante reciba la información básica de
 * los responsables académicos y de contabilidad. Se busca por número en todas
 * las líneas, igual que las notas de la persona.
 */

export type SendCategory = 'cobranza' | 'notas' | 'asistencia' | 'programa' | 'marketing' | 'otros';
export type SendArea = 'contabilidad' | 'academico' | 'marketing' | 'otros';

export interface PersonSend {
  id: number;
  batchId: number;
  batchName: string;
  category: SendCategory;
  area: SendArea;
  /** Título legible: «Cuotas vencidas», «Notas del módulo», «Inasistencia»… */
  title: string;
  programa: string | null;
  modulo: string | null;
  detail: string | null;
  sender: string;
  automatic: boolean;
  linePhone: string | null;
  lineOwner: string | null;
  body: string | null;
  contentType: string | null;
  /** pending | sent | failed | skipped | cancelled */
  status: string;
  /** Acuse de WhatsApp del mensaje enviado: sent | delivered | read | played. */
  ack: string | null;
  error: string | null;
  at: string;
}

export interface AreaSummary {
  area: SendArea;
  total: number;
  received: number;
  failed: number;
  lastAt: string | null;
  lastTitle: string | null;
  lastSender: string | null;
}

export interface PersonSends {
  key: string | null;
  items: PersonSend[];
  areas: AreaSummary[];
  byCategory: Record<SendCategory, number>;
}

interface Row {
  id: number;
  body: string | null;
  content_type: string | null;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string | null;
  batch_id: number;
  batch_name: string | null;
  meta: string | null;
  owner_name: string | null;
  line_phone: string | null;
  ack: string | null;
}

function parseMeta(raw: string | null): Record<string, any> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, any>) : {};
  } catch {
    return {};
  }
}

const AREA_OF: Record<string, SendArea> = { contabilidad: 'contabilidad', academico: 'academico', marketing: 'marketing' };

/** Categoría, área y título de un lote según lo que mandó cronogramas en su `meta`. */
export function classifySend(meta: Record<string, any>): { category: SendCategory; area: SendArea; title: string; automatic: boolean } {
  const tipo = String(meta.tipo ?? meta.category ?? '').toLowerCase();
  const automatic = meta.origen === 'recordatorio_automatico';
  if (tipo === 'cobranza' || tipo === 'cuotas' || meta.category === 'cobranza') {
    const modo = String(meta.modo ?? '');
    const title = automatic
      ? 'Recordatorio automático de cuotas'
      : modo === 'vencidas' ? 'Cuotas vencidas' : modo === 'proximas' ? 'Cuotas próximas a vencer' : 'Cobranza';
    return { category: 'cobranza', area: 'contabilidad', title, automatic };
  }
  if (tipo === 'notas') return { category: 'notas', area: 'academico', title: 'Notas del módulo', automatic };
  if (tipo === 'asistencia') return { category: 'asistencia', area: 'academico', title: 'Aviso de inasistencia', automatic };
  if (tipo === 'prospectos') return { category: 'marketing', area: 'marketing', title: 'Mensaje de marketing', automatic };
  if (tipo === 'participantes' || tipo === 'grupo' || tipo === 'grupos' || tipo === 'academico' || meta.category === 'academico') {
    const area = AREA_OF[String(meta.area ?? '')] ?? 'academico';
    return { category: 'programa', area, title: 'Mensaje del programa', automatic };
  }
  return { category: 'otros', area: AREA_OF[String(meta.area ?? '')] ?? 'otros', title: 'Envío del sistema', automatic };
}

/** Envíos por lote a un número (clave de teléfono con 591), del más nuevo al más viejo. */
export function personSends(phoneKey: string | null, limit = 300): PersonSends {
  const empty: PersonSends = {
    key: phoneKey, items: [], areas: [],
    byCategory: { cobranza: 0, notas: 0, asistencia: 0, programa: 0, marketing: 0, otros: 0 },
  };
  if (!phoneKey) return empty;
  const rows = all<Row>(
    `SELECT bi.id, bi.body, bi.content_type, bi.status, bi.error, bi.created_at, bi.updated_at,
            b.id AS batch_id, b.name AS batch_name, b.meta, s.owner_name, COALESCE(s.phone, s.expected_phone) AS line_phone,
            (SELECT m.status FROM messages m WHERE m.session_id = b.session_id AND m.wa_message_id = bi.message_id LIMIT 1) AS ack
       FROM batch_items bi
       JOIN batches b ON b.id = bi.batch_id
       LEFT JOIN sessions s ON s.id = b.session_id
      WHERE bi.chat_id IN (?, ?)
      ORDER BY COALESCE(bi.updated_at, bi.created_at) DESC, bi.id DESC
      LIMIT ?`,
    `${phoneKey}@c.us`,
    `${phoneKey}@s.whatsapp.net`,
    Math.min(Math.max(limit, 1), 1000),
  );

  // Quién pidió el envío: nombre que mandó cronogramas o el usuario de la cuenta.
  const users = new Map(
    all<{ source_uid: string; name: string | null; username: string | null }>(
      'SELECT source_uid, name, username FROM users WHERE source_uid IS NOT NULL',
    ).map((u) => [String(u.source_uid), u.name ?? u.username ?? null]),
  );

  const items: PersonSend[] = rows.map((r) => {
    const meta = parseMeta(r.meta);
    const c = classifySend(meta);
    const uid = meta.solicitado_por_id != null ? String(meta.solicitado_por_id) : meta.account != null ? String(meta.account) : null;
    const sender = c.automatic
      ? 'Envío automático'
      : String(meta.solicitado_por ?? (uid ? users.get(uid) : null) ?? r.owner_name ?? 'Sistema');
    const detail = c.category === 'asistencia' && meta.sesion ? `Sesión ${meta.sesion}` : meta.gestion ? `Gestión ${meta.gestion}` : null;
    return {
      id: r.id,
      batchId: r.batch_id,
      batchName: r.batch_name ?? `Lote #${r.batch_id}`,
      category: c.category,
      area: c.area,
      title: c.title,
      programa: meta.programa ? String(meta.programa) : null,
      modulo: meta.modulo ? String(meta.modulo) : null,
      detail,
      sender,
      automatic: c.automatic,
      linePhone: r.line_phone,
      lineOwner: r.owner_name,
      body: r.body,
      contentType: r.content_type,
      status: r.status,
      ack: r.status === 'sent' ? r.ack : null,
      error: r.error,
      at: r.status === 'pending' ? r.created_at : r.updated_at ?? r.created_at,
    };
  });

  const areas = (['contabilidad', 'academico', 'marketing', 'otros'] as SendArea[])
    .map((area) => {
      const list = items.filter((i) => i.area === area);
      const last = list.find((i) => i.status === 'sent') ?? list[0];
      return {
        area,
        total: list.length,
        received: list.filter((i) => i.status === 'sent').length,
        failed: list.filter((i) => i.status === 'failed').length,
        lastAt: last?.at ?? null,
        lastTitle: last?.title ?? null,
        lastSender: last?.sender ?? null,
      };
    })
    .filter((a) => a.total > 0 || a.area === 'contabilidad' || a.area === 'academico');

  const byCategory = { ...empty.byCategory };
  for (const i of items) byCategory[i.category]++;
  return { key: phoneKey, items, areas, byCategory };
}
