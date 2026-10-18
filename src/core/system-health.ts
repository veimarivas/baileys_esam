import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { lastBackup } from './backup.js';
import { webhookQueueStats } from './webhook-queue.js';
import { runtimeInfo, type RuntimeInfo } from './runtime.js';

/**
 * Estado del proceso para el gestor de procesos y el monitoreo (`GET /health` en
 * el gateway y `GET /healthz` en el panel).
 *
 * Es un resumen **público**: no expone rutas de archivos ni datos de
 * conversaciones, solo tamaños y contadores. `ok` responde por la vida del
 * proceso (si contesta, está vivo), no por la salud de las líneas: un gestor de
 * procesos no debe reiniciar un servicio que funciona solo porque WhatsApp se
 * desconectó. Lo que conviene mirar va en `warnings`.
 */

export interface SystemHealth {
  ok: boolean;
  engine: 'baileys';
  app: 'baileys_esam';
  runtime: RuntimeInfo;
  backup: { name: string; at: string; dbBytes: number } | null;
  /** Líneas por estado (`sessions.status`). */
  sessions: { total: number; ready: number; disconnected: number; connecting: number; other: number };
  db: { mb: number; walMb: number };
  logs: { biggestMb: number; maxMb: number; overLimit: boolean };
  webhooks: { pending: number; dead: number };
  uptimeSeconds: number;
  memoryMb: number;
  /** Cosas que conviene revisar; no implican que el proceso esté caído. */
  warnings: string[];
}

const MB = 1_048_576;

/** Tamaño de un archivo en MB, o 0 si no existe. */
function fileMb(file: string): number {
  try {
    return Math.round((fs.statSync(file).size / MB) * 10) / 10;
  } catch {
    return 0;
  }
}

/**
 * Tamaño del log más grande de la carpeta (MB). Se mira la carpeta y no un
 * archivo fijo porque el nombre cambia según el lanzador (`service.out.log` con el
 * wrapper, `pm2-out.log` con pm2).
 */
function biggestLogMb(dir: string): number {
  let biggest = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    try {
      biggest = Math.max(biggest, fs.statSync(path.join(dir, name)).size);
    } catch {
      // archivo bloqueado o borrado en el medio: se ignora
    }
  }
  return Math.round((biggest / MB) * 10) / 10;
}

export function systemHealth(sessions: Array<{ status: string }> = []): SystemHealth {
  const count = (status: string): number => sessions.filter((s) => s.status === status).length;
  const ready = count('ready');
  const disconnected = count('disconnected');
  const connecting = count('connecting');
  const dbMb = fileMb(config.dbPath);
  const walMb = fileMb(`${config.dbPath}-wal`);
  const logMb = biggestLogMb(config.logsDir);
  const queue = webhookQueueStats();
  const runtime = runtimeInfo();
  const maxMb = Math.max(1, config.logMaxMb);

  const warnings: string[] = [];
  if (!sessions.length) warnings.push('No hay líneas configuradas.');
  else if (!ready) warnings.push('Ninguna línea está conectada a WhatsApp.');
  if (logMb > maxMb) warnings.push(`El log del servicio supera ${maxMb} MB: se rota al reiniciar.`);
  if (queue.dead > 0) warnings.push(`${queue.dead} webhook(s) descartado(s) tras agotar los reintentos.`);
  if (walMb > 200) warnings.push(`El WAL de la base creció a ${walMb} MB: conviene reiniciar para hacer checkpoint.`);
  if (runtime.pendingRestart) warnings.push('Hay una compilación más nueva sin aplicar: reiniciá el servicio.');

  return {
    ok: true,
    engine: 'baileys',
    app: 'baileys_esam',
    runtime,
    backup: lastBackup(),
    sessions: {
      total: sessions.length,
      ready,
      disconnected,
      connecting,
      other: sessions.length - ready - disconnected - connecting,
    },
    db: { mb: dbMb, walMb },
    logs: { biggestMb: logMb, maxMb, overLimit: logMb > maxMb },
    webhooks: queue,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / MB),
    warnings,
  };
}
