# CAMBIOS — baileys_esam

Registro de todo lo implementado y corregido, del 2026-09-28 al 2026-10-06 (cada sección indica su fecha).

Complementa a `PLAN.md`, `MEJORAS.md` y `IMPLEMENTACION.md`.

---

## 1. Sistema Anti-Baneo (núcleo)

Implementación de las Fases 1–4 de `MEJORAS.md`.

- **SQLite**: se habilitan `PRAGMA journal_mode = WAL`, `synchronous = NORMAL` y `busy_timeout = 5000`
  (`src/db/index.ts`).
- **Tablas nuevas** (`src/db/schema.ts`):
  - `anti_ban_policies` (global con `session_id NULL` + override por sesión, índice único parcial).
  - `session_health_metrics` (semáforo y métricas 24h por sesión).
  - `webhook_queue` (cola persistente de webhooks salientes).
- **`src/core/anti-ban.ts`** (nuevo): perfiles de riesgo bajo/medio/alto, política efectiva,
  warm-up por días (día 1: 50 msgs y 3–5 min; día 2: 100 y 2–3 min; progresivo hasta el tope),
  `limitState` (límites diario/horario), `resetTrust`, `pacingOptionsFor`.
- **`src/core/health.ts`** (nuevo): `recomputeHealth`, `listHealth`, `setQuarantine`
  (semáforo verde/amarillo/rojo).
- **`src/core/pacing.ts`**: jitter desde política, ventana horaria (incluye ventanas que
  **cruzan medianoche**, ej. `08:00 → 01:00`) y **pausas por fatiga**.
- **`src/core/batches.ts`**: aplica warm-up y límites diario/horario (pausa el lote o espera la
  hora), refresca salud, detecta bloqueos, marca `messages.origin = 'batch'` y reanuda lotes.
- **`src/core/optout.ts`**: `looksLikeBlock` y `markBlocked`.
- **`src/core/templates.ts`**: motor de _spinning_ `{opción1|opción2}` (`spin`, `renderTemplate`),
  usado por `batch-service.ts`.

## 2. Pool de sesiones y cuarentena

- **`src/core/session-pool.ts`** (nuevo): `isQuarantined`, `pickHealthySession`, `rotateBatches`,
  `quarantineAndRotate`.
- El runner pone en **cuarentena automática** tras 5 fallos consecutivos y rota los lotes a una
  sesión sana; si no hay reemplazo, pausa el lote.
- Acciones en el panel: cuarentena/liberar, rotar y reset de warm-up.

## 3. Panel de administración

- **`src/panel/anti-ban.ts`** (nuevo): rutas `/anti-ban` (políticas global y por sesión + dashboard
  de salud), cuarentena/rotación/reset, y lista negra (alta, importación por líneas y export CSV).
- Menú “Políticas” → “Anti-Baneo” (`src/panel/layout.ts`).
- **`/users`**: nueva columna **Rol** (roles espejados de cronogramas; “Administrador” si es la cuenta
  local de sistema).
- **Topbar**: el chip muestra **nombre completo · rol** del usuario (antes “Gateway Baileys…”).
- **`/settings` (Conexión)**: usa la **sesión del propio usuario** para QR/pairing/logout; la lista de
  sesiones y la creación de sesiones quedan solo para admins.
- **Restricción por conexión**: cualquier usuario (incluidos admins) cuya sesión no esté `ready`
  solo puede ver **Conexión**; el menú y las rutas se restringen y `/` redirige a `/settings`.
- **Selector de sesión**: los admins sin número propio pueden elegir qué sesión/número ver
  (persistido en `configs` como `view_session:<id>`).
- **Lista de conversaciones**: `programa → nombre completo del participante → número de WhatsApp`.
- **Cabecera del chat**: badge con el **programa** (`.chat-programa`).
- **Cache-busting** de `/app.css` y `/app.js` con `?v=<mtime>` (`src/panel/layout.ts`).
- **CSS** (`public/app.css`): burbujas más compactas, hilo anclado al fondo, altura del inbox acotada,
  fondo con degradado y scrollbar fina.

## 4. Monitoreo y Reportes

- **`src/core/monitoring.ts`** (nuevo): `monitoringData(filtros)` y `reportsData()`.
- **`/monitoring`**: filtros por **fecha, programa, usuario, área y tipo**; KPIs (Cronogramas,
  Bandeja ESAM, Cobranzas, Avisos de notas, Fallidos, Recibidos); gráficos (por usuario, origen,
  programa, evolución) y tablas de seguimiento por programa y usuario.
- **`/reports`**: KPIs (Enviados, Entregados, Leídos, Fallidos, Recibidos, Entregabilidad) y gráficos
  (destinatarios por estado, envíos/recibidos por día, envíos por tipo, por programa).
- Se añade `messages.origin` (`panel` | `batch` | `phone`) para no contar como “Bandeja ESAM” los
  mensajes sincronizados del teléfono.

## 5. Cuentas, roles y SSO con cronogramas

- **`POST /api/v1/accounts`** ahora también crea/actualiza el **usuario del panel** (espejo) con
  `upsertUser` (mismos datos y credenciales que cronogramas) cuando la cuenta está autorizada y
  tiene número; recalcula `phone_verified_at` para no quedar “verificado” desactualizado.
- **`usernameAvailableFor`** (`src/auth/users.ts`): evita colisiones de `username` (si lo usa otra
  cuenta, se deja nulo y el usuario entra por email). Se usa en el alta de cuentas y en `/sso`.
- **`PUT /api/v1/config/numero`**: ya no pisa una sesión con dueño; actualiza la sesión que
  corresponde a **ese** número.
- **`GET /api/v1/accounts`** incluye `blocked_reason` y `last_error`.
- **`sessionForUser`** prioriza: (1) sesión propia por `esam_numero`, (2) por `owner_uid`,
  (3) admin sin número → principal, (4) usuario normal → su alcance.

## 6. Baileys / LID

- Upgrade **`@whiskeysockets/baileys` 6.7.16 → 6.7.24** (misma serie estable). Expone
  `key.senderPn`/`senderLid` para resolver los chats `@lid` a su **teléfono real**.
- **`src/baileys/session.ts`**: captura LID↔teléfono en mensajes entrantes (y el inverso).
- **`src/panel/server.ts`**: etiqueta de respaldo para LIDs sin teléfono (“Contacto …XXXXXX”).
- **`src/baileys/manager.ts`**: `requireReady` espera hasta ~25 s a que la sesión quede lista
  (evita fallos justo tras un reinicio).

## 7. Rendimiento, colas y limpieza

- **`src/core/webhook-queue.ts`** (nuevo): reintentos con backoff exponencial; `dispatchEvent`
  encola al fallar. Worker iniciado desde `index.ts`.
- **`src/core/retention.ts`** (nuevo): borra media antigua de `data/media` a diario
  (`MEDIA_RETENTION_DAYS`) y ejecuta `VACUUM` semanal. Iniciado desde `index.ts`.
- **`src/index.ts`**: si un puerto está ocupado, el proceso **sale** (evita instancias zombie que
  abren un segundo socket de Baileys con las mismas credenciales).

## 8. Configuración

- `.env` / `.env.example`: `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_RETRY_BASE_MS`, `MEDIA_RETENTION_DAYS`,
  `AUTO_START_SESSIONS=true`, `LOCAL_ADMIN_USER=admin2`, `SSO_SECRET` (igualado con cronogramas).
- Admin local renombrado a **`admin2`** (`admin@baileys.local`) para no confundir con el `admin` de
  cronogramas.

## 9. Incidencias corregidas

- Mensajes entrantes que no llegaban: había **dos instancias** (una zombie) conectadas con las mismas
  credenciales → se corrigió con la guarda de puerto y limpieza de procesos.
- El `/sso` daba “Cannot GET” (puerto de API en vez del panel) y luego 403 (`SSO_SECRET` vacío) y
  `UNIQUE users.username` → resuelto (panel_url en cronogramas, secreto sincronizado, guard de username).
- La sesión principal quedó bloqueada porque el “Número autorizado” global sobreescribía su
  `expected_phone` → endpoint corregido; se restauró el `expected_phone` (requiere re-vincular el
  número 591XXXXXXX1 por QR).

## 10. Verificación

- `npm run typecheck` y `npm run build` limpios en cada etapa.
- Pruebas de humo de: WAL/migración, política/warm-up, límites, pool de sesiones, webhooks, retención,
  monitoreo/reportes y render del panel.

## 11. Inbox — paridad con laravel_crm_whatsapp

Plan detallado: **`PLAN_INBOX.md`**. Alcance: chat + gestión completa (sin IA ni CRM),
sobre el stack HTML+Vanilla JS+SSE existente.

### F11.1 — Datos y contactos

- **`src/db/schema.ts`**: tablas nuevas `contacts`, `contact_notes`, `message_reactions` y
  `quick_replies` (con índices y `UNIQUE`).
- **`src/db/index.ts`**: migraciones idempotentes de columnas
  (`conversations.status|assigned_agent_id|last_message_text|contact_id|closed_at`,
  `messages.reply_to_wa_id|sender_type|sender_uid`); creación de **FTS5**
  (`messages_fts` + triggers `_ai/_ad/_au`) dentro de `try/catch` con bandera `configs.fts5`
  (fallback a `LIKE`); `backfillInbox()` que crea la ficha de contacto por conversación,
  enlaza `contact_id`, rellena `last_message_text` y `sender_type`.
- **`src/types.ts`**: tipos `ConversationRow`, `MessageRow`, `ContactRow`, `ContactNoteRow`,
  `MessageReactionRow`, `QuickReplyRow`.
- **`src/baileys/session.ts`**: `InboundMessage` extendido con `quotedWaId` y `reaction`
  (se poblarán en F11.3).
- **`src/core/contacts.ts`** (nuevo): `getOrCreateContact`, `upsertContact`, `setAvatar`,
  `listNotes`, `addNote`, `deleteNote`.
- Verificado sobre la base real: migra sin pérdida de datos, es idempotente, `contacts`
  queda con una fila por conversación y la búsqueda FTS5 responde.

### F11.2 — Backend de conversaciones

- **`src/core/conversations.ts`** (nuevo): `listConversations` (alcance por usuario +
  filtro de estado/texto), `conversationDTO`, `listMessages` (con cita y reacciones),
  `setConversationStatus`, `assignConversation`, `bulkAction` (solo admin),
  `searchMessages` (FTS5 con fallback a `LIKE`, agrupado por conversación con snippet),
  `markConversationRead`, `setReaction`, `tagOutbound` (atribuye agente y cita).
- **`src/core/quick-replies.ts`** (nuevo): CRUD y `renderQuickReply` (variables
  `{name}/{phone}/{email}/{company}`, compatibles con `{{ }}`).
- **`src/core/contacts.ts`**: se agrega `getNote`.
- **`src/panel/inbox.ts`** (nuevo): rutas JSON `/inbox/*` (lista, mensajes, búsqueda,
  miembros, quick-replies, enviar texto/media/voz/sticker, sincronizar, leer, estado,
  asignar, reaccionar, notas de contacto, bulk). Usa `/inbox/:session/:chat/...` para
  desambiguar entre varias sesiones. Autorización por alcance + asignación; asignación y
  bulk solo admin.
- **`src/panel/server.ts`**: registra `registerInboxRoutes` (el archivo no crece con la
  lógica del inbox).
- **`src/baileys/manager.ts`**: `upsertConversation` ahora escribe `last_message_text` y
  enlaza `contact_id`; se agrega `messagePreview`.
- Verificado: lista (6), mensajes con cita/reacciones, estado/asignación/bulk, búsqueda
  FTS (`mensaje` → 3) y CRUD/render de plantillas rápidas.

### F11.3 — Baileys: cita, reacciones y avatar

- **`src/baileys/session.ts`**:
  - `mapInbound` extrae `quotedWaId` (`contextInfo.stanzaId`) y `reaction`
    (`reactionMessage.key.id` + emoji).
  - `doSend`/`sendText`/`sendMedia` aceptan un `QuotedRef` opcional y arman el
    `quoted` para `sendMessage`; se agrega `buildQuoted`.
  - `sendReaction(chatId, key, emoji)` envía `{ react: {...} }`.
  - `profilePictureUrl(chatId)` (best-effort).
- **`src/baileys/manager.ts`**:
  - `sendText`/`sendMedia` aceptan `SendOptions` (`quoteWaId`, `senderUid`) y
    persisten `reply_to_wa_id`/`sender_uid`/`sender_type`.
  - `sendReaction(...)` envía a WhatsApp, persiste y emite SSE `reaction`.
  - `handleReaction` registra reacciones entrantes (cliente o propio teléfono).
  - `refreshAvatar` guarda la foto de perfil en `contacts.avatar_path` (una vez por chat).
  - `persistInbound` guarda `reply_to_wa_id` y `sender_type='customer'`.
- **`src/panel/inbox.ts`**: la ruta de reacción usa `manager.sendReaction`.
- Verificado: `typecheck`/`build` limpios; migración idempotente con `sender_type`
  poblado y columnas de cita/reacción disponibles.

### F11.4 — Frontend del inbox (3 columnas)

- **`src/panel/server.ts`**: `/conversations` y `/conversations/:chat` sirven el shell
  del inbox v2 (`renderInboxShell`): lista con pestañas por estado, búsqueda, columna
  de chat y panel de contacto; riel para colapsar la lista.
- **`src/panel/inbox.ts`**: nuevo `GET /inbox/sessions` (sesiones del alcance para el
  selector de admin).
- **`public/app.js`**: reescritura del inbox como módulo `initInbox()` contra JSON:
  - Lista con pestañas (Todas/Abiertas/Pend./Cerr.), búsqueda, avatar, estado, agente y
    no leídos; apertura de chat sin recargar.
  - Hilo con separadores por día, burbujas con acciones al hover (responder, reaccionar,
    leer), cita, reacciones, tics, media (imagen/sticker/video/audio+transcripción/documento).
  - Cabecera con estado, asignación (admin), sincronizar y toggle de contacto.
  - Compositor: adjuntar, grabadora (MediaRecorder webm), plantillas rápidas (`/atajo`
    con variables), emojis y envío con cita.
  - Panel de contacto: ficha, notas de texto y de voz, metadatos.
  - SSE (`message`, `ack`, `read`, `conversation`, `reaction`, `presence`) + polling.
- **`public/app.css`**: bloque "Inbox v2" (grid de 3 columnas, burbujas, acciones,
  notas, compositor, toasts) y responsive.
- Verificado con el servicio en marcha: `/conversations` renderiza el shell
  (`id="inbox"`, pestañas, `contact-pane`); `/inbox/conversations`, `/messages`,
  `/notes`, `/quick-replies` y `/inbox/sessions` responden 200 con datos reales.

### F11.5 — Ajustes de plantillas rápidas y badge de no leídos

- **`src/panel/server.ts`**: sección `/quick-replies` (listar, crear y borrar) sobre
  `core/quick-replies.ts`, con soporte de "compartida" (solo admin); helper
  `inboxUnreadBadges` que suma los no leídos del alcance del usuario.
- **`src/panel/layout.ts`**: nuevo ítem de menú **Plantillas rápidas** y soporte de
  `badges` por ruta (`opts.badges`) con la píldora roja de no leídos.
- Verificado: `/quick-replies` responde 200 con formulario y menú; crear una plantilla
  (`/saludo`) funciona; el menú muestra el badge con el total de no leídos (3).

### F11.6 — Verificación y corrección de la vista del inbox

- **Bug de layout corregido**: el grid del inbox definía 3 columnas pero tenía 4 hijos
  (riel + lista + chat + contacto). Con el panel de contacto oculto (`d-none`) el grid
  seguía reservando su columna de 340px, dejando un hueco y desplazando la vista.
  - `public/app.css`: `.contact-hidden` ahora colapsa a 2 columnas y oculta el panel;
    `.list-hidden` colapsa la lista al riel; el riel se oculta salvo en `list-hidden`;
    posiciones explícitas `grid-column` para lista/chat/contacto.
  - `src/panel/server.ts`: el shell arranca con `contact-hidden` (sin columna fantasma)
    hasta que se abre una conversación.
- Verificado con jsdom (sin navegador): el JS renderiza la lista, abre el chat
  (`.chat-header`, `.composer`, `.contact-panel`, `.bubble`) sin errores, y las clases
  del root pasan de `inbox contact-hidden` (2 columnas) a `inbox` (3 columnas) al abrir.
- `npm run typecheck` y `npm run build` limpios.

### F11.7 — Ajuste de alcance y rediseño del inbox

Contexto: este inbox es para conversaciones originadas en **cronogramas**; no hay
asignación a agentes ni estados (abierta/pendiente/cerrada). Se simplifica el alcance
y se rediseña la vista (modo operación, paleta institucional).

- **Alcance simplificado**:
  - `src/panel/inbox.ts`: se eliminan `PATCH /status`, `PATCH /assign`, `GET /members`
    y las acciones en lote salvo marcar leído (`/inbox/bulk` solo `mark_read`).
  - `src/panel/server.ts`: shell sin pestañas de estado ni barra de lote; búsqueda solo
    local (filtra la lista) con botón de limpiar.
  - `public/app.js`: sin estados, asignación, selección múltiple ni tabs. Cabecera con
    solo sincronizar y ficha del contacto.
- **Rediseño (skill impeccable, modo Operate)**:
  - Paleta institucional navy/azul/acento amarillo con tokens locales (`--ib-*`).
  - Tarjeta contenedora con sombra suave; columnas lista/hilo/contacto.
  - Lista con fila activa (barra de acento, no borde), avatar, hora y no leídos;
    búsqueda con foco visible; estados vacíos didácticos.
  - Hilo con fondo de micro-trama, separadores de día, burbujas entrantes/salientes,
    cita y reacciones con acciones al hover (responder/reaccionar/leer).
  - Compositor con reply-preview, plantillas rápidas, emojis y grabadora.
  - Ficha de contacto con notas de texto/voz y metadatos.
  - Detalles de craft: scrollbars tematizados, `::selection`, `:focus-visible`, toast
    con entrada suave; se eliminaron los `border-left` de acento detectados por el
    detector de impeccable (side-tab).
- Verificado con jsdom: 2 columnas al inicio (`contact-hidden`) y 3 al abrir; sin
  `#status-select`/`#assign-select`/tabs/bulk; header, compositor, contacto y burbujas
  presentes. `typecheck`/`build` limpios.

> Nota: los tipos (`ConversationRow.status`, `assigned_agent_id`) y las funciones
> `setConversationStatus`/`assignConversation` del core se conservan por compatibilidad
> de la base de datos, pero ya no se exponen en la interfaz.

### F11.8 — Ajustes de shell y vista

- **Scroll horizontal global eliminado**: `html, body { overflow-x: hidden }`, `#layout-wrapper`
  a ancho completo (se anuló el `max-width:95%` de Velzon) y `min-width:0` en
  `.main-content`/`.container-fluid` para que el grid del inbox no desborde.
- **Ítem activo del menú lateral**: `navList` ahora resalta por href/sección
  (`aria-current="page"`) y se agrega `activeHref` para desambiguar Plantillas vs
  Plantillas rápidas. Estilo propio del ítem activo (fondo acento amarillo suave,
  barra lateral y color de icono).
- **Espacio contenido ↔ footer**: `.page-content` con mayor padding inferior,
  `.footer` con `padding`/`margin-top`, y la altura del `.inbox` ajustada a
  `clamp(480px, calc(100vh - 300px), 900px)` para no dejar un hueco antes del footer.
- Verificado: cada página resalta su ítem (`/conversations`, `/reports`,
  `/quick-replies`); `typecheck`/`build` limpios.

### F11.9 — Altura del inbox sin hueco antes del footer

- El `.inbox` ya no usa una altura fija (`calc(100vh - 300px)`) que dejaba un espacio
  variable antes del footer. Ahora **llena el alto disponible** con flex:
  - `.main-content`, `.page-content` y su `.container-fluid` son `flex` en columna con
    `min-height: 100dvh` / `flex: 1`.
  - `.inbox { flex: 1; min-height: 480px; margin-bottom: 0.5rem }`.
  - `.page-content { padding: 1.4rem 0 0.5rem }` y `.footer` con padding compacto.
- Resultado: en Conversaciones queda solo un colchón mínimo (0.5rem) entre el inbox y
  el footer, sin importar la resolución. Verificado con el servicio en marcha
  (`/conversations` 200, shell presente); `typecheck`/`build` limpios.

### F11.10 — Sin scroll de página y compositor corregido

- **Scroll vertical eliminado**: se quitaron el `flex`/`min-height:100dvh` del shell que
  sumaban altura. El `.inbox` usa ahora `height: calc(100dvh - 243px)` (topbar + título
  + footer) con `margin-bottom` mínimo y `.page-content { padding-bottom: 0.4rem }`.
- **Columnas equilibradas**: lista 320px · hilo `1fr` · ficha 320px (antes 348/340), para
  que el hilo tenga más ancho; `.chat-col { overflow: hidden }`.
- **Compositor corregido**: se eliminó una regla `.composer { display:flex }` heredada del
  inbox anterior que rompía el layout, y se reestructuró `composerHtml` con `.composer-field`
  (`flex:1; min-width:0`). El campo de texto ahora ocupa el ancho disponible y el placeholder
  entra en una línea.
- Verificado con Chrome headless (viewport 1440×810): `documentElement.scrollHeight ===
  innerHeight` (sin scroll), hueco inbox→footer ≈ 26px, y al abrir un chat siguen presentes
  header, compositor y ficha sin desbordes. `typecheck`/`build` limpios.

### F11.11 — SSO de cronogramas, número autorizado e historial por usuario

Alineado con el emisor real (`el servidor de cronogramas`): SSO firmado con
`{uid, name, email, username, autorizado, area, numero, roles, next, exp, nonce}`
y registro de cuentas vía `POST /api/v1/accounts`.

- **`src/auth/users.ts`**:
  - `sessionScopeFor` compara **dígitos exactos** de `expected_phone`/`phone`
    (antes `LIKE %numero%`, que producía falsos positivos).
  - **`ensureUserSession(user)` (nuevo)**: al iniciar sesión (local o SSO) vincula o
    crea la sesión del número del usuario, fijando `owner_uid` y `expected_phone`.
    Reutiliza una sesión existente por número **o** por `owner_uid` (evita duplicar
    la que crea `/api/v1/accounts`).
  - `sessionMatchesPhone` (helper).
- **`src/panel/server.ts`**: el login local y el SSO llaman a `ensureUserSession`
  (se reemplazó el `UPDATE` con `LIKE` por la vinculación robusta).
- **`src/baileys/manager.ts`**: `onReady` valida el número vinculado contra
  `expected_phone`, el número global **o** el `esam_numero` del usuario dueño; si no
  coincide, **desvincula y bloquea** la sesión.
- **`src/core/conversations.ts`**: se eliminó la restricción por `assigned_agent_id`
  (este proyecto no asigna agentes); el alcance del inbox es solo por sesión/número.
  Esto corregía que un no-admin no viera ninguna conversación.
- **Verificado** con el servicio en marcha y SSO real:
  - Cuenta de cronogramas (`uid=42`, número `591XXXXXXX2`): tras el SSO, el inbox
    muestra **solo** su conversación ("Cliente Propio") y **no** la de otra sesión
    ("Cliente Ajeno").
  - Otro usuario (`uid=99`, número distinto): **no** ve la conversación de `uid=42`.
  - `typecheck`/`build` limpios.

### F11.12 — Limpieza de código/HTML/CSS muerto

- **`src/panel/server.ts`**: se eliminaron las rutas HTML viejas del inbox
  (`/conversations-items`, `/conversations/:chat/feed`, `/conversations/:chat/send`,
  `/conversations/:chat/sticker`, `/conversations/:chat/sync`,
  `/messages/:id/transcribe`) y sus helpers (`chatLabel`, `avatarClass`,
  `chatItemsHtml`, `emptyChatPane`, `chatPanelHtml`, `inboxShell`, `emojiTray`,
  `dayLabel`, `dateKey`, `messagesHtml`, `linkifyEscaped`, `messageHtml`), más los
  imports sin uso (`displayPhoneNumber`, `activeStickers`, `initials`, `transcribe`).
  Se mantienen `/conversations` (shell), `/conversations/:chat`, `/media/:id` y las
  rutas JSON `/inbox/*`.
- **`src/core/conversations.ts`**: se quitaron `setConversationStatus`,
  `assignConversation`, `ensureContact`, el tipo `ConversationStatus` y los imports
  sin uso (`upsertContact`, `contactIdFor`, `esamEsAdmin`).
- **`public/app.css`**: se eliminó el bloque "Inbox · lista y chat" (≈277 líneas) del
  inbox anterior (`.chatitem`, `.msgs`, `.msg`, `.msg-*`, `.chat-card`, `.chat-panel`,
  `.emoji-tray`, `.emoji-group`, `.attach-preview`, `.unread-badge`, etc.).
- Verificado con Chrome headless tras la limpieza: lista con conversaciones, sin
  scroll, hueco inbox→footer ≈ 26px y chat abierto (header/compositor/contacto/
  burbuja) sin desbordes. `typecheck`/`build` limpios.

### F11.13 — El inbox muestra solo el historial del número del usuario

**Bug**: al iniciar sesión se veían las conversaciones de **todos** los usuarios.
Causa: `sessionScopeFor` devolvía `null` (sin filtro) para **cualquier admin**,
incluidos los administradores de cronogramas, que así veían todas las sesiones.

- **`src/auth/users.ts`** (`sessionScopeFor`): ahora el historial es **siempre** el
  de la sesión/número del usuario.
  - Solo la cuenta **local** (`source === 'local'`, p. ej. `admin2`) ve todas.
  - Cualquier usuario con `esam_numero` (incluidos admins de cronogramas) ve **solo**
    las sesiones cuyo `expected_phone`/`phone` coincide exactamente con su número.
  - Usuario sin número: sesiones de su `owner_uid`.
- Verificado con SSO real (servicio en marcha):
  - Admin de cronogramas `uid=10` (número `70000010`) → ve **solo** su sesión; no ve
    las de `uid=20` ni la de otro dueño.
  - Usuario `uid=20` (número `70000020`) → ve **solo** su sesión.
  - `admin2` (local) → ve todas (cuenta de administración).
  - `typecheck`/`build` limpios.

### F11.14 — Nota de voz no enviaba (formato WebM)

**Bug**: al grabar una nota de voz no se enviaba. Causa: el grabador usaba
`MediaRecorder` (`audio/webm`), formato que WhatsApp **no** acepta como nota de
voz (espera OGG/Opus); el envío fallaba o la nota no llegaba.

- **`public/app.js`** (`VoiceRecorder`): ahora graba con **`opus-recorder`**
  (OGG/Opus nativo), cargado localmente desde `/assets/libs/opus-recorder/`
  (`recorder.min.js` + `encoderWorker.min.js`), con **fallback** a MediaRecorder
  (`audio/webm;codecs=opus`) si no está disponible.
- **`src/panel/inbox.ts`** (`POST /inbox/:session/:chat/voice`): si el archivo es
  OGG envía `audio/ogg; codecs=opus` con `ptt:true`; si llega WebM (fallback) lo
  envía como audio normal (`ptt:false`) para que no falle.
- **`package.json`**: se agrega `opus-recorder` y sus assets locales.
- Verificado con Chrome headless y micrófono simulado: la grabación inicia, al
  detener se envía el `POST /voice` con un archivo `voz-*.ogg` de tipo
  `audio/ogg`. `typecheck`/`build` limpios.

### F11.15 — La nota de voz se enviaba vacía

**Bug**: se enviaba el audio pero sin lo hablado (archivo OGG solo con cabecera).
Dos causas:
1. `rec.stop()` **no** devuelve el Blob en `opus-recorder`; el OGG llega por el
   callback **`rec.ondataavailable`** (con `streamPages:false`, una vez al terminar).
   El código lo había quitado y esperaba el retorno de `stop()`.
2. Un `null.addEventListener` por re-render del grabador interrumpía el flujo.

- **`public/app.js`** (`VoiceRecorder`): se restaura `rec.ondataavailable` para
  construir el `File` OGG (tipo `audio/ogg`) y se simplifica `stop()` para solo
  solicitar el fin de la grabación (el envío ocurre en `ondataavailable`).
- Verificado con Chrome + micrófono simulado: el archivo enviado a `/voice` es un
  OGG válido (cabecera `OggS`, ~20 KB para ~4 s) en lugar del OGG vacío de ~9 KB.

### F11.16 — Corrección de datos: sesión con número mal vinculado

**Síntoma**: dos usuarios veían el mismo historial. Causa concreta en la base real:
la sesión `esam-area-NN` (del **usuario B (admin)**, número autorizado
`591XXXXXXX3`) tenía **`phone = 591XXXXXXX4`** (el número del **usuario A**) mal
vinculado; por eso el usuario A (número `591XXXXXXX4`) matcheaba esa sesión **además**
de la suya (`esam-principal`).

- Se **desvinculó** el número incorrecto de `esam-area-NN` (`phone = NULL`,
  `phone_verified_at = NULL`, `status = created`) para que pueda vincular su número
  correcto (`591XXXXXXX3`). **No** se borró historial legítimo.
- Se eliminó un chat **basura** `<LID-del-propio-número>@lid` (91 mensajes `[protocol]`/
  `[unknown]`, sin contenido) que estaba duplicado en ambas sesiones.
- Resultado verificado:
  - **usuario A** (`591XXXXXXX4`) → solo `esam-principal` (6 conversaciones, 84 msgs).
  - **usuario B (admin)** (`591XXXXXXX3`) → solo `esam-area-NN` (vacía, lista para re-vincular).
- Respaldo previo de la base: `backup-20261003-024056.sqlite` (en el temp de trabajo).

> La causa de raíz era que una sesión de un usuario pudo vincularse con un número
> que no era el suyo (p. ej. sesiones reutilizadas). Con `onReady` (F11.11) el
> número vinculado debe coincidir con `expected_phone` o con el `esam_numero` del
> dueño; si no, se desvincula y bloquea.

---

## 12. Grupos, mensajes offline e historial (2026-10-04/05)

### Mensajes que no llegaban al reabrir el sistema

- **Causa raíz**: Baileys emite los mensajes recibidos mientras el socket estuvo
  desconectado con `type: 'append'` (offline); el panel solo procesaba `'notify'`
  (`src/baileys/session.ts`). Además `syncFullHistory` estaba en `false`, por lo
  que al vincular un dispositivo nuevo WhatsApp no entregaba el historial.
- **`session.ts`**: `onUpsert` procesa `notify` **y** `append`.
- **`config.ts`**: `BAILEYS_SYNC_FULL_HISTORY` (por defecto `true`) → `syncFullHistory`.
- **`manager.ts`**: `resumeHistories()` sincroniza (una sola vez por sesión, marca
  `configs.history_session_synced:<id>`) los chats conocidos; idempotencia por
  `wa_message_id`; la media del historial/offline **no** se descarga (URLs caducas → 403).
- **`fetchMessageHistory`** corregido: Baileys espera `(count, oldestMsgKey, timestampMs)`;
  antes se pasaba mal y fallaba con `reading 'remoteJid'`. Nuevo ancla `historyAnchor`.
- **`session.ts`**: timeout de 15 s por chat en la sincronización (evita bucle colgado).

### Grupos en el mismo inbox

- Se dejaron de excluir los `@g.us` (`manager.isInboxChat`, `onMessage`, `onHistory`;
  `core/conversations.ts:inboxWhere`; `panel/server.ts:INBOX_ORDER`).
- Nombre del grupo por `groupMetadata` cacheado (`groupSubject`, `warmGroupNames`);
  el autor de cada mensaje se guarda en `messages.sender_jid`.
- Webhooks `message.received` con `kind: group`, `group` y `participant`; **sin**
  auto-respuesta ni opt-out en grupos.
- Citas y acuses de lectura incluyen el `participant`.

### UI del inbox

- **Solapas Números / Grupos** con conteo y aviso de no leídos.
- **Paginación**: carga los últimos 10 mensajes y al hacer scroll hacia arriba
  trae 10 anteriores (`before` por cursor `occurred_at|id`). Orden cronológico
  estable en cliente y servidor.
- **Cita clickeable** → salta al mensaje original (carga páginas si hace falta) y
  muestra/abre el contacto del mensaje citado.
- Burbujas de grupo: el **autor** es clickeable para abrir su conversación;
  los **números de WhatsApp** escritos en el texto también son clickeables.
- Documentos con botón de **descarga**.
- Índices nuevos (`idx_messages_convo_time`, `idx_messages_session_wa`) que bajaron
  la consulta de mensajes de **>120 s a ~0,2 ms** en chats de 14k mensajes.

### LID → número real

- `warmGroupNames` y `groupParticipants` completan el mapa LID↔número con los
  miembros de todos los grupos; las conversaciones `@lid` se migran a `@c.us`
  (incluye ficha de contacto). `phoneFromChatId` devuelve `''` para `@lid`/grupos.
- Se guarda `participantPn`/`senderPn` como `sender_jid` para no mostrar el código anónimo.

### Notas internas (etiquetas + vencimiento)

- Tablas `note_tags` y `contact_note_tags`; columna `contact_notes.due_at`.
- `core/note-tags.ts` (CRUD de etiquetas globales) y `core/contacts.ts`
  (`updateNote`, `noteDTO`, `listAllNotes` con filtros/orden).
- **Apartado Notas** en el menú (`/notes`): todas las notas (orden por fecha o por
  vencimiento, filtros por etiqueta/vencidas/búsqueda) y gestor de etiquetas con color.
- Ficha del contacto: registrar nota con **etiquetas** y **fecha límite**, editar y
  eliminar (solo el autor o un admin).

### Actividad por usuario (reportes/monitoreo)

- `monitoringData` ahora atribuye cada lote a la **sesión** (dueño real) cuando el
  lote de cronogramas no trae `meta.account`, y muestra el **nombre de usuario (login)**.
- Nuevo `activityData` + `GET /api/activity`: por usuario lista **número · apartado
  (académico/contable) · desde cronogramas · desde panel ESAM · total**.
- Filtro por rango, **día o mes**, usuario y apartado; tabla con **auto-refresco 60 s**.
- `/api/v1/health` acepta `?uid=`/`?phone=` y devuelve la **sesión de ese usuario**
  (o `unlinked`), para no mostrar el número de otra cuenta.

### Infra

- **Arranque como servicio**: `scripts/autostart.ps1` + acceso directo en la carpeta
  de Inicio de Windows (`baileys_esam.cmd`) para capturar mensajes con el panel cerrado.
- **Guarda de instancia única**: `index.ts` espera los 3 puertos antes de conectar
  WhatsApp; si están ocupados, sale (evita sockets con credenciales duplicadas → Bad MAC).
- `AUTO_VACUUM` (por defecto `false`): el VACUUM automático bloqueaba el panel.

---

## 13. Refinamiento visual de todas las vistas (2026-10-05)

Objetivo: que **todas** las vistas se vean más profesionales, amigables y elegantes
**sin alterar la funcionalidad** (se conservaron nombres de clases, IDs, atributos
`data-*`, rutas y el comportamiento de `public/app.js`). Enfoque: refinamiento que
preserva la identidad institucional ESAM (navy + azul + acento amarillo, tipografía
Inter, plantilla Velzon). Se usó la skill **impeccable** (modo *Operate* / comando
*pollish*) y se verificó el render real con Chrome headless.

### 13.1 — Base de diseño (tokens)

`public/app.css`:

- **Elevación**: nueva escala `--esam-shadow-xs/sm/lg`. Las tarjetas en reposo usan
  **solo borde** (sin sombra) para evitar la "tarjeta fantasma"; la sombra queda
  reservada a superficies flotantes (dropdowns, toasts, inbox) y al *hover* de
  tarjetas interactivas.
- **Radios** (`--esam-radius-xs/-sm/-lg`), **ritmo espacial** (`--esam-gap-1…6`),
  **paleta neutra/semántica** afinada y curva `--esam-ease-out`.
- **Modo oscuro** con paridad de tokens (canvas, superficies, líneas y sombras).

### 13.2 — Componentes compartidos (afectan a todas las páginas)

- **Botones**: `inline-flex`, estados `:disabled`/`.disabled` atenuados, foco y
  transiciones consistentes.
- **Tarjetas**: cabecera/cuerpo con más aire; `.card-hover` y `[data-batch]` elevan
  sombra y suben 2px al pasar el cursor.
- **Badges**: `inline-flex` con separación de icono.
- **Formularios**: alturas mínimas (incluido `.form-control-sm`), foco, `.form-text`,
  *switches*/checks tematizados y estados deshabilitados.
- **Tablas**: cabecera tintada con `white-space: nowrap`, filas con *hover*, celdas
  consistentes y **tabla borde a borde** cuando es el único contenido de la tarjeta
  (`:has(> .table-responsive)`), con las esquinas inferiores redondeadas.
- **Progreso, alertas y scrollbars** alineados a los tokens.

### 13.3 — Shell, cabeceras y estados

- **Sidebar**: ítem activo más nítido (fondo degradado + barra de acento amarilla).
- **Cabecera de página**: título a `1.4rem`, subtítulo y acciones con mejor jerarquía.
- **Tarjetas de métrica**: icono y valor más grandes, *hover* sutil y etiquetas que
  **no** parten palabras.
- **Estados vacíos**: icono con anillo y **acción opcional**; copy didáctico.
- **Avisos, `kv-list`, panel de conexión** refinados.

### 13.4 — Inbox y Notas

- `code`/atajos con estilo propio, avatares con anillo, enlaces de tabla.
- **Vencimiento de notas**: se reemplazó la barra `border-left` roja por color de
  borde (evita el antipatrón *side-tab* del detector de impeccable).
- **Inbox móvil**: se corrigió el apilado (ver 13.6).

### 13.5 — Helpers de vista y metadatos

- **`src/panel/views.ts`**:
  - `emptyState(icon, title, text, action?)` acepta una acción.
  - **Lotes**: tarjeta con encabezado con marca, **progreso con porcentaje** y
    métricas en rejilla; estado vacío con botón **Importar CSV**.
- **`src/panel/layout.ts`**: `<meta name="description">` y
  `<meta name="robots" content="noindex, nofollow">`.
- **`src/panel/server.ts`**: los 6 KPIs de **Reportes** y **Monitoreo** pasan de
  `col-xl-2 col-md-4` (6 por fila) a **`col-xl-4 col-md-6`** (3 por fila) para dar
  aire a las etiquetas largas.

### 13.6 — Defectos detectados en el render y corregidos

Verificación con un **render aislado** (base SQLite temporal, **sin** arrancar
WhatsApp ni tocar datos reales) y **9 capturas** con Chrome headless
(desktop 1440px + móvil):

1. **Etiquetas de métrica partidas a mitad de palabra** (p. ej. `ENTREGAD OS`,
   `ENTREGABI LIDAD`): causa = `word-wrap: break-word` de Bootstrap en `.card`.
   → rejilla a 3 por fila + `overflow-wrap: normal` en `.stat-label`.
2. **Tablas anchas recortadas**: la regla de "tabla borde a borde" usaba
   `overflow: hidden` en el `card-body`, anulando el scroll horizontal (tabla
   "Sesiones" de Anti-Baneo). → el radio se movió al propio `.table-responsive`.
3. **Inbox móvil en dos columnas**: `.chat-col`/`.contact-panel` fijan
   `grid-column`, por lo que la regla de una sola columna generaba **columnas
   implícitas** al costado. → se reinician los `grid-column` en el breakpoint
   `max-width: 991.98px`; ahora la lista y el chat se apilan (verificado: una sola
   columna computada).

### 13.7 — Verificación

- `npm run typecheck` limpio.
- Detector de impeccable sobre los archivos cambiados: solo reporta hallazgos
  **preexistentes e intencionales** — la fuente **Inter** (identidad que se pidió
  conservar) y la animación de `width` de la barra de progreso (la usa
  `public/app.js` para el seguimiento en vivo).
- Capturas del render revisadas: login, Reportes, Usuarios, Anti-Baneo, Lotes,
  Lotes vacío, Conexión, Inbox (escritorio y móvil).
- El script temporal de previsualización usado para las capturas fue **eliminado**
  al terminar.

---

## 14. Sincronización tras apagado, media diferida y anti-baneo ampliado (2026-10-06)

### 14.1 — Mensajes enviados desde el teléfono que no aparecían

- **Causa raíz** (vista en `storage/logs/service.err.log`: 128 × `Over 2000 messages
  into the future!` del dispositivo `<LID-propio>.0`, que es el **propio teléfono**):
  con el servicio apagado, el teléfono sigue mandando mensajes internos al
  dispositivo vinculado. Al pasar de 2000, libsignal rechaza todo lo siguiente y
  los mensajes enviados desde el celular dejan de llegar. El último guardado con
  `origin = 'phone'` era del 2026-10-03.
- **`src/baileys/signal-patch.ts`** (nuevo): reemplaza `fillMessageKeys` de libsignal
  por una versión iterativa que tolera saltos de hasta 100.000 y guarda solo las
  últimas 2000 claves (mismo algoritmo; verificado contra el original).
- **`session.ts`**: los mensajes que no se pudieron descifrar se registran
  (`decrypt-failure`) y aparecen en Anti-Baneo → Salud ("N mensajes sin descifrar").
  `getMessage` ahora devuelve los últimos 3000 enviados: antes devolvía `undefined`,
  y si un contacto pedía el reenvío se quedaba en "Esperando el mensaje…".
- **`manager.ts`**: los mensajes entrantes se procesan **en orden por sesión**
  (antes en paralelo, compitiendo por la base y con riesgo de duplicados); el
  webhook `message.received` ya no frena la recepción; los enviados desde el
  teléfono publican el evento SSE (antes el chat no se refrescaba).
- **`public/app.js`**: el refresco por SSE agrupa ráfagas (como mucho cada ~1,5 s).
  Antes era un *debounce* que se reiniciaba con cada evento y no refrescaba hasta
  que terminaba la ráfaga de mensajes offline.
- Índice `idx_batch_items_message` (cada acuse recorría toda la tabla de lotes).

### 14.2 — Imágenes y videos que no se veían

- El ~98 % de la media no tenía archivo: la de los mensajes offline y la del
  historial nunca se descargaba.
- Columnas `messages.media_ref` (referencia para descargar después) y
  `messages.media_state` (`ok` / `missing`).
- Offline → descarga en segundo plano (2 en paralelo). Historial → se baja al
  abrir el mensaje. Ambos con tiempo máximo (`MEDIA_DOWNLOAD_TIMEOUT`, 20 s).
- Si WhatsApp ya no tiene el archivo se marca `missing`: el panel muestra
  "Imagen no disponible" con **Reintentar** y no vuelve a pedirlo en cada vista.
  Si un archivo se borra del disco, la burbuja cambia al aviso en vez de quedar
  rota.
- `/media/:id`: control de acceso por sesión (antes cualquier usuario podía pedir
  cualquier id), `sendFile` con soporte de *Range* (video/audio con avance) y caché.
  La API del gateway (`/messages/.../media`) también baja la media diferida.
- La retención ya no borra la biblioteca de **stickers**.
- Mensajes antiguos sin referencia guardada no se pueden recuperar: se muestran
  como "no disponible".

### 14.3 — Anti-baneo

- **Bug crítico corregido**: el plan de tiempos del lote guardaba retrasos
  relativos y el runner los comparaba con la hora absoluta, así que **los lotes
  salían sin ninguna espera** entre mensajes. Ahora la espera (jitter, pausa por
  fatiga, enfriamiento) se calcula en cada envío, también tras pausas o ventanas.
- Nuevas opciones de política (global y por sesión, con presets):
  - **Simular "escribiendo…/grabando"** antes de cada envío automático.
  - **Separación mínima** entre envíos automáticos y **tope por minuto** (ráfagas,
    también para el panel). Todos los envíos de la sesión pasan por una cola única.
  - **Contactos nuevos por día**: tope de números sin conversación previa; el lote
    se pausa al alcanzarlo.
  - **Verificar que el número tenga WhatsApp** antes del primer mensaje (se omite
    el destinatario si no existe; resultado cacheado 24 h).
  - **Pausa automática por entregabilidad baja** del lote (≥ 20 envíos con más de
    10 min, bajo el umbral).
  - **Fallos seguidos para cuarentena** configurable (antes fijo en 5).

### 14.4 — Otros

- `/events` (SSE) enviaba los mensajes de todas las sesiones a cualquier usuario
  conectado: ahora se filtran por el alcance del usuario.
- Las respuestas citadas desde el panel ahora se envían como cita a WhatsApp
  (antes solo se guardaba la cita localmente).
- `debug-messages.jsonl` deja de escribirse por defecto (`DEBUG_DUMP_MESSAGES`).
- Verificación: `typecheck`/`build` limpios; 11 pruebas sobre una copia de la base
  (parche de cifrado, media, pacing, migración, políticas) y render aislado del
  panel (sin WhatsApp) con aviso de media, *Range* y guardado de políticas.

### 14.5 — Recuperar media guardada sin referencia (2026-10-06)

- Los mensajes guardados por la versión anterior no tienen `media_ref`. Ahora se
  muestran como **"sin descargar"** (estado `unfetched`) con botón **Descargar**,
  en vez de "no disponible".
- Al pulsarlo, el servidor pide al teléfono el tramo del chat anterior al mensaje
  siguiente (historial bajo demanda, primero por LID y luego por número). Cuando
  llega, `backfillMediaRef` completa la referencia de ese mensaje y de sus
  vecinos, y el panel intenta descargar también los vecinos.
- Cualquier historial que vuelva a llegar (re-vinculación, sincronización)
  completa la referencia de los mensajes ya guardados.
- Videos y documentos tienen 90 s de tiempo máximo de descarga.
- **Requisito**: el canal teléfono → panel tiene que funcionar. Si en Anti-Baneo
  aparecen mensajes "sin descifrar del propio teléfono", hay que re-vincular.

---

## 15. Operación segura: instancia única, reinicio y respaldos (2026-10-06)

Motivo: el 06/10 el servicio siguió corriendo código viejo tras compilar, y un
`npm run dev` en paralelo corrompió la sesión de cifrado con el teléfono (hubo
que re-vincular).

- **`src/core/instance-lock.ts`**: bloqueo `data/baileys/.instance.lock`. Una segunda
  instancia (también `npm run dev`) sale antes de abrir la base o WhatsApp.
  Reemplaza locks huérfanos (PID muerto o de antes de reiniciar Windows).
- **`src/core/runtime.ts`**: versión, PID, modo y hora de arranque, y detección de
  **compilación pendiente** (dist más nuevo que el proceso). Se publica en
  `GET :2785/health` y en el pie del panel (aviso "Reinicio pendiente" para admins).
- **`scripts/restart.cjs`** (`npm run restart`): compila; si falla no toca nada; si
  compila, reinicia la instancia (pm2 o wrapper) y espera la nueva en `/health`.
  Se niega si la instancia viva es un `npm run dev`.
- **`src/core/backup.ts`**: respaldo diario (`VACUUM INTO` en un hilo aparte, sin
  congelar el panel) de la base y de `data/baileys`, conservando `BACKUP_KEEP`.
  `npm run backup` para uno manual. Aviso "Sin respaldo reciente" en el pie.
- Verificado con el servicio real: respaldo de 130 MB en 1,8 s con `quick_check`
  ok y 107.943 mensajes; un `npm run dev` con el servicio activo se rechaza en
  el acto; `npm run restart` reinicia y WhatsApp reconecta solo.

---

## 16. Notas internas como herramienta de seguimiento (2026-10-06)

Objetivo: registrar lo que se sabe de cada contacto y no queda en el chat, y que
los seguimientos con fecha no se pierdan.

- **Modelo**: `contact_notes.done_at`/`done_by` (seguimiento resuelto y por quién) y
  `updated_at` (editada). `listNotes` ordena pendientes por fecha, luego sin fecha y
  al final las resueltas. `listAllNotes` filtra por estado
  (`pending|overdue|today|week|done|all`), autor y etiqueta; `noteStats` da los
  conteos; `listTagsWithUsage` cuenta notas y pendientes por etiqueta.
- **Rutas**: `PATCH /inbox/notes/:id/done`; `GET /notes/all` devuelve `{notes, stats}`
  y cada nota trae `can_edit`; validación de fecha y largo (4000).
- **Seguridad corregida**: `/notes/all` con alcance vacío devolvía las notas de
  todos; editar, borrar o escuchar el audio de una nota no validaba la sesión; había
  un `DELETE /inbox/notes/:id` duplicado sin control de autor.
- **Ficha del contacto** (`NoteKit` en `public/app.js`, compartido con /notes):
  compositor plegado que conserva el borrador; atajos de seguimiento (Hoy, Mañana, En
  3 días, En 1 semana o fecha libre); etiquetas; Ctrl+Enter; nota de voz con texto,
  etiquetas y fecha. Las tarjetas tienen un círculo para marcar hecho/reabrir, edición
  en línea (Ctrl+Enter / Esc) y borrado con confirmación en la propia tarjeta (sin
  `confirm()`). Contadores "N vencidas / hoy"; las resueltas quedan plegadas.
- **/notes**: indicadores clicables (Vencidas, Para hoy, Próximos 7 días, Pendientes,
  Resueltas, Todas); lista agrupada por estado de seguimiento o por fecha de registro;
  búsqueda (texto, contacto o número), "Solo mis notas"; lateral de etiquetas con uso
  (pendientes / total), filtro con un clic y modo **Gestionar** (crear, renombrar,
  cambiar color, eliminar con confirmación). Responsive y modo oscuro.
- Verificado en un render aislado sobre una copia de la base con notas de ejemplo:
  registrar, completar, reabrir, editar, borrar, filtros, búsqueda, orden y gestión de
  etiquetas.

---

## 17. Documentación y publicación en GitHub (2026-10-06)

- **`IMPLEMENTACION.md`** (nuevo, reemplaza a `DESPLIEGUE.md`): guía completa de
  implementación — arquitectura y puertos, requisitos, plantilla Velzon, `.env`,
  primer arranque, vinculación, integración con cronogramas (incluido el formato del
  SSO) y openwa_basico, servicio en Windows/Linux/pm2, seguridad y HTTPS, operación,
  respaldos y restauración, migración, solución de problemas y checklist.
- `README.md` actualizado (funcionalidades, comandos, estructura, versión de Baileys
  6.7.24); `PLAN.md` con las fases F13–F16; anexo de `MEJORAS.md`; nota de estado en
  el diseño de grupos e historial.
- **Repositorio público**: `.gitignore` excluye `data/`, `storage/`, `.env`, logs, la
  base y la plantilla **Velzon** (licencia comercial); se versionan la fuente Inter
  (OFL) y `opus-recorder` (MIT). Se anonimizaron números de teléfono y nombres en
  este registro.
- `npm run check:assets`: verifica que la plantilla Velzon esté copiada.
- `npm run admin:password -- <clave> [usuario]`: cambia la clave del admin local (antes
  solo se definía en el primer arranque y no había forma de cambiarla).
- `.env.example` documenta `LOCAL_ADMIN_*`, `BAILEYS_LOG` y `TRANSCRIBE_PROMPT`.
- Lotes: el motivo de una pausa del anti-baneo ahora se ve en la tarjeta y en el detalle.

---

## 18. Sesión "conectada pero sorda" tras apagar el equipo (2026-10-07)

**Síntoma**: después de apagar y encender el equipo, la sesión figuraba conectada
pero las conversaciones no se actualizaban; solo se arreglaba desvinculando y
volviendo a vincular. En la base: ningún mensaje guardado entre el arranque y la
re-vinculación, sin errores en el registro.

**Causa (defectos de Baileys 6.7.24)**:

- Cada mensaje entrante se procesa dentro de `processingMutex`, que **no tiene
  tiempo máximo** (declara un `taskTimeout` que nunca usa). Si una tarea se cuelga
  —p. ej. la descarga de un bloque de historial o la sincronización del estado de
  la app al reconectar— **todos** los mensajes siguientes quedan esperando para
  siempre: no se descifran, no se guardan y no hay error.
- El búfer de eventos (`ev.buffer()`) solo se vacía cuando lo decide su máquina de
  estados de sincronización inicial, también sin límite de tiempo.
- Re-vincular "lo arreglaba" porque crea un socket nuevo con un mutex nuevo.

**Corrección** (`src/baileys/session.ts`):

- **Vigilante del procesamiento**: cada tarea del mutex tiene 90 s como máximo; si
  se cuelga, la cola sigue y los mensajes siguientes se procesan. Dos bloqueos en
  15 minutos ⇒ se reabre la conexión automáticamente, **sin desvincular**.
- **Vigilante del búfer**: si queda retenido más de 60 s, se libera.
- **Reconexión segura**: `connect()` no admite llamadas simultáneas y los eventos
  de un socket viejo se ignoran; `stop()` suelta el socket antes de cerrarlo (antes
  su evento de cierre disparaba la reconexión automática y podía abrir **dos
  sockets** con las mismas credenciales).
- Prueba con el mutex y el búfer reales de Baileys: sin vigilante la cola queda
  bloqueada (reproduce el defecto); con vigilante el mensaje siguiente se procesa,
  dos bloqueos reabren la conexión, el búfer retenido se libera y el cierre de un
  socket viejo no abre otro.

**Panel → Conexión**:

- Botón **Reconectar**: reabre la conexión con las mismas credenciales (no pide
  QR); es la primera acción ante "no se actualizan las conversaciones".
- **Desvincular** abre un **modal de confirmación** que explica las consecuencias
  (deja de recibir/enviar, hay que escanear el QR, el historial no se borra) y
  sugiere Reconectar. Los botones se deshabilitan al enviar (evita doble envío).

---

## 19. No leídos sincronizados con el teléfono y nuevo Seguimiento/Reportes (2026-10-07)

### 19.1 — No leídos

- **Causa**: cada mensaje entrante del historial sumaba +1 a no leídos (aunque ya
  estuviera leído en el teléfono): 621 conversaciones sumaban 45.888 no leídos falsos
  y el panel enviaba tildes azules por mensajes viejos al abrirlos. Además se
  ignoraban las lecturas hechas en el teléfono.
- **`session.ts`**: recibos `read-self` (individuales en `messages.update`, grupos en
  `message-receipt.update`) y contador de no leídos de WhatsApp (`chats.update`,
  `chats.upsert` y los `chats` del historial) se emiten como `read-self` / `chat-unread`.
- **`manager.ts`**: `onReadSelf` marca leído todo lo anterior al último mensaje leído
  y recalcula el contador; `onChatUnread` aplica el valor del teléfono (0 = leído,
  −1 = marcado como no leído, N = los N más recientes). El historial ya no suma no
  leídos y sus entrantes se guardan como leídos. Todo pasa por la cola de entrada
  (después de guardar los mensajes) y avisa al panel por SSE.
- **Reparación única** (`unread_repair_v1`): se consideran leídos los mensajes llegados
  por historial y los anteriores a la última respuesta. Resultado: 45.888 → 0.
- En un mensaje propio del historial, el nombre de perfil (el del dueño) ya no
  renombra el chat.

### 19.2 — `/monitoring` → **Seguimiento** (operación del día)

- Período con atajos (Hoy, Ayer, 7 días, 30 días, Este mes) o rango libre, y filtro
  por número. Se actualiza solo cada minuto (si no se está escribiendo en un filtro).
- Indicadores: esperando respuesta, mediana de 1.ª respuesta, % respondido en ≤ 1 h,
  recibidos, chats atendidos y seguimientos de notas vencidos o para hoy.
- **Esperando respuesta**: chats cuyo último mensaje es del contacto, ordenados por
  espera, con tiempo coloreado (≤ 15 min, ≤ 1 h, más), último mensaje, no leídos y
  notas abiertas; enlace directo al chat.
- Seguimientos de notas vencidos y de hoy; mensajes por hora; respuestas por persona
  (panel por usuario y "desde el teléfono"); envíos por usuario; estado de cada número
  (conexión, salud, último entrante, recibidos/enviados hoy) y avisos de números caídos
  o sin mensajes entrantes desde hace horas.

### 19.3 — `/reports` (análisis del período)

- Mismo selector de período y número, más los filtros de envíos (programa, usuario,
  área, tipo). Exportación **CSV** (desempeño por usuario y serie diaria).
- **Atención**: recibidos, chats atendidos, contactos nuevos (primer mensaje en el
  período), mediana/promedio de 1.ª respuesta, % ≤ 1 h, turnos sin respuesta; gráficos
  diarios; **desempeño por usuario** (respuestas, chats, tiempo, notas registradas,
  resueltas y vencidas).
- **Seguimiento con notas** y **envíos** (entregabilidad solo de lo enviado por el
  sistema: lo escrito desde el teléfono no tiene acuse en el gateway), por origen y
  por programa.
- `src/core/followup.ts` (métricas, ~20–50 ms con 108 k mensajes) y
  `src/panel/followup-views.ts` (vistas); gráficos en `public/app.js`
  (`initFollowupCharts`) con la paleta categórica validada (azul/naranja) y modo oscuro.

## 20. Notas y tareas compartidas entre todas las líneas (2026-10-10)

Antes una nota quedaba atada a la ficha `(sesión, chat)`: si la persona escribía a otro
número del sistema, quien la atendía no veía lo registrado. Ahora el detalle es de la
**persona**, no del número.

- **`contacts.phone_key`** (teléfono solo con dígitos, con índice): lo mantienen los
  triggers `contacts_phone_key_ai/au` y se completa una vez al migrar
  (`setupContactPhoneKey`, `src/db/index.ts`).
- **`listNotes`** devuelve las notas de todas las fichas con el mismo teléfono, con la
  línea de origen (`session_name`, `session_phone`). `noteVisibleIn` permite completar
  o fijar una nota de otra línea si la persona también se atiende en una sesión del
  usuario. `/notes` y sus indicadores aplican el mismo alcance.
- **Importantes** (`contact_notes.pinned`): se marcan desde el compositor o con el
  pin de la tarjeta (`PATCH /inbox/notes/:id/pin`, cualquiera del equipo). Van primero
  en la ficha y tienen su indicador y su grupo en `/notes`.
- **Aviso bajo la cabecera del chat**: muestra la nota importante (o la tarea vencida
  o la de hoy) con su autor, cuántas más hay y un botón «Ver notas».
- **Lista de conversaciones**: un indicador con las notas pendientes de la persona
  (ámbar si hay importantes, rojo si hay vencidas). `ConversationDTO.notes`, calculado
  en una sola consulta (`noteCountsFor`).
- Textos de la interfaz: «Notas y tareas», la línea de origen en cada tarjeta, un aviso
  cuando hay notas de otra línea y mensajes de confirmación más claros.
- `followup.ts`: la columna «Notas» del seguimiento también suma las de otras líneas.
- Límite: un chat `@lid` sin número conocido mantiene sus notas propias hasta que
  WhatsApp comparta el número; desde ese momento se unen solas.

## 21. Notas en vivo, papelera, historial, responsables y unificación LID por línea (2026-10-11)

- **En vivo**: cada cambio de una nota publica el evento SSE `note` con las líneas y los
  chats de la persona (sin el texto). El chat abierto recarga sus notas, la lista
  actualiza sus indicadores y `/notes` se refresca solo. `/events` filtra por línea y
  no revela chats de líneas ajenas.
- **Papelera**: eliminar una nota la oculta (`contact_notes.deleted_at/deleted_by`) en
  lugar de borrarla. Aparece la acción «Deshacer» en el aviso, el botón «Papelera» en
  `/notes` y `POST /inbox/notes/:id/restore` (autor o admin). Las notas en la papelera
  no cuentan en indicadores, etiquetas ni seguimiento.
- **Historial** (`contact_note_history`): registra ediciones (con el texto, la fecha y
  las etiquetas anteriores), completar/reabrir, fijar, asignar, eliminar y restaurar.
  Se consulta desde el ícono de reloj de cada tarjeta (`GET /inbox/notes/:id/history`).
- **Responsable** (`contact_notes.assigned_to`): se elige al registrar o editar, y
  puede ser de otra línea. El responsable ve la tarea aunque la persona no esté en su
  línea, recibe el aviso «Te asignaron una tarea» y tiene el filtro «Asignadas a mí»
  en `/notes`. La tarjeta muestra «Para vos» o el nombre del responsable.
- **Guardar un mensaje como nota**: la acción nueva en cada burbuja abre el compositor
  con el mensaje citado y enlazado (`source_message_id`). La tarjeta trae «Ver mensaje»,
  que lleva a esa burbuja.
- **`migrateLidChat` por línea** (`src/core/lid.ts`): antes, al conocerse el número de
  un `@lid`, las consultas ignoraban la sesión. Podía borrar la conversación de otra
  línea, sumarle los no leídos ajenos y apuntar las conversaciones de todas las líneas
  a una sola ficha. Ahora fusiona cada línea por separado dentro de un `SAVEPOINT`.

## 22. Notas de voz permanentes, unión por número local y búsqueda sin acentos (2026-10-11)

- **Las notas de voz ya no se borran a los 30 días.** Se guardaban en `data/media/in/`
  junto con los adjuntos de los chats, y `cleanupMedia` las eliminaba con
  `MEDIA_RETENTION_DAYS`. Ahora van a `data/media/notes/` (`storeNoteAudio`), una
  carpeta excluida de la retención. La limpieza también respeta cualquier archivo que
  use una nota, aunque esté en otra carpeta. No había notas de voz guardadas, así que
  no se perdió nada.
- **Respaldo diario**: incluye `data/media/notes/` (en `notes-media/`), porque esas
  grabaciones no están en la base ni se pueden recuperar de WhatsApp.
- **`phone_key` v2**: aplica la misma regla que `normalizePhone`. Un número local de 8
  dígitos lleva `591` delante y se quita el prefijo `00`. Así «7654 3210» cargado a
  mano une con `59176543210`. La regla tiene versión (`configs.phone_key_version`): al
  cambiarla se recrean los triggers y se recalcula una vez.
- **Búsqueda de notas sin acentos ni mayúsculas**: función SQL `fold()` registrada en
  la conexión. Busca también por responsable y etiqueta, y toma `%` y `_` literales.
  Se descartó FTS5 porque, con el volumen de notas, `LIKE` alcanza y evita triggers.
- **Aviso al cerrar o reasignar con tareas abiertas (sugerencia 4): no se hizo.** El
  panel no tiene acciones de cerrar ni reasignar conversaciones (`/inbox/bulk` solo
  marca como leídas), y el aviso fijado del chat ya cubre ese momento.

## 23. Ficha única de la persona, recordatorios con hora y plantillas de tareas (2026-10-11)

- **Ficha única** (`GET /inbox/:session/:chat/person`, `personLines`): la ficha muestra
  las otras líneas a las que escribió la persona. De cada una indica cuándo fue el
  último mensaje y si fue del contacto o del equipo, el programa y la marca «Sin
  responder» si el último mensaje es del contacto. No muestra el texto de los mensajes.
  Si a esta ficha le falta el nombre, el email, la empresa o el programa y otra línea
  los tiene, se muestran con «según <línea>». No se copian: no hay edición de fichas.
- **Recordatorios con hora** (`contact_notes.due_time`, `reminded_at`):
  - Se puede agregar una hora opcional a la fecha de seguimiento.
  - `startNoteReminderWorker` (`src/core/note-reminders.ts`) revisa cada 30 s y avisa
    una sola vez al responsable, o al autor si no hay responsable.
  - El aviso es un evento SSE **privado** (`private: true`): solo lo recibe esa
    persona, en cualquier página del panel.
  - La tarjeta del recordatorio ofrece «Hecho», «Abrir chat» y posponer 15 min, 1 h o
    hasta mañana a las 9:00 (`POST /inbox/notes/:id/snooze`). Si la pestaña está en
    segundo plano y el usuario dio permiso, también llega una notificación del sistema.
  - Los avisos atrasados más de 12 h (por ejemplo, si el servidor estuvo apagado) no
    saltan: quedan en el resumen del día.
  - Cambiar la fecha o la hora rearma el recordatorio.
- **Resumen del día** (`GET /notes/my-day`): una vez por día y navegador muestra las
  tareas para hoy y las vencidas del usuario (asignadas a él, o propias sin responsable).
- **Plantillas de tareas** (`note_templates`, `src/core/note-templates.ts`):
  - Se gestionan en la columna lateral de `/notes`: nombre, programa opcional y hasta
    15 pasos, cada uno con días desde hoy, hora e «importante».
  - En el chat, el botón junto a «Registrar una nota o tarea» muestra los pasos,
    permite elegir un responsable y crea todas las tareas de una vez
    (`POST /inbox/:session/:chat/notes/template`).
  - Las plantillas del programa del chat se sugieren primero. El historial de cada
    tarea registra de qué plantilla salió.
- **Una sola conexión SSE por página** (`liveSource()`), compartida por el inbox,
  `/notes` y los recordatorios.
- Exportar notas a PDF (sugerencia 9): descartado.

## 24. Anti-Baneo: rediseño, políticas nuevas y seguimiento (2026-10-11)

**Diseño** (`src/panel/anti-ban.ts`, estilos `.ab-*` en `public/app.css`):
- **Indicadores arriba:** líneas por estado, enviados en 24 h, entregabilidad, bloqueos
  y bajas, y lotes en pausa.
- **Cuatro pestañas** (`?tab=`): Monitoreo, Políticas, Lista negra y Bitácora. Antes
  todo estaba en una sola página larga, con una tabla de 10 columnas.
- **Monitoreo:** una tarjeta por línea, de mayor a menor riesgo. Cada una muestra el
  uso del día, de la última hora y de los contactos nuevos contra sus límites; la
  ventana horaria («abierta hasta las 20:00» o «abre en 3 h»); el día de calentamiento;
  la tasa de respuesta a los lotes en 7 días; las cifras de 24 h; un gráfico de barras
  de 7 días con marca de bloqueos; y las acciones. Debajo, los lotes en pausa con su
  motivo y un enlace para revisarlos.
- **Políticas:** el formulario va agrupado por tema, con atajos a cada sección y los
  perfiles como tarjetas con sus cifras clave. La barra de guardar queda fija abajo y
  la columna lateral, con las políticas por línea y las buenas prácticas, queda fija
  arriba.
- **Lista negra:** búsqueda, filtros por origen (bloqueo, baja o manual) y la columna
  «Línea» nueva.
- **Bitácora:** línea de tiempo de cuarentenas automáticas y manuales, pausas de
  lotes, rotaciones, cambios de política y cambios en la lista negra.
- **Página de cada línea:** formulario más tarjeta de estado, y la acción nueva
  «Usar la política global» (`POST /anti-ban/session/:id/clear`).
- Confirmación antes de las acciones delicadas (`data-confirm`, manejador global en
  `app.js`). El aviso `?ok=` vuelve a mostrarse: antes nunca se pasaba al layout.
- En celular: indicadores en dos columnas y sin desplazamiento horizontal.
- `position: sticky` no funcionaba porque `body { overflow-x: hidden }` anula sticky.
  En esta página se usa `overflow-x: clip`.

**Políticas nuevas** (columnas en `anti_ban_policies`, con valores en los tres perfiles):
- `recontact_cooldown_hours`: el lote omite a quien recibió un envío masivo hace menos
  de N horas (72 / 24 / 12).
- `max_unanswered`: el lote omite a quien ya tiene N mensajes nuestros sin responder
  (2 / 3 / 4).
- `block_rate_threshold`: si los bloqueos y bajas superan ese % de lo enviado en 24 h,
  la línea pasa a «En riesgo» y el lote se pausa (2 % / 3 % / 5 %).
- `optout_keywords`: palabras extra de baja (global), sin distinguir mayúsculas ni
  acentos y comparadas como palabra completa.
- Los rangos invertidos (espera o pausa mínima mayor que la máxima) se ordenan al
  guardar.

**Correcciones del motor:**
- **El semáforo contaba los bloqueos de todas las líneas.** `optouts` ahora guarda
  `session_id` (en bloqueos, fallos de entrega y pedidos de baja), y `recomputeHealth`
  cuenta solo los de su línea, incluidas las bajas.
- Las cuarentenas automáticas (por fallos seguidos) quedan en la auditoría y, por lo
  tanto, en la bitácora. Antes solo se registraban las manuales.
- Seguimiento en `src/core/anti-ban-monitor.ts`: `sessionUsage`, `trend7d`,
  `replyRate7d`, `pausedBatches` y `antiBanEvents`.

## 25. Seguimiento, Reportes, Auditoría, Usuarios y Plantillas: rediseño (2026-10-11)

Mismo lenguaje visual que Anti-Baneo: indicadores compactos, pestañas (`?tab=`) y
componentes `.ab-*`. `/audit`, `/users` y `/templates` pasan de `server.ts` al módulo
nuevo `src/panel/admin-views.ts`.

- **Seguimiento (`/monitoring`):** pestañas Pendientes, Actividad y Números. La tabla
  «Esperando respuesta» pasa de 7 a 4 columnas, con botón «Responder»: antes se
  cortaba y escondía los no leídos, las notas y el acceso al chat. Números se muestra
  en tarjetas con salud, actividad y accesos a Anti-baneo y Conexión. Las pestañas
  conservan el período y el número, y la página se sigue actualizando sola.
- **Reportes (`/reports`):** pestañas Atención, Equipo, Notas y tareas, y Envíos.
  - **Comparación con el período anterior** de la misma duración (`previousPeriod`):
    ▲/▼ coloreado según si la variación es buena o mala.
  - **Protección anti-baneo** en Envíos (`protectionStats`): destinatarios omitidos
    por motivo (lista negra, campaña reciente, sin respuesta, sin WhatsApp), lotes
    pausados, bloqueos y bajas del período.
- **Auditoría (`/audit`):**
  - Cada acción tiene su título en español y su detalle legible (línea, persona, lote
    con enlace, motivo). El JSON queda en «Datos técnicos».
  - Filtros por categoría con conteos (Conexiones, Lotes, Anti-baneo, Lista negra,
    Cuentas, Contenido), búsqueda y rango de fechas.
  - Las reconexiones automáticas (`session.ready`, más del 85 % de los registros)
    quedan ocultas salvo que se pidan.
  - Separación por día, repeticiones agrupadas («×5»), «Ver más antiguos» (páginas de
    60) y `/audit/export.csv` con los mismos filtros.
- **Usuarios (`/users`):** búsqueda y filtros (administradores, inactivos, sin línea
  activa, sin autorizar). De cada persona muestra el estado de su línea (conectada,
  esperando QR, desconectada, línea no creada), el último ingreso con aviso si pasaron
  más de 30 días, y su actividad de 30 días (respuestas, chats y notas). Las cuentas
  siguen siendo de solo lectura: se sincronizan desde cronogramas.
- **Plantillas (`/templates`):**
  - Antes solo se podía crear. Ahora se puede editar, duplicar (la copia nace
    inactiva), activar o desactivar y eliminar.
  - Tarjetas con vista previa al estilo WhatsApp: `*negrita*`, `_cursiva_`,
    `~tachado~`, `{{ variables }}` y variantes `{a|b}` resaltadas. Se muestra el número
    de cada plantilla (el `template_id` de las integraciones).
  - Editor fijo a la derecha, con vista previa en vivo, variables detectadas,
    contador de caracteres y aviso anti-baneo si el texto no tiene variantes.
  - **Protección:** no se puede desactivar, eliminar ni cambiar de categoría la única
    plantilla activa de una categoría, porque los envíos de cronogramas la eligen por
    categoría (`resolveTemplate`) y fallarían. Cada acción queda en la auditoría
    (`template.*`).

## 26. Acceso por rol: solo el Super Admin administra (2026-10-12)

- **`ESAM_ADMINS = ['Super Admin']`** (`src/auth/users.ts`). Acceso completo: el Super
  Admin de cronogramas y la cuenta local. El resto, incluido el rol «Administrador»,
  solo usa Conversaciones y Notas y tareas. `esamPuede` ya no habilita secciones
  administrativas por área de cronogramas.
- **Menú lateral:** quien no es Super Admin ve solo «Conversaciones» y «Notas y
  tareas». Su conexión (QR) pasa al menú de usuario como «Mi conexión de WhatsApp»,
  y mientras su número no esté conectado se lo sigue llevando a Conexión.
- La etiqueta de rol en la barra superior muestra «Super Admin», el área de
  cronogramas o «Administrador local».
- Sin cambios, ya era así: cada usuario ve solo las conversaciones de su número, y
  las notas y tareas se comparten entre líneas cuando el contacto tiene el mismo
  número, con autor y línea de origen.
- **Cronogramas** (otro repositorio): la contraseña ahora se sincroniza también
  desde el cambio en el perfil estándar (`PasswordController`) y desde la
  recuperación por correo (`NewPasswordController`), con
  `SeguimientoEsamClient::syncPassword`.

## 27. Notificaciones y derivaciones con seguimiento (2026-10-12)

- **Notificaciones** (`notifications`, `src/core/notifications.ts`): campana en la
  barra superior para todos los usuarios, con contador, lista y «Marcar todas como
  leídas». Se guardan en la base y llegan en vivo por SSE privado (`notification`),
  con un aviso con «Ver» y, si la pestaña está en segundo plano, una notificación
  del sistema. Al abrir la nota, sus avisos quedan leídos.
- **Quién recibe qué** (`announce` en `src/panel/inbox.ts`):
  - **Super Admin:** cada nota o tarea que registra otra persona, cada derivación,
    cada contacto confirmado y cada derivación resuelta.
  - **Responsable:** «X te derivó a <contacto>», con el número y el detalle.
  - **Quien derivó** (y el autor de la nota): cuando el responsable se comunica y
    cuando se resuelve.
- **Derivación** (antes «Responsable», ahora «Derivar a», con el área de cada
  persona). En `contact_notes` se guarda quién derivó y cuándo (`assigned_by`,
  `assigned_at`), cuándo la vio el responsable (`seen_at`) y la confirmación de
  contacto con su resultado (`contacted_at`, `contacted_by`, `contact_result`).
  Reasignar reinicia la vista y el contacto. Todo queda en el historial
  (`seen`, `contacted`).
- **Tarjeta de la nota:** bloque «X derivó a Y · Área», con los pasos «Vista»,
  «Se comunicó» (con el resultado) y «Resuelta». El responsable tiene «Escribirle
  desde mi línea» (abre el chat con ese número en su propia línea), «Llamar» y
  «Ya me comuniqué», que exige contar el resultado.
- **Notas y tareas:** pestaña «Derivaciones» agrupada en «Sin ver», «Vistas, sin
  confirmar contacto» y «Con contacto confirmado», con un resumen de los tres
  conteos. `?nota=ID` abre la nota de una notificación. Lo derivado que el
  responsable ve en su lista queda marcado como visto.
- **El Super Admin supervisa todas las notas** (`noteScope`), aunque tenga número
  propio. Las conversaciones siguen siendo solo las de su número.

## 28. Programa y nombre completo en todas las líneas, reconexión y autores en grupos (2026-10-12)

- **Programa y nombre completo por persona** (`person_programs`, `src/core/person.ts`):
  - Se guardan por número (`phone_key`), no por línea, así que los ve cualquier
    usuario que atienda a esa persona desde cualquier número. Admite varios
    programas por persona.
  - Se cargan en cada envío desde cronogramas (`tagConversation`). La primera vez,
    se recuperan de los lotes ya enviados (`batches.meta.programa` +
    `batch_items.contact_name`).
  - Antes el programa quedaba solo en la conversación de la línea que envió, y el
    nombre de WhatsApp pisaba al completo.
- **En el chat:** la lista muestra el programa arriba del nombre, y el nombre completo
  pasa a ser el principal. La cabecera lleva el o los programas como etiqueta y el
  nombre de WhatsApp si difiere. La ficha muestra el nombre completo y todos los
  programas. La búsqueda también encuentra por nombre completo y por programa.
- **Reconexión al arrancar:** `AUTO_START_SESSIONS` pasa a `true` por defecto (código
  y `.env.example`). Con `false`, tras cada reinicio del servicio las líneas no se
  reconectaban hasta que alguien entraba al panel, y se perdía lo recibido mientras
  tanto. **En un `.env` existente hay que cambiarlo a mano.**
- **Autor de los mensajes de grupo:**
  - El historial de WhatsApp trae el autor en `participant` del mensaje, no en la
    key. Antes se descartaba: 76 mil mensajes de grupo quedaron sin autor. Ahora se
    toma de ambos lugares.
  - Al volver a recibir un mensaje ya guardado sin autor (por la sincronización de
    ese chat), se completan su número y su nombre (`backfillSender`).
  - Si el historial no trae el nombre, se usa el último nombre que esa persona usó
    en otro mensaje, su nombre completo de cronogramas o el de su ficha
    (`fillGroupSenderNames`).
- **Orden en pantalla** (lista, cabecera del chat y ficha): primero el o los
  programas, debajo el nombre completo («Apellidos, Nombres», como lo manda
  cronogramas) y debajo el número de WhatsApp con formato (`+591 7XXX XXXX`). En la
  ficha los programas no se repiten.
- Verificado en cronogramas: `/admin/programas/{id}/show` (WhatsApp masivo por
  módulo, `enviarAcademico`), `/admin/programas/{id}/whatsapp` (participantes) y
  `/admin/contable/cuotas-vencidas` y `cuotas-proximas` (`enviarContable` y el
  recordatorio de cobranza) envían el nombre como «Apellidos, Nombres» y el
  programa. Los enlaces «Abrir WhatsApp» (`wa.me`) no pasan por baileys y no lo
  registran.

## 29. Enlace desde Notas, fotos de perfil y envíos masivos que no avanzaban (2026-10-13)

- **Notas › contacto abre la conversación:** antes solo se buscaba el `chat_id` exacto
  entre las 300 conversaciones cargadas y, si no aparecía, quedaba la lista. Ahora:
  - se busca tolerando otro formato del número;
  - si no está en la lista, se consulta `GET /inbox/find?chat=` (dentro del alcance
    del usuario, también la misma persona en otra línea por `phone_key`);
  - si tampoco existe, se abre un chat nuevo en la línea del usuario para escribirle.
- **Foto de perfil de cada contacto** (lista, cabecera del chat y ficha):
  - `GET /inbox/avatar/:contactId` respeta el alcance del usuario. Si esa línea no
    tiene la foto, usa la de la misma persona en otra línea.
  - Las fotos se guardan en `storage/avatars` (`storeAvatar`), fuera de la
    limpieza de 30 días.
  - Al abrir un chat sin foto se pide a WhatsApp (`POST /inbox/:session/:chat/avatar`
    → `ensureAvatar`) y llega por SSE. Sin foto, o si falla, se ven las iniciales.
- **Envíos masivos «en espera»** (cronogramas `/admin/programas/{id}/whatsapp`,
  `/show`, cuotas):
  - **Calentamiento por antigüedad real:** una línea recién vinculada en el VPS se
    trataba como número nuevo (día 1: 3–5 min entre mensajes). Ahora la antigüedad
    se toma del mensaje más antiguo de esa línea (`oldestMessageMs`). Un reinicio
    manual o un bloqueo siguen mandando.
  - **Motivo visible:** el lote guarda en `meta.waiting` por qué espera y hasta
    cuándo (límite por hora, ritmo anti-baneo ≥ 20 s, fuera del horario).
    `GET /api/v1/batches/:id` devuelve `waiting_reason`, `waiting_until` y
    `paused_reason`, y el modal de cronogramas los muestra.
  - **Línea no conectada → 422 inmediato:** antes el lote se creaba y quedaba sin
    salir. Se exceptúan `dry_run` y `scheduled_at`. Sin `account`, se usa la
    principal si está conectada o, si no, la primera conectada.

## 30. Nombre de contactos que no llegaron desde cronogramas (2026-10-13)

- **Registrar nombre** en la ficha del contacto (botón «Registrar nombre», o el lápiz
  para corregirlo). Se guarda por número en `person_names` y lo ven todos los
  usuarios que atiendan a esa persona, desde cualquier línea: lista, cabecera,
  ficha, búsqueda y `/notes`. La ficha indica quién lo registró. «Quitar» lo borra.
- `PUT /inbox/:session/:chat/name` avisa por SSE a las conversaciones de ese
  número para que se refresquen en vivo.
- **Si cronogramas también manda un nombre**, gana el más reciente: un envío
  posterior corrige al manual, y una corrección manual posterior se mantiene hasta
  el próximo envío. El nombre de WhatsApp se sigue mostrando debajo.
- **Corrección:** al cambiar de chat, la ficha conservaba la cabecera (nombre,
  número, foto) del chat anterior. Solo se refrescaban las notas. Ahora se redibuja
  entera.

## 31. Equipo: compañeros del sistema en las conversaciones (2026-10-13)

- **Nombre y área del compañero:** si el número de un chat es de un usuario del
  sistema, se muestra su nombre y su área (Académico, Contabilidad, Marketing…) en
  la lista, la cabecera y la ficha («Usuario del sistema · Área»), en lugar del
  nombre de WhatsApp. El número sale de `users.esam_numero` (cronogramas) o de la
  línea que tiene vinculada; el registrado en cronogramas tiene prioridad
  (`src/core/team.ts`, caché de 60 s).
- **Pestaña «Equipo»** en Conversaciones, junto a Números y Grupos: lista a todos los
  compañeros con número, siempre visible. Los que tienen mensajes sin leer van
  arriba, después por actividad. Un clic abre la conversación existente o inicia
  una nueva desde la propia línea. Un punto verde indica que su línea está
  conectada. `GET /inbox/team`.
- Un usuario local no hereda la línea de un usuario de cronogramas con el mismo id.

## 32. Conexión que se explica sola, cifrado, envíos masivos 6–7 s y pipeline de notas (2026-10-14)

- **El QR no aparecía tras un bloqueo:** cuando WhatsApp cerraba la sesión (401,
  típico tras envíos masivos) o restringía el número (403), las credenciales
  viejas quedaban. «Mostrar QR» reconectaba con ellas, WhatsApp las rechazaba otra
  vez y el QR nunca llegaba. Ahora se borran al instante. Si no se pueden borrar
  (permisos), se avisa con el comando para arreglarlo.
- **Motivo de cada desconexión** (`explainDisconnect`): cerrada o dada de baja,
  número restringido, otra conexión con el mismo vínculo (440, ya no se reconecta
  sola en bucle), claves dañadas (500, se regeneran) o red. Cada uno con qué hacer.
  Se guarda en `sessions.disconnect_info`.
- **Conexión › Diagnóstico** (visible también para usuarios no Super Admin, que
  ahora tienen «Conexión» en el menú):
  - último cierre explicado;
  - credenciales que el servicio no puede escribir (causa de «Esperando el
    mensaje»);
  - lotes pausados por el anti-baneo y el ritmo y los límites de la línea.
  - Acciones: **Reparar cifrado** (regenera las claves por contacto sin
    desvincular) y **Empezar de cero** (borra credenciales y pide QR nuevo).
  - Si el QR no sale, la caja explica por qué mientras sigue reintentando.
- **«Esperando el mensaje»:**
  - los reintentos de descifrado ahora también se atienden después de un
    reinicio (texto enviado guardado en la BD, `lookupSent`);
  - un error al guardar credenciales se registra como error visible.
- **Envíos masivos 6–7 s:**
  - nuevo perfil anti-baneo **Masivo institucional** (1500/día, 400/h, 6–7 s,
    sin calentamiento, pausas de 2–4 min cada 60, freno por baja entrega o
    bloqueos), aplicado una vez a todas las políticas;
  - el intervalo se cuenta desde el envío anterior, así que el «escribiendo…» y
    la verificación quedan dentro;
  - la espera entre lotes de distintos programas baja de 10 a 1 minuto;
  - `GET /api/v1/batches/:id` devuelve `anti_ban` (ritmo, uso por hora y día,
    contactos nuevos, horario, tiempo estimado y línea conectada) y cronogramas lo
    muestra en la ventana de progreso.
- **Leer el enlace de un grupo** (`/api/v1/groups/resolve`) usa la línea del
  usuario o cualquier línea conectada. Antes exigía la principal arrancada: «La
  sesión no está arrancada».
- **Fotos en grupos:** cada mensaje de grupo muestra la foto de perfil de quien lo
  escribió (`GET /inbox/participant-avatar/:session/:jid`; se pide a WhatsApp una
  vez y se guarda).
- **Notas y tareas:**
  - cada usuario ve en `/notes` solo lo suyo (lo que escribió, lo que derivó y lo
    que le derivaron); el Super Admin ve todo;
  - nueva vista **Pipeline** con cuatro etapas: Por hacer, En gestión,
    Contactado (pide el resultado) y Resuelta (últimos 14 días). Las notas se
    arrastran o se mueven con botones;
  - `POST /inbox/notes/:id/stage`, columna `contact_notes.pipeline_stage` y evento
    `stage` en el historial.
- Modo claro: el texto que se escribe en el chat ya no queda blanco.

## 33. Conversaciones adaptables, PDF con vista previa, citas con autor y número oculto (2026-10-15)

- **Diseño adaptable:**
  - pantallas anchas con tres columnas (340/300 px según el ancho);
  - portátil chico o tablet: la ficha se abre como panel encima del chat, con
    fondo oscurecido y botón de cerrar;
  - celular: lista y chat de a uno, con «volver», chat a pantalla completa (sin
    el título de página) y compositor visible respetando el borde inferior del
    teléfono.
  - Antes, por debajo de 992 px la lista y el chat se apilaban y la ficha (con
    las notas) no se podía abrir.
- **PDF con vista previa:** la primera página se muestra como miniatura, con la
  cantidad de páginas y la descarga. Se dibuja en el navegador con pdf.js
  (`public/vendor/pdfjs`, servido por el panel, sin CDN), al verse en pantalla y
  una sola vez.
- **Citas con autor:** «Respondiendo a …» muestra siempre a quién se responde:
  - el agente («Tú») si el mensaje citado es nuestro;
  - si es de un participante, su nombre o número, también cuando el original no
    está guardado. Se guarda el autor y el texto que informa WhatsApp
    (`messages.reply_to_sender`, `reply_to_body`).
  - La vista previa al responder también dice a quién.
- **Número oculto por WhatsApp (@lid):** cuando WhatsApp no comparte el número,
  se muestra «Contacto con número oculto» en lugar del código interno. Se guarda
  el nombre de perfil que llega en los contactos y se puede registrar un nombre
  desde la ficha (la clave es el identificador del chat).
- **Ficha del contacto:** se quitó «También escribió a»; quedan los datos y las
  notas y tareas del equipo.
- **Avatares:** las iniciales ignoran emojis y símbolos (ya no aparecen «��»).
- **Notas › Pipeline:** las cuatro columnas usan todo el ancho (el panel de
  etiquetas se oculta en esa vista) y ya no quedan detrás de él.

## 34. Envíos masivos solo desde la propia línea y con confirmación (incidente 15/10/2026)

- **Qué pasó:** a las 08:00 la tarea automática de cronogramas
  (`whatsapp:recordatorios`, días 1, 5, 10 y 15) creó recordatorios de cobranza de
  todos los programas, concluidos incluidos, sin indicar desde qué cuenta salían.
  Baileys usaba la principal y, si no estaba conectada, la primera línea
  conectada de cualquier usuario. Además, si la cuenta pedida no tenía línea,
  también caía a otra.
- **Línea estricta** (`sessionFor`): con `account`, solo la línea de ese usuario;
  si no tiene, 422 con explicación. Sin `account`, solo la principal. Nunca se
  usa la línea de otro usuario.
- **Confirmación previa:** con `require_confirmation` el lote queda
  `awaiting_confirmation` y no se envía. El dueño de la línea y el Super Admin
  reciben una notificación (campana) que lleva a `/batches/confirm/:grupo`,
  donde confirman o cancelan todos los lotes de la programación juntos. Sin
  confirmación se cancelan solos a las 20 h. Endpoint para avisar una sola vez:
  `POST /api/v1/batches/confirm-group/:grupo/notify` (`src/core/batch-confirm.ts`).
- **Lotes:** aviso de programaciones pendientes y botón **Detener todos los envíos
  masivos**.
- **Una sola vez al actualizar:** se cancelan todos los lotes en curso,
  programados o en pausa de la versión anterior (`batches_stop_v1`); al volver a
  vincular no se reanuda ningún envío viejo.
- **cronogramas:**
  - la tarea automática queda **apagada** hasta que el Super Admin la active en
    Ajustes › WhatsApp, eligiendo la **única cuenta** desde cuya línea sale, los
    días y la hora;
  - corre a las 07:30 y solo prepara lotes de programas En desarrollo e
    Inscripciones de la gestión actual, que esperan confirmación.

## 35. Baileys 7.0.0-rc14 («Esperando el mensaje») (2026-10-15)

- Se pasa de `@whiskeysockets/baileys` 6.7.24 (rama legacy) a **7.0.0-rc14**, con
  el manejo nuevo de identificadores LID y de reintentos de descifrado (la causa
  conocida de «Esperando el mensaje» en WhatsApp Web y el celular).
- Adaptaciones:
  - el evento `chats.phoneNumberShare` se reemplaza por `lid-mapping.update`;
  - el número real se toma de `remoteJidAlt` / `participantAlt`;
  - el historial trae `lidPnMappings`;
  - para un LID sin número se consulta el mapeo propio de Baileys
    (`signalRepository.lidMapping.getPNForLID`).
- Verificado: compila, todas las pruebas pasan y el handshake con WhatsApp entrega
  el QR. Requiere Node ≥ 20 y **`npm install` en el servidor** antes de
  compilar.
- Después de actualizar conviene vincular de nuevo cada línea («Empezar de cero»
  en Conexión) para que arranque con claves nuevas.

## 36. Envíos desde un número ajeno, «Lote #null» y detalle de lotes (2026-10-15)

- **Número ajeno:** en cronogramas, `SenderAccount` enviaba «sin cuenta» (por la
  línea principal, que es el número de otra persona) cuando el usuario tenía
  número pero no estaba autorizado, o era administrador sin número. Ahora
  siempre se usa la cuenta propia; sin número o sin autorización, no se envía y
  se explica por qué.
- **Verificación en baileys:** si en la línea del usuario quedó escaneado otro
  teléfono (el vinculado no coincide con el suyo), el envío se rechaza (422).
- **«Encolados… Lote #null»:** pasaba cuando todos los mensajes ya se habían
  enviado ese día (misma referencia). Baileys no creaba el lote pero respondía
  201. Ahora responde **409** explicando desde qué lote y línea salieron.
  cronogramas pregunta si se quiere **reenviar igual desde tu línea**
  (`allow_resend`). Los controladores devuelven 409/422 con el mensaje (`errorEsam`).
- **Lotes con quién y desde dónde:**
  - cada tarjeta muestra la línea que envía (número y dueño) y quién lo pidió;
  - el detalle tiene la ficha completa: línea y estado, solicitante, origen,
    programa, tipo, fechas y confirmación;
  - por destinatario: número, mensaje, estado, hora de envío y detalle.
  - cronogramas manda `solicitado_por` en cada envío.

## 37. Notas: arrastre real en el Pipeline y rediseño de la vista (2026-10-16)

- **Arrastre y soltar en el Pipeline** (`public/app.js`): se reemplaza el arrastre
  nativo HTML5 (que no iniciaba en varios navegadores y en táctil) por
  **SortableJS 1.15.2**, ya vendorizado en
  `public/assets/libs/sortablejs/Sortable.min.js` y cargado **solo** la primera
  vez que se abre el tablero (inyección desde `initNotes()`).
  - `forceFallback` + puntero: funciona con mouse y táctil (retardo de 180 ms en
    táctil para poder scrollear antes de arrastrar) y no depende de `dragstart`.
  - Se arrastra desde cualquier punto de la tarjeta; **no** desde links ni
    botones (`filter: 'a, button, input'` con `preventOnFilter: false`, así el
    link de contacto sigue navegando). Aparece un ícono de agarre al pasar el
    cursor.
  - Las notas sin permiso quedan `is-locked` y no se pueden arrastrar; siguen
    disponibles los botones de etapa.
  - Al soltar se reutiliza `moveNote()`: mismo `POST /inbox/notes/:id/stage`,
    mismo diálogo «Contactado» y mismo toast. Si se cancela o falla la API,
    `renderBoard()` devuelve la tarjeta a su etapa; si no cambió de etapa se
    redibuja igual para respetar el orden del servidor.
  - El refresco en vivo (SSE `note`) se pausa mientras hay un arrastre y se
    retoma al soltar (con tope de ~9 s), para que no se corte a mitad de drag.
  - Las instancias se destruyen en cada `renderBoard()` (token de render) y si
    Sortable no llegara a cargar sigue funcionando el respaldo nativo anterior.
- **Rediseño visual de `/notes`** (`public/app.css`, solo clases `np-*` / `pl-*`,
  con tokens `--nk-*`, en claro y oscuro; no se toca `NoteKit`):
  - indicadores de estado con barra de acento, tinte y estados hover/focus;
  - barra de herramientas: buscador, orden, filtros como píldoras y papelera;
  - títulos de grupo con filete y contador; tarjetas con elevación al hover;
  - barra lateral: etiquetas con contadores, plantillas y tips destacados;
  - Pipeline: control Lista/Pipeline segmentado, columnas de igual altura con
    cintillo de color por etapa, columna destino resaltada, estados de arrastre
    (clon flotante, hueco punteado, tarjeta elevada) y estado vacío con ícono;
  - diálogo «¿Cómo fue la comunicación?» pulido, responsive móvil (búsqueda a
    ancho completo, columnas con scroll-snap) y `prefers-reduced-motion`.
- **Sin cambios de backend**: mismos ids, endpoints, permisos y flujos.
- **Verificación:** `npm run typecheck`, `node --check public/app.js` y pruebas
  en Chrome headless con un mock estático de la vista: capturas en claro,
  oscuro y móvil, simulación del arrastre (confirma `onEnd → moveNote(id, etapa)`
  con la tarjeta en la columna destino y las clases de arrastre) y comprobación
  de que el link de contacto **no** inicia arrastre.

---

## 38. Pipeline: modal «Contactado» con fondo y etapa que sigue a la columna

Dos correcciones sobre el tablero del Pipeline (`public/app.js`, `public/app.css`),
sin tocar backend.

- **Diálogo «¿Cómo fue la comunicación?» sin fondo.** El modal se monta en
  `<body>`, fuera de `.notes-page`, pero sus reglas usaban los tokens `--nk-*`,
  que solo existen dentro de esa página: al no resolver, el panel salía
  transparente (solo texto flotando sobre la capa oscura). Ahora usa los tokens
  globales `--esam-*` (definidos en `:root` y redefinidos en el modo oscuro), por
  lo que respeta claro/oscuro. Se añadieron además fondos diferenciados para la
  capa y la caja de texto según el tema. (También se corrigió un `*/` que, dentro
  del comentario explicativo, cerraba el bloque CSS antes de tiempo.)
- **La tarjeta no quedaba en la columna soltada.** `stageOf()` calculaba la etapa
  ignorando la marca `pipeline_stage` que guarda el servidor y adivinando por
  «asignada y vista ⇒ En gestión». Resultado: al mover una nota a «Por hacer» (o
  a cualquier etapa cuyo valor no fuera `doing`) la tarjeta volvía a «En
  gestión»/etapa anterior tras refrescar. Ahora la etapa la define lo que guardó
  el servidor (`pipeline_stage`, más `contacted_at`/`done_at` para las etapas
  Contactado y Resuelta); solo las notas antiguas sin etapa guardada se infieren
  como antes. Además `moveNote()` aplica de inmediato la nota devuelta por la
  API y redibuja el tablero.
- **Verificación:** `node --check public/app.js`, balance de llaves del CSS y
  una batería de 72 transiciones de etapa (6 perfiles de nota × de → a) que
  compara `stageOf()` real contra el espejo de `setNoteStage()` del servidor:
  todas quedan en la columna soltada (con la lógica anterior, la nota derivada
  vista movida a «Por hacer» caía en «En gestión»). El modal se comprobó en
  Chrome headless con el CSS real, en claro y oscuro.

---

## 39. Notas por área, columnas con desplazamiento y fotos de miembros (2026-10-17)

- **Notas › Áreas:** barra de áreas (Todas, Académico, Contabilidad, Marketing,
  Administración, Consulta, Sin área) con su cantidad, que filtra la lista y el
  pipeline.
  - Cada nota pertenece al área de su responsable (si está derivada) o de quien
    la registró (`author_area`).
  - Las tarjetas muestran su área cuando se ven todas, y se recuerda el área
    elegida.
- **Pipeline:** cada columna tiene su propio desplazamiento vertical cuando hay
  muchas notas (alto máximo según la pantalla) y el encabezado queda fijo.
  Compatible con el arrastre SortableJS de la sección 37.
- **Ficha del grupo:** la lista de miembros muestra la foto de perfil de cada uno
  (se pide al verse en pantalla; sin foto, las iniciales).

---

## 40. Vista previa de YouTube y audio continuo entre conversaciones (2026-10-18)

- **Enlaces de YouTube en el chat:** al escribir un enlace de YouTube
  (`youtube.com/watch?v=`, `youtu.be`, `/shorts`, `/live`, `/embed`) el mensaje
  muestra una tarjeta con la miniatura, el título y el autor del video.
  - El título/autor salen de `GET /inbox/youtube/:id` (`src/panel/inbox.ts`), que
    consulta el oEmbed público de YouTube con caché de 6 h y timeout de 5 s. Solo
    se acepta el **id** del video (validado), nunca una URL arbitraria.
  - Si YouTube no responde (o el servidor aún no tiene la ruta), la tarjeta queda
    con la miniatura y el rótulo genérico: nunca rompe el hilo.
  - Al pulsarla, el video se reproduce en una ventana dentro del panel
    (`youtube-nocookie`) y el enlace sigue abriendo YouTube en otra pestaña.
- **Audio continuo (como WhatsApp):** las notas de voz ya no usan el `<audio>`
  nativo dentro del hilo, sino controles propios enlazados a un **único**
  reproductor que vive fuera del hilo (`public/app.js`, sección «Reproductor de
  audio persistente»).
  - Al cambiar de conversación el hilo se redibuja pero el sonido continúa; al
    volver al chat original los controles muestran el estado real.
  - Barra flotante (solo cuando el audio pertenece a otra conversación) para
    pausar/reanudar, ver el avance y **volver al mensaje** de voz.
  - Si el archivo falla, se reemplaza por el aviso de «Adjunto no disponible» con
    su botón de reintento, igual que el resto de los medios.

---

## 41. Aviso de mensaje nuevo: sonido y tarjeta inferior derecha (2026-10-18)

- **Sonido y aviso:** al entrar un mensaje (`message` con `direction: 'in'` por SSE)
  suena un «pop» breve y aparece una **tarjeta abajo a la derecha** con el avatar,
  el nombre del contacto y el texto (o el tipo: foto, video, nota de voz,
  documento, sticker), en cualquier página del panel con SSE activo
  (`public/app.js`, «Aviso de mensaje nuevo» + `initMessageAlerts()`).
  - El sonido se genera con **Web Audio** (dos notas), sin archivos nuevos; se
    habilita con el primer gesto del usuario (política de autoplay) y se limita a
    **un sonido cada 2,5 s**.
  - Al pulsar la tarjeta se abre la conversación **sin recargar** si el inbox está
    a la vista; si no, se navega a `/conversations/<chatId>`.
- **Comportamiento tipo WhatsApp:** se silencia si el chat ya está abierto **y** la
  ventana está a la vista y con foco (el mensaje se ve en el hilo); si la pestaña
  está oculta o en segundo plano, siempre avisa.
- **Ráfagas:** más de 5 mensajes en 3 s (p. ej. cientos de mensajes offline al
  reconectar) se agrupan en un único aviso «N mensajes nuevos» para no inundar la
  pantalla; se muestran como máximo 3 tarjetas a la vez y se autodescartan a los 8 s.
- El **historial** que llega por «Sincronizar historial» (`messaging-history.set`)
  refresca el hilo pero **no** suena ni avisa: se marca `history: true` en el evento
  (`src/baileys/manager.ts`).
- La tarjeta comparte el contenedor de la esquina inferior derecha con los
  recordatorios (`#alert-stack`), así no se solapan.

---

## 42. Reacciones con autor, más emojis y foto al abrir desde un grupo (2026-10-18)

- **Quién reaccionó:** al pulsar una reacción en la burbuja se abre un globito con
  el emoji y **el nombre de cada persona** que reaccionó (tipo WhatsApp). Si varias
  personas pusieron el mismo emoji, la reacción muestra el número (`🙏 2`).
  - El servidor resuelve el autor (`users.name` para agentes, el nombre de la ficha
    o el registrado a mano para contactos, y el número si no hay nombre) y lo manda
    en cada reacción (`src/core/conversations.ts`).
  - En **grupos** ya se distingue a cada participante: antes toda reacción quedaba
    guardada con el JID del grupo y no se sabía quién la puso
    (`handleReaction` usa ahora el `senderJid` del participante, `src/baileys/manager.ts`).
- **Más emojis:** el selector de reacciones tiene los rápidos + un botón **«+»** que
  abre un catálogo amplio (más de 200, en tres tandas: caras, corazones/objetos y
  gestos), y el selector del compositor usa ese mismo catálogo con desplazamiento
  (`EMOJI_GROUPS`/`REACTION_EMOJIS` en `public/app.js`, estilos en `public/app.css`).
- **Foto del contacto al abrir desde un grupo:** al pulsar un miembro del grupo se
  abre su conversación y ahora la cabecera y la ficha piden la foto del contacto a
  WhatsApp (una sola vez) si todavía no estaba guardada, en lugar de mostrar solo las
  iniciales (`chatPhoto()` en `public/app.js`).

---

## 43. Reacciones con autor y número, formato de WhatsApp, stickers y burbujas (2026-10-18)

- **Quién reaccionó (nombre y número):** al pulsar una reacción se abre un globito
  con fondo (nombre + número de WhatsApp de cada persona). El servidor resuelve el
  autor con `users.name` (agentes), el nombre de la ficha, el nombre registrado a
  mano o su número (`src/core/conversations.ts`: `reactionActor`).
  - Si el dato no alcanza, el panel deriva el número del JID; de último recurso
    muestra «Participante».
  - En grupos, las reacciones viejas (guardadas antes de hoy) quedaron con el JID
    del grupo porque WhatsApp solo informa quién reacciona en vivo: no se puede
    saber quién fue. Al reenviar WhatsApp esa reacción (p. ej. al sincronizar
    historial) se guarda con su autor y se **borra la vieja** para no contarla dos
    veces (`handleReaction`, `src/baileys/manager.ts`).
- **Formato de WhatsApp en el chat:** `*negrita*`, `_cursiva_`, `~tachado~` y
  ```monospace``` se muestran con su formato en la burbuja, la cita y la vista
  previa de la respuesta (`waFormatHtml`/`waRichHtml` en `public/app.js`). Respeta
  los usos normales de esos signos («2 * 3 = 6», `usuario_1`, `a*b*c`).
- **Estructura de los mensajes como WhatsApp:** el nombre de quien escribe va
  **dentro** de la burbuja (en grupos), las imágenes y videos van pegados al borde
  de la burbuja y los **stickers** se muestran sueltos (sin caja) con la hora
  superpuesta (`has-media` / `has-sticker` en `public/app.js` + `public/app.css`).
- **Stickers que no se veían:** al abrir un chat se bajan en segundo plano los
  stickers pendientes (son chicos), así se ven solos sin pulsar «Descargar»
  (`prefetchStickers` en `src/baileys/manager.ts`, llamado desde la ruta de
  mensajes). Además, un sticker que llega como documento WebP se reconoce como
  sticker (`src/baileys/session.ts`).

---

## 44. Pruebas automatizadas y avisos de caída de línea (2026-10-18)

Primer bloque de la segunda etapa de mejoras (`MEJORAS_2.md`, ítems **A1 + A2**):
red de seguridad para no romper lo que ya funciona y aviso al equipo cuando una
línea se cae.

- **Pruebas automatizadas (`npm test`):** se estrena el runner nativo `node:test`
  (sin dependencias nuevas) sobre `test/`:

  ```
  npm test          # 74 pruebas en 23 grupos
  ```

  - Corren con `tsx` contra el código fuente (`node --import tsx --test
    "test/*.test.ts"`), así que **no** hace falta compilar antes.
  - Cada archivo abre una **base temporal** (`test/helpers/temp-env.ts` crea un
    directorio en el temporal del sistema, fija `DB_PATH`/`STORAGE_DIR`/`BACKUP_DIR`
    y aplica `migrate()`): las pruebas **nunca** tocan `data/` real. `dotenv` no
    sobreescribe variables ya definidas, así que un `.env` de producción no las
    desvía.
  - Cubierto: normalización de teléfonos y JIDs (`phone.ts`), ritmo anti-baneo y
    ventana horaria (`pacing.ts`), importación de CSV (`parseCsv` +
    `importCsvToBatch`: BOM, comillas, filas sin teléfono), bajas y bloqueos
    (`optout.ts`), `phone_key`/personas (`person.ts`) y los avisos de la campana
    (`notifications.ts`, incluida la lógica nueva de A2).
  - `npm run typecheck` ahora también revisa las pruebas (`tsconfig.test.json`);
    `npm run build` sigue compilando solo `src/` (las pruebas no van a `dist/`).
  - Pendiente para una próxima pasada: `ftsQuery` (hoy privado en
    `conversations.ts`) y `waFormatHtml` (vive dentro del IIFE de `public/app.js`,
    sin módulo propio); las dos quedaron verificadas a mano.

- **Aviso de caída de línea en la campana:** cuando una sesión se desconecta, el
  panel avisa al **dueño de la línea** y al **Super Admin** (`session_down` en
  `src/core/notifications.ts`, campanita con ícono propio en rojo):
  - Las caídas **graves** (`logged_out`, `banned`, `replaced`, `bad_session`) avisan
    al instante. Las que WhatsApp suele resolver solo (`network`, `restart`) esperan
    `SESSION_DOWN_ALERT_MINUTES` (3 por defecto) y, si la línea reconectó antes, **no
    avisan** (`armSessionDownAlert` en `src/baileys/manager.ts`).
  - **No se repite** el aviso mientras el anterior siga sin leer, y el control es
    **por línea**: dos números caídos generan dos avisos (columna nueva
    `notifications.session_id` en `src/db/index.ts`).
  - El aviso enlaza a **Configuración → Conexión** para volver a vincular o
    reintentar.

---

## 45. Rotación de logs, `/healthz` y mantenimiento de la base (2026-10-18)

Segundo bloque de la segunda etapa (`MEJORAS_2.md`, ítems **A3 + A4**): que el
servicio se pueda monitorear solo y que nada crezca sin límite.

- **`/healthz` (estado del proceso):** devuelve JSON con versión/arranque, líneas
  por estado, tamaño de la base y del WAL, tamaño del log más grande, cola de
  webhooks (pendientes y descartados), memoria, tiempo encendido y una lista de
  `warnings` (ninguna línea conectada, log grande, WAL grande, compilación sin
  aplicar, webhooks descartados).
  - Disponible en el **panel** (`http://127.0.0.1:8030/healthz`) y en el
    **gateway** (`:2785/health` y `:2785/healthz`, sin API key).
  - Es una ruta **pública a propósito** y no expone rutas de archivos ni datos de
    conversaciones: solo tamaños y contadores (`src/core/system-health.ts`, una
    sola fuente para las dos rutas).
  - `ok` responde por la vida del proceso, no por la salud de las líneas: un
    gestor de procesos no debe reiniciar un servicio que funciona solo porque
    WhatsApp se desconectó. Lo que hay que mirar va en `warnings`.
  - El `/health` del gateway conserva sus claves anteriores (`runtime`, `backup`,
    `sessions`), así que `scripts/restart.cjs` sigue funcionando igual.

- **Rotación de logs:** `npm run logs:rotate` (`scripts/rotate-logs.cjs`) renombra
  `x.log` → `x.log.1` cuando supera `LOG_MAX_MB` (10 por defecto) y conserva
  `LOG_KEEP` copias (5). Los lanzadores la corren **al arrancar**, antes de abrir
  el log: en Windows no se puede renombrar un archivo que otro proceso mantiene
  abierto (se verificó), así que la rotación ocurre cuando todavía nadie lo abrió
  (`start-baileys.bat`, `scripts/autostart.ps1` y `scripts/restart.cjs`).
  - Con **pm2** los logs los maneja pm2: queda documentado en `ecosystem.config.cjs`
    (`pm2 install pm2-logrotate` + `max_size`/`retain`).
  - Si el log igual crece, `/healthz` lo delata (`logs.overLimit` + warning).

- **Mantenimiento de la base (antes nunca se hacía):**
  - **`PRAGMA optimize`** se ejecuta 5 minutos después de arrancar y luego a diario:
    sin estadísticas (`sqlite_stat1` no existía) SQLite podía elegir un plan malo
    para las consultas del inbox.
  - **Poda por retención** (`cleanupLogs`, a diario y 5 min después de arrancar):
    `webhook_logs` y `audit_logs` más viejos que `LOG_RETENTION_DAYS` (90) y los
    **avisos ya leídos** más viejos que `NOTIFICATION_RETENTION_DAYS` (30). Los
    avisos **sin leer se conservan**: son los que esperan que alguien los mire.
  - También se podan los **webhooks descartados** (agotaron reintentos) con la misma
    antigüedad; quedan un tiempo para inspección.
  - Índices nuevos por `created_at` en `webhook_logs` y `audit_logs` para que la
    poda sea barata (`src/db/index.ts`).
  - Variables nuevas: `LOG_RETENTION_DAYS`, `NOTIFICATION_RETENTION_DAYS`,
    `LOG_MAX_MB`, `LOG_KEEP`, `LOGS_DIR`.

- **Pruebas:** 86 en total. Se sumaron `test/retention.test.ts` (qué se poda y qué
  no) y `test/system-health.test.ts` (contadores, avisos y que el JSON **no** filtre
  rutas).

---

## 46. API para la app móvil (Flutter) (2026-10-18)

The app (`C:\xampp_82_12\htdocs\baileys_esam_app`, see its `PLAN.md`) uses the same JSON routes as the panel. Two additions make that possible:

- **Bearer token:**
  - `sessionToken(req)` accepts `Authorization: Bearer <token>` in addition to the cookie. It is the same signed value with the same expiry, and "Cerrar sesión" invalidates it on the server.
  - The browser keeps working exactly as before.
- **JSON errors instead of redirects** (`wantsJson`: requests with a Bearer token, `Accept: application/json`, or the `/api/`, `/inbox/`, `/notifications/` and JSON `/notes/*` routes):
  - `401 {code:'unauthenticated'}`;
  - `403 {code:'forbidden'}`;
  - `409 {code:'not_connected'}` when the line is not linked. The app then shows only Conexión, same as the web.
- **New routes (`/api/mobile/*`):**
  - `login` (`{login,password,device}` → token + user + line; rate limit 10/min; audited as `mobile.login`);
  - `logout`;
  - `me` (adds the unread notices);
  - `connection` (diagnosis);
  - `connection/{reconnect,repair,reset}`;
  - `confirmations`;
  - `confirmations/:group` (`confirm`/`cancel` for scheduled sends).
- The existing permissions do not change: each route applies `requireSection`, the user's line and notes by owner.
- **Verified:**
  - test on a copy of the database: 11/11 (wrong password, token, `/me`, 401 JSON without a token, conversations, notes, notices, diagnosis, confirmations, logout);
  - `npm test` 86/86;
  - `tsc` clean.

---

## 47. Programa y nombre completo visibles para todos, también en grupos (2026-10-19)

Los datos que cronogramas manda con cada envío masivo (`programa` y `contact_name`) ya se guardaban por número en `person_programs`, pero el panel no avisaba del cambio a las demás líneas y la ficha del grupo solo mostraba el nombre de WhatsApp de cada miembro.

- **Aviso en vivo por persona (`src/core/person.ts`, `src/baileys/manager.ts`):**
  - `tagPerson()` devuelve si el nombre o el programa cambiaron (no avisa cuando el
    envío repite el mismo dato).
  - `tagConversation()` publica el evento SSE `person` con el `phoneKey`, los datos
    actualizados y **todos los chats de esa persona en cualquier línea**.
  - El panel filtra el evento por el alcance del usuario; al recibirlo refresca la
    lista y, si la ficha está abierta, la cabecera, el programa y el nombre sin
    recargar la página. El sondeo de 20 s también corrige datos si se perdió el evento.
- **Ficha de contacto en grupos (`src/panel/inbox.ts`, `public/app.js`, `public/app.css`):**
  - `GET /inbox/:session/:chat/participants` agrega a cada miembro:
    `full_name` y `programas` (de cronogramas) y `team` (nombre/área si es usuario
    del sistema).
  - La lista de miembros muestra primero el nombre del compañero o el nombre
    completo registrado, con chips de programa/área; el nombre y número de WhatsApp
    quedan como dato secundario. El buscador incluye esos campos.
  - Al abrir la ficha de un miembro desde un grupo, `/person` devuelve también
    `team`, así se ve su condición de usuario del sistema aunque todavía no haya
    una conversación guardada en esa línea.
- **Programa del grupo:** `ConversationDTO` expone `programa`; los chats grupales
  muestran el programa etiquetado por cronogramas aunque no tengan `person_programs`
  (los grupos no representan a una persona).
- **Pruebas:** `test/person.test.ts` cubre el aviso de cambio y la búsqueda de chats
  de una persona en varias líneas. `npm run typecheck`, `npm test` (88) y
  `npm run build` limpios. Sin migración de base.

---

## 48. Última actividad por usuario y ficha individual de seguimiento (2026-10-19)

Se distingue **cuándo alguien ingresó** de **cuándo trabajó por última vez** (envió un mensaje, lanzó un lote o registró una nota), y se agrega una ficha por persona para hacer seguimiento desde Reportes.

- **`src/core/user-activity.ts` (nuevo):** `lastUseByUser()` calcula la última actividad real por cuenta:
  - mensajes salientes con `messages.sender_uid`;
  - notas con `contact_notes.user_id` (sin eliminadas);
  - lotes por `batches.meta.account` o, si falta, por el dueño de la línea (`sessions.owner_uid`).
  - El último ingreso sigue viviendo en `users.last_login_at` y se muestra por separado.
- **`/users`:** nueva columna **Última actividad** con fecha relativa, tipo de trabajo y fecha exacta al pasar el cursor. El nombre enlaza a la ficha individual.
- **`/reports` → Equipo:** la tabla **Desempeño por persona** muestra la última actividad, compacta las métricas de notas y agrega la acción **Ver ficha**. Se conservan período, sesión y filtros.
- **Alcance de Reportes:** el Super Admin ve todas las líneas y la tabla incluye a todo el equipo, incluso a quienes no tuvieron actividad en el período. El inbox y el historial personal conservan el alcance por número.
- **`/reports/users/:id` (nuevo):**
  - cabecera con identidad, roles, área, línea/estado, autorización, último ingreso y última actividad;
  - KPIs de respuestas, primera respuesta (≤15 min y ≤1 h), envíos de bandeja/lotes, notas creadas y resueltas, y tareas vencidas;
  - gráfico diario de respuestas vs. envíos;
  - tareas asignadas (vencidas, para hoy y abiertas), contactos atendidos y actividad reciente (mensajes y notas);
  - mismo selector de período y línea que Reportes; los filtros de Equipo se conservan al entrar y al volver.
- **Ajuste visual de la ficha (19/10/2026):**
  - el hero vuelve a ser horizontal en escritorio: Bootstrap `.card` lo apilaba en columna y producía un hueco vertical grande;
  - identidad a la izquierda y datos de último ingreso/última actividad en una columna lateral legible; en tablet pasan a dos columnas y en móvil a una;
  - KPIs en 3×2 en escritorio, 2 columnas en tablet y móvil ancho, y 1 columna en teléfonos; los subtítulos ya no se recortan;
  - más aire en la cabecera, sin rótulo superior, y sin halos decorativos en el avatar ni en los puntos de tareas;
  - el panel de tareas conserva un ancho mínimo y el gráfico reserva 300 px para evitar saltos de altura.
- **Métricas:** `attentionData()` ahora expone `within15`, `within60` y respuestas por día por usuario. `userReportDetail()` agrega envíos, chats atendidos, tareas y actividad reciente.
- **Pruebas:** `test/user-activity.test.ts` cubre prioridad entre mensaje/nota/lote, atribución por dueño de línea, cuentas sin actividad y el armado completo de la ficha (respuestas, envíos, notas asignadas y render HTML). `test/reports-scope.test.ts` fija que el Super Admin vea todas las líneas en Reportes sin ampliar su historial personal. `npm run typecheck`, `npm test` (94) y `npm run build` limpios. Revisión visual con capturas headless en 1440, 1024 y 500 px, y modo oscuro. Sin migración de base ni librerías nuevas.

---

## 49. Contactos, mensajes fijados y encuestas en Conversaciones (2026-10-19)

Tres mejoras del inbox para acercarlo a WhatsApp. La interfaz y los textos siguen en español.

- **Contactos compartidos (`src/baileys/session.ts`, `src/core/message-meta.ts`, `public/app.js`):**
  - los mensajes `contactMessage` y `contactsArrayMessage` ahora guardan en `messages.content_meta` el nombre y el teléfono extraídos del vCard (`waid` o `TEL`);
  - se dibujan como tarjetas con avatar, nombre, número y botón **Abrir chat**; al tocar la tarjeta se abre la conversación existente o se inicia una nueva en la misma línea;
  - los mensajes viejos que solo tenían el nombre se siguen viendo como tarjeta, pero sin número (no se puede recuperar el teléfono que no se guardó); si WhatsApp vuelve a entregar el mensaje al re-sincronizar el historial, se completan sus metadatos.
- **Mensajes fijados (API y panel):**
  - columnas `messages.pinned_at` y `messages.pinned_by`, con migración idempotente e índice por conversación;
  - se pueden fijar hasta **3 mensajes por chat** (el mismo límite de WhatsApp), con acción de pin en cada burbuja y aviso desplegable arriba del hilo;
  - el aviso muestra quién fijó, la vista previa y permite ir al mensaje o desfijarlo; se actualiza por SSE para todo el equipo;
  - es un fijado **interno del panel**: no se sincroniza con el teléfono del cliente porque Baileys no expone una API estable para eso.
- **Encuestas:**
  - botón **Crear encuesta** en el compositor: pregunta, entre 2 y 12 opciones, una o varias respuestas y envío con cita si se estaba respondiendo;
  - se muestra la encuesta con el diseño de WhatsApp (pregunta, opciones y modo de respuesta), tanto las enviadas como las recibidas;
  - el alcance implementado es crear, enviar y ver. Los votos y resultados se consultan en WhatsApp; el panel no los procesa.
- **Pruebas:** `test/message-meta.test.ts` cubre vCards (waid, TEL, N, líneas plegadas) y encuestas; `test/message-pins.test.ts` cubre el límite de 3, el desfijado y el aislamiento por chat/línea. `npm run typecheck`, `npm test` (106/106), `npm run build` y `npm run check:assets` limpios.

---

## 50. Pegar capturas, archivos del chat y sesiones (2026-10-20)

- **Pegar capturas en el compositor (`public/app.js`, `public/app.css`):** copiar una captura y pegarla con Ctrl+V ya no la envía de golpe:
  - aparece una **vista previa** arriba del campo con miniatura, nombre y peso; se confirma con el botón de enviar o Enter y se cancela con la X;
  - el texto escrito viaja como **pie de foto** y se limpia solo si el envío sale bien;
  - el pegado de texto sigue igual y no se dispara desde buscadores ni formularios;
  - se avisa con un mensaje claro si la imagen supera el máximo permitido.
- **Archivos del chat (`src/panel/server.ts`):** el inbox tenía el mismo tope de 6 MB que los stickers, así que cualquier video real fallaba. Ahora usa su propio límite de **64 MB** (`uploadInbox`) y los errores de subida responden **JSON** (413/400) para que el panel muestre el motivo en vez de "Error al enviar".
- **Fotos grandes (`public/app.js`):** antes de subir, las imágenes de más de 1,5 MB se reducen a 1920 px y se recomprimen a JPEG 0.85 solo si el resultado pesa menos; los GIF y lo que el navegador no pueda decodificar se mandan tal cual.
- **Borradores por conversación (`public/app.js`):** lo escrito se guarda por chat y sobrevive a cambiar de conversación, responder un mensaje o recibir uno nuevo; se borra al enviar.
- **Sesiones del panel (`src/auth/sessions.ts`):** una cookie con firma de largo distinto hacía que `timingSafeEqual` lanzara y el pedido terminara en 500. Ahora se compara el largo antes y la sesión se rechaza como corresponde.
- **Pruebas:** `test/web-sessions.test.ts` cubre cookie válida, firma truncada/alargada/alterada, sesión vencida y cierre de sesión. `npm run typecheck` y `npm test` (122/122) limpios.

---

## 51. CI, lint y dependencias (2026-10-20)

- **Integración continua (`.github/workflows/ci.yml`):** en cada push a `main` y en cada PR corre `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` y `npm run build` con Node 24. Las corridas viejas de la misma rama se cancelan para no encolar trabajo.
- **ESLint 10 (configuración plana, `eslint.config.js`):**
  - `public/`: scripts de navegador con `eslint:recommended` y los globals del layout (Bootstrap, Chart, ApexCharts, FilePond, Swal, Shepherd, Swiper);
  - `scripts/` y `ecosystem.config.cjs`: CommonJS con globals de Node;
  - `src/` y `test/`: TypeScript con `typescript-eslint` recomendado, sin reglas que necesiten tipos (eso ya lo cubre `tsc`).
  - No se aplica Prettier a propósito: reformatear `app.js` y `app.css` generaría un diff imposible de revisar.
- **Código muerto que encontró el lint:** se quitaron `ParsedCookie` (`src/auth/sessions.ts`), el import de `typeForMime` (`src/baileys/session.ts`), el wrapper `run0` (`src/core/batch-service.ts`), el import de `get` (`src/core/scheduler.ts`), el import de `storeIncoming` (`src/panel/inbox.ts`), `isWin` (`scripts/run-forever.cjs`) y el estado `mode`/`isOpus` del grabador de voz (`public/app.js`).
- **Dependencias:** `sharp` 0.35.4 → 0.35.5 por la vulnerabilidad de librsvg (GHSA-wq5f-xc86-pv6w); `npm audit` queda sin hallazgos.
- **Pruebas:** `npm run lint`, `npm run typecheck`, `npm test` (122/122) y `npm run build` limpios; `npm ci --dry-run` confirma que el lockfile está sincronizado.

---

## 52. Avisos de escritorio y búsqueda en el chat (2026-10-20)

- **Notificación del sistema:** cuando llega un mensaje entrante y la pestaña está en segundo plano, se muestra una notificación del sistema con el nombre del contacto y el texto (o el tipo de archivo). Es una sola por conversación: el `tag` reemplaza la anterior para no acumular avisos de un chat activo. Al hacer clic se enfoca la ventana y se abre la conversación. No se dispara durante una sincronización masiva (más de 5 mensajes en 3 s), igual que el aviso interno.
- **Permiso:** si el navegador todavía no lo concedió, la primera vez se ofrece un aviso con el botón «Activar» (los navegadores exigen un clic). Se recuerda en `localStorage` (`msg-notify-asked`) para no repetirlo.
- **Buscar en la conversación:** botón de lupa en la cabecera del chat y atajo `Ctrl+F` (también `Cmd+F`). La barra busca en **todo el historial del chat** contra el servidor, no solo en lo cargado, y muestra la cantidad de coincidencias, flechas para recorrerlas (Enter = anterior, Shift+Enter = siguiente) y una lista con fecha, sentido y el fragmento resaltado. Al elegir un resultado se cargan las páginas anteriores necesarias y se resalta el mensaje en el hilo.
- **Backend:** `searchChatMessages()` en `src/core/conversations.ts` busca en `body` y en la transcripción de las notas de voz, escapa `%`, `_` y `\` (la búsqueda es literal) y devuelve total + hasta 100 resultados del más nuevo al más viejo. Ruta `GET /inbox/:session/:chat/search?q=` con límite de 60 consultas por minuto. No colisiona con el buscador global existente (`searchMessages(user, q)`).
- **Pruebas:** `test/message-search.test.ts` (6) cubre orden, total vs. recorte, comodines escapados, alcance por chat/línea, transcripciones y mínimo de 2 letras. `npm run lint`, `npm run typecheck` y `npm test` (128/128) limpios.

---

## 53. Prospectos de marketing: seguimiento por asesor en Notas › Marketing (2026-10-26)

Cronogramas habilita a los asesores de marketing a registrar prospectos en los programas en Inscripciones y enviarles WhatsApp desde su propia línea. Cada prospecto se sigue acá como una nota del asesor.

- **API (`src/core/prospects.ts`):**
  - `PUT /api/v1/prospects/:ref` crea o actualiza el seguimiento. Recibe `account` (usuario del asesor en cronogramas), `phone`, `name`, `programa`, `programa_id`, `estado` y `nota`.
  - La nota se crea en la ficha de la persona, en la línea del asesor, con el asesor como autor y la etiqueta **Prospecto**.
  - Responde 422 con un mensaje claro si el asesor no tiene usuario o línea, o si el celular es inválido.
  - `DELETE /api/v1/prospects/:ref` manda la nota a la papelera.
  - Idempotente por referencia (`contact_notes.prospect_ref`); el programa y el estado quedan en `prospect_meta`.
  - El nombre de la persona se registra solo si no tenía uno: no pisa el de cronogramas ni el escrito a mano.
- **El estado comercial mueve el pipeline:**
  - nuevo → Por hacer;
  - contactado o interesado → Contactado;
  - no interesado o inscrito → Resuelta.
  
  Solo se mueve cuando el estado cambia, así que lo que el asesor movió a mano en /notes se respeta.
- **Quién ve qué en /notes:**
  - cada asesor ve lo suyo, como hasta ahora;
  - **Gerencia Marketing** y **Supervisor de Marketing** (`esamSupervisaArea`) ven además todas las notas del área Marketing de todos los asesores, y pueden abrirlas aunque la persona se atienda en otra línea (`noteInArea` en `accessibleNote`);
  - el Super Admin ve todo;
  - las demás áreas no ven las notas de marketing.
- **Vista /notes:**
  - en el área Marketing, quien supervisa tiene chips por **asesor**, con la cantidad de notas y de prospectos;
  - las tarjetas de lista y pipeline muestran el programa, el estado del prospecto y, para quien supervisa, el asesor.
- **Pruebas:** `test/prospects.test.ts` (6) cubre el alta, el estado→pipeline, los rechazos, la visibilidad por rol, el acceso por área y la papelera. `npm run typecheck` y `npm test` (134/134) limpios.

---

## 54. Notas agrupadas por fecha, Lotes rediseñados y actividad de envíos masivos en Reportes (2026-10-26)

### /notes: agrupar por fechas y colores por área, etapa y vigencia
- **Nuevo selector «Agrupar por»** (además del orden), recordado por usuario en `localStorage` (`notes-group`):
  - *estado del seguimiento* (lo de siempre);
  - *día de seguimiento*, con títulos como «Lunes, 27 de octubre · Mañana · Vigente»;
  - *mes de seguimiento*;
  - *día de registro*;
  - *área*;
  - *etapa* del pipeline.
- **Encabezados de grupo:**
  - el tono indica la vigencia: rojo vencido, ámbar vence hoy, verde vigente, azul verdoso resuelto (un día pasado sin pendientes dice «Resueltas», no «Vencido»);
  - cada encabezado muestra la cantidad de notas, las vencidas y las de hoy.
- **Tarjetas** (lista y pipeline):
  - franja izquierda del **color del área**;
  - etiqueta de **etapa** (Por hacer, En gestión, Contactado, Resuelta);
  - etiqueta de **vigencia**: «Vencida · hace N días», «Vence hoy», «Vigente · faltan N días», «Sin fecha límite» o «Resuelta».
  
  Para no repetir la información, la fecha se muestra exacta («sáb, 10 oct · 08:00»).
- **Leyenda de colores** bajo los filtros de área.
- `NoteKit.vigencia()` / `vigenciaHtml()` son reutilizables. En la ficha del chat las tarjetas no cambian, porque la decoración solo se activa con `opts.area` / `opts.stage` / `opts.vigencia`.

### /batches: lista compacta y detalle completo del envío (`src/panel/batches-view.ts`)
- **Lista:**
  - indicadores del día: lotes, mensajes enviados, en curso y fallidos;
  - filtros por estado (en curso, programados, terminados, con fallos, cancelados), buscador (lote, programa, línea, quién pidió) y selector de línea;
  - una **fila por lote agrupada por día** («Hoy», «Ayer», fecha), ordenada por fecha de creación. Cada fila muestra hora (24 h), número, nombre, programa, tipo, origen, línea, dueño y solicitante, progreso con enviados/total, fallidos, estado y acciones;
  - en pantallas angostas cada fila se apila como tarjeta;
  - se muestran los últimos 200 lotes (antes 100).
- **Progreso en vivo** solo para los lotes activos (`data-live="0"` en los terminados): antes la página consultaba el estado de cada lote listado al cargar.
- **Detalle del envío:**
  - encabezado con programa, tipo y origen;
  - indicadores en vivo: total, enviados, fallidos, omitidos y pendientes;
  - **ficha**: quién lo pidió, línea y su estado, origen, área, programa y gestión, creado, programado, inicio, fin, **duración**, primer y último mensaje y **ritmo real promedio por mensaje**;
  - **mensaje enviado** en burbuja tipo WhatsApp («Igual para todos» o «Personalizado · N variantes» con un ejemplo) y el adjunto;
  - **motivos de fallo agrupados**;
  - **destinatarios** con filtros por estado y buscador, mensaje completo desplegable («Ver completo»), hora exacta de envío, error, referencia de origen y enlace a la conversación. Se listan hasta 3000.

### /reports › Envíos masivos (`src/core/mass-activity.ts`)
- **Pestaña nueva «Envíos masivos»**, con el mismo período y filtro de línea que el resto de Reportes. Respeta el alcance: el Super Admin ve todas las líneas y los demás solo la suya.
- **Indicadores:** lotes, mensajes (enviados y fallidos), personas que enviaron y día con más envíos.
- **«Quién envía mensajes masivos»**, una fila por persona:
  - lotes y cancelados;
  - días con envíos;
  - **lotes por día** (promedio y máximo, con su fecha);
  - mensajes (enviados y fallidos);
  - **mensajes por lote** (promedio y máximo);
  - líneas usadas y último envío.
  
  La persona sale del `meta` del lote (`solicitado_por_id`/`solicitado_por`, o `account`). Los recordatorios automáticos y los envíos del panel o CSV se agrupan aparte.
- **«Envíos por persona y día»:** calendario con los lotes de cada persona por día (al pasar el cursor, los mensajes) y colores por intensidad.
- **«Registro de actividad»:**
  - cada lote, día por día, con hora, persona, línea, programa, tipo y origen, mensajes, enviados/fallidos/omitidos, duración, estado y enlace a su detalle;
  - filtro por persona (también desde el botón de cada fila del resumen).
- **CSV:** `GET /reports/masivos.csv` con el resumen por persona y el registro de lotes (fechas en hora local). El botón «Exportar CSV» usa este archivo cuando la pestaña está abierta.
- **Pruebas:** `test/mass-activity.test.ts` (6) cubre los totales del período, la agrupación por persona (veces por día, mensajes por lote, cancelados, líneas), los recordatorios aparte, el registro (hora, línea, duración), el alcance de líneas y el CSV. `npm run lint`, `npm run typecheck` y `npm test` (140/140) limpios.

---

## 55. Ficha del contacto: historial de envíos del sistema (cobranzas, notas, asistencias) (2026-10-26)

Objetivo: seguir en la ficha de cada persona todo lo que le envió el sistema (contabilidad y académico), quién lo pidió y si le llegó.

- **Solapa nueva «Envíos»** en la ficha del contacto, junto a Información y Grupos. Se carga solo al abrirla.
  - **Resumen por área** (Contabilidad, Académico y, si hay, Marketing): cantidad, último envío («hoy», «hace N días»), qué fue, quién lo envió y cuántos no pudieron enviarse. El color avisa: verde si recibió algo en los últimos 30 días, ámbar si no, gris si nunca.
  - **Filtros por categoría:** Cobranza, Notas, Asistencia, Programa, Marketing y Otros.
  - **Historial** del más nuevo al más viejo, con:
    - el título: «Cuotas vencidas», «Cuotas próximas a vencer», «Recordatorio automático de cuotas», «Notas del módulo», «Aviso de inasistencia» o «Mensaje del programa»;
    - fecha y hora, programa, módulo y sesión;
    - **quién lo envió** y desde qué línea;
    - el **estado de entrega con el acuse de WhatsApp** (Leído, Entregado, Enviado, No se pudo enviar con el motivo, Pendiente, Cancelado);
    - el mensaje completo;
    - el enlace al lote, solo para quien puede abrir Lotes.
  - Se busca **por número en todas las líneas**, igual que las notas de la persona.
- **Backend:**
  - `src/core/person-sends.ts`: `personSends(phoneKey)` y `classifySend(meta)`. La clasificación sale del `meta` que manda cronogramas (`tipo`, `modo`, `origen`, `area`, `programa`, `modulo`, `sesion`). El remitente sale de `solicitado_por`, del usuario de `account`/`solicitado_por_id`, o «Envío automático».
  - Ruta `GET /inbox/:session/:chat/sends`, con el mismo control de acceso que la ficha.
  - Índice nuevo `idx_batch_items_chat` para que la búsqueda por número no recorra toda la tabla.
- **API de lotes:** `GET /api/v1/batches/:id` devuelve además `requested_by` (usuario de cronogramas que pidió el lote).
- **Cronogramas** (repo aparte), **para que todo envío a participantes quede registrado**. Los avisos por `wa.me` no pasaban por el sistema y ya no se usan:
  - **Ausentes del detalle del módulo** → `POST /admin/programas/horario/{horario}/whatsapp-ausentes`. Es un lote por Seguimiento ESAM desde la línea de quien envía, con `tipo: asistencia`, sesión y módulo. Solo incluye a quienes figuran «Ausente» y no están dados de baja. Queda en `mensajes` como `whatsapp_asistencia`.
  - **Responsables › WhatsApp masivo de notas** y el **botón por fila** del modal de notas del programa → envío de notas por Seguimiento ESAM (`tipo: notas`).
  - **Enlace al celular del participante** en el programa → abre la conversación en Seguimiento ESAM (SSO con `next`).
  - **Progreso del lote:** lo ve quien tiene permisos de envío o quien pidió ese lote (antes un responsable sin esos permisos veía un error).
  - **No se tocaron** los envíos de **credenciales a docentes** (`wa.me` con usuario y contraseña), para no guardar contraseñas en el historial de mensajes.
- **Pruebas:**
  - `test/person-sends.test.ts` (5): solo la persona, clasificación por categoría y área, remitente (nombre, cuenta, automático), acuse leído, fallos con motivo y sesión.
  - En cronogramas se verificó el envío a ausentes en una transacción revertida con la API simulada (9/9).
  - `npm run lint`, `npm run typecheck` y `npm test` (145/145) limpios.

---

## 56. Notas de nivelación por WhatsApp, firma «Atte:» y envíos por área en la ficha (2026-10-26)

- **Firma en todos los mensajes masivos:** `createBatch` acepta `signature` y agrega al final de cada mensaje «Atte: nombre completo» (una sola vez, aunque el texto ya la traiga: `withSignature`).
  - La API `POST /api/v1/batches` recibe `signature`.
  - Cronogramas manda el nombre completo de quien envía en todos los lotes (cobranzas, notas, nivelación, asistencia, grupos, participantes, prospectos).
  - Los recordatorios automáticos no la llevan, porque no los envía una persona.
- **Ficha › Envíos:** selector **Cronológico** (todos los envíos, del más nuevo al más viejo, con separador por día) o **Por área** (Contabilidad, Académico, Marketing, Otros; cada una en orden cronológico). Se recuerda en `localStorage` (`sends-view`).
- **Notas de nivelación:** el historial distingue «Notas de nivelación» (`meta.modo = 'nivelacion'`) de «Notas del módulo».
- **Cronogramas** (repo aparte):
  - `App\Support\MensajeNotas`: un solo lugar para el texto de las notas. **La vista previa del modal y el envío son el mismo texto**. Antes el modal mostraba un texto y Seguimiento ESAM enviaba otro con su plantilla; ahora va como `body_override`.
    - **Regular** reprobado: se agrega que debe realizar la nivelación y estar atento al comunicado de la actividad.
    - **Nivelación** (solo para quienes reprobaron la nota regular): si aprobó, la nota máxima es 71. Si reprobó de nuevo o no tiene nota de nivelación, la siguiente nivelación (2da instancia) tiene un costo y debe comunicarse con el responsable del programa y con el área contable.
    - Los nombres se limpian de tabuladores y saltos de línea, que rompían la negrita en WhatsApp.
  - **Botón «Nivelación»** en el tab Módulos del programa, visible cuando el módulo tiene notas de nivelación registradas. Usa el mismo modal con `?modo=nivelacion` y envía con `modo: nivelacion`. La referencia `notas:<modo>:…` no choca con el envío regular del mismo día.
  - La vista previa del modal muestra también la línea «Atte: …».
  - El aviso de inasistencia reemplaza «Enviado por:» por la firma «Atte:».
- **Pruebas:**
  - baileys: `test/person-sends.test.ts` (+2): firma única y clasificación de nivelación. `npm run lint`, `npm run typecheck` y `npm test` (147/147) limpios;
  - cronogramas: verificado con el módulo 1249 en una transacción revertida y la API simulada (11/11): textos de cada caso, envío igual a la vista previa, modo, referencia y firma.

---

## Notas de operación

- En producción usar `start-baileys.bat` / pm2 / systemd (no `npm run dev`).
- **No** correr `npm run dev` con el servicio ya activo: dos instancias con las mismas
  credenciales rompen la recepción (`Bad MAC`).
- Si un usuario no ve más que Conexión, es porque su número aún no está vinculado (`ready`).
- Los mensajes anteriores a la introducción de `messages.origin` no se cuentan como “Bandeja ESAM”.
- Un `@lid` sin mapeo se mostrará como número cuando WhatsApp comparta el par LID↔número
  (al escribir o al sincronizar los grupos).
- **Estado del servicio:** `http://127.0.0.1:8030/healthz` (panel) y
  `http://127.0.0.1:2785/health` (gateway) devuelven JSON con líneas conectadas,
  tamaño de la base y avisos pendientes. No requieren sesión ni API key.
- **Logs:** se rotan al arrancar (`npm run logs:rotate`); el límite es `LOG_MAX_MB`
  (10 MB) y se conservan `LOG_KEEP` copias (5). Con pm2, instalar `pm2-logrotate`.
