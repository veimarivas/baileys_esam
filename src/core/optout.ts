import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { phoneFromChatId } from './phone.js';

export interface OptoutRow {
  chat_id: string;
  phone: string | null;
  reason: string | null;
  source: string | null;
  /** Línea en la que se originó (null = manual o anterior a este dato). */
  session_id: string | null;
  created_at: string;
}

/** Normaliza un chatId a la forma canónica `<digitos>@c.us`. */
export function normalizeChatId(input: string): string {
  const digits = (input ?? '').replace(/\D+/g, '');
  return digits ? `${digits}@c.us` : '';
}

/** ¿El chat está en la lista de no enviar? */
export function isBlocked(chatId: string): boolean {
  const normalized = normalizeChatId(chatId);
  if (!normalized) return false;
  return !!get('SELECT 1 FROM optouts WHERE chat_id = ?', normalized);
}

/** Agrega (o actualiza) un número a la lista de no enviar. */
export function addOptout(chatId: string, reason = 'Solicitó la baja', source = 'manual', sessionId: string | null = null): void {
  const normalized = normalizeChatId(chatId);
  if (!normalized) return;
  run(
    `INSERT INTO optouts (chat_id, phone, reason, source, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET reason = excluded.reason, source = excluded.source,
       session_id = COALESCE(excluded.session_id, optouts.session_id)`,
    normalized,
    phoneFromChatId(normalized),
    reason,
    source,
    sessionId,
    nowIso(),
  );
}

export function removeOptout(chatId: string): void {
  run('DELETE FROM optouts WHERE chat_id = ?', normalizeChatId(chatId));
}

/**
 * Heurística de bloqueo: Baileys no emite un evento directo de "te bloquearon",
 * así que se detecta por el error de envío (403/forbidden/spam, etc.).
 */
export function looksLikeBlock(message: string | null | undefined): boolean {
  const text = (message ?? '').toLowerCase();
  if (!text) return false;
  return /block|bloquead|forbidden|not\s*authorized|unauthorized|spam|too\s*many|401|403|409/.test(text);
}

/** Marca un destino como bloqueado y lo añade a la lista negra global. */
export function markBlocked(chatId: string, reason = 'El destinatario bloqueó el número', sessionId: string | null = null): void {
  addOptout(chatId, reason, 'blocked', sessionId);
}

export function listOptouts(): OptoutRow[] {
  return all<OptoutRow>('SELECT * FROM optouts ORDER BY created_at DESC');
}

/**
 * Detecta una petición de baja en un mensaje entrante. `extraKeywords`: palabras
 * adicionales de la política (separadas por coma), sin distinguir acentos.
 */
export function isOptoutRequest(body: string | null | undefined, extraKeywords = ''): boolean {
  const text = (body ?? '').trim().toUpperCase();
  if (!text) return false;
  if (/\b(BAJA|STOP|CANCELAR|SALIR|UNSUBSCRIBE|NO MOLESTAR)\b/u.test(text)) return true;
  const fold = (v: string) => v.normalize('NFD').replace(/\p{Mn}/gu, '').toUpperCase();
  const folded = fold(text);
  return extraKeywords
    .split(',')
    .map((k) => fold(k.trim()))
    .filter((k) => k.length >= 2)
    .some((k) => new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(folded));
}
