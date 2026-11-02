import type { NextFunction, Request, Response } from 'express';
import {
  ANTI_BAN_LINKS,
  AUDIT_CATS,
  BLACKLIST_SOURCES,
  MONITORING_TABS,
  REPORTS_TABS,
  antiBanUrl,
  auditUrl,
  isOneOf,
  monitoringUrl,
  noteStatusToSlug,
  notesUrl,
  notificationsHistoryUrl,
  positiveInt,
  reportsUrl,
  reportsUserUrl,
  templatesUrl,
  validSessionId,
  type AntiBanLinkSlug,
  type AntiBanTabSlug,
  type AuditCatSlug,
  type MonitoringTabSlug,
  type NotificationCategorySlug,
  type NotificationStateSlug,
  type PeriodSlug,
  type ReportsTabSlug,
} from './urls.js';

/**
 * Compatibilidad con las URLs viejas (`?tab=`, `?nota=`, `?edit=`, etc.).
 * Solo redirige GET de páginas: las APIs y los POST no se tocan. Los mensajes
 * `?ok=`/`?error=` se ignoran a propósito (ya no se muestran desde la URL).
 */

const OLD_PERIODS: Record<string, PeriodSlug> = {
  today: 'hoy',
  yesterday: 'ayer',
  '7d': '7d',
  '30d': '30d',
  month: 'mes',
  custom: 'rango',
};

const OLD_NOTE_STATUS = ['overdue', 'today', 'week', 'pinned', 'pending', 'derived', 'done', 'all'];

const OLD_NOTIFICATION_CATEGORIES: Record<string, NotificationCategorySlug> = {
  all: 'todas',
  notes: 'notas',
  whatsapp: 'whatsapp',
  batches: 'envios',
  chats: 'chats',
  system: 'sistema',
  todas: 'todas',
  notas: 'notas',
  envios: 'envios',
  sistema: 'sistema',
};

const OLD_NOTIFICATION_STATES: Record<string, NotificationStateSlug> = {
  all: 'todas',
  unread: 'sin-leer',
  read: 'leidas',
  todas: 'todas',
  'sin-leer': 'sin-leer',
  leidas: 'leidas',
};

function q(req: Request, key: string): string {
  const raw = req.query[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

function redirect(res: Response, req: Request, target: string): void {
  if (target === req.originalUrl) return;
  res.redirect(302, target);
}

function reportsFilters(req: Request) {
  return {
    programa: q(req, 'programa'),
    account: q(req, 'account'),
    area: q(req, 'area'),
    tipo: q(req, 'tipo'),
  };
}

export function legacyRedirects(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET') return next();

  // Anti-Baneo: pestañas, estado, área y fuente de la lista negra.
  if (req.path === '/anti-ban') {
    const tab = (isOneOf(q(req, 'tab'), ['monitoreo', 'politicas', 'lista-negra', 'bitacora'] as const)
      ? q(req, 'tab')
      : 'monitoreo') as AntiBanTabSlug;
    const estado = (isOneOf(q(req, 'estado'), ANTI_BAN_LINKS) ? q(req, 'estado') : 'todas') as AntiBanLinkSlug;
    const area = q(req, 'area').toLowerCase().slice(0, 60);
    const source = q(req, 'source');
    return redirect(
      res,
      req,
      antiBanUrl({
        tab,
        estado,
        area: area || undefined,
        source: isOneOf(source, BLACKLIST_SOURCES) ? source : undefined,
        q: q(req, 'q').slice(0, 200),
      }),
    );
  }

  // Seguimiento y Reportes.
  if (req.path === '/monitoring') {
    const tab = (isOneOf(q(req, 'tab'), MONITORING_TABS) ? q(req, 'tab') : 'pendientes') as MonitoringTabSlug;
    const period = OLD_PERIODS[q(req, 'period')] ?? (q(req, 'from') || q(req, 'to') ? 'rango' : 'hoy');
    const session = validSessionId(q(req, 'session')) ?? undefined;
    return redirect(res, req, monitoringUrl({ tab, period, session, from: q(req, 'from'), to: q(req, 'to') }));
  }
  if (req.path === '/reports') {
    const tab = (isOneOf(q(req, 'tab'), REPORTS_TABS) ? q(req, 'tab') : 'atencion') as ReportsTabSlug;
    const period = OLD_PERIODS[q(req, 'period')] ?? (q(req, 'from') || q(req, 'to') ? 'rango' : '30d');
    const session = validSessionId(q(req, 'session')) ?? undefined;
    return redirect(
      res,
      req,
      reportsUrl({ tab, period, session, from: q(req, 'from'), to: q(req, 'to'), ...reportsFilters(req) }),
    );
  }
  const userReport = /^\/reports\/users\/(\d+)\/?$/.exec(req.path);
  if (userReport) {
    const period = OLD_PERIODS[q(req, 'period')] ?? (q(req, 'from') || q(req, 'to') ? 'rango' : '30d');
    const session = validSessionId(q(req, 'session')) ?? undefined;
    return redirect(
      res,
      req,
      reportsUserUrl({
        id: Number(userReport[1]),
        period,
        session,
        from: q(req, 'from'),
        to: q(req, 'to'),
        ...reportsFilters(req),
      }),
    );
  }

  // Auditoría: la categoría pasa al path; búsqueda y fechas siguen en query.
  if (req.path === '/audit') {
    const cat = q(req, 'cat');
    if (isOneOf(cat, AUDIT_CATS)) {
      return redirect(
        res,
        req,
        auditUrl({
          cat: cat as AuditCatSlug,
          q: q(req, 'q').slice(0, 200),
          from: q(req, 'from'),
          to: q(req, 'to'),
          auto: q(req, 'auto') === '1',
          before: positiveInt(q(req, 'before')) ?? undefined,
        }),
      );
    }
  }

  // Plantillas: el editor seleccionado pasa al path.
  if (req.path === '/templates') {
    const id = positiveInt(q(req, 'edit'));
    if (id) return redirect(res, req, templatesUrl({ id, cat: q(req, 'cat'), q: q(req, 'q').slice(0, 200) }));
  }

  // Notas: nota abierta o filtro de estado.
  if (req.path === '/notes') {
    const nota = positiveInt(q(req, 'nota'));
    if (nota) return redirect(res, req, notesUrl({ id: nota }));
    const status = q(req, 'status');
    if (OLD_NOTE_STATUS.includes(status)) return redirect(res, req, notesUrl({ status: noteStatusToSlug(status) }));
  }

  // Historial de notificaciones.
  if (req.path === '/notifications/history') {
    const rawCat = q(req, 'cat');
    const rawState = q(req, 'estado');
    const page = positiveInt(q(req, 'p'));
    const category = OLD_NOTIFICATION_CATEGORIES[rawCat];
    const state = OLD_NOTIFICATION_STATES[rawState];
    if (category || state || page) {
      return redirect(res, req, notificationsHistoryUrl({ category, state, page: page ?? 1 }));
    }
  }

  next();
}
