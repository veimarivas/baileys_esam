import { esc } from './layout.js';
import { badge, emptyState, fmtDate, stat } from './views.js';
import type { CiteNote } from '../core/contacts.js';
import type { FolioCite } from '../core/cites.js';

/**
 * Vistas del apartado «Cites»: listado de cites sincronizados desde cronogramas
 * y detalle de cada uno con los contactos/notas que lo tienen registrado.
 */

const CONCEPT_LABELS: Record<string, string> = {
  Inscripcion: 'Inscripción',
  Matricula: 'Matrícula',
  Colegiatura: 'Colegiatura',
  Certificacion: 'Certificación',
};

function conceptLabel(raw: string | null | undefined): string {
  const key = String(raw ?? '').split(',')[0].trim();
  return CONCEPT_LABELS[key] ?? (key || 'Sin tipo');
}

function statusBadge(status: string): string {
  return status === 'habilitado' ? badge('Habilitado', 'success') : badge('No habilitado', 'danger');
}

function noteState(note: CiteNote): string {
  return note.done_at ? badge('Resuelta', 'success') : badge('En curso', 'info');
}

export interface CiteUsage {
  notes: number;
  last_at: string | null;
}

export function renderCitesPage(
  cites: FolioCite[],
  usage: Map<number, CiteUsage>,
  syncedAt: string | null,
  restricted: boolean,
): string {
  const totalNotes = [...usage.values()].reduce((sum, u) => sum + u.notes, 0);
  const enabled = cites.filter((c) => c.status === 'habilitado').length;
  const rows = cites.map((cite, index) => {
    const used = usage.get(cite.id) ?? { notes: 0, last_at: null };
    const label = conceptLabel(cite.concepto);
    const search = [cite.nombre, label, cite.status, cite.fecha_registro ?? ''].join(' ');
    return `<tr class="cite-row" data-status="${esc(cite.status)}" data-search="${esc(search)}">
      <td class="text-muted text-center">${index + 1}</td>
      <td>
        <a class="fw-semibold text-decoration-none" href="/cites/${cite.id}">${esc(cite.nombre)}</a>
        <div class="cite-sub">${esc(cite.fecha_registro ? 'Registrado ' + fmtDate(cite.fecha_registro) : 'Sin fecha de registro')}</div>
      </td>
      <td>${badge(label, 'info')}</td>
      <td>${statusBadge(cite.status)}</td>
      <td class="text-center">${used.notes ? `<a href="/cites/${cite.id}" class="fw-semibold text-decoration-none">${used.notes}</a>` : '<span class="text-muted">0</span>'}</td>
      <td>${used.last_at ? esc(fmtDate(used.last_at)) : '<span class="text-muted">—</span>'}</td>
      <td class="text-end">
        <a class="btn btn-sm btn-soft-primary" href="/cites/${cite.id}">
          <span class="ri-eye-line me-1"></span>Ver detalle</a>
      </td>
    </tr>`;
  }).join('');

  return `<div class="cites-page" id="cites-page">
    <div class="row g-2 mb-3">
      <div class="col-6 col-xl-3">${stat('Cites', cites.length, 'primary', 'ri-file-list-3-line')}</div>
      <div class="col-6 col-xl-3">${stat('Habilitados', enabled, 'success', 'ri-checkbox-circle-line')}</div>
      <div class="col-6 col-xl-3">${stat('No habilitados', cites.length - enabled, 'danger', 'ri-forbid-2-line')}</div>
      <div class="col-6 col-xl-3">${stat('Contactos con cite', totalNotes, 'info', 'ri-team-line')}</div>
    </div>
    ${restricted ? `<div class="insight is-info"><span class="insight-ico"><i class="ri-lock-line"></i></span>
      <p>Ves los contactos de tus sub-agendas y los que vos registraste. Los administradores ven el registro completo.</p></div>` : ''}
    <div class="card">
      <div class="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
        <div>
          <h5 class="mb-1"><span class="ri-file-list-3-line me-1"></span>Cites registrados</h5>
          <div class="cite-sub">${syncedAt
            ? 'Última sincronización desde Cronogramas: ' + esc(fmtDate(syncedAt))
            : 'Todavía no se sincronizaron cites desde Cronogramas.'}</div>
        </div>
        <div class="d-flex flex-wrap gap-2">
          <label class="notes-search" for="cites-search">
            <span class="ri-search-line" aria-hidden="true"></span>
            <input type="search" id="cites-search" placeholder="Buscar cite o tipo de pago…" autocomplete="off" />
          </label>
          <select id="cites-status-filter" class="form-select form-select-sm" aria-label="Filtrar por estado" style="width:170px;">
            <option value="">Todos los estados</option>
            <option value="habilitado">Habilitados</option>
            <option value="no_habilitado">No habilitados</option>
          </select>
        </div>
      </div>
      <div class="card-body p-0">
        ${cites.length
          ? `<div class="table-responsive">
              <table class="table table-hover align-middle mb-0" id="cites-table">
                <thead class="table-light">
                  <tr>
                    <th style="width:46px;" class="text-center">#</th>
                    <th>N° de cite</th>
                    <th style="width:140px;">Tipo de pago</th>
                    <th style="width:130px;">Estado</th>
                    <th style="width:100px;" class="text-center">Contactos</th>
                    <th style="width:170px;">Último registro</th>
                    <th style="width:130px;" class="text-end">Acciones</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
            <div class="p-4 text-center" id="cites-empty-filter" hidden>
              ${emptyState('ri-search-eye-line', 'Sin coincidencias', 'Probá con otro número de cite o cambiá el filtro de estado.')}
            </div>`
          : `<div class="p-4">
              ${emptyState('ri-file-list-3-line', 'Todavía no hay cites', 'Los cites se crean y habilitan en Cronogramas › Cites y se sincronizan automáticamente con la agenda.')}
            </div>`}
      </div>
    </div>
  </div>`;
}

export function renderCiteDetailPage(
  cite: FolioCite,
  notes: CiteNote[],
  syncedAt: string | null,
): string {
  const boards = new Set(notes.map((n) => n.board_name).filter(Boolean));
  const rows = notes.map((note) => {
    const name = note.contact_name || note.contact_phone || 'Contacto';
    const phone = note.contact_phone || '';
    const chatUrl = '/conversations/' + encodeURIComponent(note.chat_id || '');
    const attachments = [
      note.image_path ? `<a class="btn btn-sm btn-light" href="/inbox/notes/${note.id}/image" target="_blank" rel="noopener">Imagen</a>` : '',
      note.audio_path ? `<a class="btn btn-sm btn-light" href="/inbox/notes/${note.id}/audio" target="_blank" rel="noopener">Audio</a>` : '',
      note.agenda_source_note_id ? `<a class="btn btn-sm btn-light" href="/notes/${note.agenda_source_note_id}">Nota original</a>` : '',
    ].filter(Boolean).join(' ');
    return `<tr>
      <td>
        <a class="cite-contact-name text-decoration-none" href="${esc(chatUrl)}">${esc(name)}</a>
        ${phone ? `<div class="cite-sub">${esc(phone)}</div>` : ''}
        ${note.person_ci ? `<div class="cite-sub">CI ${esc(note.person_ci)}</div>` : ''}
        ${note.programa ? `<div class="cite-sub cite-program">${esc(note.programa)}</div>` : ''}
      </td>
      <td>
        <div class="fw-semibold">${esc(note.board_name || 'Sub-agenda')}</div>
        <div class="cite-sub">${esc(note.stage_name || 'Sin columna')}</div>
        ${noteState(note)}
      </td>
      <td>
        <div class="cite-note-text">${note.note_text ? esc(note.note_text) : '<span class="text-muted">Sin texto</span>'}</div>
        ${attachments ? `<div class="d-flex flex-wrap gap-1 mt-2">${attachments}</div>` : ''}
      </td>
      <td>
        <div><span class="cite-label">Registró:</span> ${esc(note.author_name || 'Sin dato')}</div>
        <div class="cite-sub">${esc(fmtDate(note.created_at))}</div>
        ${note.last_stage_by
          ? `<div class="mt-1"><span class="cite-label">Movió:</span> ${esc(note.last_stage_by)}</div>
             <div class="cite-sub">${esc(note.last_stage_at ? fmtDate(note.last_stage_at) : '')}</div>`
          : ''}
      </td>
      <td class="text-end">
        <a class="btn btn-sm btn-soft-primary" href="${esc(chatUrl)}">
          <span class="ri-chat-3-line me-1"></span>Abrir chat</a>
      </td>
    </tr>`;
  }).join('');

  return `<div class="cites-page" id="cites-page">
    <div class="card cite-detail-head mb-3">
      <div class="card-body">
        <div class="d-flex flex-wrap align-items-start justify-content-between gap-3">
          <div>
            <div class="cite-sub text-uppercase fw-semibold">Cite</div>
            <h3 class="mb-2">${esc(cite.nombre)}</h3>
            <div class="d-flex flex-wrap align-items-center gap-2">
              ${badge(conceptLabel(cite.concepto), 'info')}
              ${statusBadge(cite.status)}
            </div>
          </div>
          <div class="text-md-end cite-meta">
            <div><span class="cite-label">Registrado:</span> ${esc(cite.fecha_registro ? fmtDate(cite.fecha_registro) : '—')}</div>
            <div><span class="cite-label">Sincronizado:</span> ${esc(syncedAt ? fmtDate(syncedAt) : '—')}</div>
            <a class="btn btn-sm btn-light mt-2" href="/cites"><span class="ri-arrow-left-line me-1"></span>Volver a cites</a>
          </div>
        </div>
      </div>
    </div>

    <div class="row g-2 mb-3">
      <div class="col-6 col-xl-3">${stat('Contactos registrados', notes.length, 'info', 'ri-team-line')}</div>
      <div class="col-6 col-xl-3">${stat('Sub-agendas', boards.size, 'primary', 'ri-folder-3-line')}</div>
    </div>

    <div class="card">
      <div class="card-header">
        <h5 class="mb-1"><span class="ri-team-line me-1"></span>Contactos registrados con este cite</h5>
        <div class="cite-sub">Cada fila es una tarjeta de sub-agenda con este cite: contacto, proceso, nota y responsables.</div>
      </div>
      <div class="card-body p-0">
        ${notes.length
          ? `<div class="table-responsive">
              <table class="table table-hover align-middle mb-0">
                <thead class="table-light">
                  <tr>
                    <th style="min-width:210px;">Contacto</th>
                    <th style="min-width:170px;">Proceso</th>
                    <th style="min-width:280px;">Nota</th>
                    <th style="min-width:190px;">Registro</th>
                    <th style="width:130px;" class="text-end">Acciones</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>`
          : `<div class="p-4">
              ${emptyState('ri-user-search-line', 'Sin contactos con este cite', 'Cuando registres una nota en una columna que exige cite, el contacto aparecerá acá con todo el detalle.')}
            </div>`}
      </div>
    </div>
  </div>`;
}
