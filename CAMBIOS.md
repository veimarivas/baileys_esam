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

## Notas de operación

- En producción usar `start-baileys.bat` / pm2 / systemd (no `npm run dev`).
- **No** correr `npm run dev` con el servicio ya activo: dos instancias con las mismas
  credenciales rompen la recepción (`Bad MAC`).
- Si un usuario no ve más que Conexión, es porque su número aún no está vinculado (`ready`).
- Los mensajes anteriores a la introducción de `messages.origin` no se cuentan como “Bandeja ESAM”.
- Un `@lid` sin mapeo se mostrará como número cuando WhatsApp comparta el par LID↔número
  (al escribir o al sincronizar los grupos).
