import 'dotenv/config';

function int(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function csv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Configuracion central del servicio. Todo proviene de variables de entorno
 * (.env). Los valores por defecto mantienen el servicio arrancable en local.
 */
export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  /** Puerto del gateway compatible OpenWA (X-API-Key). */
  port: int(process.env.PORT, 2785),
  /** Puerto de la API de integracion v1 (Bearer + allowlist). */
  apiPort: int(process.env.API_PORT, 8020),

  apiKey: process.env.API_KEY ?? '',
  integrationToken: process.env.INTEGRATION_TOKEN ?? '',
  integrationAllowedIps: csv(process.env.INTEGRATION_ALLOWED_IPS, ['127.0.0.1', '::1']),
  ssoSecret: process.env.SSO_SECRET ?? '',

  dbPath: process.env.DB_PATH ?? './data/baileys_esam.sqlite',
  authDir: process.env.BAILEYS_AUTH_DIR ?? './data/baileys',
  storageDir: process.env.STORAGE_DIR ?? './data/media',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  // Reconecta al arrancar las líneas ya vinculadas. Apagado, tras un reinicio
  // no se recibe nada hasta que alguien entra al panel.
  autoStartSessions: bool(process.env.AUTO_START_SESSIONS, true),
  maxConcurrentSessions: int(process.env.MAX_CONCURRENT_SESSIONS, 0),
  browserName: process.env.BAILEYS_BROWSER_NAME ?? 'Seguimiento ESAM',
  waVersion: process.env.BAILEYS_WA_VERSION ?? '',

  /**
   * Pide el historial completo al vincular un dispositivo nuevo. Necesario para
   * recibir los mensajes que llegaron mientras la sesion no estaba vinculada.
   */
  syncFullHistory: bool(process.env.BAILEYS_SYNC_FULL_HISTORY, true),

  /** Sincronizacion de historial de chats conocidos al reconectar. */
  historySync: {
    onReady: bool(process.env.HISTORY_SYNC_ON_READY, true),
    count: int(process.env.HISTORY_SYNC_COUNT, 50),
    maxChats: int(process.env.HISTORY_SYNC_MAX_CHATS, 50),
    maxAgeDays: int(process.env.HISTORY_SYNC_MAX_AGE_DAYS, 30),
    skipFreshHours: int(process.env.HISTORY_SYNC_SKIP_FRESH_HOURS, 12),
  },

  /** Puerto del panel web (UI propia). */
  panelPort: int(process.env.PANEL_PORT, 8030),

  /** Transcipcion de notas de voz (OpenAI-compatible). */
  transcription: {
    driver: (process.env.TRANSCRIBE_DRIVER ?? 'chat') as 'chat' | 'whisper',
    url: process.env.TRANSCRIBE_URL ?? '',
    apiKey: process.env.TRANSCRIBE_API_KEY ?? '',
    model: process.env.TRANSCRIBE_MODEL ?? 'whisper-1',
    language: process.env.TRANSCRIBE_LANGUAGE ?? 'es',
    prompt:
      process.env.TRANSCRIBE_PROMPT ??
      'Transcribe el audio en español de forma literal, sin agregar comentarios.',
    timeoutMs: int(process.env.TRANSCRIBE_TIMEOUT, 90) * 1000,
  },

  /** Nombre de la cookie de sesion del panel. */
  sessionCookie: process.env.SESSION_COOKIE ?? 'baileys_esam_session',
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 24 * 14),
  secretKey: process.env.APP_KEY ?? 'baileys_esam_dev_key',

  pacing: {
    enabled: bool(process.env.PACING_ENABLED, true),
    delayMin: int(process.env.PACING_DELAY_MIN, 25),
    delayMax: int(process.env.PACING_DELAY_MAX, 45),
    windowDays: csv(process.env.PACING_WINDOW_DAYS, ['1', '2', '3', '4', '5', '6']).map((d) =>
      parseInt(d, 10),
    ),
    windowStart: process.env.PACING_WINDOW_START ?? '08:00',
    windowEnd: process.env.PACING_WINDOW_END ?? '20:00',
    programCooldownMinutes: int(process.env.PACING_PROGRAM_COOLDOWN_MINUTES, 10),
  },

  webhookTimeoutMs: int(process.env.WEBHOOK_TIMEOUT, 10000),

  /** Reintentos de webhooks salientes (backoff exponencial). */
  webhookRetry: {
    maxAttempts: int(process.env.WEBHOOK_MAX_ATTEMPTS, 8),
    baseDelayMs: int(process.env.WEBHOOK_RETRY_BASE_MS, 30_000),
  },

  /** Días de retención de archivos en `data/media` antes de borrarlos. */
  mediaRetentionDays: int(process.env.MEDIA_RETENTION_DAYS, 30),

  /**
   * Descarga de media de mensajes que no llegaron en vivo (offline/historial).
   * Los offline se bajan en segundo plano; el historial, al abrirlo en el panel.
   */
  media: {
    downloadOffline: bool(process.env.MEDIA_DOWNLOAD_OFFLINE, true),
    downloadTimeoutMs: int(process.env.MEDIA_DOWNLOAD_TIMEOUT, 20) * 1000,
  },

  /**
   * Aviso a la campana cuando una línea queda sin conexión. Para las caídas que
   * suelen resolverse solas (red, reinicio pedido por WhatsApp) se espera este
   * tiempo antes de avisar; si reconecta antes, no se avisa. Las graves
   * (desvinculada, bloqueada, sesión reemplazada) avisan al instante.
   */
  sessionDownAlertMinutes: int(process.env.SESSION_DOWN_ALERT_MINUTES, 3),

  /** Respaldo diario de la base y de las credenciales de WhatsApp. */
  backup: {
    enabled: bool(process.env.BACKUP_ENABLED, true),
    dir: process.env.BACKUP_DIR ?? './data/backups',
    /** Cantidad de respaldos que se conservan (los más viejos se borran). */
    keep: int(process.env.BACKUP_KEEP, 7),
    /** Hora local (0-23) del respaldo diario. */
    hour: int(process.env.BACKUP_HOUR, 3),
  },

  /** Vuelca cada mensaje crudo a data/debug-messages.jsonl (solo diagnóstico). */
  debugDumpMessages: bool(process.env.DEBUG_DUMP_MESSAGES, false),

  /**
   * Compacta la base (VACUUM) automáticamente. `VACUUM` es síncrono y bloquea
   * el panel mientras corre, por eso queda desactivado por defecto.
   */
  autoVacuum: bool(process.env.AUTO_VACUUM, false),
} as const;

export type AppConfig = typeof config;
