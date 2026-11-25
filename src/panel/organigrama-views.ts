import type express from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { esc } from './layout.js';
import { emptyState, initials } from './views.js';
import { setFlash } from './flash.js';
import { sendPage } from './page.js';
import { positiveInt } from './urls.js';
import { getSede } from '../core/sedes.js';
import { esamEsAdmin, esamEsGerenteSede, findById, type UserRow } from '../auth/users.js';
import {
  asignarJefe,
  jefesValidos,
  metricasLeadsDeSede,
  organigramaDeSede,
  puedeEditarOrganigrama,
  type MetricasLeads,
  type NodoOrganigrama,
} from '../core/organigrama.js';

/**
 * Organigrama POR PERSONAS de una sede (PLAN_ORGANIGRAMA.md, L1).
 *
 * Se ve en la ficha de la sede (`/unidades/:u/sedes/:s`, Super Admin) y en
 * `/organigrama` (Gerente General, su sede). Con `?editar=1`, quien puede
 * editar ve en cada persona «Depende de» con los jefes válidos según /cargos.
 */

type AuthedRequest = Request & { user?: UserRow };

interface Opciones {
  /** URL de esta misma pantalla (para «Editar» / «Listo» y para volver después de guardar). */
  base: string;
  editar: boolean;
}

const sumar = (a: MetricasLeads, b: MetricasLeads): MetricasLeads => ({
  abiertos: a.abiertos + b.abiertos,
  sinContactar: a.sinContactar + b.sinContactar,
  sinMovimiento: a.sinMovimiento + b.sinMovimiento,
});
const CERO: MetricasLeads = { abiertos: 0, sinContactar: 0, sinMovimiento: 0 };

function conEditar(base: string, editar: boolean): string {
  const [ruta, query = ''] = base.split('?');
  const params = new URLSearchParams(query);
  if (editar) params.set('editar', '1');
  else params.delete('editar');
  const qs = params.toString();
  return `${ruta}${qs ? `?${qs}` : ''}#organigrama`;
}

export function renderOrganigramaPersonas(viewer: UserRow, sedeId: number, opts: Opciones): string {
  const { raices, sinJefe } = organigramaDeSede(sedeId);
  const puedeEditar = puedeEditarOrganigrama(viewer, sedeId);
  const editar = opts.editar && puedeEditar;
  const propias = metricasLeadsDeSede(sedeId);

  // Métricas del equipo (la persona + todo su subárbol), solo para Marketing.
  const delEquipo = new Map<number, MetricasLeads>();
  const acumular = (n: NodoOrganigrama): MetricasLeads => {
    const total = n.hijos.reduce((acc, h) => sumar(acc, acumular(h)), propias.get(n.id) ?? CERO);
    delEquipo.set(n.id, total);
    return total;
  };
  raices.forEach(acumular);
  sinJefe.forEach(acumular);

  const selector = (n: NodoOrganigrama): string => {
    const persona = findById(n.id);
    if (!persona) return '';
    const opciones = jefesValidos(persona);
    if (!opciones.length) {
      return n.cargo
        ? '<p class="op-hint">Su cargo no depende de otro en esta sede.</p>'
        : '<p class="op-hint">Asignale un cargo para ubicarlo.</p>';
    }
    return `<form method="post" action="/organigrama/jefe" class="op-form" data-op-form>
      <input type="hidden" name="user_id" value="${n.id}" />
      <input type="hidden" name="volver" value="${esc(conEditar(opts.base, true))}" />
      <label class="op-form-label" for="op-jefe-${n.id}">Depende de</label>
      <div class="op-form-row">
        <select class="form-select form-select-sm" id="op-jefe-${n.id}" name="jefe_id" data-op-auto>
          <option value="">Sin jefe asignado</option>
          ${opciones.map((j) => `<option value="${j.id}"${j.id === n.jefe_id ? ' selected' : ''}>${esc(j.name ?? j.username ?? '—')}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-soft-primary" type="submit" data-op-submit>Guardar</button>
      </div>
    </form>`;
  };

  const cifras = (n: NodoOrganigrama): string => {
    if (n.area !== 'Marketing') return '';
    const m = delEquipo.get(n.id) ?? CERO;
    const equipo = n.hijos.length > 0;
    return `<div class="op-metrics" title="${equipo ? 'Leads abiertos de su equipo (incluye los propios)' : 'Sus leads abiertos'}">
      <span><b>${m.abiertos}</b> ${equipo ? 'del equipo' : 'leads'}</span>
      ${m.sinContactar ? `<span class="op-warn"><b>${m.sinContactar}</b> sin contactar</span>` : ''}
      ${m.sinMovimiento ? `<span class="op-alert"><b>${m.sinMovimiento}</b> sin movimiento</span>` : ''}
    </div>`;
  };

  const tarjeta = (n: NodoOrganigrama, raiz: boolean): string => `
    <div class="op-node${raiz ? ' op-root' : ''}${n.area === 'Marketing' ? ' op-mkt' : ''}">
      <div class="op-node-head">
        <span class="avatar-xs rounded-circle av-${n.id % 8}" aria-hidden="true">${esc(initials(n.nombre))}</span>
        <div class="min-w-0">
          <div class="op-cargo">${esc(n.cargo ?? 'Sin cargo')}</div>
          <div class="op-name">${esc(n.nombre)}</div>
        </div>
      </div>
      ${cifras(n)}
      ${editar && !raiz ? selector(n) : ''}
    </div>`;

  // Los que solo tienen gente sin gente a cargo (p. ej. un supervisor con sus
  // asesores) se dibujan como lista vertical, como en un organigrama clásico.
  const rama = (n: NodoOrganigrama, raiz = false): string => {
    const hijos = n.hijos;
    let debajo = '';
    if (hijos.length) {
      const soloHojas = !raiz && hijos.every((h) => h.hijos.length === 0);
      debajo = soloHojas
        ? `<ul class="op-stack">${hijos.map((h) => `<li>${tarjeta(h, false)}</li>`).join('')}</ul>`
        : `<ul>${hijos.map((h) => rama(h)).join('')}</ul>`;
    }
    return `<li>${tarjeta(n, raiz)}${debajo}</li>`;
  };

  const accion = puedeEditar
    ? editar
      ? `<a class="btn btn-sm btn-primary" href="${esc(conEditar(opts.base, false))}"><i class="ri-check-line me-1" aria-hidden="true"></i>Listo</a>`
      : `<a class="btn btn-sm btn-soft-primary" href="${esc(conEditar(opts.base, true))}"><i class="ri-git-merge-line me-1" aria-hidden="true"></i>Editar dependencias</a>`
    : '';

  const arbol = raices.length
    ? `<div class="org-chart op-chart"><ul class="org-tree op-tree">${raices.map((r) => rama(r, true)).join('')}</ul></div>`
    : emptyState(
        'ri-organization-chart',
        'Falta el Gerente General',
        'El organigrama empieza en el Gerente General de la sede. Asigná ese cargo a una persona en la lista de usuarios.',
      );

  const bandeja = sinJefe.length
    ? `<section class="op-loose" aria-labelledby="op-loose-title">
        <div class="op-loose-head">
          <h6 id="op-loose-title"><i class="ri-user-unfollow-line" aria-hidden="true"></i> Sin jefe asignado <span class="ab-pill ab-warn">${sinJefe.length}</span></h6>
          <p>${editar ? 'Elegí de quién depende cada uno.' : 'Estas personas todavía no aparecen en el organigrama: sus jefes no ven sus leads.'}</p>
        </div>
        <div class="op-loose-grid">${sinJefe.map((n) => tarjeta(n, false)).join('')}</div>
      </section>`
    : '';

  return `<section class="op-wrap" id="organigrama">
    <div class="op-head">
      <div>
        <h5>Organigrama de personas</h5>
        <p>Quién depende de quién. Cada jefe ve los leads de su gente: el gerente de marketing, los de sus supervisores y asesores; cada supervisor, solo los de sus asesores.</p>
      </div>
      ${accion}
    </div>
    ${editar ? '<div class="op-editing"><i class="ri-information-line" aria-hidden="true"></i> Solo aparecen como opción los jefes válidos según «Cargos y organigrama». Cada cambio queda registrado.</div>' : ''}
    ${arbol}
    ${bandeja}
  </section>
  <script src="/assets/js/organigrama.js?v=1" defer></script>`;
}

/** Solo rutas internas del panel: nunca redirigir a otro sitio. */
function volverSeguro(valor: unknown, porDefecto: string): string {
  const v = String(valor ?? '');
  return /^\/(organigrama|unidades\/\d+\/sedes\/\d+)(\?[\w=&%-]*)?(#organigrama)?$/.test(v) ? v : porDefecto;
}

export function registerOrganigramaRoutes(app: express.Express, ctx: { requireUser: RequestHandler }): void {
  // Gerente General: el organigrama de SU sede. El Super Admin lo ve en /unidades.
  app.get('/organigrama', ctx.requireUser, (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user!;
    if (esamEsAdmin(user)) {
      res.redirect('/unidades');
      return;
    }
    if (!esamEsGerenteSede(user) || !user.sede_id) {
      res.status(403).send('No tenés acceso al organigrama.');
      return;
    }
    const sede = getSede(user.sede_id);
    sendPage(
      req,
      res,
      'Organigrama',
      'organigrama',
      renderOrganigramaPersonas(user, user.sede_id, { base: '/organigrama', editar: req.query.editar === '1' }),
      { subtitle: sede ? `Equipo de ${sede.name}.` : undefined, activeHref: '/organigrama' },
    );
  });

  app.post('/organigrama/jefe', ctx.requireUser, (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user!;
    const userId = positiveInt(req.body?.user_id);
    const jefeRaw = String(req.body?.jefe_id ?? '').trim();
    const jefeId = jefeRaw === '' ? null : positiveInt(jefeRaw);
    const volver = volverSeguro(req.body?.volver, '/organigrama');

    try {
      if (!userId) throw new Error('Persona no válida.');
      if (jefeRaw !== '' && !jefeId) throw new Error('Jefe no válido.');
      asignarJefe(user, userId, jefeId);
      const persona = findById(userId);
      const jefe = jefeId ? findById(jefeId) : null;
      setFlash(res, 'ok', jefe ? `${persona?.name ?? 'La persona'} ahora depende de ${jefe.name}.` : `${persona?.name ?? 'La persona'} quedó sin jefe asignado.`);
    } catch (err) {
      setFlash(res, 'error', (err as Error).message);
    }
    res.redirect(volver);
  });
}
