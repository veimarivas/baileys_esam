import { phoneKeyOf } from './person.js';
import type { SessionRow } from '../types.js';

/**
 * Línea de WhatsApp desde la que envía un usuario de cronogramas.
 *
 * Regla: el mensaje sale SIEMPRE desde el número del usuario que envía. Antes
 * se tomaba la primera línea cuyo `owner_uid` era la cuenta, pero esa relación
 * puede quedar desordenada (una cuenta con dos líneas, o con la línea de otra
 * área) y el envío salía desde un número ajeno (p. ej. el de Contabilidad).
 *
 * Con el número del usuario (`phone`):
 *   1. la línea que tiene vinculado ese número (sea de la cuenta que sea);
 *   2. la línea propia que espera ese número;
 *   3. cualquier línea que espera ese número.
 *   Nunca cae a una línea de otro número.
 * Sin número (clientes anteriores): la línea propia que tenga vinculado el
 * número que espera; si no, la primera propia.
 */
export function resolveUserLine(sessions: SessionRow[], account: string | null | undefined, phone?: string | null): SessionRow | undefined {
  const same = (a: string | null | undefined, b: string | null | undefined) => {
    const x = phoneKeyOf(a);
    return !!x && x === phoneKeyOf(b);
  };
  const own = account ? sessions.filter((s) => s.owner_uid === String(account)) : [];
  const num = phoneKeyOf(phone);
  if (num && num.length >= 8) {
    return (
      sessions.find((s) => same(s.phone, num)) ??
      own.find((s) => same(s.expected_phone, num)) ??
      sessions.find((s) => same(s.expected_phone, num))
    );
  }
  return own.find((s) => s.phone && same(s.phone, s.expected_phone)) ?? own[0];
}

/** ¿La línea tiene vinculado un número distinto del que corresponde al usuario? */
export function linkedToOtherNumber(session: SessionRow, phone?: string | null): string | null {
  const linked = phoneKeyOf(session.phone);
  const expected = phoneKeyOf(phone) ?? phoneKeyOf(session.expected_phone);
  return linked && expected && linked !== expected ? linked : null;
}
