# PLAN — baileys_esam

Reemplazo ligero (Node.js + TypeScript + SQLite) de la pila **OpenWA**
(whatsapp-web.js + Chromium) y del motor de envíos de **openwa_basico**, usando
**Baileys**. Mantiene el contrato REST para que `cronogramas` y `openwa_basico`
funcionen sin cambios.

## Decisiones fijadas

1. Stack: **Node.js + TypeScript**, servicio único todo-en-uno.
2. Alcance v1: **gateway completo + lotes/plantillas/anti-ban**.
3. Compatibilidad: **drop-in**, mismo contrato y mismo puerto `2785`.
4. Base de datos: **SQLite** (`node:sqlite`, sin dependencias nativas).
5. Ubicación: `C:\xampp_82_12\htdocs\baileys_esam`.

## Contrato replicado

### Gateway OpenWA (`:2785`, header `X-API-Key`)

| Método | Ruta | Uso |
| --- | --- | --- |
| GET | `/api/sessions` | Listar sesiones |
| POST | `/api/sessions` | Crear sesión `{name}` |
| GET | `/api/sessions/{id}` | Estado `{status, phone, lastError}` |
| POST | `/api/sessions/{id}/start` \| `/stop` \| `/logout` | Ciclo de vida |
| GET | `/api/sessions/{id}/qr` | `{qrCode}` (data URL) |
| POST | `/api/sessions/{id}/pairing-code` | `{phoneNumber}` -> `{code}` |
| POST | `/api/sessions/{id}/webhooks` | Registrar webhook `{url,events,secret}` |
| POST | `/api/sessions/{id}/presence/subscribe` | Presencia |
| GET | `/api/sessions/{id}/contacts` | Contactos |
| GET | `/api/sessions/{id}/contacts/check/{n}` | ¿Existe el número? |
| GET | `/api/sessions/{id}/groups` \| `/groups/join-info` | Grupos / invitación |
| POST | `/api/sessions/{id}/messages/send-text` | Texto |
| POST | `/api/sessions/{id}/messages/send-{image,video,audio,document,sticker}` | Media base64 |
| GET | `/api/sessions/{id}/messages/{chat}/{id}/media` | Descargar media entrante |

### API de integración v1 (`:8020`, `Bearer` + allowlist de IP)

`/api/v1/health`, `/api/v1/config/numero`, `/api/v1/groups`,
`/api/v1/groups/resolve`, `/api/v1/accounts`, `/api/v1/batches`,
`/api/v1/batches/{id}`, `/api/v1/batches/{id}/retry`.

### Webhooks salientes

Envelope `{ sessionId, event, data }` firmado con `X-OpenWA-Signature:
sha256=<hmac>` (HMAC-SHA256 sobre el body crudo), igual que OpenWA. Eventos:
`message.received`, `message.ack`, `session.status`, `session.disconnected`,
`presence.update`.

## Fases

- [x] **F1** Scaffolding + config + SQLite + esquema.
- [x] **F2** Núcleo: teléfonos/JID, media, plantillas, pacing anti-ban, opt-out,
  webhooks, runner de lotes.
- [x] **F3** Motor Baileys: `WaSession` (QR/pairing/envío/grupos/contactos) y
  `SessionManager` multi-sesión con persistencia y teléfono autorizado.
- [x] **F4** Gateway REST compatible OpenWA (`:2785`).
- [x] **F5** API de integración v1 (`:8020`) con lotes/plantillas/media/idempotencia.
- [x] **F6** Panel web (conexión/QR, inbox, lotes, plantillas, monitoreo, reportes,
  políticas, opt-out, auditoría, usuarios).
- [x] **F7** SSO con cronogramas + usuario espejo + control de acceso por rol
  (admin/local ve todo; no-admin solo Conversaciones y Conexión).
- [x] **F8** Inbox en tiempo real (SSE + polling de respaldo), presencia
  ("escribiendo…"), stickers (WebP 512×512 con sharp) y transcripción de notas
  de voz (drivers chat/whisper OpenAI-compatibles).
- [x] **F9** Auto-respuestas por palabra clave (contains/equals/regex + cooldown
  por chat), importación de destinatarios por CSV, generación de PDFs (estado de
  cuenta y boletín, sin dependencias externas) y programación de lotes por fecha.
- [x] **F10** Historial por usuario y número (inbox filtrado por la sesión que
  corresponde al usuario, vinculada por `esam_numero`/`owner_uid`), sincronización
  bajo demanda del historial (`fetchMessageHistory` + `messaging-history.set`,
  sin duplicados), persistencia de media saliente y chat completo (imágenes,
  stickers, video, audio con transcripción, documentos, tics, emojis y adjuntos).
- [x] **F11** Inbox con paridad de `laravel_crm_whatsapp` (chat + gestión
  completa, sin IA ni CRM). Plan detallado: `PLAN_INBOX.md`.
  - [x] **F11.1** Datos y contactos: tablas `contacts`, `contact_notes`,
    `message_reactions`, `quick_replies`, FTS5 con fallback, migraciones de
    columnas y backfill.
  - [x] **F11.2** Backend: estados, asignación, bulk, notas, búsqueda y
    plantillas rápidas (`core/conversations.ts`, `core/quick-replies.ts`,
    `panel/inbox.ts` con rutas JSON `/inbox/:session/:chat/*`).
  - [x] **F11.3** Baileys: respuesta citada (`quoted`), reacciones entrantes/salientes
    (`sendReaction`) y foto de perfil del contacto.
  - [x] **F11.4** Frontend: inbox de 3 columnas (`public/app.js`/`app.css`), compositor
    con cita/reacciones/quick replies/emojis, panel de contacto, notas, grabadora
    (MediaRecorder) y lectura en voz alta (TTS).
  - [x] **F11.5** Ajustes → Plantillas rápidas (CRUD) y badge de no leídos en el menú.
  - [x] **F11.6** Verificación: corrección del layout del inbox (columna fantasma del
    panel de contacto), `typecheck`/`build` limpios y prueba de render con jsdom.
  - [x] **F11.7** Ajuste de alcance: sin estados (abierta/pendiente/cerrada) ni asignación
    a agentes; rediseño del inbox (modo Operate, paleta institucional).
  - [x] **F11.8** Shell: sin scroll horizontal, ítem activo del menú, espacio contenido↔footer.
  - [x] **F11.9** Altura del inbox adaptativa (sin hueco antes del footer).
  - [x] **F11.10** Sin scroll de página en conversaciones y compositor corregido
    (verificado con Chrome headless).
  - [x] **F11.11** SSO de cronogramas: misma cuenta (`uid`), número autorizado
    (bloquea si no coincide) e historial por sesión/número; alcance del inbox por
    sesión (sin agente asignado). Verificado con SSO real.
  - [x] **F11.12** Limpieza de código/HTML/CSS muerto del inbox anterior y
    documentación.
- [x] **F12** Grupos, offline e historial (2026-10-04/05).
  - [x] **F12.1** Mensajes offline (`append`) e historial completo al vincular
    (`BAILEYS_SYNC_FULL_HISTORY`); sincronización de chats conocidos una sola vez
    por sesión (`resumeHistories`, marca en `configs`); `fetchMessageHistory`
    corregido (`oldestMsgKey`+`timestampMs`) y con timeout por chat; la media del
    historial/offline no se descarga.
  - [x] **F12.2** Grupos en el mismo inbox (dejan de excluirse `@g.us`); nombre por
    `groupMetadata`; autor por mensaje (`messages.sender_jid`); webhook con
    `kind: group`/`participant` sin auto-respuesta ni opt-out.
  - [x] **F12.3** UI: solapas Números/Grupos, paginación de mensajes, citas
    clickeables (saltar al original), autor y números de WhatsApp clickeables,
    descarga de documentos; índices que bajan la consulta de mensajes de >120 s a
    ~0,2 ms.
  - [x] **F12.4** LID→número: mapa completado con miembros de los grupos; migración
    de conversaciones `@lid` a `@c.us`; `phoneFromChatId` vacío para `@lid`/grupos.
  - [x] **F12.5** Notas internas con etiquetas (globales con color) y fecha límite;
    apartado `/notes` (todas las notas + gestor de etiquetas); editar/eliminar solo
    el autor o admin.
  - [x] **F12.6** Seguimiento de actividad por usuario (número, apartado, origen
    cronogramas/panel, filtro día/mes, auto-refresco) en Monitoreo/Reportes;
    `GET /api/activity`.
  - [x] **F12.7** `GET /api/v1/health` por usuario (`?uid=`/`?phone=`) para que
    cronogramas muestre el estado real de la cuenta que ingresa.
  - [x] **F12.8** Infra: autoarranque en Windows (`scripts/autostart.ps1` + carpeta
    Inicio), guarda de instancia única (espera de puertos antes de conectar) y
    `AUTO_VACUUM=false`.
- [x] **F13** Sincronización tras apagado y media diferida (2026-10-06).
  - [x] **F13.1** Parche de libsignal para cadenas adelantadas (mensajes del propio
    teléfono que dejaban de llegar); `getMessage` con caché de enviados;
    procesamiento ordenado de entrantes; diagnóstico de mensajes sin descifrar.
  - [x] **F13.2** Media diferida: referencia por mensaje (`media_ref`), descarga en
    segundo plano (offline) o al abrir (historial), con tiempo máximo; aviso
    "sin descargar"/"no disponible" con Descargar/Reintentar; soporte de *Range*.
  - [x] **F13.3** Recuperación de la referencia pidiendo el tramo del chat al teléfono.
- [x] **F14** Anti-baneo ampliado: corrección del ritmo de lotes (salían sin espera),
  "escribiendo…" simulado, separación mínima y tope por minuto en todos los envíos,
  tope de contactos nuevos, verificación de número, pausa por entregabilidad baja,
  cuarentena configurable y motivo de pausa visible en el lote.
- [x] **F15** Operación segura: bloqueo de instancia única, `npm run restart`,
  versión/arranque en `/health` y en el panel, respaldo diario y `npm run backup`,
  `npm run admin:password`, `npm run check:assets`.
- [x] **F16** Notas internas como seguimiento: completar/reabrir, fecha con atajos,
  edición y borrado en línea, tablero `/notes` con indicadores, grupos y gestión de
  etiquetas; correcciones de alcance en las rutas de notas.

## Verificación

```bat
npm install
npm run typecheck
npm run build
npm run check:assets     REM plantilla Velzon presente
start-baileys.bat        REM servicio en segundo plano con reinicio
npm run restart          REM aplicar cambios de código
```

Pruebas funcionales sugeridas:

1. `GET http://127.0.0.1:2785/health` y `GET http://127.0.0.1:8020/api/v1/health`.
2. Crear sesión y vincular por QR (panel `/settings` o `/api/sessions` + `/qr`).
3. `POST /api/v1/batches` con `dry_run` y luego real; seguir con
   `GET /api/v1/batches/{id}`.
4. Verificar webhooks contra `openwa_basico` (`/webhooks/openwa`) o un receptor
   de prueba.

## Estado verificado

- Gateway y API v1 responden; seguridad 401/403; cuentas idempotentes; lotes con
  `dry_run` y validación de plantilla; import CSV; lote programado (`scheduled`).
- QR real generado y estable (Baileys 6.7.16); creación de sesión desde el panel.
- PDFs (estado de cuenta/boletín) generados; auto-respuestas con cooldown.
- Panel Velzon con paleta institucional; 13 secciones con 200; assets locales.
- Inbox (lista + conversación) renderiza; SSO y permisos por rol verificados.
- Reinicio automático del servicio probado (se mata el proceso y vuelve solo).
- `npm run typecheck` y `npm run build` limpios.

## Riesgos / notas

- Requiere **Node >= 22.5** por `node:sqlite`. Si el VPS usa Node 20, migrar el
  driver a `better-sqlite3` (compilación nativa) o subir Node.
- **Baileys 7.0.0-rc** provoca cierres en bucle en el handshake; usar la estable
  **6.7.24** (ya en `package.json`). Esta versión expone `senderPn`/`senderLid` en
  la clave del mensaje, lo que permite resolver los chats `@lid` a su teléfono
  real y mostrar el número en el panel. `BAILEYS_WA_VERSION` permite fijar la
  versión de WhatsApp Web.
- `getChatHistory`/`getContactStatus` no existen en Baileys; el historial se
  guarda desde la conexión (lotes + webhooks), igual que la póliza actual. La
  sincronización bajo demanda usa `fetchMessageHistory` (disponible en 6.7.16) y
  puede devolver pocos mensajes si el servidor no los conserva.
- Los mensajes entrantes de grupos **se incluyen** en el mismo inbox (con el
  asunto del grupo y el autor de cada mensaje). Disparan webhooks, pero no
  auto-respuestas ni opt-out. Al reconectar se sincroniza el historial de los
  chats conocidos (configurable con `HISTORY_SYNC_*`), una sola vez por sesión.
- Los mensajes recibidos con el sistema cerrado se recuperan al reconectar
  (eventos `append`). Para capturarlos siempre, dejar el servicio activo
  (autoarranque de Windows / pm2 / systemd). No correr dos instancias con las
  mismas credenciales (`Bad MAC`).
- La media del historial/offline **no** se descarga (URLs caducas → 403); se
  guarda el metadato y el archivo se descarga solo en mensajes en vivo.
- El texto/las plantillas se resuelven en baileys_esam; `body_override` sigue
  disponible para cronogramas.
- En producción **no usar `npm run dev`** (muere al cerrar la terminal): usar
  `start-baileys.bat` / pm2 / systemd.

## Registro de cambios

Ver **`CAMBIOS.md`** para el detalle de implementaciones y correcciones (anti-baneo, pool de
sesiones, panel, monitoreo/reportes, SSO con cronogramas, resolución de `@lid`, colas y retención,
grupos/offline/historial, notas con etiquetas y actividad por usuario).
Ver **`IMPLEMENTACION.md`** para la guía de implementación completa (instalación,
configuración, servicio, integración, respaldos y solución de problemas).

