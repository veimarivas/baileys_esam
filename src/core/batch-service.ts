import { get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { recount } from './batches.js';
import { renderTemplate, getTemplate, resolveTemplate, MissingTemplateVariableError } from './templates.js';
import { storeMedia, type StoredMedia } from './media.js';
import { audit } from './webhooks.js';
import type { BatchRunner } from './batches.js';

export interface BatchItemInput {
  chat_id: string;
  contact_name?: string | null;
  variables?: Record<string, unknown>;
  body_override?: string | null;
  external_ref?: string | null;
  media?: { base64?: string; mimetype?: string; filename?: string; content_type?: string } | null;
}

export interface CreateBatchOptions {
  sessionId: string;
  name: string;
  category?: string | null;
  templateId?: number | null;
  items: BatchItemInput[];
  defaultMedia?: { base64?: string; mimetype?: string; filename?: string; content_type?: string } | null;
  meta?: Record<string, unknown>;
  dryRun?: boolean;
  scheduledAt?: string | null;
  /** Reenvío intencional: no descarta lo ya enviado con la misma referencia. */
  allowResend?: boolean;
}

export interface CreateBatchResult {
  batchId: number | null;
  total: number;
  skipped: number;
  dryRun: boolean;
}

/**
 * Crea un lote (con resolución de plantilla, media e idempotencia por
 * `external_ref`) y lo encola en el runner. Reutilizado por la API v1, el panel
 * y la importación CSV.
 */
export function createBatch(opts: CreateBatchOptions, runner: BatchRunner): CreateBatchResult {
  let defaultMedia: StoredMedia | null = null;
  if (opts.defaultMedia?.base64) defaultMedia = storeMedia(opts.defaultMedia);

  let template = opts.templateId ? getTemplate(opts.templateId) : undefined;
  if (!template && opts.category) {
    const keys = Object.keys(opts.items[0]?.variables ?? {});
    template = resolveTemplate(opts.category, keys);
  }

  const prepared: Array<{
    chat_id: string;
    name: string | null;
    body: string | null;
    external_ref: string | null;
    content_type: string | null;
    media_path: string | null;
    media_mime: string | null;
  }> = [];
  const seenRefs = new Set<string>();
  let skipped = 0;

  for (const item of opts.items) {
    const chatId = String(item.chat_id ?? '');
    let ref = item.external_ref ? String(item.external_ref) : null;
    // Reenvío intencional: referencia nueva para no chocar con la del envío anterior.
    if (ref && opts.allowResend && runCheck(ref)) ref = `${ref}:r${Date.now()}`;

    if (ref) {
      const exists = runCheck(ref);
      if (seenRefs.has(ref) || exists) {
        skipped++;
        continue;
      }
      seenRefs.add(ref);
    }

    let media = defaultMedia;
    if (item.media?.base64) media = storeMedia(item.media);

    let text: string | null = null;
    try {
      text = item.body_override
        ? String(item.body_override)
        : template
          ? renderTemplate(template.body, item.variables ?? {})
          : null;
    } catch (err) {
      if (err instanceof MissingTemplateVariableError) throw err;
      throw err;
    }

    if (!text && !media) {
      throw new Error(`El destinatario ${chatId} no tiene mensaje ni media.`);
    }

    prepared.push({
      chat_id: chatId,
      name: item.contact_name ?? null,
      body: text,
      external_ref: ref,
      content_type: media?.content_type ?? null,
      media_path: media?.path ?? null,
      media_mime: media?.mime ?? null,
    });
  }

  if (opts.dryRun) return { batchId: null, total: prepared.length, skipped, dryRun: true };
  if (prepared.length === 0) return { batchId: null, total: 0, skipped, dryRun: false };

  const meta = { ...(opts.meta ?? {}) };
  const scheduled = opts.scheduledAt && new Date(opts.scheduledAt).getTime() > Date.now();
  const created = run(
    `INSERT INTO batches (session_id, name, total, status, meta, scheduled_at, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    opts.sessionId,
    opts.name.slice(0, 120),
    prepared.length,
    scheduled ? 'scheduled' : 'running',
    JSON.stringify(meta),
    scheduled ? new Date(opts.scheduledAt!).toISOString() : null,
    scheduled ? null : nowIso(),
    nowIso(),
    nowIso(),
  );
  const batchId = created.lastInsertRowid;

  for (const p of prepared) {
    run(
      `INSERT INTO batch_items (batch_id, chat_id, contact_name, body, content_type, media_path, media_mime, external_ref, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      batchId,
      p.chat_id,
      p.name,
      p.body,
      p.content_type,
      p.media_path,
      p.media_mime,
      p.external_ref,
      nowIso(),
      nowIso(),
    );
  }

  if (!scheduled) runner.enqueue(batchId);
  audit('batch.created', { batch_id: batchId, total: prepared.length, source: meta.source ?? 'panel' });
  recount(batchId);

  return { batchId, total: prepared.length, skipped, dryRun: false };
}

function runCheck(ref: string): boolean {
  return !!(get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM batch_items WHERE external_ref = ? AND status IN ('pending','sent')",
    ref,
  )?.c);
}
