import type express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { all, get } from '../db/index.js';
import { esamPuede, reportsScopeFor, type UserRow } from '../auth/users.js';
import {
  attentionData,
  deliveryStats,
  notesFollowup,
  pendingReplies,
  previousPeriod,
  protectionStats,
  resolvePeriod,
  userPerformance,
  type Scope,
} from '../core/followup.js';
import { massActivity } from '../core/mass-activity.js';
import { batchEngagement, REPLY_KIND_LABEL, summarizeEngagement } from '../core/batch-engagement.js';
import { batchOrigin, batchType, safeMeta } from './batches-view.js';

/**
 * API de la app móvil para Seguimiento y Reportes y para Lotes (en el panel
 * son páginas HTML). Mismos permisos y alcance que la web: Reportes y Lotes
 * son del Super Admin; cada respuesta es JSON listo para mostrar.
 */

type AuthedRequest = Request & { user?: UserRow };
type Mw = (req: AuthedRequest, res: Response, next: NextFunction) => void;

const SECTIONS = ['conversations', 'settings', 'monitoring', 'reports', 'batches', 'policies'];

/** Secciones que el usuario puede abrir (la app muestra solo esas pestañas). */
export function mobileSections(user: UserRow): string[] {
  return SECTIONS.filter((s) => esamPuede(user, s));
}

const nameOf = (meta: Record<string, any>, requester: string | null) => String(meta.solicitado_por ?? requester ?? (meta.source === 'panel' ? 'Panel' : '—'));

export function registerMobileApi(app: express.Express, ctx: { requireUser: Mw; requireSection: (s: string) => Mw }): void {
  const scopeOf = (req: AuthedRequest): Scope => ({ sessionIds: reportsScopeFor(req.user!), sessionId: null });

  // Seguimiento y Reportes: resumen del período.
  app.get('/api/mobile/followup', ctx.requireUser, ctx.requireSection('reports'), (req: AuthedRequest, res: Response) => {
    const scope = scopeOf(req);
    const period = resolvePeriod({ period: String(req.query.period ?? '') }, '7d');
    const prev = previousPeriod(period);
    const att = attentionData(scope, period);
    const prevAtt = attentionData(scope, prev);
    const notes = notesFollowup(scope, period, 8);
    const pending = pendingReplies(scope, { limit: 30 });
    const mass = massActivity(scope.sessionIds, period);
    const pickNote = (n: (typeof notes.overdue)[number]) => ({
      id: n.id,
      text: (n.note_text ?? 'Nota de voz').slice(0, 200),
      due_at: n.due_at,
      due_time: n.due_time,
      contact: n.contact_name ?? (n.contact_phone ? `+${n.contact_phone}` : n.chat_id.split('@')[0]),
      assigned: n.assigned_name ?? null,
      session_id: n.session_id,
      chat_id: n.chat_id,
    });
    res.json({
      period: { preset: period.preset, label: period.label, from: period.from, to: period.to },
      attention: {
        received: att.received,
        received_chats: att.receivedChats,
        sent: att.sent,
        attended_chats: att.attendedChats,
        new_chats: att.newChats,
        episodes: att.episodes,
        answered: att.answered,
        median_min: att.medianMin,
        within15: att.within15,
        within60: att.within60,
        by_day: att.byDay,
        responders: att.responders.slice(0, 12),
      },
      previous: { received: prevAtt.received, answered: prevAtt.answered, median_min: prevAtt.medianMin, episodes: prevAtt.episodes },
      delivery: deliveryStats(scope, period),
      protection: protectionStats(scope, period),
      notes: {
        stats: notes.stats,
        created: notes.createdInPeriod,
        resolved: notes.resolvedInPeriod,
        overdue: notes.overdue.map(pickNote),
        today: notes.today.map(pickNote),
      },
      users: userPerformance(scope, period, att).filter((u) => u.responses || u.notesCreated || u.notesResolved || u.notesOverdue),
      pending: { total: pending.total, rows: pending.rows },
      mass: {
        totals: mass.totals,
        by_tipo: mass.byTipo,
        requesters: mass.requesters.map((r) => ({
          key: r.key, name: r.name, area: r.area, batches: r.batches, messages: r.messages, sent: r.sent, failed: r.failed,
          tracked: r.tracked, read: r.read, replied: r.replied, days_active: r.daysActive, avg_per_day: r.avgPerDay, last_at: r.lastAt,
        })),
      },
    });
  });

  // Lotes: los últimos con su progreso y lectura/respuestas.
  app.get('/api/mobile/batches', ctx.requireUser, ctx.requireSection('batches'), (req: AuthedRequest, res: Response) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 60) || 60));
    const rows = all<{
      id: number; name: string | null; status: string; total: number; sent: number; failed: number; skipped: number;
      meta: string | null; created_at: string; started_at: string | null; finished_at: string | null; scheduled_at: string | null;
      line_owner: string | null; line_name: string | null; line_phone: string | null;
    }>(
      `SELECT b.id, b.name, b.status, b.total, b.sent, b.failed, b.skipped, b.meta, b.created_at, b.started_at, b.finished_at, b.scheduled_at,
              s.owner_name AS line_owner, s.name AS line_name, COALESCE(s.phone, s.expected_phone) AS line_phone
         FROM batches b LEFT JOIN sessions s ON s.id = b.session_id ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
      limit,
    );
    res.json({
      batches: rows.map((b) => {
        const meta = safeMeta(b.meta);
        const eng = b.sent > 0 ? summarizeEngagement(batchEngagement(b.id).values()) : null;
        return {
          id: b.id,
          name: b.name ?? `Lote #${b.id}`,
          status: b.status,
          total: b.total,
          sent: b.sent,
          failed: b.failed,
          skipped: b.skipped,
          created_at: b.created_at,
          scheduled_at: b.scheduled_at && !String(b.scheduled_at).startsWith('9999') ? b.scheduled_at : null,
          tipo: batchType(meta) || null,
          origen: batchOrigin(meta),
          programa: meta.programa ? String(meta.programa) : null,
          requester: nameOf(meta, null),
          line: { phone: b.line_phone, owner: b.line_owner ?? b.line_name },
          paused_reason: b.status === 'paused' ? meta.anti_ban_pause ?? null : null,
          engagement: eng && { read_rate: eng.readRate, replied: eng.replied, tracked: eng.tracked },
        };
      }),
    });
  });

  // Detalle de un lote: ficha, mensaje, lectura y respuestas, y cada destinatario.
  app.get('/api/mobile/batches/:id', ctx.requireUser, ctx.requireSection('batches'), (req: AuthedRequest, res: Response) => {
    const id = Number(req.params.id);
    const b = get<{
      id: number; name: string | null; status: string; total: number; sent: number; failed: number; skipped: number; meta: string | null;
      created_at: string; started_at: string | null; finished_at: string | null; line_owner: string | null; line_name: string | null; line_phone: string | null;
    }>(
      `SELECT b.*, s.owner_name AS line_owner, s.name AS line_name, COALESCE(s.phone, s.expected_phone) AS line_phone
         FROM batches b LEFT JOIN sessions s ON s.id = b.session_id WHERE b.id = ?`,
      id,
    );
    if (!b) {
      res.status(404).json({ error: 'Lote no encontrado.' });
      return;
    }
    const meta = safeMeta(b.meta);
    const items = all<{ id: number; chat_id: string; contact_name: string | null; body: string | null; status: string; error: string | null; updated_at: string | null }>(
      'SELECT id, chat_id, contact_name, body, status, error, updated_at FROM batch_items WHERE batch_id = ? ORDER BY id LIMIT 2000',
      id,
    );
    const eng = batchEngagement(id);
    const sum = summarizeEngagement(eng.values());
    const sample = items.find((i) => i.body)?.body ?? null;
    res.json({
      batch: {
        id: b.id,
        name: b.name ?? `Lote #${b.id}`,
        status: b.status,
        total: b.total,
        sent: b.sent,
        failed: b.failed,
        skipped: b.skipped,
        created_at: b.created_at,
        started_at: b.started_at,
        finished_at: b.finished_at,
        tipo: batchType(meta) || null,
        modo: meta.modo ? String(meta.modo) : null,
        origen: batchOrigin(meta),
        area: meta.area ? String(meta.area) : null,
        programa: meta.programa ? String(meta.programa) : null,
        requester: nameOf(meta, null),
        line: { phone: b.line_phone, owner: b.line_owner ?? b.line_name },
        paused_reason: b.status === 'paused' ? meta.anti_ban_pause ?? null : null,
        sample,
      },
      engagement: {
        sent: sum.sent,
        tracked: sum.tracked,
        delivered: sum.delivered,
        read: sum.read,
        replied: sum.replied,
        delivered_rate: sum.deliveredRate,
        read_rate: sum.readRate,
        reply_rate: sum.replyRate,
        median_reply_min: sum.medianReplyMinutes,
        kinds: Object.entries(sum.kinds)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => ({ kind: k, label: REPLY_KIND_LABEL[k as keyof typeof REPLY_KIND_LABEL], count: n })),
      },
      items: items.map((it) => {
        const e = eng.get(it.id);
        const r = e?.reply ?? null;
        return {
          id: it.id,
          chat_id: it.chat_id,
          name: it.contact_name,
          phone: it.chat_id.replace(/@.*$/, ''),
          status: it.status,
          error: it.error,
          at: it.status === 'sent' ? it.updated_at : null,
          ack: r && e?.ack !== 'read' ? 'read' : e?.ack ?? null,
          reply: r && {
            kind: r.kind,
            label: REPLY_KIND_LABEL[r.kind],
            text: r.body ?? (r.contentType === 'text' ? '' : `(${r.contentType})`),
            minutes: r.minutes,
          },
        };
      }),
    });
  });
}
