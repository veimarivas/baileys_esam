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
}

interface ParsedCookie {
  userId: number;
}

/**
 * Sesiones del panel: cookie firmada (HMAC) + fila en `web_sessions`.
 * Cada request verifica la firma y la expiración.
 */
export class SessionStore {
  private sign(value: string): string {
    return crypto.createHmac('sha256', config.secretKey).update(value).digest('base64url');
  }

  /** Crea una sesión web y devuelve el valor de la cookie. */
  create(userId: number): { cookie: string; expiresAt: Date } {
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
    run(
      'INSERT INTO web_sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      id,
      userId,
      nowIso(),
      expiresAt.toISOString(),
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
    if (!crypto.timingSafeEqual(Buffer.from(this.sign(id)), Buffer.from(signature))) return null;
    const row = get<WebSession>('SELECT * FROM web_sessions WHERE id = ?', id);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
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
export function sessionCookieHeader(cookie: string, expiresAt: Date): string {
  const attrs = [
    `${config.sessionCookie}=${cookie}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  return attrs.join('; ');
}

export function clearCookieHeader(): string {
  return `${config.sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export type { UserRow };
