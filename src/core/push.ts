import crypto from 'node:crypto';
import fs from 'node:fs';
import { all, get, run } from '../db/index.js';
import { logger } from '../logger.js';
import { nowIso } from '../util/async.js';
import { panelBus, type PanelEvent } from '../panel/events.js';

/**
 * Notificaciones push a la app móvil (Firebase Cloud Messaging, API HTTP v1).
 *
 * - Cada teléfono registra su token al iniciar sesión (`device_tokens`).
 * - Se envía push cuando se crea un aviso de la campana (derivaciones,
 *   respuestas a cobranzas, envíos por confirmar, línea caída…) y cuando llega
 *   un mensaje a un chat individual de la línea del usuario.
 * - Sin `FCM_SERVICE_ACCOUNT` (ruta al JSON de la cuenta de servicio) no hace
 *   nada: el panel y la app funcionan igual, solo sin push.
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let account: ServiceAccount | null | undefined;
let accessToken: { value: string; expires: number } | null = null;

function serviceAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  const file = process.env.FCM_SERVICE_ACCOUNT?.trim();
  account = null;
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ServiceAccount;
    if (parsed.project_id && parsed.client_email && parsed.private_key) account = parsed;
    else logger.warn('FCM_SERVICE_ACCOUNT no tiene project_id, client_email o private_key: push desactivado');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'No se pudo leer FCM_SERVICE_ACCOUNT: push desactivado');
  }
  return account;
}

export function pushEnabled(): boolean {
  return serviceAccount() !== null;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Token OAuth de la cuenta de servicio (se reutiliza hasta 5 min antes de vencer). */
async function oauthToken(sa: ServiceAccount): Promise<string> {
  if (accessToken && accessToken.expires > Date.now() + 300_000) return accessToken.value;
  const now = Math.floor(Date.now() / 1000);
  const aud = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud, iat: now, exp: now + 3600 }),
  )}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` }),
  });
  if (!res.ok) throw new Error(`OAuth de Firebase respondió ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  accessToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

// ── Tokens de los teléfonos ──────────────────────────────────────────────────

export function registerDevice(userId: number, token: string, platform: string): void {
  const t = token.trim();
  if (!t || t.length > 4096) throw new Error('Token de notificaciones inválido.');
  const now = nowIso();
  run(
    `INSERT INTO device_tokens (token, user_id, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, last_seen_at = excluded.last_seen_at`,
    t,
    userId,
    platform.slice(0, 20) || 'android',
    now,
    now,
  );
}

export function removeDevice(token: string): void {
  run('DELETE FROM device_tokens WHERE token = ?', token.trim());
}

export function deviceTokens(userIds: number[]): Array<{ token: string; user_id: number }> {
  const ids = [...new Set(userIds.filter((x) => Number.isInteger(x) && x > 0))];
  if (!ids.length) return [];
  return all<{ token: string; user_id: number }>(`SELECT token, user_id FROM device_tokens WHERE user_id IN (${ids.map(() => '?').join(',')})`, ...ids);
}

// ── Envío ─────────────────────────────────────────────────────────────────────

export interface PushMessage {
  title: string;
  body?: string | null;
  /** Datos para abrir la pantalla correcta al tocar (todo texto). */
  data?: Record<string, string>;
  /** Reemplaza la notificación anterior con la misma etiqueta (p. ej. un chat). */
  tag?: string;
  channel?: 'mensajes' | 'avisos';
}

/** Envía a todos los teléfonos de esos usuarios. Devuelve cuántos se entregaron a FCM. */
export async function sendPush(userIds: number[], msg: PushMessage): Promise<number> {
  const sa = serviceAccount();
  if (!sa) return 0;
  const devices = deviceTokens(userIds);
  if (!devices.length) return 0;
  let token: string;
  try {
    token = await oauthToken(sa);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Push: no se obtuvo el token de Firebase');
    return 0;
  }
  let ok = 0;
  await Promise.all(
    devices.map(async (d) => {
      try {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: d.token,
              notification: { title: msg.title.slice(0, 120), body: (msg.body ?? '').slice(0, 240) },
              data: msg.data ?? {},
              android: {
                priority: 'HIGH',
                notification: { channel_id: msg.channel ?? 'avisos', ...(msg.tag ? { tag: msg.tag } : {}) },
              },
            },
          }),
        });
        if (res.ok) {
          ok++;
          return;
        }
        const text = await res.text();
        // Token vencido o de una app desinstalada: se olvida.
        if (res.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT.*token/i.test(text)) removeDevice(d.token);
        else logger.warn({ status: res.status }, 'Push rechazado por Firebase');
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Push: error de red');
      }
    }),
  );
  return ok;
}

// ── Qué dispara un push ───────────────────────────────────────────────────────

/** Usuarios de una línea: su número de cronogramas coincide o son el dueño. */
export function lineUserIds(sessionId: string): number[] {
  const s = get<{ phone: string | null; expected_phone: string | null; owner_uid: string | null }>(
    'SELECT phone, expected_phone, owner_uid FROM sessions WHERE id = ?',
    sessionId,
  );
  if (!s) return [];
  const clean = (v: string | null | undefined) => String(v ?? '').replace(/\D+/g, '');
  const phones = new Set([clean(s.phone), clean(s.expected_phone)].filter(Boolean));
  return all<{ id: number; esam_numero: string | null; source_uid: string | null }>('SELECT id, esam_numero, source_uid FROM users')
    .filter((u) => (u.esam_numero && phones.has(clean(u.esam_numero))) || (s.owner_uid && u.source_uid === s.owner_uid))
    .map((u) => u.id);
}

function onEvent(e: PanelEvent): void {
  const p = e.payload;
  if (e.type === 'notification') {
    const ids = Array.isArray(p.userIds) ? (p.userIds as number[]) : [];
    void sendPush(ids, {
      title: String(p.title ?? 'Seguimiento ESAM'),
      body: p.body ? String(p.body) : null,
      channel: 'avisos',
      data: {
        // Un aviso con enlace a un chat abre ese chat en la app.
        type: p.noteId ? 'note' : String(p.link ?? '').startsWith('/conversations/') ? 'chat' : 'notice',
        ...(String(p.link ?? '').startsWith('/conversations/') ? { chat_id: decodeURIComponent(String(p.link).slice('/conversations/'.length)) } : {}),
        kind: String(p.kind ?? ''),
        ...(p.noteId ? { note_id: String(p.noteId) } : {}),
        ...(p.link ? { link: String(p.link) } : {}),
      },
    });
    return;
  }
  // Mensaje entrante en un chat individual (no historial ni grupos).
  if (e.type === 'message' && p.direction === 'in' && !p.history) {
    const sessionId = String(p.sessionId ?? '');
    const chatId = String(p.chatId ?? '');
    if (!sessionId || !chatId || chatId.endsWith('@g.us') || chatId === 'status@broadcast') return;
    const name = p.contact_name ? String(p.contact_name) : `+${chatId.replace(/@.*$/, '')}`;
    const kind = String(p.content_type ?? 'text');
    const body = kind === 'text' ? String(p.body ?? '') : ({ image: 'Foto', audio: 'Audio', video: 'Video', document: 'Documento', sticker: 'Sticker' } as Record<string, string>)[kind] ?? 'Mensaje';
    void sendPush(lineUserIds(sessionId), {
      title: name,
      body,
      channel: 'mensajes',
      tag: `chat:${chatId}`,
      data: { type: 'chat', session_id: sessionId, chat_id: chatId },
    });
  }
}

let started = false;

/** Escucha el bus del panel y envía los push (solo si Firebase está configurado). */
export function startPushWorker(): void {
  if (started) return;
  started = true;
  if (!pushEnabled()) {
    logger.info('Push desactivado: falta FCM_SERVICE_ACCOUNT');
    return;
  }
  panelBus.on('event', (e: PanelEvent) => {
    try {
      onEvent(e);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Push: error al preparar el aviso');
    }
  });
  logger.info('Push activado (Firebase)');
}
