/**
 * npm run backup — respaldo manual de la base y de las credenciales de WhatsApp.
 * Se puede ejecutar con el servicio en marcha (la copia es consistente).
 */
import { lastBackup, listBackups, runBackup } from '../core/backup.js';

try {
  const result = await runBackup();
  const mb = (result.dbBytes / 1024 / 1024).toFixed(1);
  console.log(`Respaldo listo en ${result.dir} (base ${mb} MB, ${result.authFiles} archivos de credenciales, ${result.ms} ms).`);
  console.log(`Respaldos guardados: ${listBackups().length}. Último: ${lastBackup()?.name ?? '—'}.`);
} catch (err) {
  console.error(`No se pudo respaldar: ${(err as Error).message}`);
  process.exit(1);
}
