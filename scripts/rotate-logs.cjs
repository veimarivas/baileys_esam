/**
 * Rotación de logs del servicio — `npm run logs:rotate`.
 *
 *   node scripts/rotate-logs.cjs [carpeta] [maxMB] [copias]
 *
 * Renombra `x.log` a `x.log.1` (y corre las copias anteriores) cuando el archivo
 * supera `maxMB`. Los lanzadores lo llaman **al arrancar**, antes de abrir el log.
 *
 * Por qué al arrancar y no en caliente: en Windows no se puede renombrar ni
 * reemplazar un archivo que otro proceso mantiene abierto (el log queda tomado por
 * el redirector del lanzador), así que la rotación se hace cuando todavía nadie lo
 * abrió. En pm2 los logs los maneja pm2: ahí conviene `pm2 install pm2-logrotate`.
 *
 * Nunca falla el arranque: cualquier error se informa y se sale con código 0.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dir = path.resolve(root, process.argv[2] || process.env.LOGS_DIR || 'storage/logs');
const maxMb = Number(process.argv[3] || process.env.LOG_MAX_MB || 10) || 10;
const keep = Math.max(1, Number(process.argv[4] || process.env.LOG_KEEP || 5) || 5);
const maxBytes = maxMb * 1024 * 1024;

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** Corre `a.log.1 → a.log.2 → …` y borra las copias que sobran. */
function shiftBackups(file) {
  try {
    fs.rmSync(`${file}.${keep}`, { force: true });
  } catch {
    // copia bloqueada: se ignora
  }
  for (let i = keep - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

let rotated = 0;
let skipped = 0;
let dirOk = false;

try {
  if (fs.existsSync(dir)) {
    dirOk = true;
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.log'))
      .sort();
    for (const name of files) {
      const file = path.join(dir, name);
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      if (size <= maxBytes) continue;
      try {
        shiftBackups(file);
        fs.renameSync(file, `${file}.1`);
        rotated++;
        console.log(`[rotate-logs] ${name}: ${mb(size)} MB → ${name}.1 (se conservan ${keep} copias)`);
      } catch (err) {
        // Lo más probable: el servicio está corriendo y tiene el archivo abierto.
        skipped++;
        console.warn(
          `[rotate-logs] ${name}: no se pudo rotar (${err.code || err.message}). ` +
            'Si el servicio está en marcha, se rotará en el próximo arranque.',
        );
      }
    }
  } else {
    console.log(`[rotate-logs] sin carpeta de logs todavía (${dir}).`);
  }
} catch (err) {
  console.warn(`[rotate-logs] error inesperado: ${err.message}`);
}

if (dirOk && !rotated && !skipped) console.log(`[rotate-logs] nada que rotar (límite ${maxMb} MB por archivo).`);
