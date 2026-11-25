import { esc } from './layout.js';
import { initials } from './views.js';
import type { UserRow } from '../auth/users.js';
import { analizarLeads, PERIODOS, type FiltrosAnalisis, type Periodo } from '../core/leads-analisis.js';
import { ETAPA_LABEL, ETAPAS } from '../core/leads.js';
import { DIAS_SIN_MOVIMIENTO } from '../core/organigrama.js';
import { esTipoPrograma, TIPO_LABEL, TIPO_PLURAL, TIPOS_PROGRAMA } from '../core/programas.js';

/**
 * /leads/analisis: gráficos del embudo de marketing (ApexCharts del panel).
 * El servidor arma los números; `leads-analisis.js` dibuja con ellos.
 */

export const COLOR_ETAPA_ANALISIS: Record<string, string> = {
  nuevo: '#94a3b8',
  contactado: '#2e90b5',
  interesado: '#d97706',
  no_interesado: '#cbd5e1',
  inscrito: '#0f7b55',
};

export function filtrosAnalisis(q: Record<string, unknown>): FiltrosAnalisis {
  const txt = (k: string) => (typeof q[k] === 'string' ? String(q[k]).trim() : '');
  const periodo = PERIODOS.some((p) => p.clave === txt('periodo')) ? (txt('periodo') as Periodo) : '90d';
  const sede = Number(txt('sede'));
  const prog = Number(txt('programa'));
  return {
    periodo,
    sede: Number.isSafeInteger(sede) && sede > 0 ? sede : null,
    programaId: txt('programa') === 'sin' ? 0 : Number.isSafeInteger(prog) && prog > 0 ? prog : null,
    tipo: esTipoPrograma(txt('tipo')) ? txt('tipo') : null,
  };
}

function url(f: FiltrosAnalisis, cambio: Partial<FiltrosAnalisis>): string {
  const t = { ...f, ...cambio };
  const p = new URLSearchParams({ periodo: t.periodo });
  if (t.sede) p.set('sede', String(t.sede));
  if (t.programaId === 0) p.set('programa', 'sin');
  else if (t.programaId) p.set('programa', String(t.programaId));
  if (t.tipo) p.set('tipo', t.tipo);
  return `/leads/analisis?${p.toString()}`;
}

export function renderAnalisis(viewer: UserRow, f: FiltrosAnalisis, ahora: Date = new Date()): string {
  const a = analizarLeads(viewer, f, ahora);
  const k = a.kpis;
  const varias = a.sedesDisponibles.length > 1;

  const kpi = (icono: string, label: string, valor: string, nota: string, tono = '') => `<div class="la-kpi${tono ? ` la-kpi-${tono}` : ''}">
      <span class="la-kpi-ico" aria-hidden="true"><i class="${icono}"></i></span>
      <div><span class="la-kpi-label">${label}</span><b>${valor}</b><small>${nota}</small></div>
    </div>`;

  const tarjeta = (id: string, titulo: string, sub: string, clase = '') => `<section class="la-card ${clase}">
      <header><h6>${titulo}</h6><span>${sub}</span></header>
      <div class="la-chart" id="${id}" role="img" aria-label="${esc(titulo)}"></div>
    </section>`;

  const ranking = a.asesores.length
    ? `<table class="la-rank">
        <thead><tr><th>Asesor</th>${varias ? '<th>Sede</th>' : ''}<th class="la-n">Leads</th><th class="la-n">Inscritos</th><th>Conversión</th><th class="la-n">Sin contactar</th></tr></thead>
        <tbody>${a.asesores.map((r, i) => `<tr>
          <td><div class="la-person"><span class="la-pos">${i + 1}</span><span class="avatar-xs rounded-circle av-${r.id % 8}" aria-hidden="true">${esc(initials(r.nombre))}</span><span>${esc(r.nombre)}</span></div></td>
          ${varias ? `<td class="la-muted">${esc(r.sede)}</td>` : ''}
          <td class="la-n">${r.total}</td>
          <td class="la-n"><b>${r.inscritos}</b></td>
          <td><div class="la-bar" title="${r.conversion ?? 0}%"><span style="width:${Math.min(100, r.conversion ?? 0)}%"></span></div><small>${r.conversion === null ? '—' : `${r.conversion}%`}</small></td>
          <td class="la-n">${r.sinContactar24h ? `<span class="ld-flag ld-flag-warn">${r.sinContactar24h}</span>` : '<span class="la-muted">0</span>'}</td>
        </tr>`).join('')}</tbody>
      </table>`
    : '<p class="la-empty-text">Sin asesores con leads en el período.</p>';

  const datos = {
    etapas: ETAPAS.map((e) => ({ clave: e, label: ETAPA_LABEL[e], color: COLOR_ETAPA_ANALISIS[e], n: a.embudo[e] })),
    semanas: a.semanas,
    sedes: a.sedes.map((s) => ({ sede: s.sede, total: s.total, conversion: s.conversion, porEtapa: s.porEtapa })),
    programas: a.programas.map((p) => ({ ...p, tipoLabel: p.tipo && esTipoPrograma(p.tipo) ? TIPO_LABEL[p.tipo] : null })),
    tipos: a.tipos.map((t) => ({ ...t, label: t.tipo === 'sin' ? 'Sin programa' : TIPO_PLURAL[t.tipo] })),
    origen: a.origen,
  };

  const vacio = k.total === 0;
  const porSede = varias && !f.sede;

  return `<div class="la-page" id="la-page">
    <form class="la-filters" method="get" action="/leads/analisis">
      <div class="la-seg" role="group" aria-label="Período">
        ${PERIODOS.map((p) => `<a class="${p.clave === f.periodo ? 'on' : ''}" href="${esc(url(f, { periodo: p.clave }))}">${p.label}</a>`).join('')}
      </div>
      <input type="hidden" name="periodo" value="${f.periodo}" />
      ${varias ? `<select class="form-select form-select-sm" name="sede" aria-label="Sede" data-la-auto>
        <option value="">Todas las sedes</option>
        ${a.sedesDisponibles.map((s) => `<option value="${s.id}"${s.id === f.sede ? ' selected' : ''}>${esc(s.nombre)}</option>`).join('')}
      </select>` : ''}
      <select class="form-select form-select-sm" name="tipo" aria-label="Tipo de programa" data-la-auto>
        <option value="">Todos los tipos</option>
        ${TIPOS_PROGRAMA.map((t) => `<option value="${t}"${t === f.tipo ? ' selected' : ''}>${TIPO_PLURAL[t]}</option>`).join('')}
      </select>
      <select class="form-select form-select-sm" name="programa" aria-label="Programa" data-la-auto>
        <option value="">Todos los programas</option>
        <option value="sin"${f.programaId === 0 ? ' selected' : ''}>Sin programa asignado</option>
        ${TIPOS_PROGRAMA.map((tipo) => {
          const lista = a.programasDisponibles.filter((p) => p.tipo === tipo && (!f.tipo || f.tipo === tipo));
          const variasSedes = new Set(a.programasDisponibles.map((p) => p.sede)).size > 1;
          return lista.length
            ? `<optgroup label="${TIPO_PLURAL[tipo]}">${lista.map((p) => `<option value="${p.id}"${p.id === f.programaId ? ' selected' : ''}>${esc(p.nombre)}${variasSedes ? ` · ${esc(p.sede)}` : ''}</option>`).join('')}</optgroup>`
            : '';
        }).join('')}
      </select>
      <button class="btn btn-sm btn-soft-primary" type="submit" data-la-submit>Aplicar</button>
    </form>

    <div class="la-kpis">
      ${kpi('ri-user-star-line', 'Leads', String(k.total), 'en el período')}
      ${kpi('ri-loader-4-line', 'Abiertos', String(k.abiertos), 'en seguimiento')}
      ${kpi('ri-graduation-cap-line', 'Inscritos', String(k.inscritos), 'cerrados con éxito', 'ok')}
      ${kpi('ri-percent-line', 'Conversión', k.conversion === null ? '—' : `${k.conversion}%`, 'inscritos / leads', 'brand')}
      ${kpi('ri-time-line', 'Sin contactar', String(k.sinContactar24h), 'nuevos de +24 h', k.sinContactar24h ? 'warn' : '')}
      ${kpi('ri-pause-circle-line', 'Sin movimiento', String(k.sinMovimiento), `abiertos, ${DIAS_SIN_MOVIMIENTO}+ días`, k.sinMovimiento ? 'alert' : '')}
    </div>

    ${vacio
      ? `<div class="ld-empty"><i class="ri-bar-chart-2-line" aria-hidden="true"></i><h5>Sin leads en este período</h5><p>Probá con un período más largo o quitá los filtros.</p></div>`
      : `<div class="la-grid">
          ${tarjeta('la-semanas', 'Leads nuevos por semana', 'Prospectos de cronogramas y contactos por WhatsApp', 'la-span-2')}
          ${tarjeta('la-embudo', 'Embudo', 'Cuántos hay en cada etapa')}
          ${porSede
            ? `${tarjeta('la-sedes', 'Por sede', 'Leads por etapa y conversión de cada sede', 'la-span-2')}
               ${tarjeta('la-origen', 'Origen', 'De dónde llegan')}
               ${tarjeta('la-programas', 'Programas con más leads', 'Leads e inscritos por programa de la oferta', 'la-span-2')}
               ${tarjeta('la-tipos', 'Por tipo de programa', 'Leads, inscritos y conversión')}
               <section class="la-card la-span-3"><header><h6>Asesores</h6><span>Por inscritos (top 15)</span></header><div class="la-rank-wrap">${ranking}</div></section>`
            : `${tarjeta('la-programas', 'Programas con más leads', 'Leads e inscritos por programa de la oferta', 'la-span-2')}
               ${tarjeta('la-tipos', 'Por tipo de programa', 'Leads, inscritos y conversión')}
               <section class="la-card la-span-2"><header><h6>Asesores</h6><span>Por inscritos (top 15)</span></header><div class="la-rank-wrap">${ranking}</div></section>
               ${tarjeta('la-origen', 'Origen', 'De dónde llegan')}`}
        </div>`}

    <script type="application/json" id="la-data">${JSON.stringify(datos).replace(/</g, '\\u003c')}</script>
  </div>
  <script src="/assets/libs/apexcharts/apexcharts.min.js"></script>
  <script src="/assets/js/leads-analisis.js?v=2" defer></script>`;
}
