import { all, get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { getConfig, setConfig } from './config-store.js';
import { notify, supervisorIds } from './notifications.js';
import { phoneKeyOf } from './person.js';
import { audit } from './webhooks.js';

/**
 * Consistencia entre las cuentas (usuarios de cronogramas) y las líneas de
 * WhatsApp. El incidente del 28/10/2026 (un Super Admin envió cobranzas y
 * salieron desde el número de Contabilidad) vino de esta relación desordenada:
 * una cuenta con dos líneas, la línea de otra área asociada, números esperados
 * desactualizados. Acá se detecta y, cuando es seguro, se repara con un clic.
 */

export type LineIssueKind =
  | 'linked_mismatch'
  | 'duplicate_owner'
  | 'shared_number'
  | 'owner_number_mismatch'
  | 'number_other_owner'
  | 'user_without_line'
  | 'orphan_line';

export type LineFixAction = 'release_owner' | 'assign_owner' | 'align_expected';

export interface LineRef {
  id: string;
  name: string;
  owner: string | null;
  ownerUid: string | null;
  expected: string | null;
  phone: string | null;
  status: string;
}

export interface LineFix {
  action: LineFixAction;
  sessionId: string;
  uid?: string | null;
  label: string;
  explain: string;
}

export interface LineIssue {
  /** Clave estable (para no repetir avisos del mismo problema). */
  key: string;
  kind: LineIssueKind;
  severity: 'alta' | 'media' | 'baja';
  title: string;
  detail: string;
  /** Qué hacer si no hay reparación automática. */
  hint?: string;
  lines: LineRef[];
  user?: { id: number; name: string; numero: string | null; uid: string | null };
  fixes: LineFix[];
}

interface SessionRow {
  id: string;
  name: string;
  owner_uid: string | null;
  owner_name: string | null;
  phone: string | null;
  expected_phone: string | null;
  status: string;
  created_at: string;
}

interface UserRow {
  id: number;
  name: string | null;
  username: string | null;
  source: string;
  source_uid: string | null;
  esam_autorizado: number;
  esam_numero: string | null;
}

const key = (v: string | null | undefined) => {
  const k = phoneKeyOf(v);
  return k && k.length >= 8 ? k : null;
};

function ref(s: SessionRow): LineRef {
  return { id: s.id, name: s.name, owner: s.owner_name, ownerUid: s.owner_uid, expected: s.expected_phone, phone: s.phone, status: s.status };
}

const userName = (u: UserRow) => u.name || u.username || `Usuario ${u.id}`;

/** Todas las inconsistencias, de la más grave a la más leve. */
export function lineIssues(): LineIssue[] {
  const sessions = all<SessionRow>('SELECT id, name, owner_uid, owner_name, phone, expected_phone, status, created_at FROM sessions ORDER BY created_at');
  const users = all<UserRow>(
    `SELECT id, name, username, source, source_uid, esam_autorizado, esam_numero FROM users
      WHERE source = 'cronogramas' AND source_uid IS NOT NULL`,
  );
  const byUid = new Map(users.map((u) => [String(u.source_uid), u]));
  const issues: LineIssue[] = [];
  const flaggedOwners = new Set<string>();

  // 1) Línea con otro número vinculado del que espera.
  for (const s of sessions) {
    const linked = key(s.phone);
    const expected = key(s.expected_phone);
    if (linked && expected && linked !== expected) {
      issues.push({
        key: `linked_mismatch:${s.id}:${linked}`,
        kind: 'linked_mismatch',
        severity: 'alta',
        title: `«${s.owner_name ?? s.name}» tiene vinculado otro número`,
        detail: `La línea espera ${expected} pero tiene escaneado el ${linked}. Para no enviar desde un número ajeno, los envíos de su dueño se bloquean.`,
        hint: 'En Conexión, desvinculá esa línea y escaneá el QR con el teléfono del número correcto.',
        lines: [ref(s)],
        fixes: [],
      });
    }
  }

  // 2) Una cuenta con varias líneas: se conserva la de su número.
  const byOwner = new Map<string, SessionRow[]>();
  for (const s of sessions) if (s.owner_uid) byOwner.set(s.owner_uid, [...(byOwner.get(s.owner_uid) ?? []), s]);
  for (const [uid, list] of byOwner) {
    if (list.length < 2) continue;
    flaggedOwners.add(uid);
    const u = byUid.get(uid);
    const numero = key(u?.esam_numero);
    const keep = numero ? list.find((s) => key(s.phone) === numero) ?? list.find((s) => key(s.expected_phone) === numero) : undefined;
    const fixes: LineFix[] = keep
      ? list.filter((s) => s.id !== keep.id).map((s) => ({
          action: 'release_owner' as const,
          sessionId: s.id,
          label: `Quitar «${s.name}» de esta cuenta`,
          explain: `La línea ${s.name} (${s.phone ?? s.expected_phone ?? 'sin número'}) deja de estar asociada a ${u ? userName(u) : `la cuenta ${uid}`}; queda la de su número (${keep.name}).`,
        }))
      : [];
    issues.push({
      key: `duplicate_owner:${uid}:${list.map((s) => s.id).sort().join(',')}`,
      kind: 'duplicate_owner',
      severity: 'alta',
      title: `${u ? userName(u) : `La cuenta ${uid}`} tiene ${list.length} líneas asociadas`,
      detail: keep
        ? `Su número en cronogramas es ${numero}: corresponde a «${keep.name}». Las demás deberían soltarse.`
        : `Ninguna coincide con su número de cronogramas (${numero ?? 'sin número registrado'}).`,
      hint: keep ? undefined : 'Registrá el número correcto del usuario en cronogramas (Usuarios) y volvé a revisar.',
      lines: list.map(ref),
      user: u ? { id: u.id, name: userName(u), numero: u.esam_numero, uid } : undefined,
      fixes,
    });
  }

  // 3) Dos líneas con el mismo número.
  const byNumber = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const k = key(s.phone) ?? key(s.expected_phone);
    if (k) byNumber.set(k, [...(byNumber.get(k) ?? []), s]);
  }
  for (const [num, list] of byNumber) {
    if (list.length < 2) continue;
    issues.push({
      key: `shared_number:${num}:${list.map((s) => s.id).sort().join(',')}`,
      kind: 'shared_number',
      severity: 'alta',
      title: `El número ${num} está en ${list.length} líneas`,
      detail: 'Un número solo puede estar vinculado a una línea: las otras se desconectan o reciben mensajes duplicados.',
      hint: 'Conservá la línea conectada (o la del dueño correcto) y en las demás cambiá el número esperado o eliminala desde Conexión.',
      lines: list.map(ref),
      fixes: [],
    });
  }

  // 4) La línea de un usuario espera otro número que el registrado en cronogramas.
  for (const s of sessions) {
    if (!s.owner_uid || flaggedOwners.has(s.owner_uid)) continue;
    const u = byUid.get(s.owner_uid);
    const numero = key(u?.esam_numero);
    if (!u || !numero) continue;
    if (key(s.phone) === numero || key(s.expected_phone) === numero) continue;
    const libre = !key(s.phone);
    issues.push({
      key: `owner_number_mismatch:${s.id}:${numero}`,
      kind: 'owner_number_mismatch',
      severity: 'media',
      title: `La línea de ${userName(u)} espera otro número`,
      detail: `Su número en cronogramas es ${numero} y la línea «${s.name}» espera ${s.expected_phone ?? '—'}${s.phone ? ` (vinculado: ${s.phone})` : ''}.`,
      hint: libre ? undefined : 'Tiene vinculado otro teléfono: desvinculala en Conexión y escaneá con el número correcto.',
      lines: [ref(s)],
      user: { id: u.id, name: userName(u), numero: u.esam_numero, uid: s.owner_uid },
      fixes: libre
        ? [{ action: 'align_expected', sessionId: s.id, label: `Esperar el ${numero}`, explain: `La línea «${s.name}» pasa a esperar el número ${numero} de ${userName(u)}.` }]
        : [],
    });
  }

  // 5) Usuarios autorizados: su número está en una línea de otra cuenta, o no tienen línea.
  for (const u of users) {
    const numero = key(u.esam_numero);
    if (!numero || !u.esam_autorizado) continue;
    const uid = String(u.source_uid);
    if (sessions.some((s) => s.owner_uid === uid && (key(s.phone) === numero || key(s.expected_phone) === numero))) continue;
    const ajena = sessions.find((s) => key(s.phone) === numero) ?? sessions.find((s) => key(s.expected_phone) === numero);
    if (ajena) {
      const actual = ajena.owner_uid ? byUid.get(ajena.owner_uid) : undefined;
      issues.push({
        key: `number_other_owner:${ajena.id}:${uid}`,
        kind: 'number_other_owner',
        severity: 'media',
        title: `La línea con el número de ${userName(u)} figura a nombre de otro`,
        detail: `«${ajena.name}» (${numero}) está asociada a ${actual ? userName(actual) : ajena.owner_name ?? 'nadie'}, pero ese número es de ${userName(u)} en cronogramas.`,
        lines: [ref(ajena)],
        user: { id: u.id, name: userName(u), numero: u.esam_numero, uid },
        fixes: [{ action: 'assign_owner', sessionId: ajena.id, uid, label: `Asignar a ${userName(u)}`, explain: `La línea «${ajena.name}» pasa a ser de ${userName(u)} (su número ${numero}).` }],
      });
    } else {
      issues.push({
        key: `user_without_line:${uid}:${numero}`,
        kind: 'user_without_line',
        severity: 'baja',
        title: `${userName(u)} no tiene línea con su número`,
        detail: `Está autorizado con el número ${numero}, pero ninguna línea lo tiene: no podrá enviar mensajes masivos.`,
        hint: 'Se crea al guardar el usuario en cronogramas o cuando entra a Seguimiento ESAM y vincula su número en Conexión.',
        lines: [],
        user: { id: u.id, name: userName(u), numero: u.esam_numero, uid },
        fixes: [],
      });
    }
  }

  // 6) Líneas sin dueño (salvo la principal) que no coinciden con ningún usuario.
  const primaryId = sessions[0]?.id;
  for (const s of sessions) {
    if (s.owner_uid || s.id === primaryId) continue;
    if (issues.some((i) => i.lines.some((l) => l.id === s.id))) continue;
    issues.push({
      key: `orphan_line:${s.id}`,
      kind: 'orphan_line',
      severity: 'baja',
      title: `«${s.name}» no tiene dueño`,
      detail: `Número ${s.phone ?? s.expected_phone ?? 'sin número'}. Nadie la usa para enviar; si no se necesita, se puede eliminar en Conexión.`,
      lines: [ref(s)],
      fixes: [],
    });
  }

  const order = { alta: 0, media: 1, baja: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Aplica una reparación (solo las seguras). Devuelve el mensaje para mostrar. */
export function applyLineFix(action: LineFixAction, sessionId: string, actorId: number | null, uid?: string | null): string {
  const s = get<SessionRow>('SELECT id, name, owner_uid, owner_name, phone, expected_phone, status, created_at FROM sessions WHERE id = ?', sessionId);
  if (!s) throw new Error('La línea ya no existe.');
  // Solo se aplica si el problema sigue vigente (evita reparar con datos viejos).
  const still = lineIssues().some((i) => i.fixes.some((f) => f.action === action && f.sessionId === sessionId && (f.uid ?? null) === (uid ?? null)));
  if (!still) throw new Error('Ese problema ya no está: recargá la página.');
  const now = nowIso();
  if (action === 'release_owner') {
    run('UPDATE sessions SET owner_uid = NULL, owner_name = NULL, updated_at = ? WHERE id = ?', now, sessionId);
    audit('line.release_owner', { session_id: sessionId, previous_owner: s.owner_uid, by: actorId });
    return `«${s.name}» ya no está asociada a esa cuenta.`;
  }
  if (action === 'assign_owner') {
    const u = get<UserRow>('SELECT id, name, username, source, source_uid, esam_autorizado, esam_numero FROM users WHERE source_uid = ?', String(uid ?? ''));
    if (!u) throw new Error('El usuario ya no existe.');
    run('UPDATE sessions SET owner_uid = ?, owner_name = ?, updated_at = ? WHERE id = ?', String(u.source_uid), userName(u), now, sessionId);
    audit('line.assign_owner', { session_id: sessionId, previous_owner: s.owner_uid, owner: u.source_uid, by: actorId });
    return `«${s.name}» ahora es de ${userName(u)}.`;
  }
  const u = s.owner_uid
    ? get<UserRow>('SELECT id, name, username, source, source_uid, esam_autorizado, esam_numero FROM users WHERE source_uid = ?', s.owner_uid)
    : undefined;
  const numero = key(u?.esam_numero);
  if (!numero) throw new Error('El dueño no tiene número registrado.');
  run('UPDATE sessions SET expected_phone = ?, phone_verified_at = NULL, updated_at = ? WHERE id = ?', numero, now, sessionId);
  audit('line.align_expected', { session_id: sessionId, previous: s.expected_phone, expected: numero, by: actorId });
  return `«${s.name}» ahora espera el número ${numero}.`;
}

const SEEN_KEY = 'line_issues_seen';

/**
 * Avisa en la campana a quienes supervisan cuando aparecen inconsistencias
 * nuevas (graves o medias). Un problema ya avisado no se repite mientras siga.
 */
export function notifyNewLineIssues(): number {
  const issues = lineIssues().filter((i) => i.severity !== 'baja');
  let seen: string[] = [];
  try {
    seen = JSON.parse(getConfig(SEEN_KEY) ?? '[]') as string[];
  } catch {
    seen = [];
  }
  const nuevos = issues.filter((i) => !seen.includes(i.key));
  // Se guardan solo las vigentes: si un problema se resuelve y vuelve, se avisa de nuevo.
  setConfig(SEEN_KEY, JSON.stringify(issues.map((i) => i.key)));
  if (!nuevos.length) return 0;
  notify(supervisorIds(), {
    kind: 'line_issue',
    title: nuevos.length === 1 ? `Inconsistencia en las líneas: ${nuevos[0].title}` : `Se detectaron ${nuevos.length} inconsistencias en las líneas de WhatsApp`,
    body: 'Puede hacer que un envío salga desde un número que no corresponde o se bloquee. Revisalo en Consistencia de líneas.',
    link: '/settings/lines',
  });
  return nuevos.length;
}

/** Revisión periódica (al arrancar y cada hora). */
export function startLineHealthWorker(): void {
  const tick = () => {
    try {
      notifyNewLineIssues();
    } catch {
      // un fallo de la revisión no debe afectar al servicio
    }
  };
  setTimeout(tick, 60_000);
  setInterval(tick, 3600_000);
}
