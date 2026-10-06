import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';

export interface AutoReplyRuleRow {
  id: number;
  keyword: string;
  match_type: 'contains' | 'equals' | 'regex';
  reply_body: string;
  cooldown_seconds: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export const MATCH_TYPES = ['contains', 'equals', 'regex'] as const;

export function listRules(): AutoReplyRuleRow[] {
  return all<AutoReplyRuleRow>('SELECT * FROM autoreply_rules ORDER BY id');
}

export function activeRules(): AutoReplyRuleRow[] {
  return all<AutoReplyRuleRow>('SELECT * FROM autoreply_rules WHERE active = 1 ORDER BY id');
}

export function createRule(keyword: string, matchType: string, replyBody: string, cooldownSeconds: number, active = true): number {
  const now = nowIso();
  const type = (MATCH_TYPES as readonly string[]).includes(matchType) ? matchType : 'contains';
  const res = run(
    `INSERT INTO autoreply_rules (keyword, match_type, reply_body, cooldown_seconds, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    keyword,
    type,
    replyBody,
    Math.max(0, cooldownSeconds),
    active ? 1 : 0,
    now,
    now,
  );
  return res.lastInsertRowid;
}

export function deleteRule(id: number): void {
  run('DELETE FROM autoreply_rules WHERE id = ?', id);
  run('DELETE FROM autoreply_cooldowns WHERE rule_id = ?', id);
}

export function toggleRule(id: number): void {
  run('UPDATE autoreply_rules SET active = CASE active WHEN 1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?', nowIso(), id);
}

/** ¿El texto del cliente dispara esta regla? */
export function matches(rule: AutoReplyRuleRow, text: string): boolean {
  const t = text.trim();
  if (rule.match_type === 'equals') return t.toLowerCase() === rule.keyword.trim().toLowerCase();
  if (rule.match_type === 'regex') {
    try {
      return new RegExp(rule.keyword, 'iu').test(t);
    } catch {
      return false;
    }
  }
  return t.toLowerCase().includes(rule.keyword.toLowerCase());
}

/**
 * Devuelve la primera regla que coincide y no está en enfriamiento para ese
 * chat (y registra el enfriamiento). `null` si no hay respuesta.
 */
export function pickReply(chatId: string, text: string): AutoReplyRuleRow | null {
  const now = Date.now();
  for (const rule of activeRules()) {
    if (!matches(rule, text)) continue;
    const cd = get<{ expires_at: string }>('SELECT expires_at FROM autoreply_cooldowns WHERE rule_id = ? AND chat_id = ?', rule.id, chatId);
    if (cd && new Date(cd.expires_at).getTime() > now) return null; // en cooldown: no responder
    run(
      `INSERT INTO autoreply_cooldowns (rule_id, chat_id, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(rule_id, chat_id) DO UPDATE SET expires_at = excluded.expires_at`,
      rule.id,
      chatId,
      new Date(now + rule.cooldown_seconds * 1000).toISOString(),
    );
    return rule;
  }
  return null;
}

/** Limpia enfriamientos vencidos. */
export function pruneCooldowns(): void {
  run('DELETE FROM autoreply_cooldowns WHERE expires_at < ?', nowIso());
}
