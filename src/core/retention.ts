import fs from 'node:fs';
import path from 'node:path';
import { all, db, run } from '../db/index.js';
import { AVATARS_MEDIA_DIR, NOTES_MEDIA_DIR } from './media.js';
import { pruneDeadWebhooks } from './webhook-queue.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const DAY_MS = 86_400_000;

/** Fecha ISO de hace `days` días (las columnas de fecha son TEXT ISO). */
function cutoffIso(days: number): string {
  return new Date(Date.now() - Math.max(0, days) * DAY_MS).toISOString();
}

/**
 * Borra archivos de `data/media` más antiguos que `mediaRetentionDays`
 * (política de retención, sección 4.3 de MEJORAS.md).
 */
export function cleanupMedia(days = config.mediaRetentionDays): { deleted: number; bytes: number } {
  const root = path.resolve(config.storageDir);
  if (!fs.existsSync(root)) return { deleted: 0, bytes: 0 };
  // La biblioteca de stickers y las notas de voz internas son contenido
  // permanente del panel, no adjuntos de chat.
  const keep = new Set([path.join(root, 'stickers'), path.join(root, NOTES_MEDIA_DIR), path.join(root, AVATARS_MEDIA_DIR)]);
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
 * Actualiza las estadísticas del planificador de SQLite. Nunca se había hecho
 * (`sqlite_stat1` no existía): sin estadísticas, SQLite puede elegir un plan
 * malo para las consultas del inbox. `PRAGMA optimize` es barato y solo analiza
 * las tablas que cambiaron lo suficiente.
 */
export function optimizeDb(): void {
  try {
    db.exec('PRAGMA optimize');
    logger.info('Estadísticas de SQLite actualizadas (PRAGMA optimize)');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'No se pudo ejecutar PRAGMA optimize');
  }
}

export interface CleanupLogsResult {
  webhooks: number;
  audits: number;
  notifications: number;
  deadWebhooks: number;
}

/**
 * Poda las tablas que crecían para siempre (`webhook_logs`, `audit_logs`) y los
 * avisos de la campana **ya leídos**. Los avisos sin leer se conservan: son los
 * que esperan que alguien los mire.
 */
export function cleanupLogs(
  days = config.logRetentionDays,
  notificationDays = config.notificationRetentionDays,
): CleanupLogsResult {
  const cutoff = cutoffIso(days);
  const result: CleanupLogsResult = {
    webhooks: run('DELETE FROM webhook_logs WHERE created_at < ?', cutoff).changes,
    audits: run('DELETE FROM audit_logs WHERE created_at < ?', cutoff).changes,
    notifications: run(
      'DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?',
      cutoffIso(notificationDays),
    ).changes,
    deadWebhooks: pruneDeadWebhooks(cutoff),
  };
  const total = result.webhooks + result.audits + result.notifications + result.deadWebhooks;
  if (total) {
    logger.info({ ...result, days }, 'Tablas de diagnóstico podadas por retención');
  }
  return result;
}

/**
 * Tarea programada: limpia media y tablas de diagnóstico a diario, actualiza las
 * estadísticas de SQLite y hace VACUUM semanal. Ejecuta una primera limpieza poco
 * después de arrancar.
 */
export function startRetentionWorker(): NodeJS.Timeout {
  const cleanupTick = () => {
    try {
      cleanupMedia();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Error en la limpieza de media');
    }
  };

  const logsTick = () => {
    try {
      cleanupLogs();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Error al podar las tablas de diagnóstico');
    }
    optimizeDb();
  };

  const timer = setInterval(() => {
    cleanupTick();
    logsTick();
  }, DAY_MS);
  // El VACUUM es sincrono y bloquea el panel mientras corre: solo se agenda si
  // se habilita explícitamente con AUTO_VACUUM=true, y nunca al arrancar.
  if (config.autoVacuum) setInterval(() => vacuumDb(), 7 * DAY_MS);
  setTimeout(cleanupTick, 60_000);
  // La primera poda y el primer `optimize` esperan a que el arranque (conexión de
  // líneas y sincronización de historial) haya terminado.
  setTimeout(logsTick, 5 * 60_000);
  return timer;
}
