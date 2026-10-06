import crypto from 'node:crypto';
import { get, run } from '../db/index.js';
import { config } from '../config.js';
import { nowIso } from '../util/async.js';

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

export interface SsoPayload {
  uid: string;
  name?: string;
  email?: string;
  username?: string;
  autorizado?: boolean;
  area?: string;
  numero?: string;
  roles?: string[];
  next?: string;
  exp?: number;
  nonce?: string;
}

/**
 * Valida un token de SSO firmado por cronogramas: formato `payload.firma`
 * (HMAC-SHA256 hex del JSON del payload), expiración y nonce de un solo uso.
 */
export function verifySsoToken(token: string, secret: string): { ok: true; payload: SsoPayload } | { ok: false; error: string } {
  if (!secret || !token) return { ok: false, error: 'SSO no configurado o token ausente.' };

  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, error: 'Token inválido.' };

  const [encoded, signature] = parts;
  const payloadJson = base64UrlDecode(encoded);
  if (!payloadJson) return { ok: false, error: 'Token inválido.' };

  const expected = crypto.createHmac('sha256', secret).update(payloadJson).digest('hex');
  if (!safeEqualHex(expected, signature)) return { ok: false, error: 'Firma inválida.' };

  let payload: SsoPayload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, error: 'Token inválido.' };
  }

  if (!payload.uid) return { ok: false, error: 'Token inválido.' };
  if ((payload.exp ?? 0) < Math.floor(Date.now() / 1000)) return { ok: false, error: 'Token expirado.' };

  const nonce = payload.nonce ?? '';
  if (!nonce) return { ok: false, error: 'Token inválido.' };
  if (get('SELECT 1 FROM sso_nonces WHERE nonce = ?', nonce)) return { ok: false, error: 'Token ya utilizado.' };
  run('INSERT INTO sso_nonces (nonce, created_at) VALUES (?, ?)', nonce, nowIso());
  // Limpieza de nonces viejos.
  run("DELETE FROM sso_nonces WHERE created_at < ?", new Date(Date.now() - 10 * 60_000).toISOString());

  return { ok: true, payload };
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Genera un `next` seguro (solo rutas internas). */
export function safeNext(next: unknown, fallback: string): string {
  return typeof next === 'string' && next.startsWith('/') ? next : fallback;
}

export { config };
