import { createRequire } from 'node:module';
import { logger } from '../logger.js';

/**
 * Parche de `libsignal` para recuperar la recepción tras un apagado largo.
 *
 * Mientras el servicio está apagado, el teléfono principal sigue enviando al
 * dispositivo vinculado mensajes internos (sincronización de estado, recibos,
 * etc.) que avanzan la cadena de cifrado. Si se acumulan más de 2000, libsignal
 * rechaza todo lo que llega después con "Over 2000 messages into the future!":
 * los mensajes enviados desde el teléfono (y a veces los recibidos) dejan de
 * verse para siempre, aunque el socket esté conectado.
 *
 * El parche reemplaza `fillMessageKeys` por una versión iterativa (la original
 * es recursiva y no admite saltos grandes) que tolera hasta `MAX_SKIP` mensajes
 * y solo conserva las claves de los últimos `KEEP_KEYS` (las anteriores
 * corresponden a mensajes que ya no van a llegar), para no inflar la sesión.
 */
const MAX_SKIP = 100_000;
const KEEP_KEYS = 2000;

const require = createRequire(import.meta.url);

let applied = false;

export function applySignalPatch(): void {
  if (applied) return;
  applied = true;
  try {
    const libsignal = require('libsignal');
    const crypto = libsignal.crypto;
    const SessionCipher = libsignal.SessionCipher;
    const SessionError = libsignal.SessionError ?? Error;
    if (!SessionCipher?.prototype?.fillMessageKeys) {
      logger.warn('libsignal sin fillMessageKeys: no se aplica el parche de cadenas largas');
      return;
    }
    SessionCipher.prototype.fillMessageKeys = function fillMessageKeys(chain: any, counter: number): void {
      if (chain.chainKey.counter >= counter) return;
      const gap = counter - chain.chainKey.counter;
      if (gap > MAX_SKIP) {
        throw new SessionError(`Over ${MAX_SKIP} messages into the future!`);
      }
      if (chain.chainKey.key === undefined) {
        throw new SessionError('Chain closed');
      }
      if (gap > KEEP_KEYS) {
        logger.warn({ gap }, 'Cadena de cifrado adelantada: se recupera saltando mensajes perdidos');
      }
      const keepFrom = counter - KEEP_KEYS;
      let key = chain.chainKey.key;
      while (chain.chainKey.counter < counter) {
        const next = chain.chainKey.counter + 1;
        if (next > keepFrom) {
          chain.messageKeys[next] = crypto.calculateMAC(key, Buffer.from([1]));
        }
        key = crypto.calculateMAC(key, Buffer.from([2]));
        chain.chainKey.key = key;
        chain.chainKey.counter = next;
      }
    };
    logger.info('Parche de libsignal aplicado (tolera cadenas adelantadas tras un apagado largo)');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'No se pudo aplicar el parche de libsignal');
  }
}
