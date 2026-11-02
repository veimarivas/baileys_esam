import type express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { esc, renderLayout } from './layout.js';
import { emptyState, fmtDate } from './views.js';
import {
  isNotificationCategory,
  listNotificationHistory,
  notificationCounts,
  unreadCounts,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationItem,
  type NotificationReadState,
} from '../core/notifications.js';
import type { UserRow } from '../auth/users.js';

/**
 * Historial de la campana. La campana muestra solo lo pendiente; esta vista
 * conserva todo (leído y no leído) con filtros por división y estado, para
 * revisar un aviso en detalle aunque ya se haya abierto.
 */

const PAGE_SIZE = 50;

const CATEGORY_META: Record<NotificationCategory, { label: string; icon: string; tone: string }> = {
  notes: { label: 'Notas y tareas', icon: 'ri-sticky-note-line', tone: 'info' },
  whatsapp: { label: 'WhatsApp', icon: 'ri-whatsapp-line', tone: 'warn' },
  batches: { label: 'Envíos', icon: 'ri-send-plane-line', tone: 'ok' },
  chats: { label: 'Conversaciones', icon: 'ri-chat-3-line', tone: 'info' },
  system: { label: 'Sistema', icon: 'ri-settings-3-line', tone: 'mute' },
};

interface HistoryFilters {
  category: NotificationCategory | 'all';
  state: NotificationReadState;
  page: number;
}

function q(req: Request, key: string): string {
  const v = req.query[key];
  return typeof v === 'string' ? v.trim() : '';
}

function readFilters(req: Request): HistoryFilters {
  const rawCat = q(req, 'cat');
  const rawState = q(req, 'estado');
  return {
    category: isNotificationCategory(rawCat) ? rawCat : 'all',
    state: rawState === 'unread' || rawState === 'read' ? rawState : 'all',
    page: Math.max(1, Math.floor(Number(q(req, 'p')) || 1)),
  };
}

function href(f: HistoryFilters, overrides: Partial<HistoryFilters> = {}): string {
  const merged = { ...f, ...overrides };
  const p = new URLSearchParams();
  if (merged.category !== 'all') p.set('cat', merged.category);
  if (merged.state !== 'all') p.set('estado', merged.state);
  if (merged.page > 1) p.set('p', String(merged.page));
  const query = p.toString();
  return `/notifications/history${query ? `?${query}` : ''}`;
}

function stateLabel(state: NotificationReadState): string {
  return state === 'unread' ? 'No leídas' : state === 'read' ? 'Leídas' : 'Todas';
}

function itemHtml(it: NotificationItem): string {
  const meta = CATEGORY_META[it.category] ?? CATEGORY_META.system;
  return `<li class="ab-log-item nh-item${it.read_at ? '' : ' nh-pending'}">
    <span class="ab-log-ic ab-${meta.tone}"><i class="${meta.icon}" aria-hidden="true"></i></span>
    <div class="ab-log-body">
      <div class="ab-log-title">${esc(it.title)}${it.read_at ? '' : ' <span class="nh-dot" title="Sin leer"></span>'}</div>
      ${it.body ? `<div class="ab-log-detail">${esc(it.body)}</div>` : ''}
      <div class="nh-meta">
        <span class="nh-tag ab-${meta.tone}"><i class="${meta.icon}" aria-hidden="true"></i>${esc(meta.label)}</span>
        ${it.actor_name ? `<span class="nh-actor"><i class="ri-user-3-line" aria-hidden="true"></i>${esc(it.actor_name)}</span>` : ''}
        <span class="nh-state ${it.read_at ? 'is-read' : 'is-unread'}">${it.read_at ? 'Leída' : 'Sin leer'}</span>
        ${it.link ? `<a class="nh-link" href="${esc(it.link)}">Abrir<i class="ri-arrow-right-up-line" aria-hidden="true"></i></a>` : ''}
      </div>
    </div>
    <time class="ab-log-time" datetime="${esc(it.created_at)}">${esc(fmtDate(it.created_at))}</time>
  </li>`;
}

function renderHistory(user: UserRow, f: HistoryFilters): string {
  const data = listNotificationHistory(user.id, {
    category: f.category,
    state: f.state,
    page: f.page,
    pageSize: PAGE_SIZE,
  });
  const counts = notificationCounts(user.id, f.state);
  const allCounts = notificationCounts(user.id, 'all');
  const unread = unreadCounts(user.id);
  const stateTotals: Record<NotificationReadState, number> = {
    all: allCounts.all,
    unread: unread.all,
    read: Math.max(0, allCounts.all - unread.all),
  };

  const catChip = (id: NotificationCategory | 'all', label: string, icon: string): string => {
    const n = counts[id];
    return `<a class="ab-filter${f.category === id ? ' on' : ''}" href="${href(f, { category: id, page: 1 })}">
      ${icon ? `<i class="${icon}" aria-hidden="true"></i>` : ''}${esc(label)} <span>${n}</span></a>`;
  };
  const stateChip = (id: NotificationReadState): string =>
    `<a class="ab-filter${f.state === id ? ' on' : ''}" href="${href(f, { state: id, page: 1 })}">${esc(stateLabel(id))}
      <span>${stateTotals[id]}</span></a>`;

  const list = data.items.length
    ? `<ol class="ab-log nh-list">${data.items.map(itemHtml).join('')}</ol>`
    : emptyState('ri-notification-off-line', 'Sin notificaciones', 'No hay avisos con los filtros elegidos.');

  const pager =
    data.pages > 1
      ? `<nav class="nh-pager" aria-label="Paginación del historial">
          <a class="btn btn-light btn-sm${data.page <= 1 ? ' disabled' : ''}" href="${href(f, { page: Math.max(1, data.page - 1) })}">
            <i class="ri-arrow-left-line me-1" aria-hidden="true"></i>Anterior</a>
          <span>Página ${data.page} de ${data.pages} · ${data.total} aviso${data.total === 1 ? '' : 's'}</span>
          <a class="btn btn-light btn-sm${data.page >= data.pages ? ' disabled' : ''}" href="${href(f, { page: Math.min(data.pages, data.page + 1) })}">
            Siguiente<i class="ri-arrow-right-line ms-1" aria-hidden="true"></i></a>
        </nav>`
      : `<div class="nh-count">${data.total} aviso${data.total === 1 ? '' : 's'} en total</div>`;

  return `<div class="ab-page nh-page">
    <div class="card ab-card"><div class="card-body">
      <div class="nh-toolbar">
        <div class="ab-filters">${catChip('all', 'Todas', '')}${NOTIFICATION_CATEGORIES.map((c) => catChip(c, CATEGORY_META[c].label, CATEGORY_META[c].icon)).join('')}</div>
        <div class="ab-filters nh-states">${stateChip('all')}${stateChip('unread')}${stateChip('read')}</div>
      </div>
      ${list}
      ${pager}
    </div></div>
  </div>`;
}

type Ctx = {
  requireUser: RequestHandler;
};

type AuthedRequest = Request & { user: UserRow };

export function registerNotificationRoutes(app: express.Express, ctx: Ctx): void {
  app.get('/notifications/history', ctx.requireUser, (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    const f = readFilters(req);
    res.send(
      renderLayout('Historial de notificaciones', user, '', renderHistory(user, f), {
        subtitle: 'Todos tus avisos, leídos y pendientes, con el detalle completo y filtros por división.',
      }),
    );
  });
}
