import express, { type Request, type Response, type NextFunction } from 'express';
import { config } from '../config.js';
import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { SessionManager } from '../baileys/manager.js';
import { BatchRunner, recount } from '../core/batches.js';
import { createBatch } from '../core/batch-service.js';
import { MissingTemplateVariableError } from '../core/templates.js';
import { extractInviteCode, normalizePhone } from '../core/phone.js';
import { getConfig, setConfig } from '../core/config-store.js';
import { importCsvToBatch } from '../core/csv.js';
import { statementPdf, boletinPdf } from '../core/pdf.js';
import { audit } from '../core/webhooks.js';
import { upsertUser, usernameAvailableFor } from '../auth/users.js';
import { logger } from '../logger.js';
import { countNewContactsToday, getPolicy, limitState } from '../core/anti-ban.js';
import { AWAITING, getGroup, markAwaiting, notifyGroup } from '../core/batch-confirm.js';
import { personChatsForNote } from '../core/contacts.js';
import { ProspectError, removeProspect, upsertProspect } from '../core/prospects.js';
import { panelBus } from '../panel/events.js';
import type { SessionRow } from '../types.js';

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function clientIp(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  return ip.replace('::ffff:', '');
}

function accountShape(row: SessionRow) {
  return {
    uid: row.owner_uid,
    name: row.owner_name,
    email: row.owner_email,
    area: row.area,
    session_name: row.name,
    session_id: row.id,
    status: row.status,
    phone: row.phone,
    expected_phone: row.expected_phone,
    verified: row.phone_verified_at !== null,
    blocked_reason: row.blocked_reason,
    last_error: row.last_error,
  };
}

/**
 * API de integración v1 — mismo contrato que `IntegrationController` de
 * openwa_basico, para que cronogramas la consuma sin cambios.
 */
export function createApiApp(manager: SessionManager, runner: BatchRunner) {
  const app = express();
  app.use(express.json({ limit: '64mb' }));

  // Seguridad: allowlist de IP + Bearer token.
  app.use((req, res, next) => {
    const ip = clientIp(req);
    if (config.integrationAllowedIps.length && !config.integrationAllowedIps.includes(ip)) {
      res.status(403).json({ message: `IP no autorizada: ${ip}` });
      return;
    }
    if (config.integrationToken) {
      const header = req.header('Authorization') ?? '';
      if (header !== `Bearer ${config.integrationToken}`) {
        res.status(401).json({ message: 'Token de integración inválido.' });
        return;
      }
    }
    next();
  });

  /**
   * Línea desde la que sale un envío masivo. Con `account` (usuario de
   * cronogramas) es SOLO la línea de ese usuario: nunca se cae a la de otro.
   * Sin `account`, solo la línea principal del sistema. Antes, si la línea
   * pedida no existía o la principal estaba desconectada, se usaba la primera
   * línea conectada de cualquier usuario y los mensajes salían desde números
   * ajenos.
   */
  const sessionFor = (account?: string | null): SessionRow | undefined => {
    if (account) return get<SessionRow>('SELECT * FROM sessions WHERE owner_uid = ?', account);
    return manager.primary();
  };

  /** La principal si está conectada; si no, la primera línea conectada. */
  const readyPrimary = (): SessionRow | undefined => {
    const primary = manager.primary();
    if (primary?.status === 'ready') return primary;
    return get<SessionRow>("SELECT * FROM sessions WHERE status = 'ready' ORDER BY created_at LIMIT 1") ?? primary;
  };

  /** Lote y línea desde la que ya salió hoy alguno de estos mensajes (para explicar el duplicado). */
  const duplicateInfo = (items: Array<{ external_ref?: string | null }>): { batchId: number; line: string } | null => {
    const ref = items.map((i) => i.external_ref).find((r) => !!r);
    if (!ref) return null;
    const row = get<{ batch_id: number; owner_name: string | null; phone: string | null; expected_phone: string | null; name: string }>(
      `SELECT bi.batch_id, s.owner_name, s.phone, s.expected_phone, s.name FROM batch_items bi
         JOIN batches b ON b.id = bi.batch_id LEFT JOIN sessions s ON s.id = b.session_id
        WHERE bi.external_ref = ? AND bi.status IN ('pending','sent') ORDER BY bi.id DESC LIMIT 1`,
      String(ref),
    );
    return row ? { batchId: row.batch_id, line: `${row.owner_name ?? row.name} · ${row.phone ?? row.expected_phone ?? '—'}` } : null;
  };

  /**
   * Sin línea conectada el lote quedaría esperando sin enviar nada: se avisa en
   * el acto (salvo envíos programados o de prueba). Devuelve el mensaje o null.
   */
  const notReadyMessage = (session: SessionRow, body: Record<string, unknown>): string | null => {
    if (session.status === 'ready' || body.dry_run || body.scheduled_at) return null;
    return body.account
      ? `Tu línea de WhatsApp (${session.expected_phone ?? session.phone ?? session.name}) no está conectada. Vinculala escaneando el QR en Seguimiento ESAM › Mi conexión y volvé a enviar.`
      : 'No hay ninguna línea de WhatsApp conectada en Seguimiento ESAM. Vinculá una en Conexión y volvé a enviar.';
  };

  /**
   * Sesión de un usuario por `owner_uid` o por número autorizado. NO cae a la
   * principal: permite distinguir "usuario sin sesión/número" del número global.
   */
  const sessionForUser = (uid?: string | null, phone?: string | null): SessionRow | undefined => {
    const clean = (v: string | null | undefined) => String(v ?? '').replace(/\D+/g, '');
    const numero = clean(phone);
    if (uid) {
      const byOwner = get<SessionRow>('SELECT * FROM sessions WHERE owner_uid = ?', String(uid));
      if (byOwner) return byOwner;
    }
    if (numero) {
      const rows = all<SessionRow>('SELECT * FROM sessions');
      return rows.find((s) => clean(s.expected_phone) === numero || clean(s.phone) === numero);
    }
    return undefined;
  };

  // ── Health ─────────────────────────────────────────────────────────────────

  app.get(
    '/api/v1/health',
    ah(async (req, res) => {
      const pending = get<{ c: number }>("SELECT COUNT(*) AS c FROM batch_items WHERE status = 'pending'")?.c ?? 0;
      const failed = get<{ c: number }>("SELECT COUNT(*) AS c FROM batch_items WHERE status = 'failed'")?.c ?? 0;

      // Con `uid`/`phone` se responde el estado de la sesión de ese usuario (una
      // por trabajador); sin ellos, el de la sesión principal (compatibilidad).
      const uid = req.query.uid ?? req.query.account;
      const phone = req.query.phone;
      const scoped = uid != null || phone != null;
      const row = scoped
        ? sessionForUser(uid != null ? String(uid) : null, phone != null ? String(phone) : null)
        : manager.primary();

      // Usuario con alcance pero sin sesión propia: no está conectado a WhatsApp.
      if (scoped && !row) {
        res.json({
          ok: true,
          app: 'baileys_esam',
          engine: 'baileys',
          session: {
            status: 'unlinked',
            connected: false,
            phone: null,
            expected_phone: phone ? String(phone) : null,
            verified: false,
          },
          queue: { pending, failed },
        });
        return;
      }

      res.json({
        ok: true,
        app: 'baileys_esam',
        engine: 'baileys',
        session: {
          status: row?.status ?? 'created',
          connected: row?.status === 'ready',
          phone: row?.phone ?? null,
          expected_phone: row?.expected_phone ?? (scoped ? null : getConfig('expected_phone')),
          verified: row?.phone_verified_at !== null && row?.phone_verified_at !== undefined,
        },
        queue: { pending, failed },
      });
    }),
  );

  // ── Número autorizado ──────────────────────────────────────────────────────

  app.get(
    '/api/v1/config/numero',
    ah(async (_req, res) => {
      const row = manager.primary();
      const expected = row?.expected_phone ?? getConfig('expected_phone');
      res.json({
        numero: expected,
        activo: row?.status === 'ready',
        expected_phone: expected,
        phone: row?.phone ?? null,
        verified: !!row?.phone_verified_at,
        connected: row?.status === 'ready',
      });
    }),
  );

  app.put(
    '/api/v1/config/numero',
    ah(async (req, res) => {
      const raw = req.body?.numero;
      const clean = (v: string | null | undefined) => String(v ?? '').replace(/\D+/g, '');
      if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
        const normalized = normalizePhone(String(raw));
        if (!normalized) {
          res.status(422).json({ message: 'Número inválido.' });
          return;
        }
        setConfig('expected_phone', normalized);

        // Actualiza la sesión que corresponde a ESE número, si existe.
        const match = manager.list().find((s) => clean(s.expected_phone) === normalized || clean(s.phone) === normalized);
        if (match) {
          const verified = clean(match.phone) === normalized;
          run(
            'UPDATE sessions SET expected_phone = ?, phone_verified_at = COALESCE(?, phone_verified_at), updated_at = ? WHERE id = ?',
            normalized,
            verified ? nowIso() : null,
            nowIso(),
            match.id,
          );
        } else {
          // Solo se toca la principal si no pertenece a una cuenta concreta;
          // así no se pisa (ni bloquea) una sesión ya vinculada a otra cuenta.
          const primary = manager.primary();
          if (primary && !primary.owner_uid) {
            run(
              'UPDATE sessions SET expected_phone = ?, updated_at = ? WHERE id = ?',
              normalized,
              nowIso(),
              primary.id,
            );
          }
        }
      } else {
        setConfig('expected_phone', null);
      }
      const row = manager.primary();
      res.json({
        expected_phone: row?.expected_phone ?? null,
        verified: !!row?.phone_verified_at,
      });
    }),
  );

  // ── Grupos ─────────────────────────────────────────────────────────────────

  app.get(
    '/api/v1/groups',
    ah(async (_req, res) => {
      const row = manager.primary();
      if (!row) {
        res.json({ groups: [] });
        return;
      }
      try {
        const groups = await manager.groups(row.id);
        res.json({
          groups: groups.map((g) => ({ id: g.id, name: g.name, participants: g.participantCount })),
        });
      } catch (err) {
        res.status(502).json({ message: (err as Error).message });
      }
    }),
  );

  app.post(
    '/api/v1/groups/resolve',
    ah(async (req, res) => {
      const code = extractInviteCode(String(req.body?.invite ?? ''));
      if (!code) {
        res.status(422).json({ message: 'Enlace o código inválido.' });
        return;
      }
      // Cualquier línea conectada sirve para leer el enlace (no hace falta la principal).
      const own = req.body?.account
        ? get<SessionRow>("SELECT * FROM sessions WHERE owner_uid = ? AND status = 'ready'", String(req.body.account))
        : undefined;
      const row = own ?? readyPrimary();
      if (!row || row.status !== 'ready') {
        res.status(422).json({
          message: 'No hay ninguna línea de WhatsApp conectada en Seguimiento ESAM para leer el enlace. Conectá una línea (Conexión) y volvé a intentar, o pegá el ID del grupo a mano.',
        });
        return;
      }
      try {
        await manager.start(row.id); // no-op si el socket ya está abierto
        const info = await manager.groupJoinInfo(row.id, code);
        res.json({ id: info.id, name: info.name });
      } catch (err) {
        res.status(502).json({ message: (err as Error).message });
      }
    }),
  );

  // ── Cuentas / sesiones ─────────────────────────────────────────────────────

  app.get(
    '/api/v1/accounts',
    ah(async (_req, res) => {
      res.json({ accounts: manager.list().map(accountShape) });
    }),
  );

  app.post(
    '/api/v1/accounts',
    ah(async (req, res) => {
      const uid = String(req.body?.uid ?? '').trim();
      if (!uid) {
        res.status(422).json({ message: 'Falta uid.' });
        return;
      }

      const name = `esam-${req.body?.area ?? 'area'}-${uid}`;
      let row =
        get<SessionRow>('SELECT * FROM sessions WHERE owner_uid = ?', uid) ??
        get<SessionRow>('SELECT * FROM sessions WHERE name = ?', name);
      const primary = manager.primary();

      if (!row) {
        row = manager.createSession(name, primary?.api_key ?? null, null);
      }

      const expected = req.body?.phone ? normalizePhone(String(req.body.phone)) : row.expected_phone;
      const currentPhone = row.phone ? normalizePhone(row.phone) : '';
      // Si cambia el número autorizado, la verificación previa deja de valer
      // salvo que el número vinculado coincida con el nuevo.
      const verifiedAt = expected && currentPhone && currentPhone === expected ? row.phone_verified_at ?? nowIso() : null;
      run(
        `UPDATE sessions SET owner_uid = ?, owner_name = ?, owner_email = ?, area = ?, expected_phone = ?, phone_verified_at = ?, updated_at = ? WHERE id = ?`,
        uid,
        req.body?.name ?? row.owner_name,
        req.body?.email ?? row.owner_email,
        req.body?.area ?? row.area,
        expected,
        verifiedAt,
        nowIso(),
        row.id,
      );

      // Crea/actualiza el usuario del panel en ESAM con los mismos datos y
      // credenciales que cronogramas (usuario espejo), para que pueda iniciar
      // sesión y vincular su número. Solo si está autorizado y tiene número.
      if (!!req.body?.authorized && expected) {
        try {
          const username = usernameAvailableFor(
            typeof req.body?.username === 'string' ? req.body.username : null,
            uid,
          );
          const roles = Array.isArray(req.body?.roles)
            ? (req.body.roles as unknown[]).filter((r): r is string => typeof r === 'string')
            : [];
          upsertUser({
            sourceUid: uid,
            name: req.body?.name ?? null,
            username,
            email: req.body?.email ?? null,
            password: req.body?.password ?? null,
            source: 'cronogramas',
            autorizado: true,
            area: req.body?.area ?? null,
            numero: expected,
            roles,
          });
          audit('account.panel_user_upserted', { uid, username });
        } catch (err) {
          logger.warn({ uid, err: (err as Error).message }, 'No se pudo crear el usuario espejo en el panel de ESAM');
        }
      }

      if (!!req.body?.authorized && expected) {
        try {
          await manager.start(row.id);
        } catch (err) {
          res.status(502).json({
            message: 'Cuenta guardada, pero el gateway rechazó la sesión: ' + (err as Error).message,
            uid,
          });
          return;
        }
      }

      const fresh = manager.byId(row.id)!;
      res.json({
        uid: fresh.owner_uid,
        session_name: fresh.name,
        session_id: fresh.id,
        status: fresh.status,
        expected_phone: fresh.expected_phone,
      });
    }),
  );

  // ── Prospectos de marketing ────────────────────────────────────────────────
  // Cronogramas registra el prospecto; acá queda como nota de seguimiento del
  // asesor (área Marketing en /notes). Idempotente por referencia.

  /** Avisa en vivo a /notes y a las fichas abiertas que la nota cambió. */
  const publishProspect = (noteId: number, action: string) => {
    const chats = personChatsForNote(noteId);
    panelBus.publish('note', {
      noteId,
      action,
      actorId: null,
      assignedTo: null,
      userIds: [],
      sessionIds: [...new Set(chats.map((c) => c.session_id))],
      chats: chats.map((c) => ({ sessionId: c.session_id, chatId: c.chat_id })),
    });
  };

  app.put(
    '/api/v1/prospects/:ref',
    ah(async (req, res) => {
      const body = req.body ?? {};
      const account = String(body.account ?? '').trim();
      if (!account) {
        res.status(422).json({ message: 'Falta la cuenta (account) del asesor.' });
        return;
      }
      try {
        const result = upsertProspect(
          {
            ref: String(req.params.ref),
            account,
            phone: String(body.phone ?? ''),
            name: body.name ?? null,
            programa: body.programa ?? null,
            programaId: body.programa_id ? Number(body.programa_id) : null,
            estado: body.estado ?? null,
            nota: body.nota ?? null,
          },
          sessionFor(account),
        );
        publishProspect(result.noteId, result.created ? 'created' : 'edited');
        audit(result.created ? 'prospect.created' : 'prospect.updated', { ref: req.params.ref, account, note_id: result.noteId });
        res.status(result.created ? 201 : 200).json({ note_id: result.noteId, created: result.created });
      } catch (err) {
        const status = err instanceof ProspectError ? err.status : 500;
        res.status(status).json({ message: (err as Error).message });
      }
    }),
  );

  app.delete(
    '/api/v1/prospects/:ref',
    ah(async (req, res) => {
      const noteId = removeProspect(String(req.params.ref));
      if (noteId) {
        publishProspect(noteId, 'deleted');
        audit('prospect.deleted', { ref: req.params.ref, note_id: noteId });
      }
      res.json({ ok: true, note_id: noteId });
    }),
  );

  // ── Lotes ──────────────────────────────────────────────────────────────────

  app.post(
    '/api/v1/batches',
    ah(async (req, res) => {
      const body = req.body ?? {};
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) {
        res.status(422).json({ message: 'Se requiere al menos un destinatario.' });
        return;
      }

      const session = sessionFor(body.account ? String(body.account) : null);
      if (!session) {
        res.status(422).json({
          message: body.account
            ? 'Tu cuenta no tiene una línea de WhatsApp vinculada en Seguimiento ESAM. Vinculá tu número en Conexión: los envíos salen solo desde tu propia línea.'
            : 'No hay una línea principal configurada en Seguimiento ESAM.',
        });
        return;
      }
      // La línea debe tener vinculado el número del propio usuario: si en esa
      // sesión quedó escaneado otro teléfono, no se envía desde un número ajeno.
      if (body.account && session.phone && session.expected_phone) {
        const linked = String(session.phone).replace(/\D+/g, '');
        const expected = String(session.expected_phone).replace(/\D+/g, '');
        if (linked && expected && linked !== expected) {
          res.status(422).json({
            message: `Tu línea tiene vinculado el número ${linked}, que no es el tuyo (${expected}). Desvinculalo en Seguimiento ESAM › Conexión y escaneá el QR con tu teléfono.`,
          });
          return;
        }
      }
      // Programación con confirmación: se crea sin enviar y espera que el dueño
      // de la línea (o el Super Admin) la confirme desde la notificación.
      const needsConfirm = !!body.require_confirmation;
      const confirmGroup = needsConfirm ? String(body.confirm_group || `cg-${session.id.slice(0, 8)}-${Date.now()}`) : null;
      const notReady = needsConfirm ? null : notReadyMessage(session, body);
      if (notReady) {
        res.status(422).json({ message: notReady });
        return;
      }

      try {
        const result = createBatch(
          {
            sessionId: session.id,
            name: String(body.name ?? `Integración ${nowIso()}`),
            category: body.category ?? null,
            templateId: body.template_id ? Number(body.template_id) : null,
            items,
            defaultMedia: body.default_media ?? null,
            meta: { source: 'integration', account: body.account ?? null, ...(body.meta ?? {}), category: body.category ?? null },
            dryRun: !!body.dry_run,
            // Reenvío intencional (el usuario confirmó repetir lo ya enviado hoy).
            allowResend: !!body.allow_resend,
            // Con confirmación se crea como programado (sin encolar) y enseguida pasa a «esperando confirmación».
            // (siempre la fecha de reserva: si la hora pedida ya pasó, createBatch lo encolaría sin confirmar)
            scheduledAt: needsConfirm ? '9999-12-31T00:00:00.000Z' : body.scheduled_at ?? null,
          },
          runner,
        );

        if (result.dryRun) {
          res.json({ dry_run: true, total: result.total, skipped: result.skipped });
          return;
        }
        // No se creó nada: todos eran repetidos de hoy. Antes respondía 201 con
        // batch_id null y cronogramas mostraba «Encolados… Lote #null».
        if (!result.batchId) {
          const prev = duplicateInfo(items);
          res.status(409).json({
            duplicate: true,
            skipped: result.skipped,
            message:
              `No se envió: ${result.skipped} mensaje(s) ya se habían enviado hoy` +
              (prev ? ` (lote #${prev.batchId}, desde ${prev.line})` : '') +
              '. Para evitar duplicados no se repiten.',
          });
          return;
        }
        if (needsConfirm && result.batchId) {
          markAwaiting(result.batchId, confirmGroup!, body.scheduled_at ?? null);
          if (body.notify !== false && !body.confirm_group) notifyGroup(confirmGroup!, body.confirm_description ?? null);
        }
        res.status(201).json({
          batch_id: result.batchId,
          total: result.total,
          skipped: result.skipped,
          ...(needsConfirm ? { status: AWAITING, confirm_group: confirmGroup } : {}),
        });
      } catch (err) {
        if (err instanceof MissingTemplateVariableError) {
          res.status(422).json({ message: 'Plantilla incompleta: ' + err.message });
          return;
        }
        res.status(422).json({ message: (err as Error).message });
      }
    }),
  );

  // Avisa una sola vez por programación (cuando el integrador creó todos sus lotes).
  app.post(
    '/api/v1/batches/confirm-group/:group/notify',
    ah(async (req, res) => {
      const group = String(req.params.group);
      if (!getGroup(group)) {
        res.status(404).json({ message: 'Programación no encontrada.' });
        return;
      }
      notifyGroup(group, req.body?.description ? String(req.body.description) : null);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/v1/batches/:id',
    ah(async (req, res) => {
      const batch = get<{
        id: number;
        name: string | null;
        status: string;
        total: number;
        sent: number;
        failed: number;
        skipped: number;
        meta: string | null;
        session_id: string;
      }>('SELECT id, name, status, total, sent, failed, skipped, meta, session_id FROM batches WHERE id = ?', Number(req.params.id));
      if (!batch) {
        res.status(404).json({ message: 'Lote no encontrado.' });
        return;
      }
      // Detalle anti-baneo de la línea que envía: ritmo, límites y tiempo estimado.
      let antiBan: Record<string, unknown> | null = null;
      try {
        const sessionRow = get<SessionRow>('SELECT * FROM sessions WHERE id = ?', batch.session_id);
        const policy = getPolicy(batch.session_id);
        const lim = limitState(batch.session_id, policy, sessionRow);
        const remaining = Math.max(0, batch.total - batch.sent - batch.failed - batch.skipped);
        const avg = (lim.delayMin + lim.delayMax) / 2;
        antiBan = {
          profile: policy.risk_profile,
          pace: `${lim.delayMin}–${lim.delayMax} s por mensaje`,
          hourly_limit: lim.hourlyLimit,
          hourly_used: lim.hourlyUsed,
          daily_limit: lim.dailyLimit,
          daily_used: lim.dailyUsed,
          new_contacts_today: countNewContactsToday(batch.session_id),
          new_contacts_limit: policy.new_contacts_daily_limit,
          window: `${policy.window_start}–${policy.window_end}`,
          line_connected: sessionRow?.status === 'ready',
          eta_minutes: remaining ? Math.ceil((remaining * avg) / 60) : 0,
        };
      } catch {
        antiBan = null;
      }
      const pending = Math.max(0, batch.total - batch.sent - batch.failed - batch.skipped);
      const progress = batch.total > 0 ? Math.round(((batch.sent + batch.failed + batch.skipped) / batch.total) * 100) : 0;
      let meta: { waiting?: { reason?: string; until?: string }; anti_ban_pause?: string; solicitado_por_id?: number | string; account?: string } = {};
      try {
        meta = batch.meta ? JSON.parse(batch.meta) : {};
      } catch {
        meta = {};
      }
      res.json({
        waiting_reason: batch.status === 'running' ? meta.waiting?.reason ?? null : null,
        waiting_until: batch.status === 'running' ? meta.waiting?.until ?? null : null,
        paused_reason: batch.status === 'paused' ? meta.anti_ban_pause ?? null : null,
        batch_id: batch.id,
        name: batch.name,
        status: batch.status,
        total: batch.total,
        sent: batch.sent,
        failed: batch.failed,
        skipped: batch.skipped,
        pending,
        progress,
        anti_ban: antiBan,
        // Quién pidió el lote (usuario de cronogramas): cronogramas deja ver el
        // progreso a esa persona aunque no tenga permisos de administración.
        requested_by: meta.solicitado_por_id != null ? String(meta.solicitado_por_id) : meta.account ?? null,
      });
    }),
  );

  app.post(
    '/api/v1/batches/:id/retry',
    ah(async (req, res) => {
      const batchId = Number(req.params.id);
      const result = run(
        "UPDATE batch_items SET status = 'pending', error = NULL, updated_at = ? WHERE batch_id = ? AND status = 'failed'",
        nowIso(),
        batchId,
      );
      recount(batchId);
      run("UPDATE batches SET status = 'running', finished_at = NULL, updated_at = ? WHERE id = ?", nowIso(), batchId);
      runner.enqueue(batchId);
      res.json({ retrying: result.changes });
    }),
  );

  /** Importa destinatarios desde un CSV (contenido en base64) y crea un lote. */
  app.post(
    '/api/v1/batches/import',
    ah(async (req, res) => {
      const body = req.body ?? {};
      const name = String(body.filename ?? `csv-${Date.now()}.csv`);
      const contents = Buffer.from(String(body.content_base64 ?? ''), 'base64');
      if (contents.length === 0) {
        res.status(422).json({ message: 'Falta content_base64.' });
        return;
      }

      const session = sessionFor(body.account ? String(body.account) : null);
      if (!session) {
        res.status(422).json({ message: 'No hay sesión de envío disponible.' });
        return;
      }
      const notReady = notReadyMessage(session, body);
      if (notReady) {
        res.status(422).json({ message: notReady });
        return;
      }

      const { saveUpload } = await import('../core/uploads.js');
      const filePath = saveUpload(name, contents);

      const result = importCsvToBatch(
        filePath,
        {
          name: body.name ? String(body.name) : undefined,
          category: body.category ?? null,
          templateId: body.template_id ? Number(body.template_id) : null,
          meta: { ...(body.meta ?? {}), account: body.account ?? null },
        },
        (payload) => {
          const created = createBatch(
            {
              sessionId: session.id,
              name: payload.name,
              category: payload.category,
              templateId: payload.templateId,
              items: payload.items,
              meta: { ...payload.meta, source: 'csv' },
            },
            runner,
          );
          return created.batchId ?? 0;
        },
      );

      res.status(result.batchId ? 201 : 422).json({
        batch_id: result.batchId,
        total: result.total,
        skipped: result.skipped,
        errors: result.errors,
      });
    }),
  );

  /** Genera el PDF de estado de cuenta de un cliente (devuelve la ruta). */
  app.post(
    '/api/v1/pdf/statement',
    ah(async (req, res) => {
      const b = req.body ?? {};
      const path = statementPdf({
        name: b.name ?? null,
        ref: b.ref ?? b.external_ref ?? null,
        concept: b.concept ?? null,
        amount: b.amount != null ? Number(b.amount) : null,
        currency: b.currency ?? 'Bs',
        dueDate: b.due_date ?? null,
      });
      res.status(201).json({ path });
    }),
  );

  /** Genera el PDF de boletín académico (devuelve la ruta). */
  app.post(
    '/api/v1/pdf/boletin',
    ah(async (req, res) => {
      const b = req.body ?? {};
      const path = boletinPdf({
        name: b.name ?? null,
        period: b.period ?? null,
        course: b.course ?? null,
        rows: Array.isArray(b.rows) ? b.rows : [],
      });
      res.status(201).json({ path });
    }),
  );

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.warn({ err: err.message }, 'Error en la API v1');
    res.status(502).json({ message: err.message });
  });

  return app;
}
