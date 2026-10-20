/**
 * Esquema SQLite del gateway. Replica las entidades de openwa_basico
 * (sesiones, mensajes, conversaciones, lotes, plantillas, opt-out, auditoria)
 * adaptadas a un servicio Node unico.
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Cuentas / sesiones (una por trabajador o la principal).
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  api_key           TEXT,
  webhook_secret    TEXT,
  owner_uid         TEXT,
  owner_name        TEXT,
  owner_email       TEXT,
  area              TEXT,
  status            TEXT NOT NULL DEFAULT 'created',
  phone             TEXT,
  expected_phone    TEXT,
  phone_verified_at TEXT,
  last_error        TEXT,
  blocked_reason    TEXT,
  proxy_url         TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_uid);

-- Registro de webhooks salientes por sesion.
CREATE TABLE IF NOT EXISTS webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  url         TEXT NOT NULL,
  secret      TEXT,
  events      TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(session_id, url)
);

-- Mensajes entrantes/salientes.
CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT,
  session_phone    TEXT,
  chat_id          TEXT NOT NULL,
  contact_name     TEXT,
  direction        TEXT NOT NULL,
  content_type     TEXT NOT NULL DEFAULT 'text',
  body             TEXT,
  content_meta     TEXT,
  pinned_at        TEXT,
  pinned_by        INTEGER,
  media_mime       TEXT,
  media_path       TEXT,
  media_filename   TEXT,
  media_seconds    INTEGER,
  wa_message_id    TEXT,
  status           TEXT NOT NULL DEFAULT 'sent',
  transcription    TEXT,
  origin           TEXT,
  occurred_at      TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(session_id, chat_id, id);

-- Conversaciones (una por chat y sesion).
CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  whatsapp_phone  TEXT,
  chat_id         TEXT NOT NULL,
  contact_name    TEXT,
  programa        TEXT,
  programa_id     INTEGER,
  last_message_at TEXT,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  last_direction  TEXT,
  history_synced_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(session_id, chat_id)
);

-- Plantillas con {{ variables }} por categoria.
CREATE TABLE IF NOT EXISTS templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  body        TEXT NOT NULL,
  variables   TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);

-- Lotes de envio.
CREATE TABLE IF NOT EXISTS batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT,
  name          TEXT,
  total         INTEGER NOT NULL DEFAULT 0,
  sent          INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'running',
  meta          TEXT,
  scheduled_at  TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_batches_session ON batches(session_id);
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);

-- Destinatarios del lote.
CREATE TABLE IF NOT EXISTS batch_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER NOT NULL,
  chat_id       TEXT NOT NULL,
  contact_name  TEXT,
  body          TEXT,
  content_type  TEXT,
  media_path    TEXT,
  media_mime    TEXT,
  external_ref  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  error         TEXT,
  message_id    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY(batch_id) REFERENCES batches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_items_status ON batch_items(status);
CREATE INDEX IF NOT EXISTS idx_batch_items_ref ON batch_items(external_ref);

-- Lista de no enviar (opt-out).
CREATE TABLE IF NOT EXISTS optouts (
  chat_id    TEXT PRIMARY KEY,
  phone      TEXT,
  reason     TEXT,
  source     TEXT,
  created_at TEXT NOT NULL
);

-- Webhooks recibidos para diagnostico.
CREATE TABLE IF NOT EXISTS webhook_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT,
  ip         TEXT,
  payload    TEXT,
  created_at TEXT NOT NULL
);

-- Auditoria de acciones.
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  context    TEXT,
  created_at TEXT NOT NULL
);

-- Configuracion clave/valor global.
CREATE TABLE IF NOT EXISTS configs (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT
);

-- Usuarios del panel (espejo de cronogramas + cuentas locales).
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT,
  username       TEXT UNIQUE,
  email          TEXT UNIQUE,
  password       TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'local',
  source_uid     TEXT,
  esam_autorizado INTEGER NOT NULL DEFAULT 0,
  esam_area      TEXT,
  esam_numero    TEXT,
  esam_roles     TEXT,
  last_login_at  TEXT,
  last_login_ip  TEXT,
  login_count    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_source_uid ON users(source_uid);

-- Sesiones del panel web (cookie -> usuario).
CREATE TABLE IF NOT EXISTS web_sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Nonces de SSO consumidos (un solo uso).
CREATE TABLE IF NOT EXISTS sso_nonces (
  nonce      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Libreria de stickers (WebP 512x512).
CREATE TABLE IF NOT EXISTS stickers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  media_path TEXT NOT NULL,
  media_mime TEXT NOT NULL DEFAULT 'image/webp',
  size       INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Reglas de respuesta automatica por palabra clave.
CREATE TABLE IF NOT EXISTS autoreply_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword          TEXT NOT NULL,
  match_type       TEXT NOT NULL DEFAULT 'contains',
  reply_body       TEXT NOT NULL,
  cooldown_seconds INTEGER NOT NULL DEFAULT 3600,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Enfriamiento por regla + chat (evita responder en bucle).
CREATE TABLE IF NOT EXISTS autoreply_cooldowns (
  rule_id    INTEGER NOT NULL,
  chat_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (rule_id, chat_id)
);

-- Mapeo LID (identificador anónimo de WhatsApp) -> JID de teléfono.
-- WhatsApp entrega individuales como @lid; el panel usa el número real.
CREATE TABLE IF NOT EXISTS lid_map (
  lid        TEXT PRIMARY KEY,
  pn         TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Politicas anti-baneo: fila global (session_id NULL) y override por sesion.
CREATE TABLE IF NOT EXISTS anti_ban_policies (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id                TEXT,
  risk_profile              TEXT NOT NULL DEFAULT 'medium',
  daily_limit               INTEGER NOT NULL DEFAULT 300,
  hourly_limit              INTEGER NOT NULL DEFAULT 50,
  delay_min_seconds         INTEGER NOT NULL DEFAULT 45,
  delay_max_seconds         INTEGER NOT NULL DEFAULT 90,
  window_start              TEXT NOT NULL DEFAULT '08:00',
  window_end                TEXT NOT NULL DEFAULT '20:00',
  window_days               TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
  warmup_enabled            INTEGER NOT NULL DEFAULT 1,
  warmup_start_date         TEXT,
  warmup_day1_limit         INTEGER NOT NULL DEFAULT 50,
  pauses_enabled            INTEGER NOT NULL DEFAULT 1,
  pause_every               INTEGER NOT NULL DEFAULT 20,
  pause_min_minutes         INTEGER NOT NULL DEFAULT 5,
  pause_max_minutes         INTEGER NOT NULL DEFAULT 15,
  health_delivery_threshold REAL NOT NULL DEFAULT 0.85,
  active                    INTEGER NOT NULL DEFAULT 1,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

-- Solo una politica por sesion (la global queda sin restriccion unica).
CREATE UNIQUE INDEX IF NOT EXISTS idx_anti_ban_session
  ON anti_ban_policies(session_id) WHERE session_id IS NOT NULL;

-- Salud de cada sesion (materializada para el panel y el runner).
CREATE TABLE IF NOT EXISTS session_health_metrics (
  session_id      TEXT PRIMARY KEY,
  health          TEXT NOT NULL DEFAULT 'green',
  status_reason   TEXT,
  sent_24h        INTEGER NOT NULL DEFAULT 0,
  delivered_24h   INTEGER NOT NULL DEFAULT 0,
  read_24h        INTEGER NOT NULL DEFAULT 0,
  failed_24h      INTEGER NOT NULL DEFAULT 0,
  blocked_24h     INTEGER NOT NULL DEFAULT 0,
  delivery_rate   REAL NOT NULL DEFAULT 1,
  report_rate     REAL NOT NULL DEFAULT 0,
  warmup_day      INTEGER,
  warmup_limit    INTEGER,
  quarantine      INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  updated_at      TEXT NOT NULL
);

-- Cola persistente de webhooks salientes que no se pudieron entregar.
CREATE TABLE IF NOT EXISTS webhook_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  url         TEXT NOT NULL,
  secret      TEXT,
  event       TEXT NOT NULL,
  body        TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT NOT NULL,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_queue_due ON webhook_queue(next_try_at);

-- ── Inbox: contactos, notas, reacciones y plantillas rapidas ─────────────────

-- Ficha del contacto (una por chat y sesion). La completa el gateway al ver
-- mensajes y la edita el panel desde la columna de contacto.
CREATE TABLE IF NOT EXISTS contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  name        TEXT,
  phone       TEXT,
  email       TEXT,
  company     TEXT,
  avatar_path TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(session_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_contacts_session ON contacts(session_id);
CREATE INDEX IF NOT EXISTS idx_contacts_chat ON contacts(session_id, chat_id);

-- Notas internas del contacto (solo visibles en el panel; texto o audio).
CREATE TABLE IF NOT EXISTS contact_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  user_id    INTEGER,
  note_text  TEXT,
  audio_path TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_notes_contact ON contact_notes(contact_id);

-- Etiquetas de notas (globales, compartidas por el equipo).
CREATE TABLE IF NOT EXISTS note_tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '#045474',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Relacion nota <-> etiqueta (varias etiquetas por nota).
CREATE TABLE IF NOT EXISTS contact_note_tags (
  note_id INTEGER NOT NULL,
  tag_id  INTEGER NOT NULL,
  PRIMARY KEY (note_id, tag_id),
  FOREIGN KEY(note_id) REFERENCES contact_notes(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES note_tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_note_tags_tag ON contact_note_tags(tag_id);

-- Reacciones a mensajes (cliente o agente). Una por actor y mensaje.
CREATE TABLE IF NOT EXISTS message_reactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  session_id TEXT,
  chat_id    TEXT NOT NULL,
  actor_type TEXT NOT NULL,   -- customer | agent
  actor_id   TEXT,            -- users.id (agente) o chat_id (cliente)
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(message_id, actor_type, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);

-- Plantillas rapidas del compositor (atajo /xxx, personales o compartidas).
CREATE TABLE IF NOT EXISTS quick_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shortcut   TEXT NOT NULL UNIQUE,
  content    TEXT NOT NULL,
  user_id    INTEGER,                 -- NULL = compartida
  shared     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Nota: la tabla FTS5 messages_fts y sus triggers se crean en migrate()
-- (db/index.ts) dentro de un try/catch, porque no todos los builds de SQLite
-- traen FTS5. Si falla, la busqueda degrada a LIKE.
`;
