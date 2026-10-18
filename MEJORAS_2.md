# Plan de mejoras — `baileys_esam` (segunda etapa)

> Documento de decisión. **No describe trabajo hecho**: sirve para elegir qué se
> implementa y en qué orden. Complementa a `MEJORAS.md` (anti-baneo) y a
> `CAMBIOS.md` (historial de lo entregado).

## 0. Estado actual verificado

Antes de proponer nada se revisó el código. Estos son hechos comprobados, no
suposiciones:

| Área | Estado |
|---|---|
| Marcadores `TODO`/`FIXME` en `src/` | **0**. El código no tiene deuda anotada. |
| Pruebas automatizadas | **No hay ninguna** (ni framework ni script `test`). |
| Webhooks | Firmados, con cola y reintentos con backoff (`src/core/webhook-queue.ts`). |
| Búsqueda de mensajes | FTS5 con degradación a `LIKE` (`src/core/conversations.ts:626`). |
| Índices SQLite | Completos: `idx_messages_convo(_time)`, `idx_reactions_message`, `idx_webhook_queue_due`, etc. |
| `ANALYZE` / `PRAGMA optimize` | **Nunca se ejecutó** (`sqlite_stat1` no existe). |
| Retención | Borra media a diario; `VACUUM` semanal solo si `AUTO_VACUUM=true` (`src/core/retention.ts`). No poda `webhook_logs`, `audit_logs` ni `notifications`. |
| Salud de sesión | `health.ts` con cuarentena + evento `session.disconnected` por webhook. |
| Aviso de caída de sesión | Solo por webhook; **no genera notificación en el panel**. |
| Typing / presencia | Ya implementado (`simulateTyping`, `presenceSubscribe`, `onPresence`). |
| Estado y asignación de conversación | **Backend listo y sin usar**: `conversations.status` / `assigned_agent_id`, filtro por estado en `listConversations`, y `bulkAction` con `close`/`open`/`pending`/`mark_read`/`assign` (`src/core/conversations.ts:557`). El panel **no usa nada de esto**: `/inbox/bulk` solo acepta `mark_read` (`src/panel/inbox.ts:1145`) y el cliente pide la lista sin filtro de estado (`public/app.js:2386`). |
| Transcodificación / miniaturas | `sharp` ya es dependencia, pero **no se generan miniaturas**. |
| BD actual | ~154 MB + 51 MB de WAL; `messages` ~110 k filas. |

**Conclusión:** el sistema ya es funcional y completo en features. Lo que falta es
**red de seguridad (pruebas), avisos operativos, inteligencia anti-baneo y las
acciones de mensaje que WhatsApp sí tiene**. No se propone "más pantallas".

---

## 1. Cómo priorizar

Cada ítem se evalúa con tres ejes:

- **Impacto**: cuánto protege o mejora la operación diaria.
- **Esfuerzo**: S (≤ media jornada), M (1–2 jornadas), L (más de 2).
- **Riesgo**: probabilidad de romper algo existente (Bajo / Medio / Alto).

Regla de oro del proyecto: **nada puede afectar el funcionamiento actual**. Por eso
el bloque A (red de seguridad) va primero.

---

## A. Robustez y mantenimiento  ·  *bajo riesgo, habilita el resto*

### A1. Pruebas automatizadas mínimas
- **Qué**: usar el runner nativo `node:test` (Node ≥ 22.5, ya requerido) y agregar
  `"test": "node --test test/"` en `package.json`. Cubrir solo lo crítico:
  - `phoneKeyOf` / `personTagsByKeys` (normalización de números y acentos).
  - Ritmo anti-ban (`pacing.ts`) y ventana horaria.
  - Máquina de estados de lotes (`batches.ts`, `batch-service.ts`).
  - `ftsQuery` (armado de la consulta FTS5).
  - `waFormatHtml` (formato de WhatsApp) y `reactionActor`.
- **Por qué**: hoy **no existe ninguna prueba**. Cada cambio se valida a mano en
  producción; un error en el motor de lotes puede quemar un número.
- **Esfuerzo**: M · **Riesgo**: Bajo · **Aceptación**: `npm test` corre en verde y
  falla si se rompe una regla crítica.
- **✅ Hecho (2026-10-18)**: `npm test` con el runner nativo y **74 pruebas** sobre
  base temporal aislada (nadie toca `data/` real): teléfonos/JIDs, pacing y ventana
  horaria, CSV, bajas/bloqueos, `phone_key`/personas y campana. `npm run typecheck`
  también revisa las pruebas. Quedaron fuera `ftsQuery` (privado en
  `conversations.ts`) y `waFormatHtml` (dentro del IIFE de `public/app.js`); ver
  `CAMBIOS.md` §44.

### A2. Avisos de caída de sesión en el panel
- **Qué**: al recibir `session.disconnected` / cuarentena (`health.ts`), crear una
  notificación (`src/core/notifications.ts`) para el dueño y supervisores, con
  enlace a `/settings`. Opcional: aviso por WhatsApp a un número de guardia.
- **Por qué**: hoy el evento solo sale por webhook; si nadie mira el panel, el
  número queda caído sin que el equipo lo sepa.
- **Esfuerzo**: S · **Riesgo**: Bajo · **Aceptación**: al desconectar una sesión de
  prueba aparece la campanita y el aviso.
- **✅ Hecho (2026-10-18)**: aviso `session_down` al dueño y al Super Admin con enlace
  a Configuración → Conexión. Inmediato en caídas graves; demorado
  (`SESSION_DOWN_ALERT_MINUTES`, 3 por defecto) y cancelable en las transitorias; no
  se repite mientras el aviso anterior siga sin leer y el control es por línea.
  Falta (no incluido): aviso por WhatsApp a un número de guardia y el disparo desde
  cuarentena (`session-pool.ts`).

### A3. Rotación de logs y `/healthz`
- **Qué**: rotación de `sout.log`/`serr.log` (o `pm2-logrotate`) y una ruta
  `GET /healthz` que devuelva estado de proceso, sesiones conectadas y tamaño de la
  BD, para que el gestor de procesos pueda reiniciar si no responde.
- **Por qué**: los logs crecen sin límite y hoy no hay forma de que el supervisor
  detecte un cuelgue.
- **Esfuerzo**: S · **Riesgo**: Bajo · **Aceptación**: los logs rotan y `/healthz`
  responde JSON.

### A4. Mantenimiento de la base de datos
- **Qué**: ejecutar **`ANALYZE`/`PRAGMA optimize`** periódico (nunca se hizo) y
  podar filas viejas de `webhook_logs`, `audit_logs` y `notifications` dentro de
  `startRetentionWorker`.
- **Por qué**: los índices existen pero sin estadísticas el planificador de SQLite
  puede elegir planes malos; y las tablas de log crecen para siempre.
- **Esfuerzo**: S · **Riesgo**: Bajo (solo toca filas antiguas) · **Aceptación**: la
  BD deja de crecer por logs y las consultas del inbox siguen igual de rápidas.

---

## B. Anti-baneo inteligente  ·  *mayor riesgo de negocio*

> Ya esbozado en `MEJORAS.md` §2. Acá se acota a lo implementable.

### B1. Calentamiento progresivo por número (warm-up)
- **Qué**: límite diario y delay que escalan según los días de vida de la sesión
  (día 1: 50 msj / 3–5 min; día 2: 100 / 2–3 min; …). Guardar la fecha de alta en
  `sessions` y aplicar el multiplicador en `pacing.ts` / `anti-ban.ts`.
- **Por qué**: es la causa más común de baneo de números nuevos.
- **Esfuerzo**: M · **Riesgo**: Medio (toca el ritmo de envío) · **Aceptación**: un
  número nuevo no supera su cupo del día y el panel muestra el día de calentamiento.

### B2. Pausa por cansancio y enfriamiento automático
- **Qué**: si la tasa de fallos o de descifrado sube en una ventana corta
  (`anti-ban-monitor.ts` ya mide), pausar el lote y poner la sesión en cuarentena
  con aviso (usa A2).
- **Por qué**: hoy el sistema no se frena solo cuando WhatsApp empieza a rechazar.
- **Esfuerzo**: M · **Riesgo**: Medio · **Aceptación**: al simular fallos el lote se
  pausa y se avisa.

### B3. Panel de salud del número (semáforo)
- **Qué**: vista que combine `health.ts`, `session_health_metrics` y las políticas
  anti-ban en un semáforo (verde/amarillo/rojo) con la razón y la acción sugerida.
- **Por qué**: hoy los datos existen pero están repartidos en varias pantallas.
- **Esfuerzo**: M · **Riesgo**: Bajo (solo lectura) · **Aceptación**: una sola
  pantalla responde "¿este número está sano?".

---

## C. Inbox: acciones que WhatsApp tiene y acá faltan

> Verificado en `src/panel/inbox.ts`: **no existen** borrar, reenviar ni destacar.

### C1. Borrar para todos, reenviar y destacar
- **Qué**: con Baileys (`sock.sendMessage(jid, { delete: key })` y `chatModify` para
  destacar), más las rutas y botones en la burbuja. *Verificar las firmas exactas
  contra Baileys 7.0.0-rc14.*
- **Por qué**: son operaciones básicas que hoy obligan a salir del panel.
- **Esfuerzo**: M · **Riesgo**: Medio (borra mensajes reales) · **Aceptación**:
  borrar desaparece para el cliente, reenviar pide destino y destacar queda local.

### C2. Archivar / fijar / silenciar conversación
- **Qué**: `chatModify({ archive | pin | mute })` + estado local en `conversations`.
- **Esfuerzo**: M · **Riesgo**: Bajo · **Aceptación**: el estado se mantiene entre
  recargas y se refleja en la lista.

### C3. Estado y asignación de conversación  ⭐ *mejor relación valor/costo*
- **Qué**: exponer lo que **ya está hecho en el backend**: pestañas
  Abierta / Pendiente / Cerrada (el backend filtra con `listConversations({status})`),
  asignar a un agente (`assigned_agent_id`, ya viene en el DTO como `assigned_agent`)
  y acciones en lote (abrir/cerrar/pendiente/asignar) llamando a `bulkAction`.
  Cambios mínimos: ampliar la validación de `/inbox/bulk` (`src/panel/inbox.ts:1145`),
  agregar una ruta para asignar una sola conversación y la UI en `public/app.js`.
- **Por qué**: con varias líneas y varios agentes hoy no hay forma de saber quién
  lleva cada chat ni de cerrar un caso resuelto. Y el trabajo pesado **ya está pago**:
  solo falta la pantalla. Nota: la asignación que existe hoy es de **notas/tareas**
  (`contact_notes.assigned_to`), no de conversaciones.
- **Esfuerzo**: S · **Riesgo**: Bajo (no toca envío ni conexión) · **Aceptación**: se
  puede filtrar por estado y por "mías / sin asignar", asignar y cerrar.

### C4. Buscar dentro del chat con salto a resultados
- **Qué**: búsqueda FTS5 acotada a la conversación activa + botones anterior/siguiente.
- **Esfuerzo**: S · **Riesgo**: Bajo · **Aceptación**: encuentra y salta a la burbuja.

### C5. Exportar conversación
- **Qué**: descargar el historial en `.txt` (y `.zip` con media, reusando lo que ya
  sirve `/media/:id`).
- **Por qué**: pedidos de respaldo o de evidencia.
- **Esfuerzo**: S · **Riesgo**: Bajo · **Aceptación**: se descarga el archivo.

### C6. Programar envío desde el inbox
- **Qué**: exponer el `scheduler.ts` existente en el compositor ("enviar a las…").
- **Esfuerzo**: S · **Riesgo**: Bajo · **Aceptación**: el mensaje se envía a la hora
  indicada y queda visible como programado.

---

## D. Rendimiento y almacenamiento

### D1. Miniaturas de media (usa `sharp`)
- **Qué**: generar miniatura al guardar la media y servirla en la lista y en el hilo
  antes de cargar el original.
- **Por qué**: hoy se baja la imagen completa (varios MB) incluso para verla chica.
- **Esfuerzo**: M · **Riesgo**: Bajo (se conserva el original) · **Aceptación**: el
  hilo abre mucho más liviano en chats con muchas fotos.

### D2. Paginación / virtualización del hilo
- **Qué**: revisar cuántos mensajes monta el DOM y recortar los que quedan fuera de
  pantalla en chats muy largos.
- **Por qué**: `messages` tiene ~110 k filas; un chat histórico puede colgar el panel.
- **Esfuerzo**: M · **Riesgo**: Medio (toca el scroll) · **Aceptación**: chat de
  miles de mensajes con scroll fluido.

### D3. Compresión y limpieza de huérfanos
- **Qué**: borrar archivos de `data/media` sin fila asociada (la retención actual
  borra por antigüedad, no por referencia rota).
- **Esfuerzo**: S · **Riesgo**: Bajo · **Aceptación**: el espacio en disco se
  mantiene estable.

---

## E. Reportes e integraciones

### E1. Exportar reportes a CSV/PDF
- **Qué**: botón de descarga en monitoreo/reportes (`monitoring.ts`, `pdf.ts` ya existe).
- **Esfuerzo**: S · **Riesgo**: Bajo · **Aceptación**: se descarga el mismo dato que
  se ve en pantalla.

### E2. Métricas por programa y por agente
- **Qué**: cortar `monitoringData` / `reportsData` por `person_programs` y por usuario.
- **Esfuerzo**: M · **Riesgo**: Bajo · **Aceptación**: se puede comparar programas.

### E3. Más eventos de webhook
- **Qué**: publicar `message.reaction`, `message.edited`, `message.deleted` en
  `webhooks.ts` (hoy solo salen los principales).
- **Esfuerzo**: S · **Riesgo**: Bajo · **Aceptación**: un integrador recibe el evento.

---

## 2. Orden sugerido

| Fase | Contenido | Por qué en este orden |
|---|---|---|
| **1** | A1, A2, A3, A4 | Red de seguridad y avisos. Bajo riesgo, protege todo lo que venga después. |
| **2** | B1, B2, B3 | El riesgo de negocio (quemar números) es el más caro. |
| **3** | C3, C1, C4, C6 | C3 primero: es el mayor beneficio con el menor esfuerzo (el backend ya está). Después, las acciones del inbox que más se extrañan. |
| **4** | D1, E1, E2 | Rendimiento, reportes e integraciones, cuando ya hay estabilidad y pruebas. |

## 3. Lo que **no** haría (todavía)

- Reescribir el frontend en un framework: `public/app.js` es un módulo grande pero
  funciona y no tiene bundler; migrarlo es riesgo alto y beneficio inmediato bajo.
- Migrar de SQLite a Postgres: el volumen actual no lo justifica.
- Tocar el formato de la API v1 que consume **cronogramas**: es un contrato externo.

## 4. Cómo sabremos que mejoró

- `npm test` en verde y **cero regresiones** en las pruebas manuales del inbox.
- Un número nuevo **nunca** supera su cupo de calentamiento (medible en
  `session_health_metrics`).
- Una sesión caída genera aviso **sin que nadie abra el panel**.
- Tamaño de la BD y del disco **estables** mes a mes.
- El hilo de un chat histórico abre con scroll fluido.

---

## 5. Próximo paso

Elegir uno o más ítems y desarrollarlos con el mismo criterio que las mejoras
anteriores: verificar con `node --check`, `npm run typecheck`, `npm run build` y
`npm run check:assets`, documentar en `CAMBIOS.md` y subir a GitHub.

Tres arranques razonables, según el objetivo:

- **Máxima seguridad**: **A1 + A2** (pruebas y avisos). Bajo riesgo, protege todo.
- **Mejor valor por esfuerzo**: **C3** (estado y asignación de conversación), porque
  el backend ya está y solo falta la pantalla.
- **Mayor impacto de negocio**: **B1** (calentamiento de números), para dejar de
  arriesgar las líneas nuevas.
