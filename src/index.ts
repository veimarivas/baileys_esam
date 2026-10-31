import { startLineHealthWorker } from './core/line-health.js';
import { startReplyFollowupWorker } from './core/reply-followup.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { migrate } from './db/index.js';
import { seedDefaultTemplates } from './core/templates.js';
import { SessionManager } from './baileys/manager.js';
import { BatchRunner } from './core/batches.js';
import { createGatewayApp } from './gateway/server.js';
import { createApiApp } from './api/server.js';
import { createPanelApp } from './panel/server.js';
import { pickReply, pruneCooldowns as pruneCooldownsImpl } from './core/autoreply.js';
import { startScheduler } from './core/scheduler.js';
import { startWebhookQueueWorker } from './core/webhook-queue.js';
import { startRetentionWorker } from './core/retention.js';
import { startBackupWorker } from './core/backup.js';
import { startNoteReminderWorker } from './core/note-reminders.js';
import { acquireInstanceLock } from './core/instance-lock.js';
import { runtime } from './core/runtime.js';
import { timezoneDrift } from './core/system-health.js';

async function main(): Promise<void> {
  // Antes que nada: una sola instancia por carpeta de credenciales.
  acquireInstanceLock(runtime.mode);
  logger.info({ version: runtime.version, pid: runtime.pid, mode: runtime.mode, buildAt: runtime.buildAt }, 'Arrancando baileys_esam');
  migrate();
  const tzDrift = timezoneDrift();
  if (tzDrift) logger.warn(tzDrift);
  seedDefaultTemplates();

  const manager = new SessionManager();
  const runner = new BatchRunner(manager);

  // Auto-respuestas: al recibir un texto, se busca una regla y se responde.
  manager.onIncomingText((sessionId, chatId, text) => {
    const rule = pickReply(chatId, text);
    if (!rule) return;
    void manager
      .sendText(sessionId, chatId, rule.reply_body)
      .then(() => logger.info({ chatId, rule: rule.id }, 'Auto-respuesta enviada'))
      .catch((err) => logger.warn({ err: (err as Error).message }, 'No se pudo enviar la auto-respuesta'));
  });

  const gateway = createGatewayApp(manager);
  const api = createApiApp(manager, runner);
  const panel = createPanelApp(manager, runner);

  // Se espera a que los TRES puertos queden abiertos antes de conectar ninguna
  // sesión de WhatsApp. Si un puerto está ocupado hay otra instancia corriendo:
  // se sale (vía el handler de error) sin abrir el socket, porque dos sockets
  // con las mismas credenciales corrompen las claves y dejan la sesión inútil.
  const gatewayServer = gateway.listen(config.port, config.host);
  const apiServer = api.listen(config.apiPort, config.host);
  const panelServer = panel.listen(config.panelPort, config.host);

  const listeningP = (
    server: import('node:http').Server,
    name: string,
  ) =>
    new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.once('listening', () => resolve());
      server.on('error', (err: NodeJS.ErrnoException) => {
        logger.error({ server: name, code: err.code, err: err.message }, 'No se pudo abrir el puerto; saliendo');
        process.exit(1);
      });
    });

  await Promise.all([
    listeningP(gatewayServer, 'gateway'),
    listeningP(apiServer, 'api'),
    listeningP(panelServer, 'panel'),
  ]);
  logger.info(`Gateway OpenWA-compatible (Baileys) en http://${config.host}:${config.port}`);
  logger.info(`API de integración v1 en http://${config.host}:${config.apiPort}/api/v1`);
  logger.info(`Panel web en http://${config.host}:${config.panelPort}`);

  if (config.autoStartSessions) {
    await manager.autoStart();
  }
  runner.resumePending();
  startScheduler(runner);
  startWebhookQueueWorker();
  startRetentionWorker();
  startBackupWorker();
  startNoteReminderWorker();
  startLineHealthWorker();
  startReplyFollowupWorker();
  setInterval(() => {
    try {
      pruneCooldownsImpl();
    } catch {
      // ignore
    }
  }, 3600_000);

  const shutdown = () => {
    logger.info('Apagando baileys_esam...');
    gatewayServer.close();
    apiServer.close();
    panelServer.close();
    setTimeout(() => process.exit(0), 300);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.stack ?? err.message : String(err) }, 'Fallo al arrancar');
  process.exit(1);
});

// Un error inesperado NO debe tumbar el servicio: se registra y se sigue.
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason.stack ?? reason.message : String(reason) },
    'Promesa rechazada no capturada',
  );
});

process.on('uncaughtException', (err) => {
  logger.error({ err: err.stack ?? err.message }, 'Excepción no capturada');
});
