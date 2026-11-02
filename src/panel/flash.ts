import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';

/**
 * Mensajes de éxito/error de un solo uso, guardados en una cookie firmada.
 *
 * Antes viajaban en la URL (`?ok=`, `?error=`), lo que permitía inventar un
 * mensaje falso. Ahora solo el servidor puede firmarlos y se consumen al
 * renderizar la página siguiente.
 */

export type FlashKind = 'ok' | 'error';

export interface FlashMessage {
  kind: FlashKind;
  message: string;
  exp: number;
}

export const FLASH_COOKIE = 'esam_flash';
const TTL_MS = 5 * 60_000;
const MAX_MESSAGE = 500;

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64url');
}

function encode(flash: FlashMessage): string {
  const payload = Buffer.from(JSON.stringify(flash)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function decode(raw: string): FlashMessage | null {
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Partial<FlashMessage>;
  if ((value.kind !== 'ok' && value.kind !== 'error') || typeof value.message !== 'string') return null;
  if (typeof value.exp !== 'number' || value.exp < Date.now()) return null;
  return { kind: value.kind, message: value.message.slice(0, MAX_MESSAGE), exp: value.exp };
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.header('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function isHttps(req: Request): boolean {
  return req.secure || String(req.header('x-forwarded-proto') ?? '').split(',')[0].trim() === 'https';
}

function cookieAttrs(req: Request, maxAge: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

export function setFlash(res: Response, kind: FlashKind, message: string): void {
  const text = String(message ?? '').trim().slice(0, MAX_MESSAGE);
  if (!text) return;
  const flash: FlashMessage = { kind, message: text, exp: Date.now() + TTL_MS };
  res.append('Set-Cookie', `${FLASH_COOKIE}=${encode(flash)}; ${cookieAttrs(res.req, 300)}`);
}

/** Lee el aviso pendiente y borra la cookie, incluso si estaba manipulada. */
export function takeFlash(req: Request, res: Response): FlashMessage | null {
  const raw = cookieValue(req, FLASH_COOKIE);
  if (!raw) return null;
  res.append('Set-Cookie', `${FLASH_COOKIE}=; ${cookieAttrs(req, 0)}`);
  return decode(raw);
}
