import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { esamEsAdmin, esamRoles, type UserRow } from '../auth/users.js';

/**
 * Oferta de programas POR SEDE (mientras cronogramas maneja una sola sede).
 *
 * Cada programa tiene un tipo (Curso, Diplomado, Especialidad, Maestría), un
 * precio al contado y uno a crédito en tres partes —matrícula, colegiatura y
 * certificación—, cada una con su monto total y su cantidad de cuotas. Los
 * montos se guardan en centavos de boliviano.
 *
 * Lo administran el Super Admin y, en su sede, el Gerente General y el Gerente
 * de Marketing. Un lead se asigna a un programa de la oferta de SU sede.
 */

export const TIPOS_PROGRAMA = ['curso', 'diplomado', 'especialidad', 'maestria'] as const;
export type TipoPrograma = (typeof TIPOS_PROGRAMA)[number];

export const TIPO_LABEL: Record<TipoPrograma, string> = {
  curso: 'Curso',
  diplomado: 'Diplomado',
  especialidad: 'Especialidad',
  maestria: 'Maestría',
};

export const TIPO_PLURAL: Record<TipoPrograma, string> = {
  curso: 'Cursos',
  diplomado: 'Diplomados',
  especialidad: 'Especialidades',
  maestria: 'Maestrías',
};

export function esTipoPrograma(v: unknown): v is TipoPrograma {
  return typeof v === 'string' && (TIPOS_PROGRAMA as readonly string[]).includes(v);
}

export interface Programa {
  id: number;
  sede_id: number;
  tipo: TipoPrograma;
  nombre: string;
  activo: number;
  contado_centavos: number | null;
  matricula_centavos: number | null;
  matricula_cuotas: number;
  colegiatura_centavos: number | null;
  colegiatura_cuotas: number;
  certificacion_centavos: number | null;
  certificacion_cuotas: number;
  created_at: string;
  updated_at: string;
}

export interface ProgramaInput {
  tipo: string;
  nombre: string;
  /** Montos en bolivianos, como los escribe la persona («1.500», «1500,50»). */
  contado?: string | number | null;
  matricula?: string | number | null;
  matriculaCuotas?: string | number | null;
  colegiatura?: string | number | null;
  colegiaturaCuotas?: string | number | null;
  certificacion?: string | number | null;
  certificacionCuotas?: string | number | null;
  activo?: boolean;
}

// ── Dinero ────────────────────────────────────────────────────────────────

/** «1.500», «1500,50», «1500.5», 1500 → centavos. Vacío → null. */
export function aCentavos(valor: string | number | null | undefined, campo: string): number | null {
  if (valor === null || valor === undefined) return null;
  let texto = String(valor).trim().replace(/^bs\.?\s*/i, '').replace(/\s+/g, '');
  if (!texto) return null;
  // «1.500,50» (formato boliviano) o «1,500.50»: el último separador es el decimal
  // si le siguen 1 o 2 dígitos; los demás son de miles.
  const ultimo = Math.max(texto.lastIndexOf(','), texto.lastIndexOf('.'));
  if (ultimo >= 0 && texto.length - ultimo - 1 <= 2) {
    texto = `${texto.slice(0, ultimo).replace(/[.,]/g, '')}.${texto.slice(ultimo + 1)}`;
  } else {
    texto = texto.replace(/[.,]/g, '');
  }
  const n = Number(texto);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${campo}: escribí un monto válido (ej.: 1.500 o 1500,50).`);
  if (n > 10_000_000) throw new Error(`${campo}: el monto es demasiado alto.`);
  return Math.round(n * 100);
}

function cuotas(valor: string | number | null | undefined, campo: string): number {
  if (valor === null || valor === undefined || String(valor).trim() === '') return 1;
  const n = Number(String(valor).trim());
  if (!Number.isInteger(n) || n < 1 || n > 60) throw new Error(`${campo}: la cantidad de cuotas va de 1 a 60.`);
  return n;
}

/** 150000 → «Bs 1.500»; 150050 → «Bs 1.500,50». */
export function bs(centavos: number | null | undefined): string {
  if (centavos === null || centavos === undefined) return '—';
  const entero = Math.floor(centavos / 100);
  const dec = centavos % 100;
  return `Bs ${entero.toLocaleString('es-BO').replace(/,/g, '.')}${dec ? `,${String(dec).padStart(2, '0')}` : ''}`;
}

/** «10 cuotas de Bs 150» o «1 pago de Bs 300». */
export function enCuotas(centavos: number | null, cantidad: number): string {
  if (centavos === null) return '—';
  if (cantidad <= 1) return `1 pago de ${bs(centavos)}`;
  return `${cantidad} cuotas de ${bs(Math.round(centavos / cantidad))}`;
}

/** Total a crédito: matrícula + colegiatura + certificación. */
export function totalCredito(p: Programa): number | null {
  const partes = [p.matricula_centavos, p.colegiatura_centavos, p.certificacion_centavos];
  return partes.every((x) => x === null) ? null : partes.reduce<number>((n, x) => n + (x ?? 0), 0);
}

// ── Permisos ──────────────────────────────────────────────────────────────

/** Super Admin, o Gerente General / Gerente de Marketing miembro de esa sede. */
export function puedeEditarProgramas(user: UserRow, sedeId: number): boolean {
  if (esamEsAdmin(user)) return true;
  const roles = esamRoles(user);
  const cargo = roles.includes('Gerente General') || roles.includes('Gerente de Marketing') || roles.includes('Gerencia Marketing');
  return cargo && !!get<{ user_id: number }>('SELECT user_id FROM sede_miembros WHERE user_id = ? AND sede_id = ?', user.id, sedeId);
}

/** Sedes cuya oferta puede administrar la persona (para el selector de /programas). */
export function sedesEditables(user: UserRow): Array<{ id: number; nombre: string }> {
  const sedes = esamEsAdmin(user)
    ? all<{ id: number; nombre: string }>('SELECT id, name AS nombre FROM sedes ORDER BY name COLLATE NOCASE')
    : all<{ id: number; nombre: string }>(
        `SELECT s.id, s.name AS nombre FROM sede_miembros m JOIN sedes s ON s.id = m.sede_id
          WHERE m.user_id = ? ORDER BY m.principal DESC, s.name COLLATE NOCASE`,
        user.id,
      );
  return sedes.filter((s) => puedeEditarProgramas(user, s.id));
}

// ── Consultas ─────────────────────────────────────────────────────────────

export function getPrograma(id: number): Programa | undefined {
  return get<Programa>('SELECT * FROM programas_oferta WHERE id = ?', id);
}

/** Oferta de una sede, por tipo y nombre. */
export function programasDeSede(sedeId: number, soloActivos = false): Programa[] {
  return all<Programa>(
    `SELECT * FROM programas_oferta WHERE sede_id = ? ${soloActivos ? 'AND activo = 1' : ''}
      ORDER BY CASE tipo WHEN 'curso' THEN 1 WHEN 'diplomado' THEN 2 WHEN 'especialidad' THEN 3 ELSE 4 END, nombre COLLATE NOCASE`,
    sedeId,
  );
}

/**
 * Programa de la sede con ese nombre (sin distinguir mayúsculas ni tildes),
 * para emparejar lo que manda cronogramas con la oferta de la sede.
 */
export function programaPorNombre(sedeId: number | null, nombre: string | null | undefined): Programa | undefined {
  if (!sedeId || !nombre?.trim()) return undefined;
  const clave = normalizar(nombre);
  return programasDeSede(sedeId, true).find((p) => normalizar(p.nombre) === clave);
}

function normalizar(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Altas y cambios ───────────────────────────────────────────────────────

function limpiar(input: ProgramaInput): Omit<Programa, 'id' | 'sede_id' | 'created_at' | 'updated_at'> {
  if (!esTipoPrograma(input.tipo)) throw new Error('Elegí el tipo de programa.');
  const nombre = String(input.nombre ?? '').trim().replace(/\s+/g, ' ').slice(0, 160);
  if (nombre.length < 3) throw new Error('Escribí el nombre del programa.');
  const datos = {
    tipo: input.tipo,
    nombre,
    activo: input.activo === false ? 0 : 1,
    contado_centavos: aCentavos(input.contado, 'Precio al contado'),
    matricula_centavos: aCentavos(input.matricula, 'Matrícula'),
    matricula_cuotas: cuotas(input.matriculaCuotas, 'Matrícula'),
    colegiatura_centavos: aCentavos(input.colegiatura, 'Colegiatura'),
    colegiatura_cuotas: cuotas(input.colegiaturaCuotas, 'Colegiatura'),
    certificacion_centavos: aCentavos(input.certificacion, 'Certificación'),
    certificacion_cuotas: cuotas(input.certificacionCuotas, 'Certificación'),
  };
  if (datos.contado_centavos === null && datos.matricula_centavos === null && datos.colegiatura_centavos === null && datos.certificacion_centavos === null) {
    throw new Error('Cargá al menos el precio al contado o el precio a crédito.');
  }
  return datos;
}

function duplicado(sedeId: number, tipo: string, nombre: string, exceptoId: number | null): boolean {
  return !!get<{ id: number }>(
    'SELECT id FROM programas_oferta WHERE sede_id = ? AND tipo = ? AND nombre = ? COLLATE NOCASE AND id <> ?',
    sedeId,
    tipo,
    nombre,
    exceptoId ?? 0,
  );
}

export function crearPrograma(actor: UserRow, sedeId: number, input: ProgramaInput): number {
  if (!puedeEditarProgramas(actor, sedeId)) throw new Error('No podés cambiar la oferta de esta sede.');
  if (!get<{ id: number }>('SELECT id FROM sedes WHERE id = ?', sedeId)) throw new Error('Sede no encontrada.');
  const d = limpiar(input);
  if (duplicado(sedeId, d.tipo, d.nombre, null)) throw new Error(`Ya existe ${TIPO_LABEL[d.tipo as TipoPrograma].toLowerCase()} «${d.nombre}» en esta sede.`);
  const now = nowIso();
  const id = run(
    `INSERT INTO programas_oferta (sede_id, tipo, nombre, activo, contado_centavos, matricula_centavos, matricula_cuotas,
       colegiatura_centavos, colegiatura_cuotas, certificacion_centavos, certificacion_cuotas, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sedeId, d.tipo, d.nombre, d.activo, d.contado_centavos, d.matricula_centavos, d.matricula_cuotas,
    d.colegiatura_centavos, d.colegiatura_cuotas, d.certificacion_centavos, d.certificacion_cuotas, actor.id, now, now,
  ).lastInsertRowid;
  auditar('programa.creado', actor, { id, sede_id: sedeId, nombre: d.nombre, tipo: d.tipo });
  return id;
}

export function actualizarPrograma(actor: UserRow, id: number, input: ProgramaInput): void {
  const actual = getPrograma(id);
  if (!actual) throw new Error('Programa no encontrado.');
  if (!puedeEditarProgramas(actor, actual.sede_id)) throw new Error('No podés cambiar la oferta de esta sede.');
  const d = limpiar(input);
  if (duplicado(actual.sede_id, d.tipo, d.nombre, id)) throw new Error(`Ya existe ${TIPO_LABEL[d.tipo as TipoPrograma].toLowerCase()} «${d.nombre}» en esta sede.`);
  run(
    `UPDATE programas_oferta SET tipo = ?, nombre = ?, activo = ?, contado_centavos = ?, matricula_centavos = ?, matricula_cuotas = ?,
       colegiatura_centavos = ?, colegiatura_cuotas = ?, certificacion_centavos = ?, certificacion_cuotas = ?, updated_at = ?
     WHERE id = ?`,
    d.tipo, d.nombre, d.activo, d.contado_centavos, d.matricula_centavos, d.matricula_cuotas,
    d.colegiatura_centavos, d.colegiatura_cuotas, d.certificacion_centavos, d.certificacion_cuotas, nowIso(), id,
  );
  auditar('programa.editado', actor, { id, sede_id: actual.sede_id, nombre: d.nombre });
}

/** Pausar o volver a ofertar (un programa con leads no se borra: se pausa). */
export function alternarPrograma(actor: UserRow, id: number): Programa {
  const actual = getPrograma(id);
  if (!actual) throw new Error('Programa no encontrado.');
  if (!puedeEditarProgramas(actor, actual.sede_id)) throw new Error('No podés cambiar la oferta de esta sede.');
  run('UPDATE programas_oferta SET activo = ?, updated_at = ? WHERE id = ?', actual.activo ? 0 : 1, nowIso(), id);
  return getPrograma(id)!;
}

/** Borra un programa sin leads; si tiene leads, hay que pausarlo. */
export function borrarPrograma(actor: UserRow, id: number): void {
  const actual = getPrograma(id);
  if (!actual) return;
  if (!puedeEditarProgramas(actor, actual.sede_id)) throw new Error('No podés cambiar la oferta de esta sede.');
  const usados = get<{ c: number }>('SELECT COUNT(*) AS c FROM leads WHERE programa_id = ?', id)?.c ?? 0;
  if (usados) throw new Error(`«${actual.nombre}» tiene ${usados} lead${usados === 1 ? '' : 's'}: pausalo en lugar de borrarlo.`);
  run('DELETE FROM programas_oferta WHERE id = ?', id);
  auditar('programa.borrado', actor, { id, sede_id: actual.sede_id, nombre: actual.nombre });
}

function auditar(accion: string, actor: UserRow, contexto: Record<string, unknown>): void {
  run('INSERT INTO audit_logs (action, context, created_at) VALUES (?, ?, ?)', accion, JSON.stringify({ ...contexto, by: actor.id }), nowIso());
}

/** Cuántos leads tiene cada programa de una sede (para la pantalla de oferta). */
export function leadsPorPrograma(sedeId: number): Map<number, number> {
  return new Map(all<{ programa_id: number; n: number }>(
    `SELECT l.programa_id, COUNT(*) AS n FROM leads l JOIN programas_oferta p ON p.id = l.programa_id
      WHERE p.sede_id = ? GROUP BY l.programa_id`,
    sedeId,
  ).map((r) => [r.programa_id, r.n]));
}
