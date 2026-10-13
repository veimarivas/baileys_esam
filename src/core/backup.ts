import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import { NOTES_MEDIA_DIR } from './media.js';
import { logger } from '../logger.js';

/**
 * Respaldo diario de la base SQLite (`VACUUM INTO`, copia consistente aunque
 * el servicio esté escribiendo) y de las credenciales de WhatsApp
 * (`data/baileys`). Se conservan los últimos `BACKUP_KEEP`.
 *
 * El `VACUUM INTO` corre en un hilo aparte con su propia conexión: con una
 * base de cientos de MB, hacerlo en el hilo principal congelaría el panel y la
 * recepción de mensajes durante varios segundos.
 */

export interface BackupResult {
  dir: string;
  dbBytes: number;
  authFiles: number;
  ms: number;
}

const PREFIX = 'backup-';
let running: Promise<BackupResult> | null = null;

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function backupRoot(): string {
  return path.resolve(config.backup.dir);
}

/** Copia la base con `VACUUM INTO` en un worker (no bloquea el hilo principal). */
function vacuumInto(dbPath: string, target: string): Promise<void> {
  const code = `
    const { workerData, parentPort } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.db, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 30000');
      db.prepare('VACUUM INTO ?').run(workerData.target);
      parentPort.postMessage({ ok: true });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
    } finally {
      db.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { db: dbPath, target } });
    worker.once('message', (m: { ok: boolean; error?: string }) => (m.ok ? resolve() : reject(new Error(m.error))));
    worker.once('error', reject);
    worker.once('exit', (codeExit) => {
      if (codeExit !== 0) reject(new Error(`El respaldo terminó con código ${codeExit}`));
    });
  });
}

/** Copia recursiva de la carpeta de credenciales (sin el lock de instancia). */
function copyDir(src: string, dest: string): number {
  if (!fs.existsSync(src)) return 0;
  let count = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.instance.lock') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) count += copyDir(from, to);
    else {
      fs.copyFileSync(from, to);
      count++;
    }
  }
  return count;
}

/** Respaldos existentes, del más nuevo al más viejo. */
export function listBackups(): Array<{ name: string; dir: string; at: string; dbBytes: number }> {
  const root = backupRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(PREFIX))
    .map((e) => {
      const dir = path.join(root, e.name);
      const db = path.join(dir, 'baileys_esam.sqlite');
      let dbBytes = 0;
      let at = '';
      try {
        const st = fs.statSync(db);
        dbBytes = st.size;
        at = st.mtime.toISOString();
      } catch {
        // respaldo incompleto
      }
      return { name: e.name, dir, at, dbBytes };
    })
    .filter((b) => b.dbBytes > 0)
    .sort((a, b) => b.name.localeCompare(a.name));
}

function prune(): void {
  const all = listBackups();
  for (const old of all.slice(Math.max(1, config.backup.keep))) {
    try {
      fs.rmSync(old.dir, { recursive: true, force: true });
      logger.info({ backup: old.name }, 'Respaldo antiguo eliminado');
    } catch (err) {
      logger.warn({ backup: old.name, err: (err as Error).message }, 'No se pudo borrar un respaldo antiguo');
    }
  }
  // Restos de respaldos interrumpidos (p. ej. por un reinicio a mitad).
  const root = backupRoot();
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith(PREFIX) && e.name.endsWith('.tmp')) {
      fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
    }
  }
}

/** Ejecuta un respaldo ahora (si ya hay uno en curso, devuelve ese). */
export function runBackup(): Promise<BackupResult> {
  if (running) return running;
  running = (async () => {
    const t0 = Date.now();
    const root = backupRoot();
    fs.mkdirSync(root, { recursive: true });
    const name = `${PREFIX}${stamp()}`;
    const tmp = path.join(root, `${name}.tmp`);
    const final = path.join(root, name);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const dbTarget = path.join(tmp, 'baileys_esam.sqlite');
      await vacuumInto(path.resolve(config.dbPath), dbTarget);
      const authFiles = copyDir(path.resolve(config.authDir), path.join(tmp, 'baileys'));
      // Notas de voz internas: no están en la base y no se pueden recuperar de WhatsApp.
      copyDir(path.resolve(config.storageDir, NOTES_MEDIA_DIR), path.join(tmp, 'notes-media'));
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(tmp, final);
      prune();
      const result = { dir: final, dbBytes: fs.statSync(path.join(final, 'baileys_esam.sqlite')).size, authFiles, ms: Date.now() - t0 };
      logger.info(result, 'Respaldo completado');
      return result;
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      logger.error({ err: (err as Error).message }, 'Falló el respaldo');
      throw err;
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Último respaldo correcto (para /health y el panel). */
export function lastBackup(): { name: string; at: string; dbBytes: number } | null {
  const [latest] = listBackups();
  return latest ? { name: latest.name, at: latest.at, dbBytes: latest.dbBytes } : null;
}

/**
 * Programa el respaldo diario a `BACKUP_HOUR`. Si el último tiene más de 24 h
 * (o no hay ninguno), hace uno a los 2 minutos de arrancar.
 */
export function startBackupWorker(): void {
  if (!config.backup.enabled) return;
  const last = lastBackup();
  if (!last || Date.now() - Date.parse(last.at) > 24 * 3_600_000) {
    setTimeout(() => void runBackup().catch(() => undefined), 2 * 60_000);
  }
  let lastDay = '';
  setInterval(() => {
    const now = new Date();
    const day = now.toDateString();
    if (now.getHours() === config.backup.hour && day !== lastDay) {
      lastDay = day;
      void runBackup().catch(() => undefined);
    }
  }, 60_000);
}
