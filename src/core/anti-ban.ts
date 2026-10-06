import { get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import type { SessionRow } from '../types.js';
import type { PacingOptions } from './pacing.js';

export type RiskProfile = 'low' | 'medium' | 'high';

export interface AntiBanPolicy {
  id: number;
  session_id: string | null;
  risk_profile: RiskProfile;
  daily_limit: number;
  hourly_limit: number;
  delay_min_seconds: number;
  delay_max_seconds: number;
  window_start: string;
  window_end: string;
  window_days: number[];
  warmup_enabled: boolean;
  warmup_start_date: string | null;
  warmup_day1_limit: number;
  pauses_enabled: boolean;
  pause_every: number;
  pause_min_minutes: number;
  pause_max_minutes: number;
  health_delivery_threshold: number;
  active: boolean;
  /** Muestra "escribiendo…" antes de cada envío. */
  typing_simulation: boolean;
  /** Separación mínima entre dos envíos cualesquiera de la sesión (s). */
  min_gap_seconds: number;
  /** Tope de envíos por minuto (ráfaga) sumando panel, API y lotes. */
  burst_per_minute: number;
  /** Verifica que el número tenga WhatsApp antes de escribirle por primera vez. */
  verify_numbers: boolean;
  /** Máximo de contactos nuevos (sin historial) por día. */
  new_contacts_daily_limit: number;
  /** Fallos seguidos antes de poner la sesión en cuarentena. */
  max_consecutive_failures: number;
  /** Pausa el lote si la entregabilidad cae bajo el umbral. */
  auto_pause_low_delivery: boolean;
}

interface PolicyRow {
  id: number;
  session_id: string | null;
  risk_profile: string;
  daily_limit: number;
  hourly_limit: number;
  delay_min_seconds: number;
  delay_max_seconds: number;
  window_start: string;
  window_end: string;
  window_days: string;
  warmup_enabled: number;
  warmup_start_date: string | null;
  warmup_day1_limit: number;
  pauses_enabled: number;
  pause_every: number;
  pause_min_minutes: number;
  pause_max_minutes: number;
  health_delivery_threshold: number;
  active: number;
  typing_simulation: number;
  min_gap_seconds: number;
  burst_per_minute: number;
  verify_numbers: number;
  new_contacts_daily_limit: number;
  max_consecutive_failures: number;
  auto_pause_low_delivery: number;
}

/** Presets de riesgo (sección 3.1 de MEJORAS.md). */
export const RISK_PRESETS: Record<RiskProfile, Omit<PolicyFields, 'risk_profile'>> = {
  low: {
    daily_limit: 100,
    hourly_limit: 20,
    delay_min_seconds: 180,
    delay_max_seconds: 300,
    window_start: '08:00',
    window_end: '20:00',
    window_days: [1, 2, 3, 4, 5, 6],
    warmup_enabled: true,
    warmup_start_date: null,
    warmup_day1_limit: 30,
    pauses_enabled: true,
    pause_every: 10,
    pause_min_minutes: 10,
    pause_max_minutes: 20,
    health_delivery_threshold: 0.9,
    active: true,
    typing_simulation: true,
    min_gap_seconds: 8,
    burst_per_minute: 3,
    verify_numbers: true,
    new_contacts_daily_limit: 15,
    max_consecutive_failures: 3,
    auto_pause_low_delivery: true,
  },
  medium: {
    daily_limit: 300,
    hourly_limit: 50,
    delay_min_seconds: 45,
    delay_max_seconds: 90,
    window_start: '08:00',
    window_end: '20:00',
    window_days: [1, 2, 3, 4, 5, 6],
    warmup_enabled: true,
    warmup_start_date: null,
    warmup_day1_limit: 50,
    pauses_enabled: true,
    pause_every: 20,
    pause_min_minutes: 5,
    pause_max_minutes: 15,
    health_delivery_threshold: 0.85,
    active: true,
    typing_simulation: true,
    min_gap_seconds: 3,
    burst_per_minute: 8,
    verify_numbers: true,
    new_contacts_daily_limit: 40,
    max_consecutive_failures: 5,
    auto_pause_low_delivery: true,
  },
  high: {
    daily_limit: 800,
    hourly_limit: 120,
    delay_min_seconds: 15,
    delay_max_seconds: 30,
    window_start: '08:00',
    window_end: '20:00',
    window_days: [1, 2, 3, 4, 5, 6],
    warmup_enabled: false,
    warmup_start_date: null,
    warmup_day1_limit: 100,
    pauses_enabled: true,
    pause_every: 40,
    pause_min_minutes: 2,
    pause_max_minutes: 5,
    health_delivery_threshold: 0.8,
    active: true,
    typing_simulation: false,
    min_gap_seconds: 1,
    burst_per_minute: 20,
    verify_numbers: true,
    new_contacts_daily_limit: 120,
    max_consecutive_failures: 8,
    auto_pause_low_delivery: true,
  },
};

export interface PolicyFields {
  risk_profile: RiskProfile;
  daily_limit: number;
  hourly_limit: number;
  delay_min_seconds: number;
  delay_max_seconds: number;
  window_start: string;
  window_end: string;
  window_days: number[];
  warmup_enabled: boolean;
  warmup_start_date: string | null;
  warmup_day1_limit: number;
  pauses_enabled: boolean;
  pause_every: number;
  pause_min_minutes: number;
  pause_max_minutes: number;
  health_delivery_threshold: number;
  active: boolean;
  /** Muestra "escribiendo…" antes de cada envío. */
  typing_simulation: boolean;
  /** Separación mínima entre dos envíos cualesquiera de la sesión (s). */
  min_gap_seconds: number;
  /** Tope de envíos por minuto (ráfaga) sumando panel, API y lotes. */
  burst_per_minute: number;
  /** Verifica que el número tenga WhatsApp antes de escribirle por primera vez. */
  verify_numbers: boolean;
  /** Máximo de contactos nuevos (sin historial) por día. */
  new_contacts_daily_limit: number;
  /** Fallos seguidos antes de poner la sesión en cuarentena. */
  max_consecutive_failures: number;
  /** Pausa el lote si la entregabilidad cae bajo el umbral. */
  auto_pause_low_delivery: boolean;
}

export type PolicyPatch = Partial<PolicyFields>;

function parseDays(raw: string | null): number[] {
  if (!raw) return [1, 2, 3, 4, 5, 6];
  const days = raw
    .split(',')
    .map((d) => parseInt(d.trim(), 10))
    .filter((d) => Number.isFinite(d) && d >= 1 && d <= 7);
  return days.length ? days : [1, 2, 3, 4, 5, 6];
}

function toProfile(value: string): RiskProfile {
  return value === 'low' || value === 'high' ? value : 'medium';
}

function rowToPolicy(row: PolicyRow): AntiBanPolicy {
  return {
    id: row.id,
    session_id: row.session_id,
    risk_profile: toProfile(row.risk_profile),
    daily_limit: row.daily_limit,
    hourly_limit: row.hourly_limit,
    delay_min_seconds: row.delay_min_seconds,
    delay_max_seconds: row.delay_max_seconds,
    window_start: row.window_start,
    window_end: row.window_end,
    window_days: parseDays(row.window_days),
    warmup_enabled: !!row.warmup_enabled,
    warmup_start_date: row.warmup_start_date,
    warmup_day1_limit: row.warmup_day1_limit,
    pauses_enabled: !!row.pauses_enabled,
    pause_every: row.pause_every,
    pause_min_minutes: row.pause_min_minutes,
    pause_max_minutes: row.pause_max_minutes,
    health_delivery_threshold: row.health_delivery_threshold,
    active: !!row.active,
    typing_simulation: row.typing_simulation == null ? true : !!row.typing_simulation,
    min_gap_seconds: row.min_gap_seconds ?? 3,
    burst_per_minute: row.burst_per_minute ?? 8,
    verify_numbers: row.verify_numbers == null ? true : !!row.verify_numbers,
    new_contacts_daily_limit: row.new_contacts_daily_limit ?? 40,
    max_consecutive_failures: row.max_consecutive_failures ?? 5,
    auto_pause_low_delivery: row.auto_pause_low_delivery == null ? true : !!row.auto_pause_low_delivery,
  };
}

/** Politica global (fila con `session_id IS NULL`). */
export function getGlobalPolicy(): AntiBanPolicy {
  let row = get<PolicyRow>('SELECT * FROM anti_ban_policies WHERE session_id IS NULL ORDER BY id LIMIT 1');
  if (!row) {
    const now = nowIso();
    run(
      `INSERT INTO anti_ban_policies (session_id, created_at, updated_at) VALUES (NULL, ?, ?)`,
      now,
      now,
    );
    row = get<PolicyRow>('SELECT * FROM anti_ban_policies WHERE session_id IS NULL ORDER BY id LIMIT 1')!;
  }
  return rowToPolicy(row);
}

function getSessionPolicyRow(sessionId: string): PolicyRow | undefined {
  return get<PolicyRow>('SELECT * FROM anti_ban_policies WHERE session_id = ?', sessionId);
}

/** Politica efectiva de una sesion: override propio sobre la global. */
export function getPolicy(sessionId?: string | null): AntiBanPolicy {
  const global = getGlobalPolicy();
  if (!sessionId) return global;
  const own = getSessionPolicyRow(sessionId);
  return own ? { ...rowToPolicy(own), session_id: sessionId } : global;
}

/**
 * Crea/actualiza una politica (global o de sesion). La politica de sesion se
 * crea a partir de la efectiva actual y solo cambia el parche recibido.
 */
export function upsertPolicy(sessionId: string | null, patch: PolicyPatch): AntiBanPolicy {
  const base = sessionId ? getPolicy(sessionId) : getGlobalPolicy();
  const current = { ...base, ...patch };
  const now = nowIso();

  const columns: Record<keyof PolicyFields, unknown> = {
    risk_profile: current.risk_profile,
    daily_limit: current.daily_limit,
    hourly_limit: current.hourly_limit,
    delay_min_seconds: current.delay_min_seconds,
    delay_max_seconds: current.delay_max_seconds,
    window_start: current.window_start,
    window_end: current.window_end,
    window_days: current.window_days.join(','),
    warmup_enabled: current.warmup_enabled,
    warmup_start_date: current.warmup_start_date,
    warmup_day1_limit: current.warmup_day1_limit,
    pauses_enabled: current.pauses_enabled,
    pause_every: current.pause_every,
    pause_min_minutes: current.pause_min_minutes,
    pause_max_minutes: current.pause_max_minutes,
    health_delivery_threshold: current.health_delivery_threshold,
    active: current.active,
    typing_simulation: current.typing_simulation,
    min_gap_seconds: current.min_gap_seconds,
    burst_per_minute: current.burst_per_minute,
    verify_numbers: current.verify_numbers,
    new_contacts_daily_limit: current.new_contacts_daily_limit,
    max_consecutive_failures: current.max_consecutive_failures,
    auto_pause_low_delivery: current.auto_pause_low_delivery,
  };

  const existing = sessionId ? getSessionPolicyRow(sessionId) : get<PolicyRow>('SELECT * FROM anti_ban_policies WHERE session_id IS NULL ORDER BY id LIMIT 1');
  if (existing) {
    const keys = Object.keys(columns) as Array<keyof PolicyFields>;
    run(
      `UPDATE anti_ban_policies SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      ...keys.map((k) => columns[k]),
      now,
      existing.id,
    );
  } else {
    const keys = Object.keys(columns) as Array<keyof PolicyFields>;
    run(
      `INSERT INTO anti_ban_policies (session_id, ${keys.join(', ')}, created_at, updated_at)
       VALUES (?, ${keys.map(() => '?').join(', ')}, ?, ?)`,
      sessionId,
      ...keys.map((k) => columns[k]),
      now,
      now,
    );
  }

  return getPolicy(sessionId);
}

/** Aplica los valores por defecto de un perfil de riesgo (sin persistir). */
export function presetFor(profile: RiskProfile): PolicyFields {
  return { risk_profile: profile, ...RISK_PRESETS[profile] } as PolicyFields;
}

/** Reinicia la confianza de una sesion: el warm-up vuelve al dia 1. */
export function resetTrust(sessionId: string): void {
  upsertPolicy(sessionId, { warmup_start_date: nowIso() });
}

export interface WarmupState {
  enabled: boolean;
  /** Dia de calentamiento (1-based); 0 si el warm-up esta desactivado. */
  day: number;
  /** Limite diario efectivo durante el warm-up. */
  dailyLimit: number;
  delayMin: number;
  delayMax: number;
  /** `true` mientras el limite siga por debajo del limite configurado. */
  active: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function lerp(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * clamp(t, 0, 1));
}

/** Inicio del warm-up: fecha explicita o alta/verificacion de la sesion. */
export function warmupStartMs(policy: AntiBanPolicy, session?: SessionRow | null): number {
  const explicit = policy.warmup_start_date;
  if (explicit) {
    const t = Date.parse(explicit);
    if (Number.isFinite(t)) return t;
  }
  const fallback = session?.phone_verified_at ?? session?.created_at;
  const t = fallback ? Date.parse(fallback) : Date.now();
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * Warm-up por dias: dia 1 = `warmup_day1_limit`, +un multiplo por dia hasta el
 * tope configurado. Delays largos al inicio que bajan progresivamente al valor
 * de la politica (dia 7 en adelante).
 */
export function warmupState(policy: AntiBanPolicy, startMs: number, nowMs = Date.now()): WarmupState {
  if (!policy.warmup_enabled) {
    return {
      enabled: false,
      day: 0,
      dailyLimit: policy.daily_limit,
      delayMin: policy.delay_min_seconds,
      delayMax: policy.delay_max_seconds,
      active: false,
    };
  }
  const day = Math.max(1, Math.floor((nowMs - startMs) / 86_400_000) + 1);
  const dailyLimit = Math.min(policy.daily_limit, policy.warmup_day1_limit * day);
  const progress = (day - 2) / 5; // dias 2..7 se acercan al valor de politica
  const delayMin = day <= 1 ? 180 : lerp(120, policy.delay_min_seconds, progress);
  const delayMax = day <= 1 ? 300 : lerp(180, policy.delay_max_seconds, progress);
  return {
    enabled: true,
    day,
    dailyLimit,
    delayMin: Math.min(delayMin, delayMax),
    delayMax: Math.max(delayMin, delayMax),
    active: dailyLimit < policy.daily_limit,
  };
}

function startOfLocalDayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Mensajes salientes de la sesion desde un instante (ISO). */
export function countSentSince(sessionId: string, sinceIso: string): number {
  const row = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM messages
     WHERE session_id = ? AND direction = 'out' AND occurred_at >= ?`,
    sessionId,
    sinceIso,
  );
  return row?.c ?? 0;
}

export interface LimitState extends WarmupState {
  dailyLimit: number;
  hourlyLimit: number;
  dailyUsed: number;
  hourlyUsed: number;
  dailyRemaining: number;
  hourlyRemaining: number;
}

/** Estado de limites (diario/horario + warm-up) de una sesion. */
export function limitState(sessionId: string, policy: AntiBanPolicy, session?: SessionRow | null): LimitState {
  const warm = warmupState(policy, warmupStartMs(policy, session));
  const dailyUsed = countSentSince(sessionId, startOfLocalDayIso());
  const hourlyUsed = countSentSince(sessionId, new Date(Date.now() - 3_600_000).toISOString());
  const dailyLimit = Math.min(policy.daily_limit, warm.dailyLimit);
  return {
    ...warm,
    dailyLimit,
    hourlyLimit: policy.hourly_limit,
    dailyUsed,
    hourlyUsed,
    dailyRemaining: Math.max(0, dailyLimit - dailyUsed),
    hourlyRemaining: Math.max(0, policy.hourly_limit - hourlyUsed),
  };
}

/** ¿Nunca hubo mensajes (en ninguna dirección) con ese chat en la sesión? */
export function isNewContact(sessionId: string, chatId: string): boolean {
  const row = get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM (SELECT 1 FROM messages WHERE session_id = ? AND chat_id = ? LIMIT 1)',
    sessionId,
    chatId,
  );
  return (row?.c ?? 0) === 0;
}

/**
 * Contactos nuevos escritos hoy: chats con algún envío hoy que no tenían
 * ningún mensaje antes de hoy. Escribir en frío a muchos números es la causa
 * principal de reportes y baneos.
 */
export function countNewContactsToday(sessionId: string): number {
  const since = startOfLocalDayIso();
  const row = get<{ c: number }>(
    `SELECT COUNT(DISTINCT m.chat_id) AS c FROM messages m
      WHERE m.session_id = ? AND m.direction = 'out' AND m.occurred_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM messages p
           WHERE p.session_id = m.session_id AND p.chat_id = m.chat_id AND p.occurred_at < ?
        )`,
    sessionId,
    since,
    since,
  );
  return row?.c ?? 0;
}

/**
 * Entregabilidad de un lote: entregados / enviados, considerando solo los
 * envíos con más de `settleMinutes` (los recientes aún no tienen acuse).
 */
export function batchDeliveryRate(batchId: number, settleMinutes = 10): { sent: number; delivered: number; rate: number } {
  const cutoff = new Date(Date.now() - settleMinutes * 60_000).toISOString();
  const row = get<{ sent: number; delivered: number }>(
    `SELECT COUNT(*) AS sent,
            SUM(CASE WHEN m.status IN ('delivered','read','played') THEN 1 ELSE 0 END) AS delivered
       FROM batch_items bi
       JOIN messages m ON m.wa_message_id = bi.message_id
      WHERE bi.batch_id = ? AND bi.message_id IS NOT NULL AND m.direction = 'out' AND m.occurred_at <= ?`,
    batchId,
    cutoff,
  );
  const sent = Number(row?.sent ?? 0);
  const delivered = Number(row?.delivered ?? 0);
  return { sent, delivered, rate: sent > 0 ? delivered / sent : 1 };
}

/**
 * Opciones de pacing efectivas (jitter, ventana y pausas) para el runner,
 * combinando la politica con el dia de warm-up actual.
 */
export function pacingOptionsFor(
  sessionId: string,
  policy: AntiBanPolicy,
  session?: SessionRow | null,
  programCooldownMinutes = 10,
): PacingOptions {
  const warm = warmupState(policy, warmupStartMs(policy, session));
  return {
    enabled: policy.active,
    delayMin: Math.max(5, warm.delayMin),
    delayMax: Math.max(5, warm.delayMax),
    windowDays: policy.window_days,
    windowStart: policy.window_start,
    windowEnd: policy.window_end,
    programCooldownMinutes,
    pausesEnabled: policy.pauses_enabled,
    pauseEvery: policy.pause_every,
    pauseMin: policy.pause_min_minutes * 60,
    pauseMax: policy.pause_max_minutes * 60,
  };
}
