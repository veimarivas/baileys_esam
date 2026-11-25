import type express from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { esc } from './layout.js';
import { setFlash } from './flash.js';
import { sendPage } from './page.js';
import { positiveInt } from './urls.js';
import type { UserRow } from '../auth/users.js';
import {
  actualizarPrograma,
  alternarPrograma,
  borrarPrograma,
  bs,
  crearPrograma,
  enCuotas,
  leadsPorPrograma,
  programasDeSede,
  sedesEditables,
  TIPO_LABEL,
  TIPO_PLURAL,
  TIPOS_PROGRAMA,
  totalCredito,
  type Programa,
  type ProgramaInput,
} from '../core/programas.js';

/**
 * /programas — oferta de programas de cada sede (cursos, diplomados,
 * especialidades y maestrías) con precio al contado y a crédito.
 * Super Admin: todas las sedes. Gerente General y Gerente de Marketing: las suyas.
 */

type AuthedRequest = Request & { user?: UserRow };

const ICONO_TIPO: Record<string, string> = {
  curso: 'ri-book-open-line',
  diplomado: 'ri-award-line',
  especialidad: 'ri-medal-line',
  maestria: 'ri-graduation-cap-line',
};

/** Monto en bolivianos para el formulario («1500,50»), vacío si no hay. */
function montoForm(centavos: number | null): string {
  if (centavos === null) return '';
  return centavos % 100 ? (centavos / 100).toFixed(2).replace('.', ',') : String(centavos / 100);
}

function datosEdicion(p: Programa): string {
  const d = {
    id: p.id, tipo: p.tipo, nombre: p.nombre,
    contado: montoForm(p.contado_centavos),
    matricula: montoForm(p.matricula_centavos), matriculaCuotas: p.matricula_cuotas,
    colegiatura: montoForm(p.colegiatura_centavos), colegiaturaCuotas: p.colegiatura_cuotas,
    certificacion: montoForm(p.certificacion_centavos), certificacionCuotas: p.certificacion_cuotas,
  };
  return esc(JSON.stringify(d));
}

export function renderProgramas(viewer: UserRow, sedeId: number): string {
  const sedes = sedesEditables(viewer);
  const programas = programasDeSede(sedeId);
  const usados = leadsPorPrograma(sedeId);
  const volver = `/programas?sede=${sedeId}`;

  const selector = sedes.length > 1
    ? `<div class="pg-sedes" role="group" aria-label="Sede">${sedes.map((s) =>
        `<a class="ld-chip${s.id === sedeId ? ' on' : ''}" href="/programas?sede=${s.id}">${esc(s.nombre)}</a>`).join('')}</div>`
    : '';

  const secciones = TIPOS_PROGRAMA.map((tipo) => {
    const lista = programas.filter((p) => p.tipo === tipo);
    const filas = lista.map((p) => {
      const credito = totalCredito(p);
      const n = usados.get(p.id) ?? 0;
      return `<tr class="${p.activo ? '' : 'is-off'}">
        <td data-label="Programa"><b>${esc(p.nombre)}</b>${p.activo ? '' : ' <span class="ab-pill ab-mute">En pausa</span>'}</td>
        <td data-label="Contado" class="pg-money">${bs(p.contado_centavos)}</td>
        <td data-label="Matrícula"><span class="pg-money">${bs(p.matricula_centavos)}</span><small>${p.matricula_centavos === null ? '' : enCuotas(p.matricula_centavos, p.matricula_cuotas)}</small></td>
        <td data-label="Colegiatura"><span class="pg-money">${bs(p.colegiatura_centavos)}</span><small>${p.colegiatura_centavos === null ? '' : enCuotas(p.colegiatura_centavos, p.colegiatura_cuotas)}</small></td>
        <td data-label="Certificación"><span class="pg-money">${bs(p.certificacion_centavos)}</span><small>${p.certificacion_centavos === null ? '' : enCuotas(p.certificacion_centavos, p.certificacion_cuotas)}</small></td>
        <td data-label="Total a crédito" class="pg-money"><b>${bs(credito)}</b></td>
        <td data-label="Leads" class="pg-n">${n || '<span class="la-muted">0</span>'}</td>
        <td class="pg-actions">
          <button type="button" class="btn btn-sm btn-soft-secondary" data-pg-edit="${datosEdicion(p)}" title="Editar"><i class="ri-pencil-line" aria-hidden="true"></i><span class="visually-hidden">Editar ${esc(p.nombre)}</span></button>
          <form method="post" action="/programas/${p.id}/alternar"><input type="hidden" name="volver" value="${esc(volver)}" />
            <button class="btn btn-sm btn-soft-secondary" type="submit" title="${p.activo ? 'Pausar: deja de ofrecerse a los leads nuevos' : 'Volver a ofertar'}">
              <i class="${p.activo ? 'ri-pause-line' : 'ri-play-line'}" aria-hidden="true"></i><span class="visually-hidden">${p.activo ? 'Pausar' : 'Activar'}</span></button></form>
          ${n ? '' : `<form method="post" action="/programas/${p.id}/borrar" data-pg-confirm="¿Borrar «${esc(p.nombre)}»?"><input type="hidden" name="volver" value="${esc(volver)}" />
            <button class="btn btn-sm btn-soft-danger" type="submit" title="Borrar"><i class="ri-delete-bin-6-line" aria-hidden="true"></i><span class="visually-hidden">Borrar</span></button></form>`}
        </td>
      </tr>`;
    }).join('');

    return `<section class="pg-group">
      <header class="pg-group-head">
        <span class="pg-ico" aria-hidden="true"><i class="${ICONO_TIPO[tipo]}"></i></span>
        <h6>${TIPO_PLURAL[tipo]}</h6>
        <span class="pg-count">${lista.length}</span>
        <button type="button" class="btn btn-sm btn-link ms-auto" data-pg-new="${tipo}"><i class="ri-add-line" aria-hidden="true"></i> Agregar ${TIPO_LABEL[tipo].toLowerCase()}</button>
      </header>
      ${lista.length
        ? `<div class="pg-table-wrap"><table class="pg-table">
            <thead><tr><th>Programa</th><th>Contado</th><th>Matrícula</th><th>Colegiatura</th><th>Certificación</th><th>Total a crédito</th><th class="pg-n">Leads</th><th></th></tr></thead>
            <tbody>${filas}</tbody></table></div>`
        : `<p class="pg-empty">Todavía no hay ${TIPO_PLURAL[tipo].toLowerCase()} en la oferta de esta sede.</p>`}
    </section>`;
  }).join('');

  const campoMonto = (name: string, label: string, ayuda = '') => `<div class="pg-field">
      <label class="form-label" for="pg-${name}">${label}</label>
      <div class="input-group input-group-sm"><span class="input-group-text">Bs</span>
        <input class="form-control" id="pg-${name}" name="${name}" inputmode="decimal" placeholder="0" autocomplete="off" /></div>
      ${ayuda ? `<small class="pg-help">${ayuda}</small>` : ''}
    </div>`;
  const campoCuotas = (name: string) => `<div class="pg-field pg-field-cuotas">
      <label class="form-label" for="pg-${name}">Cuotas</label>
      <input class="form-control form-control-sm" id="pg-${name}" name="${name}" type="number" min="1" max="60" value="1" />
      <small class="pg-help" data-pg-cuota="${name}"></small>
    </div>`;

  return `<div class="pg-page" id="pg-page">
    ${selector}
    <div class="pg-intro">
      <p>La oferta de esta sede: los asesores eligen de esta lista el programa de cada lead. Los montos a crédito son el <b>total</b> de cada concepto; el panel calcula cada cuota.</p>
      <button type="button" class="btn btn-primary btn-sm" data-pg-new=""><i class="ri-add-line me-1" aria-hidden="true"></i>Nuevo programa</button>
    </div>
    ${secciones}

    <dialog class="ub-modal ub-modal-wide pg-modal" id="pg-modal">
      <form method="post" action="/programas" class="ub-modal-form" id="pg-form">
        <header class="ub-modal-head">
          <div><h5 id="pg-title">Nuevo programa</h5><p>Precio al contado y a crédito (matrícula, colegiatura y certificación).</p></div>
          <button class="ub-modal-x" type="button" data-pg-close aria-label="Cerrar"><i class="ri-close-line"></i></button>
        </header>
        <div class="ub-modal-body">
          <input type="hidden" name="sede_id" value="${sedeId}" />
          <input type="hidden" name="volver" value="${esc(volver)}" />
          <div class="pg-row">
            <div class="pg-field">
              <label class="form-label" for="pg-tipo">Tipo <span class="ub-req">*</span></label>
              <select class="form-select form-select-sm" id="pg-tipo" name="tipo" required>
                ${TIPOS_PROGRAMA.map((t) => `<option value="${t}">${TIPO_LABEL[t]}</option>`).join('')}
              </select>
            </div>
            <div class="pg-field pg-grow">
              <label class="form-label" for="pg-nombre">Nombre del programa <span class="ub-req">*</span></label>
              <input class="form-control form-control-sm" id="pg-nombre" name="nombre" required minlength="3" maxlength="160" placeholder="Ej.: Maestría en Educación Superior" />
            </div>
          </div>
          <fieldset class="pg-block">
            <legend>Al contado</legend>
            <div class="pg-row">${campoMonto('contado', 'Precio total', 'Un solo pago.')}</div>
          </fieldset>
          <fieldset class="pg-block">
            <legend>A crédito <span class="pg-total" id="pg-total"></span></legend>
            <div class="pg-row">${campoMonto('matricula', 'Matrícula')}${campoCuotas('matricula_cuotas')}</div>
            <div class="pg-row">${campoMonto('colegiatura', 'Colegiatura')}${campoCuotas('colegiatura_cuotas')}</div>
            <div class="pg-row">${campoMonto('certificacion', 'Certificación')}${campoCuotas('certificacion_cuotas')}</div>
          </fieldset>
        </div>
        <footer class="ub-modal-foot">
          <span></span>
          <div class="ub-modal-buttons">
            <button class="btn btn-soft-secondary" type="button" data-pg-close>Cancelar</button>
            <button class="btn btn-primary" type="submit"><i class="ri-save-line me-1"></i>Guardar</button>
          </div>
        </footer>
      </form>
    </dialog>
  </div>
  <script src="/assets/js/programas.js?v=1" defer></script>`;
}

function entrada(body: Record<string, unknown>): ProgramaInput {
  const t = (k: string) => (body[k] === undefined || body[k] === null ? null : String(body[k]));
  return {
    tipo: String(body.tipo ?? ''),
    nombre: String(body.nombre ?? ''),
    contado: t('contado'),
    matricula: t('matricula'),
    matriculaCuotas: t('matricula_cuotas'),
    colegiatura: t('colegiatura'),
    colegiaturaCuotas: t('colegiatura_cuotas'),
    certificacion: t('certificacion'),
    certificacionCuotas: t('certificacion_cuotas'),
  };
}

/** Solo volver a /programas (nunca a otro sitio). */
function volverSeguro(valor: unknown): string {
  const v = String(valor ?? '');
  return /^\/programas(\?sede=\d+)?$/.test(v) ? v : '/programas';
}

export function registerProgramasRoutes(app: express.Express, ctx: { requireUser: RequestHandler }): void {
  app.get('/programas', ctx.requireUser, (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user!;
    const sedes = sedesEditables(user);
    if (!sedes.length) {
      res.status(403).send('No tenés acceso a la oferta de programas.');
      return;
    }
    const pedida = positiveInt(req.query.sede);
    const sede = sedes.find((s) => s.id === pedida) ?? sedes[0];
    sendPage(req, res, 'Programas', 'programas', renderProgramas(user, sede.id), {
      subtitle: `Oferta de ${sede.nombre}: cursos, diplomados, especialidades y maestrías con sus precios.`,
      activeHref: '/programas',
    });
  });

  const accion = (fn: (user: UserRow, req: Request) => string) => (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user!;
    try {
      setFlash(res, 'ok', fn(user, req));
    } catch (err) {
      setFlash(res, 'error', (err as Error).message);
    }
    res.redirect(volverSeguro(req.body?.volver));
  };

  app.post('/programas', ctx.requireUser, accion((user, req) => {
    const sedeId = positiveInt(req.body?.sede_id);
    if (!sedeId) throw new Error('Elegí la sede.');
    const id = positiveInt(req.body?.id);
    const datos = entrada(req.body ?? {});
    if (id) {
      actualizarPrograma(user, id, datos);
      return `Programa actualizado: «${datos.nombre.trim()}».`;
    }
    crearPrograma(user, sedeId, datos);
    return `Programa agregado a la oferta: «${datos.nombre.trim()}».`;
  }));

  app.post('/programas/:id/alternar', ctx.requireUser, accion((user, req) => {
    const p = alternarPrograma(user, positiveInt(req.params.id) ?? 0);
    return p.activo ? `«${p.nombre}» vuelve a la oferta.` : `«${p.nombre}» quedó en pausa: no se ofrece a leads nuevos.`;
  }));

  app.post('/programas/:id/borrar', ctx.requireUser, accion((user, req) => {
    borrarPrograma(user, positiveInt(req.params.id) ?? 0);
    return 'Programa borrado.';
  }));
}
