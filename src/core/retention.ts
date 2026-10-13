import fs from 'node:fs';
import path from 'node:path';
import { all, db } from '../db/index.js';
import { NOTES_MEDIA_DIR } from './media.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const DAY_MS = 86_400_000;

/**
 * Borra archivos de `data/media` más antiguos que `mediaRetentionDays`
 * (política de retención, sección 4.3 de MEJORAS.md).
 */
export function cleanupMedia(days = config.mediaRetentionDays): { deleted: number; bytes: number } {
  const root = path.resolve(config.storageDir);
  if (!fs.existsSync(root)) return { deleted: 0, bytes: 0 };
  // La biblioteca de stickers y las notas de voz internas son contenido
  // permanente del panel, no adjuntos de chat.
  const keep = new Set([path.join(root, 'stickers'), path.join(root, NOTES_MEDIA_DIR)]);
  // Por si alguna nota de voz quedó guardada en otra carpeta (versiones anteriores).
  const noteFiles = new Set(
    all<{ audio_path: string }>('SELECT audio_path FROM contact_notes WHERE audio_path IS NOT NULL').map((r) =>
      path.resolve(r.audio_path),
    ),
  );
  const cutoff = Date.now() - days * DAY_MS;
  let deleted = 0;
  let bytes = 0;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!keep.has(full)) walk(full);
        continue;
      }
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff && !noteFiles.has(path.resolve(full))) {
          bytes += stat.size;
          fs.unlinkSync(full);
          deleted++;
        }
      } catch {
        // archivo bloqueado o ya borrado: se ignora
      }
    }
  };

  walk(root);
  if (deleted) logger.info({ deleted, bytes, days }, 'Media antigua eliminada por retención');
  return { deleted, bytes };
}

/** Compacta la base SQLite (semanal). */
export function vacuumDb(): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    logger.info('VACUUM de SQLite completado');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'No se pudo ejecutar VACUUM');
  }
}

/**
 * Tarea programada: limpia media a diario y hace VACUUM semanal. Ejecuta una
 * primera limpieza/VACUUM poco después de arrancar.
 */
export function startRetentionWorker(): NodeJS.Timeout {
  const cleanupTick = () => {
    try {
      cleanupMedia();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Error en la limpieza de media');
    }
  };

  const timer = setInterval(cleanupTick, DAY_MS);
  // El VACUUM es sincrono y bloquea el panel mientras corre: solo se agenda si
  // se habilita explícitamente con AUTO_VACUUM=true, y nunca al arrancar.
  if (config.autoVacuum) setInterval(() => vacuumDb(), 7 * DAY_MS);
  setTimeout(cleanupTick, 60_000);
  return timer;
}
