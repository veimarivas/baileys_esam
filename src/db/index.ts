import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { SCHEMA } from './schema.js';
import { logger } from '../logger.js';

const resolved = path.resolve(config.dbPath);
fs.mkdirSync(path.dirname(resolved), { recursive: true });

export const db = new DatabaseSync(resolved);

// Bind nativo no acepta boolean ni undefined: se normalizan a 0/1 y null.
function norm(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

export function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(norm(params) as never[])) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(norm(params) as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
  const result = db.prepare(sql).run(...(norm(params) as never[]));
  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}

/** Agrega una columna si no existe (migración idempotente de bases antiguas). */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.info({ table, column }, 'Columna agregada por migración');
  }
}

/** Crea/actualiza el esquema y aplica valores por defecto. */
export function migrate(): void {
  // Lecturas concurrentes sin bloquear escrituras de lotes/webhooks.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  // Migraciones ligeras para bases ya existentes.
  addColumnIfMissing('messages', 'media_filename', 'TEXT');
  addColumnIfMissing('messages', 'media_seconds', 'INTEGER');
  addColumnIfMissing('messages', 'origin', 'TEXT');
  addColumnIfMissing('messages', 'reply_to_wa_id', 'TEXT');
  addColumnIfMissing('messages', 'sender_type', 'TEXT');
  addColumnIfMissing('messages', 'sender_uid', 'INTEGER');
  addColumnIfMissing('messages', 'sender_jid', 'TEXT');
  // Media diferida: referencia para bajarla después y su estado
  // (NULL = sin intentar, 'ok', 'missing' = no disponible en WhatsApp).
  addColumnIfMissing('messages', 'media_ref', 'TEXT');
  addColumnIfMissing('messages', 'media_state', 'TEXT');
  // Políticas anti-baneo ampliadas (envío humano y protección de reputación).
  addColumnIfMissing('anti_ban_policies', 'typing_simulation', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing('anti_ban_policies', 'min_gap_seconds', 'INTEGER NOT NULL DEFAULT 3');
  addColumnIfMissing('anti_ban_policies', 'verify_numbers', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing('anti_ban_policies', 'new_contacts_daily_limit', 'INTEGER NOT NULL DEFAULT 40');
  addColumnIfMissing('anti_ban_policies', 'max_consecutive_failures', 'INTEGER NOT NULL DEFAULT 5');
  addColumnIfMissing('anti_ban_policies', 'auto_pause_low_delivery', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing('anti_ban_policies', 'burst_per_minute', 'INTEGER NOT NULL DEFAULT 8');
  addColumnIfMissing('conversations', 'history_synced_at', 'TEXT');
  addColumnIfMissing('conversations', 'status', "TEXT NOT NULL DEFAULT 'open'");
  addColumnIfMissing('conversations', 'assigned_agent_id', 'INTEGER');
  addColumnIfMissing('conversations', 'last_message_text', 'TEXT');
  addColumnIfMissing('conversations', 'contact_id', 'INTEGER');
  addColumnIfMissing('conversations', 'closed_at', 'TEXT');
  addColumnIfMissing('contact_notes', 'due_at', 'TEXT');
  // Seguimiento de notas: completada (quién y cuándo) y última edición.
  addColumnIfMissing('contact_notes', 'done_at', 'TEXT');
  addColumnIfMissing('contact_notes', 'done_by', 'INTEGER');
  addColumnIfMissing('contact_notes', 'updated_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contact_notes_due ON contact_notes(done_at, due_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(session_id, chat_id, id)');
  // Orden por fecha dentro de un chat (evita ordenar toda la tabla en el inbox).
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_convo_time ON messages(session_id, chat_id, occurred_at, id)');
  // Join de respuestas citadas por wamid dentro de la sesión (evita escanear todo).
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_wa ON messages(session_id, wa_message_id)');
  // Cada acuse (ack) actualiza el destinatario del lote por wamid: sin este
  // índice recorría toda la tabla de destinatarios (lento al reconectar).
  db.exec('CREATE INDEX IF NOT EXISTS idx_batch_items_message ON batch_items(message_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(assigned_agent_id)');
  setupFullTextSearch();
  backfillInbox();
  backfillConversationLast();
  seedGlobalPolicy();
  logger.info({ db: resolved }, 'Esquema SQLite listo');
}

/** Marca en `configs` si la busqueda full-text (FTS5) quedo disponible. */
function setConfigFlag(key: string, value: string): void {
  db.prepare(
    `INSERT INTO configs (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

/**
 * Crea el indice FTS5 de mensajes y sus triggers. Si el build de SQLite no
 * trae FTS5, deja la bandera en `0` y la busqueda degrada a `LIKE`.
 */
function setupFullTextSearch(): void {
  const existed = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
    .get();
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(body, transcription, content='messages', content_rowid='id')`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, body, transcription) VALUES (new.id, new.body, new.transcription);
    END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body, transcription)
      VALUES ('delete', old.id, old.body, old.transcription);
    END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body, transcription)
      VALUES ('delete', old.id, old.body, old.transcription);
      INSERT INTO messages_fts(rowid, body, transcription) VALUES (new.id, new.body, new.transcription);
    END`);
    // Solo al crear el indice: carga los mensajes historicos una vez.
    if (!existed) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
    setConfigFlag('fts5', '1');
  } catch (err) {
    setConfigFlag('fts5', '0');
    logger.warn({ err: (err as Error).message }, 'FTS5 no disponible: la busqueda usara LIKE');
  }
}

/**
 * Rellena datos derivados al migrar una base existente: ficha de contacto por
 * conversacion, enlace `contact_id`, `last_message_text` y `sender_type`.
 */
function backfillInbox(): void {
  const now = new Date().toISOString();
  db.exec(`INSERT OR IGNORE INTO contacts (session_id, chat_id, name, phone, created_at, updated_at)
    SELECT session_id, chat_id, contact_name, whatsapp_phone,
           COALESCE(created_at, '${now}'), COALESCE(updated_at, '${now}')
    FROM conversations`);
  db.exec(`UPDATE conversations SET contact_id = (
      SELECT c.id FROM contacts c
      WHERE c.session_id = conversations.session_id AND c.chat_id = conversations.chat_id)
    WHERE contact_id IS NULL`);
  db.exec(`UPDATE conversations SET last_message_text = (
      SELECT CASE WHEN m.content_type = 'text' THEN m.body ELSE '[' || m.content_type || ']' END
      FROM messages m
      WHERE m.session_id = conversations.session_id AND m.chat_id = conversations.chat_id
      ORDER BY m.id DESC LIMIT 1)
    WHERE last_message_text IS NULL`);
  db.exec(`UPDATE messages
    SET sender_type = CASE direction WHEN 'in' THEN 'customer' ELSE 'agent' END
    WHERE sender_type IS NULL`);
}

/**
 * Recalcula `last_message_at`/`last_message_text`/`last_direction` de cada
 * conversacion a partir de sus mensajes reales (por `occurred_at`). Necesario
 * tras la sincronizacion de historial, que inserta mensajes fuera de orden y
 * antes dejaba la fecha en el momento de la sincronizacion. Corre una sola vez.
 */
function backfillConversationLast(): void {
  const flag = db
    .prepare("SELECT value FROM configs WHERE key = 'conv_last_backfill_v1'")
    .get() as { value?: string } | undefined;
  if (flag?.value === '1') return;
  db.exec(`UPDATE conversations SET
    last_message_at = (SELECT MAX(m.occurred_at) FROM messages m
      WHERE m.session_id = conversations.session_id AND m.chat_id = conversations.chat_id),
    last_message_text = (SELECT CASE WHEN m.content_type = 'text' THEN m.body ELSE '[' || m.content_type || ']' END
      FROM messages m
      WHERE m.session_id = conversations.session_id AND m.chat_id = conversations.chat_id
      ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1),
    last_direction = (SELECT m.direction FROM messages m
      WHERE m.session_id = conversations.session_id AND m.chat_id = conversations.chat_id
      ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1)
    WHERE EXISTS (SELECT 1 FROM messages m
      WHERE m.session_id = conversations.session_id AND m.chat_id = conversations.chat_id)`);
  db.prepare(
    `INSERT INTO configs (key, value, updated_at) VALUES ('conv_last_backfill_v1', '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
  ).run(new Date().toISOString());
  logger.info('Ultimo mensaje de conversaciones recalculado desde el historial');
}

/** Crea la politica anti-baneo global por defecto si no existe. */
function seedGlobalPolicy(): void {
  const row = db.prepare('SELECT COUNT(*) AS c FROM anti_ban_policies WHERE session_id IS NULL').get() as { c: number };
  if ((row?.c ?? 0) > 0) return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO anti_ban_policies
       (session_id, risk_profile, daily_limit, hourly_limit, delay_min_seconds, delay_max_seconds,
        window_start, window_end, window_days, warmup_enabled, warmup_day1_limit, pauses_enabled,
        pause_every, pause_min_minutes, pause_max_minutes, health_delivery_threshold, active, created_at, updated_at)
     VALUES (NULL, 'medium', 300, 50, 45, 90, '08:00', '20:00', '1,2,3,4,5,6', 1, 50, 1, 20, 5, 15, 0.85, 1, ?, ?)`,
  ).run(now, now);
  logger.info('Politica anti-baneo global creada por defecto');
}

export { resolved as dbPath };
