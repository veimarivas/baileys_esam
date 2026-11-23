import crypto from 'node:crypto';
import { get, run } from '../db/index.js';
import { config } from '../config.js';
import { nowIso } from '../util/async.js';
import type { UserRow } from './users.js';

export interface WebSession {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
}

/**
 * Sesiones del panel: cookie firmada (HMAC) + fila en `web_sessions`.
 * Cada request verifica la firma y la expiración.
 */
export class SessionStore {
  private sign(value: string): string {
    return crypto.createHmac('sha256', config.secretKey).update(value).digest('base64url');
  }

  /** Borra sesiones vencidas o inactivas (limpieza oportunista). */
  private cleanup(now: number): void {
    run('DELETE FROM web_sessions WHERE expires_at < ?', new Date(now).toISOString());
    if (config.sessionIdleMinutes > 0) {
      const cutoff = new Date(now - config.sessionIdleMinutes * 60_000).toISOString();
      run('DELETE FROM web_sessions WHERE COALESCE(last_seen_at, created_at) < ?', cutoff);
    }
  }

  /** Crea una sesión web y devuelve el valor de la cookie. */
  create(userId: number): { cookie: string; expiresAt: Date } {
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = new Date(now + config.sessionTtlHours * 3600_000);
    this.cleanup(now);
    run(
      'INSERT INTO web_sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      id,
      userId,
      nowIso(),
      expiresAt.toISOString(),
      nowIso(),
    );
    return { cookie: `${id}.${this.sign(id)}`, expiresAt };
  }

  destroy(cookie: string | undefined): void {
    const parsed = this.parse(cookie);
    if (parsed) run('DELETE FROM web_sessions WHERE id = ?', parsed.id);
  }

  /** Devuelve el id de sesión si la cookie es válida (firma + no expirada). */
  private parse(cookie: string | undefined): { id: string; row: WebSession } | null {
    if (!cookie) return null;
    const [id, signature] = cookie.split('.');
    if (!id || !signature) return null;
    // timingSafeEqual exige el mismo largo: una firma manipulada de otro tamaño
    // debe rechazarse, no hacer explotar el pedido con un 500.
    const expected = Buffer.from(this.sign(id));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    const row = get<WebSession>('SELECT * FROM web_sessions WHERE id = ?', id);
    if (!row) return null;

    const now = Date.now();
    const created = Date.parse(row.created_at);
    const ttlMs = config.sessionTtlHours * 3600_000;
    const idleMs = config.sessionIdleMinutes * 60_000;
    // Vencimiento absoluto: aunque una fila vieja tenga expires_at lejano, no
    // puede durar más que SESSION_TTL_HOURS desde que se creó.
    const expired =
      (Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) < now) ||
      (Number.isFinite(created) && now > created + ttlMs);
    // Inactividad: al volver al día siguiente la sesión ya no sirve.
    const lastSeen = row.last_seen_at && Number.isFinite(Date.parse(row.last_seen_at))
      ? Date.parse(row.last_seen_at)
      : created;
    const idle = idleMs > 0 && Number.isFinite(lastSeen) && now - lastSeen > idleMs;

    if (expired || idle) {
      run('DELETE FROM web_sessions WHERE id = ?', id);
      return null;
    }
    // Se actualiza como máximo una vez por minuto para no escribir en cada request.
    if (!Number.isFinite(lastSeen) || now - lastSeen > 60_000) {
      run('UPDATE web_sessions SET last_seen_at = ? WHERE id = ?', new Date(now).toISOString(), id);
    }
    return { id, row };
  }

  /** Extrae el userId de la cookie (o null). */
  userId(cookie: string | undefined): number | null {
    const parsed = this.parse(cookie);
    return parsed ? parsed.row.user_id : null;
  }
}

export const sessionStore = new SessionStore();

/** Reparte 'Set-Cookie' para el panel. */
export function sessionCookieHeader(cookie: string, expiresAt: Date, secure = false): string {
  const attrs = [
    `${config.sessionCookie}=${cookie}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookieHeader(): string {
  return `${config.sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export type { UserRow };
