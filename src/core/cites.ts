import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';

/**
 * Cites: folios de pago a la universidad administrados en Cronogramas
 * (/admin/folios) y sincronizados acá. Las sub-agendas que lo exigen piden
 * elegir un cite habilitado al mover una tarjeta de columna.
 */
export interface FolioCite {
  id: number;
  /** Número de cite (el nombre del folio en cronogramas). */
  nombre: string;
  /** Tipo de pago: Inscripcion | Matricula | Colegiatura | Certificacion. */
  concepto: string | null;
  status: 'habilitado' | 'no_habilitado';
  fecha_registro: string | null;
}

export interface CiteInput {
  id?: unknown;
  nombre?: unknown;
  concepto?: unknown;
  status?: unknown;
  fecha_registro?: unknown;
}

const CONCEPT_LABELS: Record<string, string> = {
  Inscripcion: 'Inscripción',
  Matricula: 'Matrícula',
  Colegiatura: 'Colegiatura',
  Certificacion: 'Certificación',
};

/** Texto legible del tipo de pago de un cite. */
export function citeConceptLabel(concepto: string | null | undefined): string {
  const raw = String(concepto ?? '').split(',')[0]?.trim() ?? '';
  return CONCEPT_LABELS[raw] ?? raw;
}

/** Normaliza el estado que llega de cronogramas (admite los antiguos). */
function normalizeStatus(value: unknown): 'habilitado' | 'no_habilitado' {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'no_habilitado' || raw === 'no habilitado' || raw === 'cerrado' || raw === 'inhabilitado') {
    return 'no_habilitado';
  }
  return 'habilitado';
}

/**
 * Reemplaza la lista de cites con la que envía cronogramas. Se ejecuta en una
 * transacción: la agenda nunca queda con una lista a medias.
 */
export function replaceCites(items: CiteInput[]): number {
  const now = nowIso();
  let count = 0;
  run('BEGIN IMMEDIATE');
  try {
    run('DELETE FROM folio_cites');
    for (const item of items) {
      const id = Number(item?.id);
      const nombre = String(item?.nombre ?? '').trim().slice(0, 120);
      if (!Number.isInteger(id) || id <= 0 || !nombre) continue;
      run(
        `INSERT INTO folio_cites (id, nombre, concepto, status, fecha_registro, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        nombre,
        item.concepto ? String(item.concepto).slice(0, 120) : null,
        normalizeStatus(item.status),
        item.fecha_registro ? String(item.fecha_registro).slice(0, 40) : null,
        now,
      );
      count++;
    }
    run('COMMIT');
  } catch (err) {
    run('ROLLBACK');
    throw err;
  }
  return count;
}

/** Cites disponibles para elegir (por defecto solo los habilitados). */
export function listCites(
  opts: { enabledOnly?: boolean; q?: string | null } = {},
): FolioCite[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.enabledOnly !== false) where.push("status = 'habilitado'");
  if (opts.q) {
    where.push('(nombre LIKE ? OR concepto LIKE ?)');
    const like = `%${String(opts.q).trim()}%`;
    params.push(like, like);
  }
  const rows = all<FolioCite>(
    `SELECT id, nombre, concepto, status, fecha_registro
       FROM folio_cites
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY nombre COLLATE NOCASE, id`,
    ...params,
  );
  return rows.map((row) => ({ ...row, status: normalizeStatus(row.status) }));
}

/** Un cite por id. */
export function citeById(id: number): FolioCite | undefined {
  const row = get<FolioCite>(
    'SELECT id, nombre, concepto, status, fecha_registro FROM folio_cites WHERE id = ?',
    id,
  );
  return row ? { ...row, status: normalizeStatus(row.status) } : undefined;
}

/** Última sincronización recibida de cronogramas (para avisar si está vacía). */
export function citesSyncedAt(): string | null {
  return get<{ synced_at: string | null }>('SELECT MAX(synced_at) AS synced_at FROM folio_cites')?.synced_at ?? null;
}

/** Uso de cada cite: notas que lo tienen asignado (para el listado y sus contadores). */
export interface CiteUsageRow {
  cite_folio_id: number;
  agenda_board_id: number | null;
  user_id: number | null;
  created_at: string;
}

export function citeUsageRows(): CiteUsageRow[] {
  return all<CiteUsageRow>(
    `SELECT cite_folio_id, agenda_board_id, user_id, created_at
       FROM contact_notes
      WHERE personal = 1 AND deleted_at IS NULL AND cite_folio_id IS NOT NULL`,
  );
}
