import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Datos del proceso en ejecución: versión, hora de arranque y si hay una
 * compilación más nueva sin aplicar (código cambiado pero servicio sin
 * reiniciar). Se muestran en el pie del panel y en `/health`.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = path.join(root, 'dist', 'index.js');
const runningFile = fileURLToPath(import.meta.url);

function readVersion(): string {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function mtimeIso(file: string): string | null {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

export const runtime = {
  version: readVersion(),
  pid: process.pid,
  startedAt: new Date().toISOString(),
  /** `dist` (servicio compilado) o `src` (npm run dev / tsx). */
  mode: runningFile.endsWith('.js') ? 'dist' : 'src',
  /** Fecha de la compilación con la que arrancó este proceso. */
  buildAt: mtimeIso(distEntry),
};

export interface RuntimeInfo {
  version: string;
  pid: number;
  mode: string;
  startedAt: string;
  buildAt: string | null;
  uptimeSeconds: number;
  /** Hay una compilación más nueva en disco que este proceso no cargó. */
  pendingRestart: boolean;
  latestBuildAt: string | null;
}

export function runtimeInfo(): RuntimeInfo {
  const latest = mtimeIso(distEntry);
  const pendingRestart =
    runtime.mode === 'dist' && !!latest && !!runtime.buildAt && Date.parse(latest) > Date.parse(runtime.buildAt) + 1000;
  return {
    version: runtime.version,
    pid: runtime.pid,
    mode: runtime.mode,
    startedAt: runtime.startedAt,
    buildAt: runtime.buildAt,
    uptimeSeconds: Math.round(process.uptime()),
    pendingRestart,
    latestBuildAt: latest,
  };
}
