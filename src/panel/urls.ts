import type { PeriodPreset } from '../core/followup.js';
import type { NotificationCategory, NotificationReadState } from '../core/notifications.js';

/**
 * Constructores y validadores de las URLs limpias del panel.
 *
 * Regla: la navegación (pestañas, entidades seleccionadas, páginas) va en el
 * path; la búsqueda, los rangos de fecha y los filtros opcionales van en query.
 * Todo valor dinámico se codifica acá una sola vez.
 */

export type AntiBanTabSlug = 'monitoreo' | 'politicas' | 'lista-negra' | 'bitacora';
export type AntiBanLinkSlug = 'todas' | 'vinculadas' | 'sin-vincular';
export type MonitoringTabSlug = 'pendientes' | 'actividad' | 'numeros';
export type ReportsTabSlug = 'atencion' | 'equipo' | 'seguimiento' | 'envios' | 'masivos';
export type PeriodSlug = 'hoy' | 'ayer' | '7d' | '30d' | 'mes' | 'rango';
export type AuditCatSlug = 'conexiones' | 'lotes' | 'anti-baneo' | 'lista-negra' | 'cuentas' | 'contenido';
export type NoteStatusSlug = 'vencidas' | 'hoy' | 'semana' | 'importantes' | 'pendientes' | 'derivadas' | 'resueltas' | 'todas';
export type NotificationCategorySlug = 'todas' | 'notas' | 'whatsapp' | 'envios' | 'chats' | 'sistema';
export type NotificationStateSlug = 'todas' | 'sin-leer' | 'leidas';

export const ANTI_BAN_TABS: AntiBanTabSlug[] = ['monitoreo', 'politicas', 'lista-negra', 'bitacora'];
export const ANTI_BAN_LINKS: AntiBanLinkSlug[] = ['todas', 'vinculadas', 'sin-vincular'];
export const MONITORING_TABS: MonitoringTabSlug[] = ['pendientes', 'actividad', 'numeros'];
export const REPORTS_TABS: ReportsTabSlug[] = ['atencion', 'equipo', 'seguimiento', 'envios', 'masivos'];
export const PERIOD_SLUGS: PeriodSlug[] = ['hoy', 'ayer', '7d', '30d', 'mes', 'rango'];
export const AUDIT_CATS: AuditCatSlug[] = ['conexiones', 'lotes', 'anti-baneo', 'lista-negra', 'cuentas', 'contenido'];
export const NOTE_STATUSES: NoteStatusSlug[] = ['vencidas', 'hoy', 'semana', 'importantes', 'pendientes', 'derivadas', 'resueltas', 'todas'];
export const NOTIFICATION_CATEGORY_SLUGS: NotificationCategorySlug[] = ['todas', 'notas', 'whatsapp', 'envios', 'chats', 'sistema'];
export const NOTIFICATION_STATE_SLUGS: NotificationStateSlug[] = ['todas', 'sin-leer', 'leidas'];
export const BLACKLIST_SOURCES = ['manual', 'reply', 'blocked'] as const;

const PERIOD_TO_SLUG: Record<PeriodPreset, PeriodSlug> = {
  today: 'hoy',
  yesterday: 'ayer',
  '7d': '7d',
  '30d': '30d',
  month: 'mes',
  custom: 'rango',
};

const SLUG_TO_PERIOD: Record<PeriodSlug, PeriodPreset> = {
  hoy: 'today',
  ayer: 'yesterday',
  '7d': '7d',
  '30d': '30d',
  mes: 'month',
  rango: 'custom',
};

const NOTE_STATUS_TO_SLUG: Record<string, NoteStatusSlug> = {
  overdue: 'vencidas',
  today: 'hoy',
  week: 'semana',
  pinned: 'importantes',
  pending: 'pendientes',
  derived: 'derivadas',
  done: 'resueltas',
  all: 'todas',
};

const SLUG_TO_NOTE_STATUS: Record<NoteStatusSlug, string> = {
  vencidas: 'overdue',
  hoy: 'today',
  semana: 'week',
  importantes: 'pinned',
  pendientes: 'pending',
  derivadas: 'derived',
  resueltas: 'done',
  todas: 'all',
};

const NOTIFICATION_CATEGORY_TO_SLUG: Record<NotificationCategory | 'all', NotificationCategorySlug> = {
  all: 'todas',
  notes: 'notas',
  whatsapp: 'whatsapp',
  batches: 'envios',
  chats: 'chats',
  system: 'sistema',
};

const SLUG_TO_NOTIFICATION_CATEGORY: Record<NotificationCategorySlug, NotificationCategory | 'all'> = {
  todas: 'all',
  notas: 'notes',
  whatsapp: 'whatsapp',
  envios: 'batches',
  chats: 'chats',
  sistema: 'system',
};

const NOTIFICATION_STATE_TO_SLUG: Record<NotificationReadState, NotificationStateSlug> = {
  all: 'todas',
  unread: 'sin-leer',
  read: 'leidas',
};

const SLUG_TO_NOTIFICATION_STATE: Record<NotificationStateSlug, NotificationReadState> = {
  todas: 'all',
  'sin-leer': 'unread',
  leidas: 'read',
};

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

export function positiveInt(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** IDs de sesión (UUID de Baileys o nombres creados a mano). */
export function validSessionId(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

/** Agrega solo parámetros con valor y los codifica. */
export function withQuery(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): string {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === false || value === '') continue;
    p.set(key, String(value));
  }
  const query = p.toString();
  return query ? `${path}?${query}` : path;
}

export function periodToSlug(preset: PeriodPreset): PeriodSlug {
  return PERIOD_TO_SLUG[preset] ?? 'hoy';
}

export function slugToPeriod(slug: PeriodSlug): PeriodPreset {
  return SLUG_TO_PERIOD[slug];
}

export function noteStatusToSlug(status: string): NoteStatusSlug {
  return NOTE_STATUS_TO_SLUG[status] ?? 'todas';
}

export function slugToNoteStatus(slug: NoteStatusSlug): string {
  return SLUG_TO_NOTE_STATUS[slug];
}

export function notificationCategorySlug(category: NotificationCategory | 'all'): NotificationCategorySlug {
  return NOTIFICATION_CATEGORY_TO_SLUG[category];
}

export function slugToNotificationCategory(slug: NotificationCategorySlug): NotificationCategory | 'all' {
  return SLUG_TO_NOTIFICATION_CATEGORY[slug];
}

export function notificationStateSlug(state: NotificationReadState): NotificationStateSlug {
  return NOTIFICATION_STATE_TO_SLUG[state];
}

export function slugToNotificationState(slug: NotificationStateSlug): NotificationReadState {
  return SLUG_TO_NOTIFICATION_STATE[slug];
}

export interface AntiBanUrlOptions {
  tab?: AntiBanTabSlug;
  estado?: AntiBanLinkSlug;
  /** Clave del área ya normalizada; `sin-area` para las que no tienen área. */
  area?: string;
  source?: string;
  q?: string;
}

export function antiBanUrl(opts: AntiBanUrlOptions = {}): string {
  const tab = opts.tab ?? 'monitoreo';
  let path = '/anti-ban';
  if (tab === 'monitoreo') {
    path += '/monitoreo';
    const estado = opts.estado && opts.estado !== 'todas' ? opts.estado : '';
    if (estado) path += `/${estado}`;
    if (opts.area) {
      if (!estado) path += '/todas';
      path += `/${encodeURIComponent(opts.area)}`;
    }
  } else {
    path += `/${tab}`;
    if (tab === 'lista-negra' && isOneOf(opts.source, BLACKLIST_SOURCES)) path += `/${opts.source}`;
  }
  return withQuery(path, { q: tab === 'lista-negra' ? opts.q : undefined });
}

export interface MonitoringUrlOptions {
  tab?: MonitoringTabSlug;
  period?: PeriodSlug;
  session?: string;
  from?: string;
  to?: string;
}

export function monitoringUrl(opts: MonitoringUrlOptions = {}): string {
  const tab = opts.tab ?? 'pendientes';
  const period = opts.period ?? 'hoy';
  let path = `/monitoring/${tab}/${period}`;
  if (opts.session) path += `/${encodeURIComponent(opts.session)}`;
  return withQuery(path, { from: period === 'rango' ? opts.from : undefined, to: period === 'rango' ? opts.to : undefined });
}

export interface ReportsUrlOptions {
  tab?: ReportsTabSlug;
  period?: PeriodSlug;
  session?: string;
  from?: string;
  to?: string;
  programa?: string;
  account?: string;
  area?: string;
  tipo?: string;
}

export function reportsUrl(opts: ReportsUrlOptions = {}): string {
  const tab = opts.tab ?? 'atencion';
  const period = opts.period ?? '30d';
  let path = `/reports/${tab}/${period}`;
  if (opts.session) path += `/${encodeURIComponent(opts.session)}`;
  return withQuery(path, {
    from: period === 'rango' ? opts.from : undefined,
    to: period === 'rango' ? opts.to : undefined,
    programa: opts.programa,
    account: opts.account,
    area: opts.area,
    tipo: opts.tipo,
  });
}

export interface ReportsUserUrlOptions extends Omit<ReportsUrlOptions, 'tab'> {
  id: number | string;
}

export function reportsUserUrl(opts: ReportsUserUrlOptions): string {
  const period = opts.period ?? '30d';
  let path = `/reports/users/${encodeURIComponent(String(opts.id))}/${period}`;
  if (opts.session) path += `/${encodeURIComponent(opts.session)}`;
  return withQuery(path, {
    from: period === 'rango' ? opts.from : undefined,
    to: period === 'rango' ? opts.to : undefined,
    programa: opts.programa,
    account: opts.account,
    area: opts.area,
    tipo: opts.tipo,
  });
}

export interface AuditUrlOptions {
  cat?: AuditCatSlug | '';
  q?: string;
  from?: string;
  to?: string;
  auto?: boolean;
  before?: number;
}

export function auditUrl(opts: AuditUrlOptions = {}): string {
  const path = `/audit${opts.cat ? `/${opts.cat}` : ''}`;
  return withQuery(path, { q: opts.q, from: opts.from, to: opts.to, auto: opts.auto, before: opts.before });
}

export interface TemplatesUrlOptions {
  id?: number;
  cat?: string;
  q?: string;
}

export function templatesUrl(opts: TemplatesUrlOptions = {}): string {
  const path = `/templates${opts.id ? `/${opts.id}` : ''}`;
  return withQuery(path, { cat: opts.cat, q: opts.q });
}

export interface NotesUrlOptions {
  id?: number;
  status?: NoteStatusSlug;
}

export function notesUrl(opts: NotesUrlOptions = {}): string {
  if (opts.id) return `/notes/${opts.id}`;
  if (opts.status && opts.status !== 'todas') return `/notes/estado/${opts.status}`;
  return '/notes';
}

export interface NotificationsHistoryUrlOptions {
  category?: NotificationCategorySlug;
  state?: NotificationStateSlug;
  page?: number;
}

export function notificationsHistoryUrl(opts: NotificationsHistoryUrlOptions = {}): string {
  const category = opts.category ?? 'todas';
  const state = opts.state ?? 'todas';
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  let path = '/notifications/history';
  if (category !== 'todas' || state !== 'todas' || page > 1) path += `/${category}`;
  if (state !== 'todas' || page > 1) path += `/${state}`;
  if (page > 1) path += `/${page}`;
  return path;
}
