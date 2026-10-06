import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Bloqueo de instancia única sobre la carpeta de credenciales de WhatsApp.
 *
 * Dos procesos con las mismas credenciales (p. ej. el servicio y un
 * `npm run dev` olvidado) corrompen las claves de cifrado: aparecen "Bad MAC" y
 * el teléfono deja de poder enviar al panel hasta re-vincular. La guarda de
 * puertos no alcanza (el segundo proceso puede quedar vivo esperando), así que
 * se usa un archivo con el PID del dueño.
 */

interface LockData {
  pid: number;
  startedAt: string;
  /** Arranque del sistema operativo (para ignorar locks previos a un reinicio). */
  bootAt: number;
  mode: string;
}

export const lockPath = path.join(path.resolve(config.authDir), '.instance.lock');

function bootAt(): number {
  return Date.now() - os.uptime() * 1000;
}

function isAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = existe pero sin permiso para señalarlo: sigue vivo.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Lee el bloqueo actual (si lo hay y su dueño sigue vivo). */
export function currentLockOwner(): LockData | null {
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockData;
    // Un lock de antes del último reinicio de Windows es huérfano aunque el PID
    // haya sido reutilizado por otro programa.
    if (Math.abs((data.bootAt ?? 0) - bootAt()) > 120_000) return null;
    return isAlive(data.pid) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Toma el bloqueo o termina el proceso si otra instancia viva ya lo tiene.
 * Se libera al salir (y un lock huérfano por un cierre forzado se reemplaza).
 */
export function acquireInstanceLock(mode: string): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const owner = currentLockOwner();
  if (owner) {
    logger.error(
      { pid: owner.pid, since: owner.startedAt, mode: owner.mode, lock: lockPath },
      'Ya hay otra instancia de baileys_esam usando las credenciales de WhatsApp; se cancela este arranque para no corromper la sesión. Detené la otra (o usá `npm run restart`).',
    );
    process.exit(1);
  }
  const data: LockData = { pid: process.pid, startedAt: new Date().toISOString(), bootAt: bootAt(), mode };
  // Lock huérfano (dueño muerto o de antes de un reinicio): se reemplaza. La
  // creación exclusiva ('wx') evita que dos arranques simultáneos lo tomen.
  fs.rmSync(lockPath, { force: true });
  try {
    fs.writeFileSync(lockPath, JSON.stringify(data), { flag: 'wx' });
  } catch {
    logger.error({ lock: lockPath }, 'Otra instancia tomó el bloqueo al mismo tiempo; se cancela este arranque.');
    process.exit(1);
  }
  const release = () => {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockData;
      if (current.pid === process.pid) fs.rmSync(lockPath, { force: true });
    } catch {
      // ya no existe
    }
  };
  process.on('exit', release);
}
