/**
 * Metadatos de mensajes especiales guardados en `messages.content_meta`.
 *
 * WhatsApp entrega los contactos como vCard y las encuestas como un objeto con
 * pregunta/opciones. Se guardan como JSON para que el panel pueda dibujar una
 * tarjeta útil sin depender del mensaje crudo (que no se conserva).
 */

export interface ContactCard {
  name: string | null;
  /** Teléfono en dígitos, sin JID ni signos. */
  phone: string | null;
}

export interface ContactMessageMeta {
  kind: 'contact';
  contacts: ContactCard[];
}

export interface PollMessageMeta {
  kind: 'poll';
  question: string;
  options: string[];
  /** 1 = una sola respuesta; 0 (o más de 1) = varias respuestas. */
  selectable_count: number;
}

export type MessageMeta = ContactMessageMeta | PollMessageMeta;

/** Desescapa los valores de un vCard (saltos, comas y punto y coma). */
function vcardText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * Extrae nombre y teléfono de un vCard de WhatsApp.
 *
 * Se prioriza `waid` (el número real que usa WhatsApp) y, si no está, el valor
 * del primer `TEL`. También se aceptan líneas con grupo (`item1.TEL`) y vCards
 * plegados, que son habituales en contactos compartidos.
 */
export function parseVCard(vcard: string | null | undefined): ContactCard {
  const raw = String(vcard ?? '')
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .replace(/\r\n/g, '\n');
  let name: string | null = null;
  let fallbackName: string | null = null;
  let phone: string | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const head = trimmed.slice(0, colon);
    const value = trimmed.slice(colon + 1);
    const key = (head.split(';')[0].split('.').pop() ?? '').toUpperCase();

    if (key === 'FN' && !name) {
      name = vcardText(value) || null;
    } else if (key === 'N' && !fallbackName) {
      // N: apellido;nombre;segundo nombre;prefijo;sufijo
      const parts = value.split(';').map(vcardText).filter(Boolean);
      fallbackName = parts.length > 1 ? [parts[1], parts[0]].filter(Boolean).join(' ') : parts[0] ?? null;
    } else if (key === 'TEL' && !phone) {
      const waid = /(?:^|;)waid=([^;:]+)/i.exec(head);
      const candidate = (waid ? waid[1] : value).replace(/\D+/g, '');
      if (candidate) phone = candidate;
    }
  }

  return { name: name || fallbackName, phone };
}

/** Metadatos de un `contactMessage` (un solo contacto). */
export function contactMeta(
  displayName: string | null | undefined,
  vcard: string | null | undefined,
): ContactMessageMeta {
  const parsed = parseVCard(vcard);
  return {
    kind: 'contact',
    contacts: [{ name: String(displayName ?? '').trim() || parsed.name, phone: parsed.phone }],
  };
}

/** Metadatos de un `contactsArrayMessage` (varios contactos en un mensaje). */
export function contactsArrayMeta(
  contacts: Array<{ displayName?: string | null; vcard?: string | null }> | null | undefined,
): ContactMessageMeta {
  const list = (contacts ?? [])
    .map((contact) => {
      const parsed = parseVCard(contact.vcard);
      return {
        name: String(contact.displayName ?? '').trim() || parsed.name,
        phone: parsed.phone,
      };
    })
    .filter((contact) => contact.name || contact.phone);
  return { kind: 'contact', contacts: list };
}

/** Metadatos de una encuesta creada por WhatsApp (o enviada desde el panel). */
export function pollMeta(
  name: string | null | undefined,
  options: Array<{ optionName?: string | null }> | null | undefined,
  selectableCount: number | null | undefined,
): PollMessageMeta {
  const rawCount = Number(selectableCount);
  return {
    kind: 'poll',
    question: String(name ?? '').trim() || 'Encuesta',
    options: (options ?? [])
      .map((option) => String(option.optionName ?? '').trim())
      .filter(Boolean)
      .slice(0, 12),
    selectable_count: Number.isFinite(rawCount) ? rawCount : 1,
  };
}

/** Texto corto para la vista previa de la conversación. */
export function contactPreview(meta: ContactMessageMeta): string {
  const first = meta.contacts[0];
  if (!first) return 'Contacto';
  const name = first.name || first.phone || 'Contacto';
  return meta.contacts.length > 1 ? `${name} y ${meta.contacts.length - 1} más` : name;
}

/** Serializa los metadatos para guardarlos en SQLite. */
export function metaJson(meta: MessageMeta | null): string | null {
  return meta ? JSON.stringify(meta) : null;
}
