# PLAN — Inbox de Conversaciones (paridad con laravel_crm_whatsapp)

> **Estado: completado (F11.1–F11.11).** Ver el detalle en `CAMBIOS.md` §11 y en
> `PLAN.md` (fase F11). Cambios de alcance respecto a este documento original:
> - **Sin estados ni asignación**: este inbox es para las conversaciones originadas
>   en **cronogramas**, no se asignan agentes ni se marcan abierta/pendiente/cerrada.
>   Se removieron `/inbox/:chat/status`, `/inbox/:chat/assign`, `GET /inbox/members`
>   y las acciones en lote salvo `mark_read`.
> - **Rutas**: `/inbox/:session/:chat/...` (para desambiguar entre sesiones).
> - **Acceso por sesión/número único**: el alcance se resuelve por `esam_numero` /
>   `owner_uid` (ver §3.3 y F11.11), no por agente asignado.
> - **Rediseño**: la vista sigue el modo Operate con la paleta institucional
>   (`public/app.css`, bloque "Inbox · conversaciones").
> - **IA/CRM**: fuera de alcance (decidido al inicio).

Objetivo: llevar a `baileys_esam` toda la funcionalidad del Inbox del proyecto
`laravel_crm_whatsapp` (que hoy usa la API de Meta) al abrir y gestionar las
conversaciones, pero sobre el stack propio del gateway **Baileys**:
**Node + Express + SQLite + panel HTML server-rendered + Vanilla JS + SSE**.

> Alcance acordado: **Chat + gestión completa**. Se implementa la vista de
> conversación (3 columnas, respuestas citadas, reacciones, notas internas,
> panel de contacto, separadores por día, tics, grabadora de voz y lectura en
> voz alta) y la gestión del inbox (estados, filtros, asignación a agentes,
> acciones en lote, búsqueda full-text y plantillas rápidas).
>
> **Fuera de alcance (por ahora):** capa de IA (toggle IA/Humano, borrador,
> "pensando", pausa por límite), y entidades del CRM (deals/pipelines,
> automatizaciones, flows, notificaciones in-app, canal/service-window de Meta).

## Decisiones fijadas

1. **Alcance**: chat + gestión completa, sin IA ni CRM.
2. **Asignación**: multiagente. `conversations.assigned_agent_id` → `users`.
   Admin ve las conversaciones de las sesiones de su alcance; un agente no-admin
   ve solo las asignadas a él.
3. **Contactos/notas**: tabla `contacts` (por sesión+chat) + `contact_notes`.
4. **Plantillas rápidas**: tabla `quick_replies` dedicada (`/atajo`, variables).
5. **Frontend**: server-rendered + Vanilla JS + SSE. Sin build step nuevo.

## Estado actual vs. Laravel (brecha)

| Función | laravel_crm_whatsapp | baileys_esam hoy |
| --- | --- | --- |
| Layout | 3 columnas colapsables | 2 columnas |
| Estados open/pending/closed + filtros + totales | Sí | No |
| Asignación a agentes | Sí | No |
| Acciones en lote | Sí | No |
| Respuestas citadas | Sí | No |
| Reacciones | Sí | No |
| Notas internas (texto y voz) | Sí | No |
| Panel de contacto | Sí (email, empresa, ficha) | No |
| Búsqueda full-text | Sí | No (solo filtro local en lista) |
| Plantillas rápidas `/atajo` | Sí | No |
| Separadores por día | Sí | Sí (`day-sep`) |
| Tics de estado | Sí | Sí (parcial) |
| Grabadora de voz | opus-recorder | No |
| Leer en voz alta (TTS) | Web Speech API | No |
| Enviar texto/media/sticker | Sí | Sí |
| Sincronizar historial / transcribir | Sí | Sí |
| Contacto/avatar | `contacts` + avatar | Solo `contact_name` |
| Tiempo real | Reverb + polling | SSE + polling |

---

## 1. Arquitectura y archivos

Para no seguir engordando `src/panel/server.ts` (1.817 líneas), el inbox se
separa en módulos con responsabilidad única:

```
src/
  db/
    schema.ts            + tablas nuevas + FTS5 (CREATE IF NOT EXISTS)
    index.ts             + migraciones idempotentes (addColumnIfMissing)
  core/
    conversations.ts     (nuevo) estados, asignación, bulk, búsqueda, unread
    contacts.ts          (nuevo) upsert de contacto, fichas y notas
    quick-replies.ts     (nuevo) CRUD + render de variables
  panel/
    server.ts            registra las rutas de inbox.ts (queda delgado)
    inbox.ts             (nuevo) rutas + HTML del inbox (JSON para app.js)
  baileys/
    session.ts           + reply citado, reacciones, avatar, captura de citas
    manager.ts           + persistencia de reacciones/citas y eventos SSE
  types.ts               + tipos ConversationRow / MessageRow / InboundMessage
public/
  app.js                 reescritura del módulo initInbox()
  app.css                estilos de las 3 columnas y nuevas burbujas
  assets/libs/opus-recorder/  (nuevo) worker + encoder para notas de voz
```

Regla: `server.ts` importa y llama `registerInboxRoutes(app, deps)`; no contiene
la lógica del inbox.

---

## 2. Modelo de datos (SQLite)

### 2.1 Columnas nuevas (migración idempotente en `db/index.ts`)

`conversations`:
```sql
ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE conversations ADD COLUMN assigned_agent_id INTEGER;
ALTER TABLE conversations ADD COLUMN last_message_text TEXT;
ALTER TABLE conversations ADD COLUMN contact_id INTEGER;
ALTER TABLE conversations ADD COLUMN closed_at TEXT;
```
> `NOT NULL DEFAULT` en ALTER es válido porque el default es constante.

`messages`:
```sql
ALTER TABLE messages ADD COLUMN reply_to_wa_id TEXT;
ALTER TABLE messages ADD COLUMN sender_type TEXT;   -- customer | agent
ALTER TABLE messages ADD COLUMN sender_uid INTEGER; -- usuario del panel (agente)
```

### 2.2 Tablas nuevas (en `SCHEMA`, con `CREATE TABLE IF NOT EXISTS`)

```sql
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

CREATE TABLE IF NOT EXISTS quick_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shortcut   TEXT NOT NULL UNIQUE,
  content    TEXT NOT NULL,
  user_id    INTEGER,                 -- NULL = compartida
  shared     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 2.3 Búsqueda full-text (FTS5)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(body, transcription, content='messages', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body, transcription)
  VALUES (new.id, new.body, new.transcription);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, transcription)
  VALUES ('delete', old.id, old.body, old.transcription);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, transcription)
  VALUES ('delete', old.id, old.body, old.transcription);
  INSERT INTO messages_fts(rowid, body, transcription)
  VALUES (new.id, new.body, new.transcription);
END;
```

**Fallback**: si en el arranque `node:sqlite` no soporta FTS5 (capturar el error
al crear la tabla virtual), `conversations.search()` usa `LIKE` sobre
`messages.body`. Se detecta con una tabla `configs` (`fts5 = '0'|'1'`).

---

## 3. Backend — rutas del inbox

Todas bajo `requireUser` + `requireSection('conversations')`. Se agregan bajo el
prefijo `/inbox/*` (JSON) para no romper las rutas HTML actuales
`/conversations/:chat/*`, que se mantienen durante la transición.

> Nota de implementación (F11.2): las rutas de chat quedaron como
> `/inbox/:session/:chat/...` (no `/inbox/:chat/...`) para desambiguar cuando el
> alcance del usuario abarca varias sesiones.

### 3.1 Lectura

| Método | Ruta | Cuerpo/Query | Respuesta |
| --- | --- | --- | --- |
| GET | `/inbox/conversations` | `?status=open\|pending\|closed&q=` | `ConversationDTO[]` |
| GET | `/inbox/:chat/messages` | `?after=&limit=200` | `MessageDTO[]` |
| GET | `/inbox/:chat/notes` | — | `NoteDTO[]` |
| GET | `/inbox/search` | `?q=` (>=3 chars) | `{conversation, snippet, match_count, match_at}[]` |
| GET | `/inbox/quick-replies` | — | `QuickReplyDTO[]` (mías + compartidas) |
| GET | `/inbox/members` | — | `{id, name}[]` (usuarios del alcance) |

`ConversationDTO`:
```json
{
  "id": 12, "chat_id": "5917...@s.whatsapp.net", "session_id": "s-1",
  "contact": { "id": 3, "name": "Ana", "phone": "591...", "email": null, "company": null, "avatar_path": null },
  "assigned_agent": { "id": 2, "name": "Luis" },
  "status": "open", "unread_count": 2,
  "last_message_text": "Hola", "last_message_at": "2026-...", "last_direction": "in"
}
```

`MessageDTO` (serializado en `conversations.serializeMessage`):
```json
{
  "id": 55, "direction": "in", "content_type": "text", "body": "Hola",
  "media_path": "...", "media_mime": "...", "media_filename": "...",
  "transcription": null, "status": "read", "occurred_at": "2026-...",
  "sender_type": "customer", "sender": { "id": 2, "name": "Luis" },
  "reply_to": { "wa_message_id": "AAA", "body": "Hola", "content_type": "text" },
  "reactions": [{ "emoji": "👍", "actor_type": "customer" }]
}
```

### 3.2 Escritura

| Método | Ruta | Cuerpo | Efecto |
| --- | --- | --- | --- |
| POST | `/inbox/:chat/send` | `{text, reply_to_wa_id?}` | `manager.sendText(...)`; persiste; SSE |
| POST | `/inbox/:chat/media` | multipart `file`, `caption?` | `manager.sendMedia(...)`; SSE |
| POST | `/inbox/:chat/voice` | multipart `audio` (ogg/opus) | `manager.sendMedia(..., ptt:true)` |
| POST | `/inbox/:chat/sticker` | `{sticker_id}` | `manager.sendStickerFile(...)` |
| POST | `/inbox/:chat/sync` | `{count?}` | `manager.syncHistory(...)` |
| POST | `/inbox/:chat/read` | — | `manager.markChatRead(...)` |
| PATCH | `/inbox/:chat/status` | `{status}` | estado + SSE `conversation` |
| PATCH | `/inbox/:chat/assign` | `{agent_id \| null}` | asignación + SSE `conversation` |
| POST | `/inbox/:chat/reaction` | `{message_id, emoji}` | reacción (vacío = quitar) |
| POST | `/inbox/:chat/notes` | `{text}` o multipart `audio` | nota interna |
| POST | `/inbox/bulk` | `{conversation_ids[], action, agent_id?}` | close/open/pending/mark_read/assign |
| POST | `/inbox/quick-replies` | `{shortcut, content, shared}` | crear (admin) |
| PUT | `/inbox/quick-replies/:id` | `{shortcut, content, shared}` | editar (admin) |
| DELETE | `/inbox/quick-replies/:id` | — | borrar (admin) |

Validaciones: `text` ≤ 4096; `emoji` ≤ 16 (vacío = retirar); `status` ∈
`open|pending|closed`; en `bulk`, `conversation_ids` ≤ 200 y el `<select>` de
asignación valida que el usuario destino sea del mismo alcance.

### 3.3 Autorización y visibilidad (`core/conversations.ts`)

```ts
// Alcance de sesiones del usuario; null = todas (admin).
const scope = sessionScopeFor(user);

// Condición base del listado:
//   admin  -> session_id IN (scope)  (o sin filtro si scope null)
//   agente -> session_id IN (scope) AND assigned_agent_id = user.id
```

- `authorizeConversation(user, conv)`: 403 si la sesión no está en su alcance o
  (no-admin y `assigned_agent_id !== user.id`).
- `bulk` solo admin (igual que Laravel).
- `members`: usuarios del panel visibles para la asignación.

---

## 4. Tiempo real (SSE)

Se reutiliza `src/panel/events.ts` (`panelBus`) y el endpoint `/events`.
Eventos existentes: `message`, `ack`, `read`, `presence`.
**Nuevos:**
- `conversation` `{sessionId, chatId, status?, assigned_agent_id?, unread_count?}`
- `reaction` `{sessionId, chatId, messageId}`
- `typing` `{sessionId, chatId, userId, name, typing}` (entre agentes)

`public/app.js` agrega listeners para `conversation`, `reaction` y `typing`.
El polling de respaldo (8 s hilo / 20 s lista) se mantiene.

---

## 5. Cambios en Baileys (`baileys/session.ts` + `manager.ts`)

1. **Tipos**: extender `InboundMessage` (`types.ts`) con
   `quotedWaId?: string | null` y `reaction?: { targetWaId: string; emoji: string }`.
2. **Captura de respuesta citada**: en `mapInbound`, leer
   `raw.message.*.contextInfo.quotedMessage` / `stanzaId` y guardar
   `quotedWaId`.
3. **Reacciones entrantes**: `describe()` ya reconoce `reactionMessage`; exponer
   `reaction` con `targetWaId = reactionMessage.key.id` y `emoji`. En `manager`,
   persistir en `message_reactions` (actor `customer`) y emitir SSE `reaction`.
4. **Enviar respuesta citada**: `sendText(chatId, text, quotedKey?)` y
   `sendMedia(..., quotedKey?)`. `doSend` arma `{ quoted }` con
   `{ key: { remoteJid, id, fromMe }, message: { conversation } }` reconstruido
   desde el mensaje citado guardado.
5. **Enviar reacción**: `sendReaction(chatId, key, emoji)` →
   `sock.sendMessage(jid, { react: { text: emoji, key } })`; persistir/eliminar
   en `message_reactions` (actor `agent`) y SSE `reaction`.
6. **Avatar**: `profilePictureUrl(jid, 'image')` (best-effort, con caché) para
   guardar `contacts.avatar_path`.
7. **Upsert de contacto**: al persistir entrante/saliente, `contacts.upsert()`
   completa nombre/teléfono y enlaza `conversations.contact_id`.
8. **Unread y `last_message_text`**: `upsertConversation` actualiza
   `last_message_text` además de `last_message_at`/`unread_count`.

---

## 6. Frontend (`public/app.js` + `public/app.css`)

Reescribir `initInbox()` con estado cliente y render de 3 columnas:

- **Columna 1 — lista**: buscador (filtra local + dispara `/inbox/search` con
  ≥3 letras), pestañas de estado con totales (Todas/Abiertas/Pend./Cerr.),
  checkboxes de selección (solo admin), barra de acciones en lote
  (leídas/cerrar/pendiente/asignar).
- **Columna 2 — chat**: cabecera con avatar, teléfono, badge de estado, agente
  asignado y `<select>` de estado; hilo con separadores por día; burbujas con
  acciones al hover (responder, reaccionar, leer en voz alta); preview de
  "Respondiendo"; banner de reacciones; tics (`sending/sent/delivered/read/failed`).
- **Columna 3 — contacto**: ficha (nombre, teléfono, email, empresa), notas
  internas (texto + voz) y metadatos.
- **Compositor**: adjuntar, grabadora (opus-recorder), plantillas `/atajo` con
  autocomplete y variables `{name} {phone} {email} {company}`, picker de emojis,
  textarea autosize, Enter envía / Shift+Enter salto.
- **TTS**: Web Speech API (`es-BO`), toggle por burbuja.
- **Paneles colapsables** (lista y contacto).
- **Lightbox**: se conserva el actual (`openLightbox`).

Se mantienen `escapeHtml`, `linkifyHtml`, `daySeparator`, `buildMessage` y el
visor de imágenes; se amplían para reacciones, cita y acciones.

CSS nuevo: `.inbox` a 3 columnas, `.convo-item`, `.bubble-actions`,
`.reaction-pill`, `.reply-preview`, `.contact-panel`, `.bulk-bar`, `.recorder`.

---

## 7. Fases y tareas

> Lista de tareas original (histórica): todo se implementó con los ajustes de
> alcance indicados al inicio. El estado real está en `PLAN.md` (F11) y en
> `CAMBIOS.md` §11.

### F11.1 — Datos y contactos
- [ ] `db/schema.ts`: tablas `contacts`, `contact_notes`, `message_reactions`,
      `quick_replies`, `messages_fts` + triggers.
- [ ] `db/index.ts`: `addColumnIfMissing` para las columnas de §2.1; detección
      de FTS5 con fallback; backfill de `contacts` desde `conversations`.
- [ ] `types.ts`: `ConversationRow`, `MessageRow`, `InboundMessage` extendido.
- [ ] `core/contacts.ts`: `upsert`, `getByChat`, `setAvatar`, `listNotes`,
      `addNote`, `deleteNote`.
- [ ] **Aceptación**: `npm run build` limpio; base existente migra sin perder
      datos; `contacts` con una fila por conversación.

### F11.2 — Backend de conversaciones
- [ ] `core/conversations.ts`: `list`, `serializeMessage`, `setStatus`,
      `assign`, `bulk`, `search`, `markRead`, `addReaction`, `removeReaction`.
- [ ] `core/quick-replies.ts`: CRUD + `render(content, contact)`.
- [ ] `panel/inbox.ts`: rutas §3.1 y §3.2 + `registerInboxRoutes`.
- [ ] `panel/server.ts`: registrar y quitar del archivo la lógica duplicada.
- [ ] `panel/events.ts`: documentar eventos nuevos.
- [ ] **Aceptación**: listar/filtrar/estados/asignar/bulk/notas/búsqueda/
      quick-replies responden JSON; permisos 403 correctos; `typecheck` limpio.

### F11.3 — Baileys (citas, reacciones, avatar)
- [ ] `session.ts`: `quotedWaId` en `mapInbound`; `reaction` entrante;
      `sendText`/`sendMedia` con `quoted`; `sendReaction`; `profilePictureUrl`.
- [ ] `manager.ts`: persistir cita/reacción; emitir SSE `reaction`; avatar;
      `last_message_text`; `sender_uid`/`sender_type` en salientes.
- [ ] **Aceptación**: responder citando muestra la cita en WhatsApp;
      reaccionar desde el panel aparece en el teléfono y viceversa; la reacción
      del cliente queda registrada.

### F11.4 — Frontend del inbox
- [ ] `app.css`: layout 3 columnas + componentes nuevos.
- [ ] `app.js`: reescritura de `initInbox()` (lista, chat, contacto,
      compositor, acciones, SSE nuevos, TTS, grabadora, `/atajos`).
- [ ] `assets/libs/opus-recorder/`: worker + encoder; carga diferida.
- [ ] **Aceptación**: paridad visual/funcional con el Inbox de Laravel (sin
      IA ni service-window); usable en móvil; sin errores de consola.

### F11.5 — Ajustes y pulido
- [ ] Sección Ajustes → Plantillas rápidas (CRUD).
- [ ] Badge global de no leídos en el menú lateral.
- [ ] Estado vacío didáctico y manejo de errores del compositor.
- [ ] **Aceptación**: crear/editar/borrar atajos; contador de no leídos correcto.

### F11.6 — Verificación
- [ ] `npm run typecheck` y `npm run build` limpios.
- [ ] Pruebas funcionales de §8.
- [ ] Actualizar `PLAN.md` (fase F11), `README.md` y `CAMBIOS.md`.

---

## 8. Verificación funcional

1. Abrir `/conversations`: lista con estados y totales; abrir un chat muestra el
   hilo con separadores por día y tics.
2. Enviar texto, imagen, documento, sticker y nota de voz; se reflejan en el
   teléfono y al recargar.
3. Responder citando un mensaje; la cita se ve en WhatsApp.
4. Reaccionar a un mensaje y recibir una reacción del cliente; ambas persisten.
5. Crear nota interna de texto y de voz; visibles solo en el panel.
6. Cambiar estado a pendiente/cerrado; filtrar por estado; acción en lote
   (cerrar/leído/asignar) como admin.
7. Asignar a otro agente; entrar con ese usuario y ver solo su conversación.
8. Buscar una palabra en el historial (≥3 letras) y abrir la coincidencia.
9. Insertar una plantilla con `/atajo` y comprobar la interpolación de variables.
10. Leer en voz alta una burbuja (TTS) y detenerla.

## 9. Riesgos y mitigaciones

- **ALTER TABLE `NOT NULL DEFAULT`**: permitido con default constante; una
  columna por vez.
- **FTS5 en `node:sqlite`**: si no está disponible, fallback a `LIKE`
  transparente (flag en `configs`).
- **Cita (`quoted`) en Baileys**: reconstruir el objeto desde el mensaje guardado
  (`wa_message_id` + `conversation`); si no hay cuerpo, degradar a texto plano.
- **Reacciones**: el `key` de Baileys requiere `remoteJid`, `id` y `fromMe`;
  validar en el servidor antes de enviar.
- **`server.ts` grande**: mitigado extrayendo `panel/inbox.ts`.
- **Voz (opus-recorder)**: es un asset extra; si el navegador no lo soporta, se
  oculta la grabadora y queda MediaRecorder (webm) como fallback.
- **Concurrencia SQLite**: `busy_timeout = 5000` y WAL ya configurados.
- **Permisos**: mantener `requireSection('conversations')`; no-admin limitado a
  lo asignado; acciones en lote solo admin.

## 10. Criterio de cierre

El Inbox de `baileys_esam` reproduce, sin la capa de IA ni el CRM, el
comportamiento del Inbox de `laravel_crm_whatsapp`: listado con estados y
filtros, gestión (asignar/bulk/leer/cerrar), conversación completa (cita,
reacciones, notas, contacto, tics, media, voz, TTS) y plantillas rápidas, todo
en tiempo real y sobre el stack HTML+JS+SSE existente.
