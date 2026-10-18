/**
 * npm run restart — compila y reinicia el servicio para aplicar los cambios.
 *
 *  1. Compila (tsc). Si falla, NO toca el servicio en marcha.
 *  2. Ubica la instancia viva por el bloqueo de instancia única y la detiene:
 *     el wrapper (run-forever / pm2) la vuelve a levantar con el código nuevo.
 *     Si no hay wrapper, la arranca en segundo plano.
 *  3. Espera a que /health responda con el proceso nuevo y lo informa.
 */
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
process.chdir(root);
try {
  require('dotenv').config({ path: path.join(root, '.env') });
} catch {
  // sin dotenv: se usan los valores por defecto
}

const isWin = process.platform === 'win32';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 2785);
const lockPath = path.join(path.resolve(root, process.env.BAILEYS_AUTH_DIR || './data/baileys'), '.instance.lock');

function log(msg) {
  console.log(`[restart] ${msg}`);
}

function health() {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLock() {
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return data && alive(data.pid) ? data : null;
  } catch {
    return null;
  }
}

/** pm2 en Windows es un .cmd: se invoca vía cmd /c (sin shell: true). */
function pm2(args, stdio) {
  return isWin
    ? spawnSync('cmd', ['/d', '/s', '/c', 'pm2', ...args], { stdio })
    : spawnSync('pm2', args, { stdio });
}

function hasPm2App() {
  return pm2(['describe', 'baileys_esam'], 'ignore').status === 0;
}

function startDetached() {
  if (isWin) {
    log('arrancando en segundo plano (scripts/autostart.ps1)…');
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'autostart.ps1')], {
      stdio: 'inherit',
    });
    return;
  }
  log('arrancando en segundo plano (scripts/run-forever.cjs)…');
  const logs = path.join(root, 'storage', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  // Rota antes de abrir el log (acá este script es el dueño del archivo).
  spawnSync(process.execPath, [path.join(root, 'scripts', 'rotate-logs.cjs')], { stdio: 'ignore' });
  const out = fs.openSync(path.join(logs, 'service.out.log'), 'a');
  spawn(process.execPath, [path.join(root, 'scripts', 'run-forever.cjs')], {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
  }).unref();
}

async function waitForNew(oldPid, seconds) {
  for (let i = 0; i < seconds; i++) {
    const h = await health();
    if (h && h.runtime && h.runtime.pid !== oldPid) return h;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

(async () => {
  log('compilando…');
  const tsc = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
    stdio: 'inherit',
  });
  if (tsc.status !== 0) {
    log('la compilación falló: el servicio en marcha NO se tocó.');
    process.exit(1);
  }

  const lock = readLock();
  if (lock && lock.mode === 'src') {
    log(`la instancia viva (PID ${lock.pid}) es un "npm run dev". Detenela antes: el servicio de producción no debe correr en paralelo.`);
    process.exit(1);
  }

  if (hasPm2App()) {
    log('reiniciando con pm2…');
    pm2(['restart', 'baileys_esam'], 'inherit');
  } else if (lock) {
    log(`deteniendo la instancia PID ${lock.pid} (el wrapper la vuelve a levantar)…`);
    try {
      process.kill(lock.pid);
    } catch (err) {
      log(`no se pudo detener: ${err.message}`);
      process.exit(1);
    }
  } else {
    log('no hay una instancia corriendo.');
  }

  let h = await waitForNew(lock ? lock.pid : -1, 20);
  if (!h) {
    // Sin wrapper que la relance (p. ej. se había arrancado con npm start).
    startDetached();
    h = await waitForNew(lock ? lock.pid : -1, 60);
  }
  if (!h) {
    log('el servicio no respondió en /health. Revisá storage/logs/service.out.log.');
    process.exit(1);
  }
  const rt = h.runtime;
  log(`listo: v${rt.version} · PID ${rt.pid} · modo ${rt.mode} · compilado ${rt.buildAt}`);
  if (rt.pendingRestart) log('atención: el proceso nuevo todavía reporta una compilación pendiente.');
})();
