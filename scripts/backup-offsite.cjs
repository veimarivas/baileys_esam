/**
 * Copia del respaldo FUERA del servidor — `npm run backup:offsite`.
 *
 *   node scripts/backup-offsite.cjs [--dry-run]
 *
 * El respaldo diario (`src/core/backup.ts`) deja la base con `VACUUM INTO` y
 * las credenciales de WhatsApp en `data/backups/`. Eso resuelve "me equivoqué y
 * quiero volver atrás" y no resuelve nada de lo que de verdad asusta: el
 * respaldo vive en el MISMO volumen que respalda, así que un disco que falla se
 * lleva los datos y las copias juntos, y un `docker volume rm` también.
 *
 * Esto manda la última copia a otro lado y poda las viejas del destino.
 *
 * Inerte sin configuración, igual que el push: si `OFFSITE_DEST` no está
 * definido, informa y sale con 0. Un cron que no tiene nada que hacer no es un
 * error.
 *
 * Variables:
 *   OFFSITE_DEST     destino. Con rsync/scp: `usuario@host:/ruta`.
 *                    Con rclone: `remoto:bucket/ruta`.
 *   OFFSITE_METHOD   rsync (por defecto) | scp | rclone
 *   OFFSITE_SSH_PORT puerto SSH del destino (por defecto 22)
 *   OFFSITE_SSH_KEY  ruta a la clave privada (opcional)
 *   OFFSITE_KEEP     cuántas copias conservar en el destino (por defecto 14).
 *                    Solo se aplica con rsync/scp sobre SSH.
 *   BACKUP_DIR       de dónde leer (por defecto ./data/backups)
 *
 * Corre en el HOST, no dentro del contenedor: necesita la clave SSH del
 * destino, y una clave que puede escribir en el respaldo no tiene por qué estar
 * dentro de un proceso que mira internet.
 *
 * El cifrado NO está acá a propósito: el destino decide (un bucket con cifrado
 * en reposo, o un `rclone crypt`). Meter una passphrase en este script
 * significa una passphrase más que alguien tiene que no perder, y un respaldo
 * que no se puede descifrar es peor que no tenerlo.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

const dest = (process.env.OFFSITE_DEST || '').trim();
const method = (process.env.OFFSITE_METHOD || 'rsync').trim();
const sshPort = (process.env.OFFSITE_SSH_PORT || '22').trim();
const sshKey = (process.env.OFFSITE_SSH_KEY || '').trim();
const keep = Math.max(1, Number.parseInt(process.env.OFFSITE_KEEP || '14', 10) || 14);
const backupDir = path.resolve(root, process.env.BACKUP_DIR || './data/backups');

function log(...args) {
  console.log('[backup-offsite]', ...args);
}

function fail(message) {
  console.error('[backup-offsite] ERROR:', message);
  process.exit(1);
}

if (!dest) {
  log('OFFSITE_DEST no está definido: no hay a dónde copiar. Nada que hacer.');
  process.exit(0);
}

if (!['rsync', 'scp', 'rclone'].includes(method)) {
  fail(`OFFSITE_METHOD='${method}' no es rsync, scp ni rclone.`);
}

if (!fs.existsSync(backupDir)) {
  fail(`no existe ${backupDir}. ¿Corrió alguna vez el respaldo diario?`);
}

/** La carpeta de respaldo más reciente (`backup-YYYYMMDD-HHMM`). */
function latestBackup() {
  const dirs = fs
    .readdirSync(backupDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('backup-'))
    .map((e) => e.name)
    .sort();

  return dirs.length ? dirs[dirs.length - 1] : null;
}

const latest = latestBackup();

if (!latest) {
  fail(`no hay ninguna carpeta backup-* en ${backupDir}.`);
}

const source = path.join(backupDir, latest);
const bytes = fs
  .readdirSync(source, { withFileTypes: true })
  .filter((e) => e.isFile())
  .reduce((sum, e) => sum + fs.statSync(path.join(source, e.name)).size, 0);

log(`copia ${latest} (${(bytes / 1048576).toFixed(1)} MB) → ${dest} vía ${method}`);

/** Opciones de SSH comunes a rsync y scp. */
function sshOptions() {
  const parts = ['ssh', '-p', sshPort];
  if (sshKey) parts.push('-i', sshKey);
  return parts.join(' ');
}

function run(command, args) {
  log(dryRun ? 'SIMULADO:' : 'ejecuta:', command, args.join(' '));
  if (dryRun) return { status: 0 };

  const result = spawnSync(command, args, { stdio: 'inherit' });

  if (result.error) fail(`no se pudo ejecutar ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} terminó con código ${result.status}`);

  return result;
}

// --- subida ---------------------------------------------------------------
if (method === 'rsync') {
  // --partial + --append-verify: si se corta a mitad de una base de 500 MB, la
  // próxima corrida sigue donde quedó en vez de empezar de nuevo.
  run('rsync', ['-az', '--partial', '--append-verify', '-e', sshOptions(), `${source}/`, `${dest}/${latest}/`]);
} else if (method === 'scp') {
  const args = ['-r', '-P', sshPort];
  if (sshKey) args.push('-i', sshKey);
  run('scp', [...args, source, `${dest}/`]);
} else {
  run('rclone', ['copy', source, `${dest}/${latest}`, '--checksum']);
}

// --- poda del destino -----------------------------------------------------
//
// Sin esto el destino crece para siempre y el "respaldo externo" se convierte
// en una factura que nadie revisa.
if (method === 'rclone') {
  log(`poda del destino: con rclone se hace con una regla de lifecycle del bucket, no desde acá.`);
} else {
  const match = dest.match(/^([^:]+):(.+)$/);

  if (!match) {
    log(`no se pudo separar host y ruta de '${dest}': se omite la poda.`);
  } else {
    const [, host, remotePath] = match;
    // `ls -1d` ordenado por nombre (los nombres son fechas, así que el orden
    // alfabético ES el cronológico) y se borran todas menos las últimas `keep`.
    const remoteCommand = [
      `cd '${remotePath}' || exit 0;`,
      `ls -1d backup-* 2>/dev/null | sort | head -n -${keep} |`,
      `while read -r d; do rm -rf -- "$d"; done`,
    ].join(' ');

    const args = ['-p', sshPort];
    if (sshKey) args.push('-i', sshKey);
    run('ssh', [...args, host, remoteCommand]);
  }
}

log(dryRun ? 'simulación terminada.' : `listo. Se conservan las últimas ${keep} copias en el destino.`);
log('Recordatorio: un respaldo que nunca se restauró no es un respaldo. Probar el restore una vez por mes.');
