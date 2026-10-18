/**
 * Aislamiento de las pruebas: fija las rutas a un directorio temporal ANTES de
 * que se evalúe cualquier módulo de `src/` (varios abren la base al importarse).
 *
 * Se importa con `import './helpers/temp-env.js';` como **primera** línea del
 * archivo de pruebas: ESM evalúa los imports en orden, así que este módulo corre
 * antes que `src/config.ts` (que lee `process.env` al cargarse). El import de la
 * base es dinámico justamente para que ocurra después de fijar las variables.
 *
 * Importante: nunca apuntar a `data/` real. `dotenv` no sobreescribe variables
 * ya definidas, por lo que estos valores ganan sobre el `.env` del proyecto.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-esam-test-'));

process.env.DB_PATH = path.join(dir, 'test.sqlite');
process.env.STORAGE_DIR = path.join(dir, 'media');
process.env.BAILEYS_AUTH_DIR = path.join(dir, 'baileys');
process.env.BACKUP_ENABLED = 'false';
process.env.BACKUP_DIR = path.join(dir, 'backups');
process.env.DEBUG_DUMP_MESSAGES = 'false';
process.env.AUTO_VACUUM = 'false';
// Las migraciones dejan avisos informativos en consola; en pruebas estorban.
process.env.LOG_LEVEL = 'silent';

// Base temporal con el esquema completo. `migrate()` no corre al importar el
// módulo (en producción lo llama `src/index.ts`), así que se aplica acá.
const { migrate } = await import('../../src/db/index.js');
migrate();

process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Si un archivo quedó tomado por SQLite, el sistema limpia el temporal.
  }
});

/** Directorio temporal de esta corrida (para archivos de prueba). */
export const testDir = dir;
