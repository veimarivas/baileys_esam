import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';

export class MissingTemplateVariableError extends Error {}

export interface TemplateRow {
  id: number;
  name: string;
  category: string;
  body: string;
  variables: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

/** Nombres de variables `{{ x }}` presentes en un cuerpo. */
export function extractVariables(body: string): string[] {
  const found = new Set<string>();
  const re = /\{\{\s*([\w.]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) found.add(m[1]);
  return [...found];
}

/**
 * Reemplaza `{{ variable }}` por su valor. Si falta una variable lanza
 * `MissingTemplateVariableError` (igual que openwa_basico).
 */
export function render(body: string, variables: Record<string, unknown>): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_full, name: string) => {
    const value = variables[name];
    if (value === undefined || value === null) {
      throw new MissingTemplateVariableError(`Falta la variable "{{ ${name} }}".`);
    }
    return String(value);
  });
}

/**
 * Spinning de texto: elige al azar una de las opciones de `{opción1|opción2}`
 * para no enviar el mismo hash exacto miles de veces. Los `{{ variables }}` no
 * se ven afectados (no contienen `|`).
 */
export function spin(body: string): string {
  return body.replace(/\{([^{}]*\|[^{}]*)\}/g, (_full, group: string) => {
    const options = group.split('|');
    return options[Math.floor(Math.random() * options.length)];
  });
}

/** Renderiza una plantilla: primero el spinning, luego las variables. */
export function renderTemplate(body: string, variables: Record<string, unknown>): string {
  return render(spin(body), variables);
}

function parseVars(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Plantillas activas de una categoría. */
export function templatesByCategory(category: string): TemplateRow[] {
  return all<TemplateRow>('SELECT * FROM templates WHERE category = ? AND active = 1 ORDER BY id DESC', category);
}

/**
 * Elige la plantilla de la categoría cuyas variables estén todas presentes en
 * `keys` (la más específica). Evita plantillas viejas/incompletas.
 */
export function resolveTemplate(category: string, keys: string[]): TemplateRow | undefined {
  const present = new Set(keys);
  return templatesByCategory(category)
    .filter((t) => parseVars(t.variables).every((v) => present.has(v)))
    .sort((a, b) => parseVars(b.variables).length - parseVars(a.variables).length)[0];
}

export function getTemplate(id: number): TemplateRow | undefined {
  return get<TemplateRow>('SELECT * FROM templates WHERE id = ?', id);
}

export function createTemplate(name: string, category: string, body: string, active = true): number {
  const now = nowIso();
  const res = run(
    'INSERT INTO templates (name, category, body, variables, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    name,
    category,
    body,
    JSON.stringify(extractVariables(body)),
    active ? 1 : 0,
    now,
    now,
  );
  return res.lastInsertRowid;
}

export function listTemplates(): TemplateRow[] {
  return all<TemplateRow>('SELECT * FROM templates ORDER BY category COLLATE NOCASE, name COLLATE NOCASE');
}

/** Variables declaradas de una plantilla. */
export function templateVariables(t: Pick<TemplateRow, 'variables'>): string[] {
  return parseVars(t.variables);
}

export function updateTemplate(id: number, name: string, category: string, body: string): void {
  run(
    'UPDATE templates SET name = ?, category = ?, body = ?, variables = ?, updated_at = ? WHERE id = ?',
    name,
    category,
    body,
    JSON.stringify(extractVariables(body)),
    nowIso(),
    id,
  );
}

export function setTemplateActive(id: number, active: boolean): void {
  run('UPDATE templates SET active = ?, updated_at = ? WHERE id = ?', active ? 1 : 0, nowIso(), id);
}

export function deleteTemplate(id: number): void {
  run('DELETE FROM templates WHERE id = ?', id);
}

/**
 * ¿Es la única plantilla activa de su categoría? Los envíos de cronogramas
 * eligen la plantilla por categoría (`resolveTemplate`): sin ninguna activa,
 * esos envíos fallan.
 */
export function isLastActiveOfCategory(id: number): boolean {
  const t = getTemplate(id);
  if (!t || !t.active) return false;
  const others = get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM templates WHERE category = ? AND active = 1 AND id <> ?',
    t.category,
    id,
  );
  return (others?.c ?? 0) === 0;
}

const COBRANZA_BODY = `Sr(a). *{{ nombre_completo }}*, participante del programa *{{ programa }}* ({{ programa_codigo }}).

Le informamos que mantiene cuotas *{{ situacion }}*:

{{ detalle_cuotas }}

💰 *Total adeudado: Bs {{ total_adeudado }}*

{{ cierre }}`;

const ACADEMICO_BODY = `Sr(a). *{{ nombre_completo }}*, participante del programa *{{ programa }}*.

En el módulo *{{ modulo }}* su nota final es *{{ nota }}* ({{ estado }}).
{{ nivelacion }}

Saludos cordiales.`;

/** Crea las plantillas por defecto si la tabla está vacía. */
export function seedDefaultTemplates(): void {
  const row = get<{ c: number }>('SELECT COUNT(*) AS c FROM templates');
  if ((row?.c ?? 0) > 0) return;
  createTemplate('Cobranza', 'cobranza', COBRANZA_BODY);
  createTemplate('Académico', 'academico', ACADEMICO_BODY);
}
