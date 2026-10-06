const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * Ejecuta el servicio y lo reinicia automáticamente si se cae (con backoff).
 * Evita que un error puntual deje el gateway y la API caídos.
 */
const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const distEntry = path.join(root, 'dist', 'index.js');
const fs = require('node:fs');

// Prefiere el build compilado; si no existe, usa tsx sobre el código fuente.
const useDist = fs.existsSync(distEntry);
const command = process.execPath;
const args = useDist ? [distEntry] : [tsxCli, 'src/index.ts'];

let backoff = 1000;
let stopping = false;

console.log('[run-forever] arrancando:', useDist ? 'dist/index.js' : 'src/index.ts');

function start() {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });

  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[run-forever] el proceso terminó (code=${code} signal=${signal}); reinicio en ${backoff} ms`);
    setTimeout(() => {
      backoff = Math.min(backoff * 2, 30000);
      start();
    }, backoff);
  });

  // Tras 30 s estable, se resetea el backoff.
  setTimeout(() => {
    backoff = 1000;
  }, 30000);

  process.on('SIGINT', () => {
    stopping = true;
    child.kill('SIGINT');
    process.exit(0);
  });
}

start();
