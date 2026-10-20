import { all, get, foldText } from '../db/index.js';

/**
 * Directorio global de personas registradas por cronogramas.
 *
 * `person_programs` guarda, por número, el nombre completo y los programas que
 * llegaron con los envíos masivos. El inbox solo listaba conversaciones: si una
 * persona nunca escribió (o se le envió desde otra línea), no aparecía al
 * buscar. Este módulo arma una lista única por número con esos datos y, cuando
 * la persona tiene conversación en alguna de las líneas del usuario, agrega el
 * chat para poder abrirlo.
 */

export interface DirectoryChat {
  contact_id: number;
  phone_key: string;
  session_id: string;
  chat_id: string;
  contact_name: string | null;
  last_message_at: string | null;
}

export interface DirectoryPerson {
  phone_key: string;
  /** Nombre completo más reciente (cronogramas o registrado a mano). */
  full_name: string | null;
  /** Número listo para abrir el chat. */
  phone: string;
  name_source: 'cronogramas' | 'manual' | null;
  name_by: string | null;
  /** Programas, del más reciente al más antiguo. */
  programas: string[];
  /** Último envío o registro de la persona. */
  last_at: string | null;
  /** Conversación en una de las líneas del usuario (si existe). */
  chat: DirectoryChat | null;
}

export interface DirectoryResult {
  people: DirectoryPerson[];
  total: number;
  /** Programas disponibles para el filtro. */
  programas: string[];
}

/** Escapa `%`, `_` y `!` para usarlos como texto dentro de un LIKE. */
function likePattern(value: string): string {
  return `%${foldText(value).replace(/[!%_]/g, (c) => '!' + c)}%`;
}

/** Personas y programas ya registrados (para el selector de programa). */
export function directoryPrograms(): string[] {
  return all<{ programa: string }>(
    `SELECT DISTINCT programa FROM person_programs
      WHERE NULLIF(TRIM(programa), '') IS NOT NULL
      ORDER BY programa COLLATE NOCASE`,
  ).map((r) => r.programa);
}

/**
 * Lista el directorio, filtrable por nombre, número o programa.
 * `sessionIds` limita solo la conversación que se adjunta: el directorio en sí
 * es de toda la institución (todos ven los nombres y programas).
 */
export function listDirectory(opts: {
  q?: string | null;
  programa?: string | null;
  sessionIds?: string[] | null;
  limit?: number;
  offset?: number;
} = {}): DirectoryResult {
  const q = (opts.q ?? '').trim();
  const programa = (opts.programa ?? '').trim();
  const limit = Math.min(Math.max(opts.limit ?? 800, 1), 2000);
  const offset = Math.max(opts.offset ?? 0, 0);

  // Una fila por persona (número). El nombre manual y el de cronogramas se
  // resuelven después, quedándose con el más reciente.
  const cte = `WITH people AS (
      SELECT phone_key, full_name, programa, last_at, 0 AS manual
        FROM person_programs
      UNION ALL
      SELECT phone_key, full_name, NULL AS programa, updated_at AS last_at, 1 AS manual
        FROM person_names
    ),
    grouped AS (
      SELECT phone_key, MAX(last_at) AS last_at
        FROM people
       GROUP BY phone_key
    )`;

  const where: string[] = [];
  const params: unknown[] = [];
  if (programa) {
    where.push(`EXISTS (SELECT 1 FROM people fp
      WHERE fp.phone_key = grouped.phone_key AND fold(COALESCE(fp.programa, '')) = ?)`);
    params.push(foldText(programa));
  }
  if (q) {
    const like = likePattern(q);
    const digits = q.replace(/\D+/g, '');
    const phoneClause = digits ? ` OR fp.phone_key LIKE ? ESCAPE '!'` : '';
    where.push(`EXISTS (SELECT 1 FROM people fp
      WHERE fp.phone_key = grouped.phone_key AND (
        fold(COALESCE(fp.full_name, '')) LIKE ? ESCAPE '!'
        OR fold(COALESCE(fp.programa, '')) LIKE ? ESCAPE '!'${phoneClause}
      ))`);
    params.push(like, like);
    if (digits) params.push(likePattern(digits));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = Number(
    get<{ c: number | null }>(`${cte} SELECT COUNT(*) AS c FROM grouped ${whereSql}`, ...params)?.c ?? 0,
  );

  const rows = all<{ phone_key: string; last_at: string | null }>(
    `${cte}
     SELECT phone_key, last_at FROM grouped
     ${whereSql}
     ORDER BY COALESCE(last_at, '') DESC, phone_key ASC
     LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  if (!rows.length) return { people: [], total, programas: directoryPrograms() };

  const keys = rows.map((r) => r.phone_key);
  const inList = keys.map(() => '?').join(',');

  // Programas y nombre de cronogramas de las personas de esta página.
  const programRows = all<{
    phone_key: string;
    programa: string;
    full_name: string | null;
    last_at: string;
  }>(
    `SELECT phone_key, programa, full_name, last_at
       FROM person_programs
      WHERE phone_key IN (${inList})
      ORDER BY last_at DESC, programa COLLATE NOCASE`,
    ...keys,
  );
  const manualRows = all<{ phone_key: string; full_name: string; updated_at: string; by_name: string | null }>(
    `SELECT pn.phone_key, pn.full_name, pn.updated_at,
            COALESCE(NULLIF(u.name, ''), u.username) AS by_name
       FROM person_names pn LEFT JOIN users u ON u.id = pn.updated_by
      WHERE pn.phone_key IN (${inList})`,
    ...keys,
  );

  interface Built {
    programas: string[];
    cronName: string | null;
    cronAt: string | null;
    manualName: string | null;
    manualAt: string | null;
    manualBy: string | null;
  }
  const built = new Map<string, Built>();
  const getBuilt = (key: string): Built => {
    let item = built.get(key);
    if (!item) {
      item = { programas: [], cronName: null, cronAt: null, manualName: null, manualAt: null, manualBy: null };
      built.set(key, item);
    }
    return item;
  };
  for (const r of programRows) {
    const item = getBuilt(r.phone_key);
    if (!item.programas.includes(r.programa)) item.programas.push(r.programa);
    if (!item.cronName && r.full_name) {
      item.cronName = r.full_name;
      item.cronAt = r.last_at;
    }
  }
  for (const r of manualRows) {
    const item = getBuilt(r.phone_key);
    item.manualName = r.full_name;
    item.manualAt = r.updated_at;
    item.manualBy = r.by_name;
  }

  const chats = chatsFor(keys, opts.sessionIds ?? null, inList);

  const people: DirectoryPerson[] = rows.map((row) => {
    const item = getBuilt(row.phone_key);
    // Igual que en `personTagsByKeys`: gana el nombre más reciente, sea de
    // cronogramas o registrado a mano en el panel.
    const manualWins = !!item.manualName && (!item.cronName || (item.manualAt ?? '') >= (item.cronAt ?? ''));
    const fullName = manualWins ? item.manualName : item.cronName;
    return {
      phone_key: row.phone_key,
      full_name: fullName,
      phone: row.phone_key,
      name_source: fullName ? (manualWins ? 'manual' : 'cronogramas') : null,
      name_by: manualWins ? item.manualBy : null,
      programas: item.programas,
      last_at: row.last_at,
      chat: chats.get(row.phone_key) ?? null,
    };
  });

  return { people, total, programas: directoryPrograms() };
}

/** Conversación de cada persona en las líneas del usuario (la más reciente). */
function chatsFor(
  keys: string[],
  sessionIds: string[] | null,
  inList: string,
): Map<string, DirectoryChat> {
  const map = new Map<string, DirectoryChat>();
  if (!keys.length) return map;
  if (sessionIds !== null && !sessionIds.length) return map;

  const scope = sessionIds === null
    ? ''
    : ` AND c.session_id IN (${sessionIds.map(() => '?').join(',')})`;
  const rows = all<DirectoryChat>(
    `SELECT ct.id AS contact_id, ct.phone_key, c.session_id, c.chat_id, ct.name AS contact_name, c.last_message_at
       FROM contacts ct
       JOIN conversations c ON c.session_id = ct.session_id AND c.chat_id = ct.chat_id
      WHERE ct.phone_key IN (${inList})
        AND c.chat_id NOT LIKE '%@broadcast' AND c.chat_id NOT LIKE '%@newsletter'${scope}
      ORDER BY COALESCE(c.last_message_at, '') DESC, c.updated_at DESC`,
    ...keys,
    ...(sessionIds ?? []),
  );
  for (const row of rows) {
    if (!map.has(row.phone_key)) map.set(row.phone_key, row);
  }
  return map;
}
