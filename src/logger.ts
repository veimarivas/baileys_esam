import pino from 'pino';
import { config } from './config.js';

/** Logger principal del servicio. */
export const logger = pino({
  level: config.logLevel,
  base: { app: 'baileys_esam' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Logger silenciado para Baileys: la libreria es muy verbosa (debug de protocolo)
 * y no aporta al operador. Se puede subir con LOG_LEVEL=debug y BAILEYS_LOG=debug.
 */
export const baileysLogger = pino({
  level: process.env.BAILEYS_LOG ?? 'silent',
});
