import { get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';
import { digits } from './phone.js';

/**
 * WhatsApp entrega los chats individuales modernos como `@lid` (identificador
 * anónimo) en lugar de `@s.whatsapp.net`. El panel trabaja con el número real
 * (`@c.us`), así que se mantiene un mapeo LID -> teléfono que llega por el
 * evento `chats.phoneNumberShare` y por los `contacts`.
 */

/** Registra (o actualiza) el mapeo LID -> JID de teléfono. */
export function rememberLid(lid: string | null | undefined, pn: string | null | undefined): void {
  if (!lid || !pn) return;
  if (!String(lid).includes('@lid')) return;
  const pnDigits = digits(pn);
  if (!pnDigits) return;
  const lidKey = lid.includes('@') ? lid : `${lid}@lid`;
  const pnKey = pn.includes('@') ? pn : `${pnDigits}@s.whatsapp.net`;
  run(
    `INSERT INTO lid_map (lid, pn, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn, updated_at = excluded.updated_at`,
    lidKey,
    pnKey,
    nowIso(),
  );
  migrateLidChat(lidKey, `${pnDigits}@c.us`);
}

/**
 * Cuando se descubre el número real de un LID, las conversaciones y mensajes
 * ya guardados con el LID se migran al número para que el panel los una.
 */
function migrateLidChat(lidChatId: string, pnChatId: string): void {
  try {
    const existing = get<{ id: number }>('SELECT id FROM conversations WHERE chat_id = ?', pnChatId);
    if (existing) {
      // Ya hay una conversación con el número: se fusiona (suma de no leídos).
      const lid = get<{ unread_count: number; last_message_at: string | null; last_direction: string | null }>(
        'SELECT unread_count, last_message_at, last_direction FROM conversations WHERE chat_id = ?',
        lidChatId,
      );
      if (lid) {
        run(
          `UPDATE conversations
             SET unread_count = unread_count + ?,
                 last_message_at = MAX(COALESCE(last_message_at, ''), COALESCE(?, '')),
                 updated_at = ?
           WHERE chat_id = ?`,
          Number(lid.unread_count ?? 0),
          lid.last_message_at,
          nowIso(),
          pnChatId,
        );
        run('DELETE FROM conversations WHERE chat_id = ?', lidChatId);
      }
    } else {
      run('UPDATE conversations SET chat_id = ? WHERE chat_id = ?', pnChatId, lidChatId);
    }
    run('UPDATE messages SET chat_id = ? WHERE chat_id = ?', pnChatId, lidChatId);

    // La ficha de contacto tambien pasa al chat con numero.
    const pnPhone = digits(pnChatId);
    const pnContact = get<{ id: number }>('SELECT id FROM contacts WHERE chat_id = ?', pnChatId);
    const lidContact = get<{ id: number }>('SELECT id FROM contacts WHERE chat_id = ?', lidChatId);
    if (lidContact && pnContact && pnContact.id !== lidContact.id) {
      run('DELETE FROM contacts WHERE id = ?', lidContact.id);
    } else if (lidContact) {
      run(
        'UPDATE contacts SET chat_id = ?, phone = COALESCE(phone, ?), updated_at = ? WHERE id = ?',
        pnChatId,
        pnPhone,
        nowIso(),
        lidContact.id,
      );
    }
    const finalContact = get<{ id: number }>('SELECT id FROM contacts WHERE chat_id = ?', pnChatId);
    if (finalContact) {
      run('UPDATE conversations SET contact_id = ? WHERE chat_id = ?', finalContact.id, pnChatId);
    }
  } catch {
    // best-effort: si falla la fusión no se pierde el mapeo.
  }
}

/**
 * Número mostrable de un chat: resuelve el LID a teléfono cuando se conoce.
 * Devuelve `null` si el chat es un LID sin mapeo (WhatsApp no comparte el PN).
 */
export function displayPhoneNumber(chatId: string | null | undefined): string | null {
  if (!chatId) return null;
  if (chatId.endsWith('@lid')) {
    const pn = phoneForLid(chatId);
    return pn ? digits(pn) : null;
  }
  return digits(chatId) || null;
}

/** Devuelve el teléfono (JID `@s.whatsapp.net`) para un LID, si se conoce. */
export function phoneForLid(lid: string | null | undefined): string | null {
  if (!lid) return null;
  const lidKey = lid.includes('@') ? lid : `${lid}@lid`;
  const row = get<{ pn: string }>('SELECT pn FROM lid_map WHERE lid = ?', lidKey);
  return row?.pn ?? null;
}

/** LID (`@lid`) conocido para un chat con número (`@c.us`/`@s.whatsapp.net`). */
export function lidForPhone(chatId: string | null | undefined): string | null {
  const d = digits(chatId ?? '');
  if (!d || String(chatId).endsWith('@g.us')) return null;
  const row = get<{ lid: string }>('SELECT lid FROM lid_map WHERE pn = ? ORDER BY updated_at DESC LIMIT 1', `${d}@s.whatsapp.net`);
  return row?.lid ?? null;
}

/**
 * Normaliza un JID entrante a un chat_id del panel:
 * - Si es `@lid` y se conoce su teléfono, devuelve `<digitos>@c.us`.
 * - Si es `@s.whatsapp.net`, devuelve `<digitos>@c.us`.
 * - Grupos y otros JID se devuelven tal cual.
 */
export function resolveChatId(jid: string | null | undefined): string {
  if (!jid) return '';
  if (jid.endsWith('@g.us')) return jid;
  if (jid.endsWith('@lid')) {
    const pn = phoneForLid(jid);
    if (pn) return `${digits(pn)}@c.us`;
    return jid;
  }
  if (jid.endsWith('@s.whatsapp.net')) return `${digits(jid)}@c.us`;
  return jid;
}

/** Number de teléfono legible de un chat_id (para mostrar). */
export function displayPhone(chatId: string | null | undefined): string {
  const raw = (chatId ?? '').split('@')[0] ?? '';
  return raw.split(':')[0] ?? '';
}
