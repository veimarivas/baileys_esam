import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { SCHEMA } from './schema.js';
import { logger } from '../logger.js';

const resolved = path.resolve(config.dbPath);
fs.mkdirSync(path.dirname(resolved), { recursive: true });

export const db = new DatabaseSync(resolved);

/**
 * `fold(texto)`: minúsculas y sin acentos, para búsquedas que encuentren
 * «José» al escribir «jose» (LIKE de SQLite solo ignora mayúsculas ASCII).
 */
export function foldText(value: string): string {
  // Tras descomponer (NFD), quita las marcas diacríticas (categoría Unicode Mn).
  return value.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
}
db.function('fold', { deterministic: true }, (value: unknown) => (value == null ? null : foldText(String(value))));

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
  // Respuestas: autor y texto del mensaje citado (contextInfo), por si el original no está.
  addColumnIfMissing('messages', 'reply_to_sender', 'TEXT');
  addColumnIfMissing('messages', 'reply_to_body', 'TEXT');
  // Etapa manual del pipeline de seguimiento ('todo' | 'doing'); las demás salen de los datos.
  addColumnIfMissing('contact_notes', 'pipeline_stage', 'TEXT');
  // Último cierre de conexión explicado (JSON de DisconnectInfo) para la vista Conexión.
  addColumnIfMissing('sessions', 'disconnect_info', 'TEXT');
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
  // Protección del contacto: no insistir ni repetir campañas al mismo número.
  addColumnIfMissing('anti_ban_policies', 'recontact_cooldown_hours', 'INTEGER NOT NULL DEFAULT 24');
  addColumnIfMissing('anti_ban_policies', 'max_unanswered', 'INTEGER NOT NULL DEFAULT 3');
  // Seguimiento: tasa de bloqueos y bajas (24 h) que pone la sesión en riesgo y frena lotes.
  addColumnIfMissing('anti_ban_policies', 'block_rate_threshold', 'REAL NOT NULL DEFAULT 0.03');
  // Palabras extra que cuentan como pedido de baja (separadas por coma).
  addColumnIfMissing('anti_ban_policies', 'optout_keywords', 'TEXT');
  // Línea en la que se originó la baja o el bloqueo (para la salud de cada sesión).
  addColumnIfMissing('optouts', 'session_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_optouts_session ON optouts(session_id, created_at)');
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
  // Nota importante: se muestra fijada arriba del chat en todas las líneas.
  addColumnIfMissing('contact_notes', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
  // Papelera: eliminar una nota la oculta (se puede restaurar).
  addColumnIfMissing('contact_notes', 'deleted_at', 'TEXT');
  addColumnIfMissing('contact_notes', 'deleted_by', 'INTEGER');
  // Historial: quién completó, fijó, editó (con el texto anterior) o borró cada nota.
  db.exec(`CREATE TABLE IF NOT EXISTS contact_note_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id     INTEGER NOT NULL,
    user_id     INTEGER,
    action      TEXT NOT NULL,
    prev_text   TEXT,
    prev_due_at TEXT,
    prev_tags   TEXT,
    created_at  TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_contact_note_history_note ON contact_note_history(note_id, id)');
  // Dato extra de un evento del historial (p. ej. a quién se asignó).
  addColumnIfMissing('contact_note_history', 'detail', 'TEXT');
  // Responsable de la tarea (puede ser de otra línea) y mensaje del chat que la originó.
  addColumnIfMissing('contact_notes', 'assigned_to', 'INTEGER');
  addColumnIfMissing('contact_notes', 'source_message_id', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contact_notes_assigned ON contact_notes(assigned_to, done_at)');
  // Hora del recordatorio (HH:MM, con `due_at`) y cuándo se avisó.
  addColumnIfMissing('contact_notes', 'due_time', 'TEXT');
  addColumnIfMissing('contact_notes', 'reminded_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contact_notes_reminder ON contact_notes(reminded_at, done_at, due_at)');
  // Derivación: quién derivó y cuándo, cuándo la vio el responsable y su
  // confirmación de que se comunicó con el contacto (con el resultado).
  addColumnIfMissing('contact_notes', 'assigned_by', 'INTEGER');
  addColumnIfMissing('contact_notes', 'assigned_at', 'TEXT');
  addColumnIfMissing('contact_notes', 'seen_at', 'TEXT');
  addColumnIfMissing('contact_notes', 'contacted_at', 'TEXT');
  addColumnIfMissing('contact_notes', 'contacted_by', 'INTEGER');
  addColumnIfMissing('contact_notes', 'contact_result', 'TEXT');
  // Notificaciones del panel (campana).
  db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    note_id    INTEGER,
    actor_id   INTEGER,
    title      TEXT NOT NULL,
    body       TEXT,
    link       TEXT,
    created_at TEXT NOT NULL,
    read_at    TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, id)');
  // Línea a la que se refiere el aviso (p. ej. "se desconectó WhatsApp"): sirve
  // para no repetir el mismo aviso mientras siga sin leer.
  addColumnIfMissing('notifications', 'session_id', 'TEXT');
  setupPersonPrograms();
  // Plantillas de tareas (pasos que se repiten, p. ej. una inscripción).
  db.exec(`CREATE TABLE IF NOT EXISTS note_templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    programa   TEXT,
    items      TEXT NOT NULL,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  setupContactPhoneKey();
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
  applyMassProfileV1();
  stopLegacyBatchesV1();
  repairUnreadV1();
  logger.info({ db: resolved }, 'Esquema SQLite listo');
}

/**
 * `contacts.phone_key`: el teléfono solo con dígitos. Une las fichas de una
 * misma persona en todas las líneas (sesiones), para que las notas y tareas
 * registradas desde un número las vea quien la atienda desde cualquier otro.
 * Lo mantienen triggers, así cualquier escritura de `phone` lo actualiza.
 */
/** Versión de la regla de `phone_key`: al cambiarla se recrean los triggers y se recalcula. */
const PHONE_KEY_VERSION = '2';

function setupContactPhoneKey(): void {
  // Misma regla que `normalizePhone` (src/core/phone.ts): sin signos, sin prefijo
  // internacional `00` y con `591` delante si es un número local de 8 dígitos
  // (así «7123 4567» cargado a mano une con el `59171234567` de WhatsApp).
  const clean = (col: string) =>
    `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col}, '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')`;
  const keyExpr = (col: string) => `NULLIF(CASE
      WHEN LENGTH(${clean(col)}) = 8 THEN '591' || ${clean(col)}
      WHEN ${clean(col)} LIKE '00%' THEN SUBSTR(${clean(col)}, 3)
      ELSE ${clean(col)} END, '')`;
  addColumnIfMissing('contacts', 'phone_key', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contacts_phone_key ON contacts(phone_key)');
  const current = (db.prepare("SELECT value FROM configs WHERE key = 'phone_key_version'").get() as { value?: string } | undefined)
    ?.value;
  if (current === PHONE_KEY_VERSION) return;
  db.exec('DROP TRIGGER IF EXISTS contacts_phone_key_ai');
  db.exec('DROP TRIGGER IF EXISTS contacts_phone_key_au');
  db.exec(`CREATE TRIGGER contacts_phone_key_ai AFTER INSERT ON contacts BEGIN
    UPDATE contacts SET phone_key = ${keyExpr('new.phone')} WHERE id = new.id;
  END`);
  db.exec(`CREATE TRIGGER contacts_phone_key_au AFTER UPDATE OF phone ON contacts BEGIN
    UPDATE contacts SET phone_key = ${keyExpr('new.phone')} WHERE id = new.id;
  END`);
  db.exec(`UPDATE contacts SET phone_key = ${keyExpr('phone')}`);
  setConfigFlag('phone_key_version', PHONE_KEY_VERSION);
}

/**
 * `person_programs`: nombre completo y programas de cada persona (por número),
 * tal como los manda cronogramas en los envíos. La primera vez se recupera de
 * los lotes ya enviados (`batches.meta.programa` + `batch_items.contact_name`).
 */
function setupPersonPrograms(): void {
  // Nombre registrado a mano en el panel (contactos que no llegaron desde
  // cronogramas). Por número, así lo ven todas las líneas.
  db.exec(`CREATE TABLE IF NOT EXISTS person_names (
    phone_key  TEXT PRIMARY KEY,
    full_name  TEXT NOT NULL,
    updated_by INTEGER,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS person_programs (
    phone_key   TEXT NOT NULL,
    programa    TEXT NOT NULL,
    programa_id INTEGER,
    full_name   TEXT,
    session_id  TEXT,
    last_at     TEXT NOT NULL,
    PRIMARY KEY (phone_key, programa)
  )`);
  const done = (db.prepare("SELECT value FROM configs WHERE key = 'person_programs_v1'").get() as { value?: string } | undefined)?.value;
  if (done) return;
  const digits = "REPLACE(REPLACE(REPLACE(SUBSTR(bi.chat_id, 1, INSTR(bi.chat_id || '@', '@') - 1), '+', ''), ' ', ''), '-', '')";
  const key = `CASE WHEN LENGTH(${digits}) = 8 THEN '591' || ${digits} WHEN ${digits} LIKE '00%' THEN SUBSTR(${digits}, 3) ELSE ${digits} END`;
  try {
    db.exec(`INSERT INTO person_programs (phone_key, programa, programa_id, full_name, session_id, last_at)
      SELECT ${key}, json_extract(b.meta, '$.programa'), json_extract(b.meta, '$.programa_id'),
             NULLIF(TRIM(bi.contact_name), ''), b.session_id, COALESCE(bi.updated_at, bi.created_at)
        FROM batch_items bi JOIN batches b ON b.id = bi.batch_id
       WHERE bi.chat_id NOT LIKE '%@g.us' AND json_valid(b.meta)
         AND NULLIF(TRIM(json_extract(b.meta, '$.programa')), '') IS NOT NULL
       ORDER BY COALESCE(bi.updated_at, bi.created_at)
      ON CONFLICT(phone_key, programa) DO UPDATE SET
        full_name = COALESCE(excluded.full_name, person_programs.full_name),
        programa_id = COALESCE(excluded.programa_id, person_programs.programa_id),
        last_at = MAX(person_programs.last_at, excluded.last_at)`);
    logger.info('Programas de cada persona recuperados de los lotes enviados');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'No se pudieron recuperar los programas de los lotes');
  }
  setConfigFlag('person_programs_v1', '1');
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
/**
 * Reparación única (2026-10-07) de los contadores de no leídos: hasta ahora cada
 * mensaje entrante del historial sumaba +1, aunque ya estuviera leído en el
 * teléfono (miles de "no leídos" falsos). Se considera leído todo lo que llegó
 * por historial (guardado más de 10 min después de ocurrir) y lo anterior a la
 * última respuesta; el contador queda con los recibidos en vivo posteriores.
 * Desde ahora el estado lo actualiza WhatsApp (`read-self` / `chat-unread`).
 */
function repairUnreadV1(): void {
  const done = db.prepare("SELECT value FROM configs WHERE key = 'unread_repair_v1'").get() as { value?: string } | undefined;
  if (done?.value === '1') return;
  db.exec('BEGIN');
  try {
    db.exec(`
      UPDATE messages SET status = 'read'
       WHERE direction = 'in'
         AND COALESCE(status, '') NOT IN ('read', 'played')
         AND ((julianday(created_at) - julianday(occurred_at)) * 1440 >= 10
              OR occurred_at <= COALESCE((SELECT MAX(o.occurred_at) FROM messages o
                                           WHERE o.session_id = messages.session_id
                                             AND o.chat_id = messages.chat_id
                                             AND o.direction = 'out'), ''))`);
    db.exec(`
      UPDATE conversations SET unread_count = (
        SELECT COUNT(*) FROM messages m
         WHERE m.session_id = conversations.session_id AND m.chat_id = conversations.chat_id
           AND m.direction = 'in' AND COALESCE(m.status, '') NOT IN ('read', 'played'))`);
    db.prepare("INSERT OR REPLACE INTO configs (key, value, updated_at) VALUES ('unread_repair_v1', '1', ?)").run(new Date().toISOString());
    db.exec('COMMIT');
    logger.info('Contadores de no leídos reparados (los del historial se consideran leídos)');
  } catch (err) {
    db.exec('ROLLBACK');
    logger.warn({ err: (err as Error).message }, 'No se pudieron reparar los contadores de no leídos');
  }
}

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

/**
 * Una sola vez: todas las políticas pasan al perfil «Masivo institucional»
 * (6–7 s por mensaje, sin calentamiento, pausas cortas y freno automático),
 * el ritmo acordado para los envíos de cronogramas. Las palabras de baja se
 * conservan. Después se puede cambiar el perfil por línea en Anti-Baneo.
 */
function applyMassProfileV1(): void {
  const done = (db.prepare("SELECT value FROM configs WHERE key = 'antiban_mass_v1'").get() as { value?: string } | undefined)?.value;
  if (done) return;
  db.prepare(
    `UPDATE anti_ban_policies SET risk_profile = 'mass', daily_limit = 1500, hourly_limit = 400,
       delay_min_seconds = 6, delay_max_seconds = 7, window_start = '07:00', window_end = '21:00',
       warmup_enabled = 0, warmup_start_date = NULL, warmup_day1_limit = 200,
       pauses_enabled = 1, pause_every = 60, pause_min_minutes = 2, pause_max_minutes = 4,
       health_delivery_threshold = 0.75, typing_simulation = 1, min_gap_seconds = 5, burst_per_minute = 12,
       verify_numbers = 1, new_contacts_daily_limit = 600, max_consecutive_failures = 8, auto_pause_low_delivery = 1,
       recontact_cooldown_hours = 0, max_unanswered = 0, block_rate_threshold = 0.04, updated_at = ?`,
  ).run(new Date().toISOString());
  setConfigFlag('antiban_mass_v1', '1');
  logger.info('Políticas anti-baneo pasadas al perfil «Masivo institucional» (6–7 s por mensaje)');
}

/**
 * Una sola vez (incidente del 15/10/2026): se cancelan todos los lotes que
 * quedaron en curso, programados o en pausa con la versión anterior, que podía
 * enviar desde líneas ajenas y sin confirmación. Así, al volver a vincular un
 * número, no se reanuda ningún envío viejo. Corre antes de que la cola
 * reanude lotes pendientes.
 */
function stopLegacyBatchesV1(): void {
  const done = (db.prepare("SELECT value FROM configs WHERE key = 'batches_stop_v1'").get() as { value?: string } | undefined)?.value;
  if (done) return;
  const now = new Date().toISOString();
  const res = db
    .prepare(`UPDATE batches SET status = 'cancelled', updated_at = ? WHERE status IN ('running', 'scheduled', 'paused')`)
    .run(now);
  db.prepare(`UPDATE batch_items SET status = 'skipped', error = COALESCE(error, 'Cancelado: lote detenido al actualizar'), updated_at = ?
               WHERE status = 'pending' AND batch_id IN (SELECT id FROM batches WHERE status = 'cancelled')`).run(now);
  setConfigFlag('batches_stop_v1', '1');
  logger.warn({ batches: Number(res.changes) }, 'Lotes anteriores detenidos: no se reanudarán');
}

export { resolved as dbPath };
