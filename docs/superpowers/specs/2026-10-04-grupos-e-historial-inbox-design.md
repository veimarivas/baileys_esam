# Grupos de WhatsApp e historial de mensajes en el inbox — Diseño

Fecha: 2026-10-04
Estado: **Implementado** (ver `CAMBIOS.md` §12 y §14).

> Diferencias con este diseño: `syncFullHistory` quedó en **`true`** por defecto
> (`BAILEYS_SYNC_FULL_HISTORY`), para recibir el historial al vincular; la
> sincronización de chats conocidos corre una sola vez por sesión; la media del
> historial y de los mensajes offline se descarga después (en segundo plano o al
> abrirla), no al recibirlos.

## 1. Problema

Al reingresar al sistema, no aparecen los mensajes que llegaron mientras el
servicio estuvo caído ni los mensajes de grupos de WhatsApp. Diagnóstico:

1. **Mensajes offline descartados.** Baileys emite los mensajes recibidos
   mientras el socket estuvo desconectado con `type: 'append'`
   (`node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js:699`:
   `upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')`). El panel
   solo procesa `'notify'` (`src/baileys/session.ts:277`), por lo que esos
   mensajes nunca se persisten.
2. **Grupos excluidos por diseño.** Los chats `@g.us` se filtran en
   `src/baileys/manager.ts:39` (`isInboxChat`), `manager.ts:437` y
   `manager.ts:533`, en `src/core/conversations.ts:13` (`inboxWhere`) y en
   `src/panel/server.ts:104` (`INBOX_WHERE`). Aunque los mensajes lleguen, se
   descartan antes de guardarse y antes de disparar webhooks.
3. **Historial no recuperado.** `makeWASocket` usa `syncFullHistory: false`
   (`src/baileys/session.ts:199`) y no se dispara ninguna sincronización al
   reconectar, así que un hueco de mensajes no se rellena.

## 2. Objetivo

- Persistir y mostrar los mensajes recibidos mientras el servicio estuvo caído.
- Recuperar el historial reciente de los chats conocidos al reconectar.
- Mostrar los mensajes de grupos de WhatsApp en el mismo inbox que los
  individuales, con el nombre del autor de cada mensaje.

## 3. No objetivo

- Historial completo al vincular (`syncFullHistory` sigue en `false`).
- Modelo de grupos completo (miembros, administración, roles de grupo).
- Auto-respuestas y opt-out en grupos (siguen siendo solo para individuales).
- Garantizar la recuperación de mensajes que llegaron con la sesión
  desvinculada (logout + re-vinculación por QR); ver §9.

## 4. Alcance

### A. Mensajes offline e historial

**A1. Aceptar upserts `append`.**
En `WaSession.onUpsert` (`src/baileys/session.ts:276`) procesar los payloads de
tipo `'notify'` y `'append'`. Los mensajes `append` son mensajes reales que
llegaron offline: se tratan igual que `notify` (persistencia, webhook,
auto-respuesta en individuales). Se añade una guarda de idempotencia por
`wa_message_id` antes de procesar, en `SessionManager.onMessage`, para evitar
duplicados cuando un mismo mensaje llegue por más de una vía.

**A2. Sincronización de historial al reconectar.**
En `SessionManager.onReady` (`src/baileys/manager.ts:387`), tras dejar la sesión
en `ready`, disparar en segundo plano (sin `await`, para no demorar el ready) un
método `resumeHistories(sessionId)` que:

- Lista las conversaciones de la sesión ordenadas por `last_message_at DESC`.
- Filtra las que tengan actividad dentro de `HISTORY_SYNC_MAX_AGE_DAYS`.
- Toma hasta `HISTORY_SYNC_MAX_CHATS`.
- Omite las sincronizadas en las últimas 12 h (`history_synced_at`).
- Llama a la sincronización existente (`syncHistory`) de a una, con la pausa ya
  incorporada en `WaSession.fetchHistory` (`session.ts:592`), capturando errores
  por chat para no abortar el resto.
- Se protege con un `Set` en memoria para no solapar ejecuciones de la misma
  sesión.

Si `HISTORY_SYNC_ON_READY` es `false`, no se ejecuta.

**A3. `syncFullHistory`** permanece en `false`.

### B. Grupos en el mismo inbox

**B1. Levantar el filtro de grupos.**
- `src/baileys/manager.ts` `isInboxChat`: permitir `@g.us`; seguir excluyendo
  `@broadcast` y `@newsletter`.
- `src/baileys/manager.ts:437` (`onMessage`) y `:533` (`onHistory`): reemplazar
  la condición por `if (!isInboxChat(msg.chatId)) return;`.
- `src/core/conversations.ts` `inboxWhere`: dejar de excluir `@g.us`.
- `src/panel/server.ts` `INBOX_WHERE`: dejar de excluir `@g.us`.

**B2. Nombre del grupo y autor del mensaje.**
- Nuevo `WaSession.groupSubject(jid)`: resuelve el asunto con
  `sock.groupMetadata(jid)`, con caché en memoria (`Map`). Se siembra una vez al
  quedar `ready` con `groupFetchAllParticipating`. Si falla, se usa el nombre
  guardado o el JID.
- En `onMessage`/`onHistory`, cuando `msg.isGroup`, el `contactName` de la
  conversación es el **asunto del grupo** (no el `pushName` del participante).
- El `pushName` de cada mensaje de grupo (el participante) se guarda como
  remitente del mensaje (`messages.contact_name`, ya existente) y se expone en
  el DTO como `sender_name`.

**B3. `participant` para citas y acuses de lectura.**
- Nueva columna `messages.sender_jid` (migración idempotente) con el
  `key.participant` de los mensajes entrantes de grupo.
- `InboundMessage` incorpora `senderJid`.
- `QuotedRef` incorpora `participant` opcional; `buildQuoted` lo incluye en el
  `key` cuando existe, para citar correctamente mensajes de grupo.
- `markChatRead` incluye `participant` en las claves de `readMessages` cuando
  el chat es grupo (tomado de `sender_jid`).

**B4. Webhooks.**
- Los grupos disparan `message.received` (el payload ya distingue
  `kind: 'group'` e `isGroup`). Se añaden `participant` (JID) y
  `participantName` (pushName).
- No aplican `isOptoutRequest()` ni la auto-respuesta para grupos.

### C. Configuración y UI

**C1. Variables de entorno** (`.env.example`), con defaults:
- `HISTORY_SYNC_ON_READY` (bool, `true`)
- `HISTORY_SYNC_COUNT` (int, `50`)
- `HISTORY_SYNC_MAX_CHATS` (int, `50`)
- `HISTORY_SYNC_MAX_AGE_DAYS` (int, `30`)

**C2. UI (`public/app.js`).**
- Burbujas entrantes de grupo muestran el nombre del autor (`sender_name`).
- La lista y la cabecera marcan los grupos (ícono/badge "Grupo") y usan el
  asunto del grupo como nombre.
- `MessageDTO` expone `sender_name` (`src/core/conversations.ts`) y `isGroup`
  (derivado de `chat_id.endsWith('@g.us')`).

## 5. Modelo de datos

- `messages.sender_jid TEXT` (migración en `src/db/index.ts`
  `addColumnIfMissing`).
- Sin tablas nuevas.

## 6. Archivos afectados

- `src/baileys/session.ts` — aceptar `append`; `groupSubject`; `senderJid`;
  `QuotedRef.participant`; `buildQuoted`.
- `src/baileys/manager.ts` — filtros; `isInboxChat`; rama de grupos en
  `onMessage`/`onHistory`; `sender_jid`; webhook con participant; idempotencia;
  `resumeHistories`; `markChatRead` con participant.
- `src/core/conversations.ts` — `inboxWhere`; `MessageDTO.sender_name`.
- `src/panel/server.ts` — `INBOX_WHERE`.
- `src/config.ts` — nuevas variables.
- `src/db/index.ts` — migración `sender_jid`.
- `.env.example` — documentar variables.
- `public/app.js` — render de autor y marca de grupo.

## 7. Manejo de errores

- `groupMetadata` puede fallar o tardar: se cachea y se degrada al JID.
- `fetchMessageHistory` puede no estar soportado o fallar por chat: se captura
  y se continúa con el siguiente.
- La descarga de media de mensajes `append` puede fallar: ya se captura por
  mensaje (`session.ts:401`).
- Duplicados: guarda por `wa_message_id` antes de persistir/disparar webhook.

## 8. Verificación

- `npm run typecheck` y `npm run build`.
- Prueba manual:
  1. Con la sesión vigente, detener el servicio, enviar mensajes individuales y
     de grupo, reiniciar: deben aparecer.
  2. Al reconectar, verificar la sincronización de historial en los chats
     conocidos.
  3. Mensaje de grupo: se ve el nombre del grupo y el autor de cada burbuja; el
     webhook llega con `kind: group` y `participant`.
  4. Confirmar que auto-respuesta y opt-out **no** se disparan en grupos.

## 9. Limitaciones conocidas

- Tras un logout y re-vinculación por QR, WhatsApp puede no reentregar los
  mensajes del período desvinculado; la sincronización recupera solo lo que el
  servidor ofrezca.
- No se implementa administración de grupos (crear, añadir/quitar miembros).
