import type express from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { esc } from './layout.js';
import { initials } from './views.js';
import { setFlash } from './flash.js';
import { pageHtml, sendPage } from './page.js';
import { positiveInt } from './urls.js';
import type { UserRow } from '../auth/users.js';
import { ETAPA_LABEL, ETAPAS, esEtapa, moverEtapa, type Etapa } from '../core/leads.js';
import {
  agruparPorEtapa,
  detalleLead,
  listarLeads,
  personasVisibles,
  programasVisibles,
  type DetalleLead,
  type FiltrosLeads,
  type TarjetaLead,
} from '../core/leads-vista.js';
import { DIAS_SIN_MOVIMIENTO } from '../core/organigrama.js';

/**
 * /leads — «Leads de marketing» (PLAN_ORGANIGRAMA.md, L3).
 *
 * Tablero con las cinco etapas. El servidor lo arma con los filtros de la URL
 * (funciona sin JavaScript); `leads.js` agrega arrastrar entre columnas y la
 * ficha en un panel lateral. Lo que se ve lo recorta `alcanceLeads`: el asesor,
 * lo suyo; cada jefe, lo de su gente (y solo mira: la etapa la mueve el dueño).
 */

type AuthedRequest = Request & { user?: UserRow };

const COLOR_ETAPA: Record<Etapa, string> = {
  nuevo: '#64748b',
  contactado: '#2e90b5',
  interesado: '#b45309',
  no_interesado: '#9ca3af',
  inscrito: '#0f7b55',
};

function hace(iso: string | null, ahora: Date): string {
  if (!iso) return '';
  const min = Math.max(0, Math.round((ahora.getTime() - new Date(iso).getTime()) / 60000));
  if (min < 60) return min < 1 ? 'recién' : `hace ${min} min`;
  const horas = Math.round(min / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.round(horas / 24);
  return dias === 1 ? 'ayer' : `hace ${dias} días`;
}

function fechaHora(iso: string): string {
  return new Date(iso).toLocaleString('es-BO', { timeZone: 'America/La_Paz', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function filtrosDe(req: Request): FiltrosLeads {
  const txt = (k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]).trim() : '');
  const filtro = txt('filtro');
  const origen = txt('origen');
  return {
    persona: positiveInt(req.query.persona),
    programa: txt('programa') || null,
    filtro: filtro === 'sin_contactar' || filtro === 'sin_movimiento' ? filtro : null,
    origen: origen === 'prospecto' || origen === 'linea' ? origen : null,
    q: txt('q').slice(0, 80) || null,
  };
}

function urlCon(f: FiltrosLeads, cambio: Partial<FiltrosLeads>): string {
  const todo = { ...f, ...cambio };
  const p = new URLSearchParams();
  if (todo.persona) p.set('persona', String(todo.persona));
  if (todo.programa) p.set('programa', todo.programa);
  if (todo.filtro) p.set('filtro', todo.filtro);
  if (todo.origen) p.set('origen', todo.origen);
  if (todo.q) p.set('q', todo.q);
  const qs = p.toString();
  return `/leads${qs ? `?${qs}` : ''}`;
}

function tarjeta(t: TarjetaLead, verDueno: boolean, ahora: Date): string {
  const alertas = [
    t.sin_contactar ? '<span class="ld-flag ld-flag-warn">Sin contactar</span>' : '',
    t.sin_movimiento ? `<span class="ld-flag ld-flag-alert">${esc(hace(t.ultima_actividad_at, ahora).replace('hace ', ''))} sin movimiento</span>` : '',
  ].join('');
  return `<article class="ld-card${t.propio ? ' is-own' : ''}" data-lead="${t.id}" data-etapa="${t.etapa}"${t.propio ? ' draggable="true"' : ''}>
    <a class="ld-card-link" href="/leads/${t.id}" data-ld-open="${t.id}">
      <span class="ld-card-top">
        <span class="ld-card-name">${esc(t.nombre)}</span>
        <span class="ld-origin ld-origin-${t.origen}" title="${t.origen === 'prospecto' ? 'Registrado en cronogramas' : 'Escribió a la línea'}">${t.origen === 'prospecto' ? 'Prospecto' : 'WhatsApp'}</span>
      </span>
      ${t.programa ? `<span class="ld-card-prog">${esc(t.programa)}</span>` : ''}
      <span class="ld-card-meta">
        ${t.telefono ? `<span class="ff-monospace">${esc(t.telefono)}</span>` : ''}
        <span>${t.ultimo_contacto_at ? `Contacto ${esc(hace(t.ultimo_contacto_at, ahora))}` : 'Aún sin contacto'}</span>
      </span>
      ${alertas ? `<span class="ld-card-flags">${alertas}</span>` : ''}
      ${verDueno ? `<span class="ld-card-owner"><span class="avatar-xs rounded-circle av-${t.owner_user_id % 8}">${esc(initials(t.owner_name))}</span>${esc(t.owner_name)}</span>` : ''}
    </a>
  </article>`;
}

export function renderLeadsBoard(viewer: UserRow, f: FiltrosLeads, ahora: Date = new Date()): string {
  const { tarjetas, truncado } = listarLeads(viewer, f, ahora);
  const grupos = agruparPorEtapa(tarjetas);
  const programas = programasVisibles(viewer);
  const personas = personasVisibles(viewer);
  const verDueno = tarjetas.some((t) => !t.propio);
  const sinContactar = tarjetas.filter((t) => t.sin_contactar).length;
  const sinMovimiento = tarjetas.filter((t) => t.sin_movimiento).length;

  const chip = (valor: FiltrosLeads['filtro'], texto: string, n?: number) =>
    `<a class="ld-chip${f.filtro === valor ? ' on' : ''}" href="${esc(urlCon(f, { filtro: valor }))}">${texto}${n !== undefined ? ` <b>${n}</b>` : ''}</a>`;

  const columnas = ETAPAS.map((etapa) => {
    const lista = grupos[etapa];
    return `<section class="ld-col" data-col="${etapa}" aria-label="${ETAPA_LABEL[etapa]}">
      <header class="ld-col-head" style="--ld-col:${COLOR_ETAPA[etapa]}">
        <span class="ld-col-dot" aria-hidden="true"></span>
        <h6>${ETAPA_LABEL[etapa]}</h6>
        <span class="ld-col-count">${lista.length}</span>
      </header>
      <div class="ld-col-body" data-drop="${etapa}">
        ${lista.length ? lista.map((t) => tarjeta(t, verDueno, ahora)).join('') : '<p class="ld-col-empty">Sin leads</p>'}
      </div>
    </section>`;
  }).join('');

  const vacio = tarjetas.length === 0;
  const hayFiltros = !!(f.programa || f.filtro || f.origen || f.q || f.persona);

  return `<div class="ld-page" id="ld-page">
    <form class="ld-toolbar" method="get" action="/leads" role="search">
      <label class="ld-search">
        <i class="ri-search-line" aria-hidden="true"></i>
        <input type="search" name="q" value="${esc(f.q ?? '')}" placeholder="Nombre, número o programa" aria-label="Buscar leads" />
      </label>
      ${personas.length > 1 ? `<select class="form-select form-select-sm" name="persona" aria-label="Asesor" data-ld-auto>
        <option value="">Todo mi equipo</option>
        ${personas.map((p) => `<option value="${p.id}"${p.id === f.persona ? ' selected' : ''}>${p.id === viewer.id ? 'Mis leads' : esc(p.nombre)}</option>`).join('')}
      </select>` : ''}
      <select class="form-select form-select-sm" name="programa" aria-label="Programa" data-ld-auto>
        <option value="">Todos los programas</option>
        ${programas.map((p) => `<option value="${esc(p)}"${p === f.programa ? ' selected' : ''}>${esc(p)}</option>`).join('')}
      </select>
      <select class="form-select form-select-sm" name="origen" aria-label="Origen" data-ld-auto>
        <option value="">Todos los orígenes</option>
        <option value="prospecto"${f.origen === 'prospecto' ? ' selected' : ''}>Solo prospectos</option>
        <option value="linea"${f.origen === 'linea' ? ' selected' : ''}>Solo WhatsApp</option>
      </select>
      ${f.filtro ? `<input type="hidden" name="filtro" value="${esc(f.filtro)}" />` : ''}
      <button class="btn btn-sm btn-soft-primary" type="submit" data-ld-submit>Filtrar</button>
      ${hayFiltros ? '<a class="btn btn-sm btn-link" href="/leads">Limpiar</a>' : ''}
    </form>

    <div class="ld-chips" role="group" aria-label="Atajos">
      ${chip(null, 'Todos', tarjetas.length)}
      ${chip('sin_contactar', 'Sin contactar', f.filtro ? undefined : sinContactar)}
      ${chip('sin_movimiento', `Sin movimiento (${DIAS_SIN_MOVIMIENTO}+ días)`, f.filtro ? undefined : sinMovimiento)}
    </div>

    ${vacio && !hayFiltros
      ? `<div class="ld-empty">
          <i class="ri-user-star-line" aria-hidden="true"></i>
          <h5>Todavía no tenés leads</h5>
          <p>Aparecen solos: cuando alguien te escribe por primera vez a tu línea de WhatsApp, o cuando registrás un prospecto en cronogramas.</p>
        </div>`
      : `<div class="ld-board" id="ld-board">${columnas}</div>
         ${truncado ? '<p class="ld-note">Se muestran los 400 más recientes. Usá los filtros para ver el resto.</p>' : ''}`}

    <aside class="ld-drawer" id="ld-drawer" hidden aria-label="Ficha del lead">
      <div class="ld-drawer-inner" id="ld-drawer-body"></div>
    </aside>
    <div class="ld-backdrop" id="ld-backdrop" hidden></div>
  </div>
  <script src="/assets/js/leads.js?v=1" defer></script>`;
}

export function renderLeadDetalle(viewer: UserRow, d: DetalleLead, ahora: Date = new Date(), enPanel = false): string {
  const t = d.tarjeta;
  const etapa = t.propio
    ? `<form method="post" action="/leads/${t.id}/etapa" class="ld-stage-form" data-ld-stage>
        <label class="form-label" for="ld-etapa-${t.id}">Etapa</label>
        <div class="ld-stage-row">
          <select class="form-select form-select-sm" id="ld-etapa-${t.id}" name="etapa">
            ${ETAPAS.map((e) => `<option value="${e}"${e === t.etapa ? ' selected' : ''}>${ETAPA_LABEL[e]}</option>`).join('')}
          </select>
          <button class="btn btn-sm btn-primary" type="submit">Mover</button>
        </div>
      </form>`
    : `<div class="ld-stage-ro"><span class="ld-stage-pill" style="--ld-col:${COLOR_ETAPA[t.etapa]}">${ETAPA_LABEL[t.etapa]}</span>
        <small>La etapa la mueve ${esc(t.owner_name)}.</small></div>`;

  const mensajes = d.mensajes.length
    ? d.mensajes.map((m) => `<div class="ld-msg ld-msg-${m.direction}">
        <div class="ld-msg-body">${m.body ? esc(m.body) : `<i>[${esc(m.content_type)}]</i>`}</div>
        <time>${esc(fechaHora(m.occurred_at))}</time>
      </div>`).join('')
    : '<p class="ld-muted">Todavía no hay mensajes con esta persona en la línea.</p>';

  const eventoTexto = (e: DetalleLead['eventos'][number]): string => {
    if (e.tipo === 'etapa') {
      const de = esEtapa(e.de) ? ETAPA_LABEL[e.de] : e.de;
      const a = esEtapa(e.a) ? ETAPA_LABEL[e.a] : e.a;
      return `${esc(e.autor ?? 'Cronogramas')} lo movió de <b>${esc(de ?? '—')}</b> a <b>${esc(a ?? '—')}</b>${e.texto ? ` · ${esc(e.texto)}` : ''}`;
    }
    return esc(e.texto ?? e.tipo);
  };

  return `<div class="ld-detail">
    <header class="ld-detail-head">
      <span class="avatar-sm rounded-circle av-${t.id % 8}" aria-hidden="true">${esc(initials(t.nombre))}</span>
      <div class="min-w-0">
        <h4>${esc(t.nombre)}</h4>
        <p>${t.telefono ? `<span class="ff-monospace">${esc(t.telefono)}</span> · ` : ''}${t.origen === 'prospecto' ? 'Prospecto de cronogramas' : 'Escribió a la línea'}${t.programa ? ` · ${esc(t.programa)}` : ''}</p>
      </div>
      ${enPanel ? '<button type="button" class="btn-close" data-ld-close aria-label="Cerrar"></button>' : ''}
    </header>
    <div class="ld-detail-facts">
      <div><span>Asesor</span><b>${esc(t.owner_name)}</b></div>
      <div><span>Último contacto</span><b>${t.ultimo_contacto_at ? esc(hace(t.ultimo_contacto_at, ahora)) : 'Sin contacto'}</b></div>
      <div><span>Última actividad</span><b>${esc(hace(t.ultima_actividad_at, ahora))}</b></div>
    </div>
    ${etapa}
    <section class="ld-section">
      <div class="ld-section-head"><h6>Conversación</h6>
        ${t.propio && t.chat_id ? `<a class="btn btn-sm btn-soft-primary" href="/conversations/${encodeURIComponent(t.chat_id)}"><i class="ri-chat-3-line me-1" aria-hidden="true"></i>Responder</a>` : ''}
      </div>
      <div class="ld-thread">${mensajes}</div>
    </section>
    <section class="ld-section">
      <div class="ld-section-head"><h6>Historial</h6></div>
      <ul class="ld-timeline">
        ${d.eventos.map((e) => `<li><time>${esc(fechaHora(e.created_at))}</time><span>${eventoTexto(e)}</span></li>`).join('') || '<li class="ld-muted">Sin movimientos.</li>'}
      </ul>
    </section>
  </div>`;
}

export function registerLeadsRoutes(
  app: express.Express,
  ctx: { requireUser: RequestHandler; requireSection: (section: string) => RequestHandler },
): void {
  const guard = [ctx.requireUser, ctx.requireSection('leads')];

  app.get('/leads', ...guard, (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user!;
    sendPage(req, res, 'Leads', 'leads', renderLeadsBoard(user, filtrosDe(req)), {
      subtitle: 'Tus leads de marketing por etapa. Arrastrá una tarjeta para moverla; tocála para ver la conversación.',
      activeHref: '/leads',
    });
  });

  const noEncontrado = (req: Request, res: Response) =>
    res.status(404).send(pageHtml(req, res, 'Lead no encontrado', 'leads',
      '<div class="ld-empty"><i class="ri-user-unfollow-line" aria-hidden="true"></i><h5>Lead no encontrado</h5><p>No existe o no es de tu equipo.</p><a class="btn btn-primary btn-sm" href="/leads">Volver a Leads</a></div>',
      { activeHref: '/leads' }));

  app.get('/leads/:id/panel', ...guard, (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user!;
    const id = positiveInt(req.params.id);
    const d = id ? detalleLead(user, id) : undefined;
    if (!d) {
      res.status(404).send('<p class="ld-muted p-3">Lead no encontrado.</p>');
      return;
    }
    res.send(renderLeadDetalle(user, d, new Date(), true));
  });

  app.get('/leads/:id', ...guard, (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user!;
    const id = positiveInt(req.params.id);
    const d = id ? detalleLead(user, id) : undefined;
    if (!d) {
      noEncontrado(req, res);
      return;
    }
    sendPage(req, res, d.tarjeta.nombre, 'leads', `<div class="ld-detail-page"><a class="ld-back" href="/leads"><i class="ri-arrow-left-line" aria-hidden="true"></i> Leads</a>${renderLeadDetalle(user, d)}</div>`, {
      activeHref: '/leads',
    });
  });

  app.post('/leads/:id/etapa', ...guard, (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user!;
    const id = positiveInt(req.params.id);
    const etapa = String(req.body?.etapa ?? '');
    const json = /application\/json/i.test(String(req.headers.accept ?? ''));
    try {
      if (!id) throw new Error('Lead no encontrado.');
      const lead = moverEtapa(user.id, id, etapa);
      if (json) {
        res.json({ ok: true, etapa: lead.etapa, label: ETAPA_LABEL[lead.etapa] });
        return;
      }
      setFlash(res, 'ok', `Movido a «${ETAPA_LABEL[lead.etapa]}».`);
      res.redirect(`/leads/${id}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (json) {
        res.status(msg === 'Lead no encontrado.' ? 404 : 422).json({ error: msg });
        return;
      }
      setFlash(res, 'error', msg);
      res.redirect(id ? `/leads/${id}` : '/leads');
    }
  });
}
