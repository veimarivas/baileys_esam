/**
 * Utilidades de teléfono / JID compatibles con OpenWA y con `PhoneGuard` de
 * openwa_basico. Formato destino: `<digitos>@c.us` individual, `<id>@g.us` grupo.
 */

/** Deja solo dígitos. */
export function digits(input: string | null | undefined): string {
  return (input ?? '').replace(/\D+/g, '');
}

/**
 * Normaliza un teléfono boliviano: 8 dígitos -> `591` + 8; ya con `591` se
 * respeta; el resto se deja tal cual.
 */
export function normalizePhone(input: string | null | undefined): string {
  let d = digits(input);
  if (d.length === 8) d = `591${d}`;
  return d;
}

/** Construye el chatId individual `591XXXXXXXX@c.us`. */
export function chatIdFor(phone: string): string {
  return `${digits(phone)}@c.us`;
}

/** `true` si el JID es un grupo. */
export function isGroupJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith('@g.us');
}

/** Extrae los dígitos de un JID (`591...@s.whatsapp.net` -> `591...`). */
export function phoneFromJid(jid: string | null | undefined): string {
  if (!jid) return '';
  const bare = jid.split('@')[0] ?? '';
  return bare.split(':')[0] ?? '';
}

/**
 * Extrae el teléfono de un chat_id (`591...@c.us`). Devuelve `''` para chats
 * anónimos (`@lid`) y grupos, que no representan un número de WhatsApp.
 */
export function phoneFromChatId(chatId: string | null | undefined): string {
  const id = chatId ?? '';
  if (id.endsWith('@lid') || id.endsWith('@g.us') || id.endsWith('@broadcast')) return '';
  return phoneFromJid(id);
}

/** Traduce un MIME al tipo de contenido interno. */
export function typeForMime(mime: string): 'image' | 'video' | 'audio' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/** Extrae el código de un enlace de invitación de grupo. */
export function extractInviteCode(invite: string): string {
  const trimmed = invite.trim();
  const m = trimmed.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  return trimmed.replace(/[^A-Za-z0-9]/g, '');
}
