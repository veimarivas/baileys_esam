/**
 * Traducción de los errores crudos de WhatsApp a mensajes comprensibles para
 * el panel. Un «forbidden» en un grupo significa que la línea no participa en
 * el grupo, no que el destinatario haya bloqueado la línea.
 */

export type SendErrorKind =
  | 'group-membership'
  | 'blocked'
  | 'no-whatsapp'
  | 'media'
  | 'rate-limit'
  | 'connection'
  | 'other';

export interface SendErrorInfo {
  kind: SendErrorKind;
  title: string;
  detail: string;
  action: string;
  /** Texto original devuelto por WhatsApp/Baileys. */
  raw: string;
}

const GROUP_CHAT = /@g\.us$/i;

function cleanError(raw: string | null | undefined): string {
  return String(raw ?? '').trim().replace(/^bloqueado:\s*/i, '').trim();
}

/** Describe un fallo de envío según el error y el tipo de destino. */
export function describeSendError(
  raw: string | null | undefined,
  chatId: string | null | undefined,
): SendErrorInfo {
  const message = String(raw ?? '').trim();
  const text = cleanError(message).toLowerCase();
  const isGroup = GROUP_CHAT.test(String(chatId ?? ''));

  if ((isGroup && /forbidden|not[\s-]*authorized|not a participant|403/.test(text)) || /la l[ií]nea no est[aá] en el grupo|no participa en el grupo/.test(text)) {
    return {
      kind: 'group-membership',
      title: 'La línea no está en el grupo',
      detail:
        'WhatsApp rechazó el envío porque esta línea no participa en el grupo o fue eliminada de él. No es un bloqueo del destinatario ni un problema del mensaje.',
      action:
        'Agregá esta línea al grupo en WhatsApp y verificá que el enlace del grupo del programa sea el correcto en Cronogramas.',
      raw: message,
    };
  }

  if (/el contacto bloque[oó] la l[ií]nea|forbidden|block|bloque|reported|spam|not[\s-]*authorized|401|403|409/.test(text)) {
    return {
      kind: 'blocked',
      title: 'El contacto bloqueó la línea',
      detail:
        'El destinatario no admite mensajes de este número: bloqueó la línea o WhatsApp rechazó el envío por seguridad.',
      action:
        'No insistas desde esta línea. Verificá el número con otro medio y, si corresponde, intentá desde otra línea.',
      raw: message,
    };
  }

  if (/el n[uú]mero no tiene whatsapp|no.*whatsapp|not.*(on|in).*whatsapp|404|410|not found|gone|invalid number|n[uú]mero inv[aá]lido/.test(text)) {
    return {
      kind: 'no-whatsapp',
      title: 'El número no tiene WhatsApp',
      detail: 'WhatsApp no reconoce ese número como una cuenta activa.',
      action: 'Verificá el número del contacto. Si está mal cargado, corregilo en Cronogramas o en la ficha.',
      raw: message,
    };
  }

  if (/l[ií]mite temporal de whatsapp|too many|rate|429|l[ií]mite|limit exceeded|slow down/.test(text)) {
    return {
      kind: 'rate-limit',
      title: 'Límite temporal de WhatsApp',
      detail: 'WhatsApp frenó el envío por volumen o por velocidad. La línea sigue operativa.',
      action: 'Esperá unos minutos y reintentá los fallidos. Evitá enviar otra campaña grande ahora.',
      raw: message,
    };
  }

  if (/sin conexi[oó]n con whatsapp|timeout|timed out|econn|socket|connection|closed|offline|network|fetch failed/.test(text)) {
    return {
      kind: 'connection',
      title: 'Sin conexión con WhatsApp',
      detail: 'La línea perdió la conexión o el envío tardó demasiado en completarse.',
      action: 'Revisá el estado de la línea en Conexiones y reintentá cuando esté conectada.',
      raw: message,
    };
  }

  if (/no se pudo enviar el archivo|media|upload|download|expired|unavailable|empty|file|archivo|adjunto/.test(text)) {
    return {
      kind: 'media',
      title: 'No se pudo enviar el archivo',
      detail: 'El adjunto no se pudo preparar o subir a WhatsApp.',
      action: 'Verificá que el archivo siga disponible y reintentá el envío.',
      raw: message,
    };
  }

  return {
    kind: 'other',
    title: 'No se pudo completar el envío',
    detail: message || 'WhatsApp no devolvió un motivo concreto.',
    action: 'Reintentá los fallidos. Si el problema se repite, revisá la línea y el número de destino.',
    raw: message,
  };
}
