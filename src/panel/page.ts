import type { Request, Response } from 'express';
import type { UserRow } from '../auth/users.js';
import { renderLayout } from './layout.js';
import { takeFlash } from './flash.js';

export interface PageOptions {
  flash?: string;
  error?: string;
  subtitle?: string;
  restrictToSettings?: boolean;
  badges?: Record<string, number>;
  activeHref?: string;
  actions?: string;
}

type AuthedRequest = Request & { user?: UserRow };

/** Renderiza una página HTML consumiendo el aviso pendiente (si hay). */
export function pageHtml(req: Request, res: Response, title: string, active: string, body: string, opts: PageOptions = {}): string {
  const user = (req as AuthedRequest).user;
  if (!user) throw new Error('pageHtml requiere un usuario autenticado');
  const flash = takeFlash(req, res);
  return renderLayout(title, user, active, body, {
    ...opts,
    flash: flash?.kind === 'ok' ? flash.message : opts.flash,
    error: flash?.kind === 'error' ? flash.message : opts.error,
  });
}

export function sendPage(req: Request, res: Response, title: string, active: string, body: string, opts: PageOptions = {}): void {
  const user = (req as AuthedRequest).user;
  if (!user) {
    res.redirect('/login');
    return;
  }
  res.send(pageHtml(req, res, title, active, body, opts));
}
