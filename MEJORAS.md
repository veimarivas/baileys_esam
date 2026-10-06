# Plan de Mejora Funcional y Estrategia Anti-Baneo para `baileys_esam`

## 1. Introducción y Objetivos

El objetivo de este documento es definir la hoja de ruta para mejorar el funcionamiento general de `baileys_esam` e implementar un **Sistema Anti-Baneo Inteligente y Administrable**.

WhatsApp bloquea números basándose en dos factores principales: **comportamiento anómalo** (envíos masivos en poco tiempo) y **reportes de usuarios** (spam/bloqueos manuales). Este plan aborda ambos frentes mediante lógica de negocio, configuración en el panel y optimización del motor.

---

## 2. Estrategia Anti-Baneo (Motor y Lógica)

El sistema anti-baneo dejará de ser un simple "delay" fijo para convertirse en un motor de reglas dinámicas.

### 2.1. Calentamiento de Números (Warm-up)

Los números nuevos o recién vinculados tienen un "límite de confianza" bajo.

- **Lógica**: El sistema aplicará un multiplicador de días.
  - _Día 1_: Máx 50 mensajes, delay de 3-5 min entre cada uno.
  - _Día 2_: Máx 100 mensajes, delay de 2-3 min.
  - _Día 3-7_: Aumento progresivo hasta alcanzar el límite de la plantilla.
- **Reset de confianza**: Si un número recibe un bloqueo o reporte, su nivel de confianza vuelve a 0 y reinicia el warm-up.

### 2.2. Pacing Dinámico y Ritmo Humano (Throttling)

- **Delay Aleatorio (Jitter)**: Nunca enviar con un delay exacto (ej. siempre 60s). El sistema usará rangos (ej. `min: 45s`, `max: 90s`).
- **Horarios Naturales**: Respetar franjas horarias. Configurable por país/zona del destinatario. No enviar entre 11:00 PM y 7:00 AM a menos que sea explícitamente permitido.
- **Pausas por "Fatiga"**: Cada X mensajes (ej. 20), el sistema hace una pausa larga aleatoria (5 a 15 minutos) para simular que el operador está haciendo otra cosa.

### 2.3. Gestión de Reportes y Opt-Out (Crítico)

_La causa #1 de baneos son los reportes de los usuarios._

- **Detección de Bloqueo**: Si Baileys reporta que el usuario bloqueó al número, el sistema marca el destino como `BLOCKED` y lo añade a la lista negra global.
- **Palabras Clave de Opt-Out**: Si el usuario responde "STOP", "BAJA", "NO", el sistema lo marca como `OPTED_OUT` y bloquea futuros envíos automáticos.
- **Tasa de Reportes**: Si la tasa de entrega con éxito baja del 85% en un lote, el lote se pausa automáticamente y notifica al admin.

### 2.4. Variación de Contenido y Plantillas

- **Spinning de Texto**: Permitir variables en las plantillas (ej. `{nombre}`, `{empresa}`) y sinónimos aleatorios (ej. `{Hola|Buenos días|Qué tal}`) para que no se envíe el _hash_ exacto del mismo mensaje miles de veces.
- **Media Mixta**: Intercalar mensajes de texto con imágenes, audios o stickers. Los mensajes puramente textuales masivos son más flaggeados.

### 2.5. Rotación y Fallback de Sesiones

- Si una sesión (`wa_session`) es detectada como "en riesgo" (muchos errores de envío, desconexiones frecuentes o reportes), el sistema la pone en `CUARENTENA` y rota los lotes pendientes a otra sesión sana del mismo pool.

---

## 3. Panel de Administración Anti-Baneo (UI/UX en Velzon)

Se añadirá una nueva sección en el panel (`:8030`) llamada **"Políticas Anti-Baneo"** para que los administradores configuren estas reglas sin tocar código.

### 3.1. Configuración Global y por Sesión

- **Perfil de Riesgo**: Selector (Bajo, Medio, Alto).
  - _Bajo_: Delays largos, warm-up estricto (ideal para números nuevos o muy valiosos).
  - _Alto_: Delays cortos, sin warm-up (solo para números desechables o de alto volumen).
- **Límites por Hora/Día**: Inputs numéricos para topear envíos.
- **Franja Horaria Permitida**: Selectores de hora de inicio y fin.
- **Lista Negra (Blacklist)**: Tabla para importar/exportar números bloqueados, opt-out o dominios de correo asociados a spam.

### 3.2. Monitor de Salud en Tiempo Real

Un dashboard con semáforos para cada sesión:

- 🟢 **Verde**: Saludable, operando normal.
- 🟡 **Amarillo**: Tasa de entrega bajando, acercándose al límite diario, o en modo warm-up.
- 🔴 **Rojo**: En cuarentena, pausada por el sistema, o requiere re-vinculación.
- **Métricas**: Mensajes enviados, entregados, leídos, fallidos y bloqueados en las últimas 24h.

---

## 4. Mejoras de Funcionamiento General (Performance)

Para soportar la lógica anti-baneo y el panel en tiempo real, se optimizará el núcleo.

### 4.1. Optimización de SQLite y Colas

- **Modo WAL (Write-Ahead Logging)**: Habilitar `PRAGMA journal_mode=WAL;` en SQLite para permitir lecturas concurrentes sin bloquear los webhooks entrantes mientras se escriben lotes.
- **Cola de Lotes (Batch Queue)**: Implementar un sistema de colas basado en SQLite (o migrar a BullMQ/Redis si el volumen escala a >10k msgs/hora) para que el _pacing_ no consuma memoria RAM manteniendo `setTimeout` gigantes.
- **VACUUM Automático**: Tarea programada semanal para limpiar la base de datos de mensajes antiguos y optimizar el tamaño del archivo `.sqlite`.

### 4.2. Manejo de Errores y Reconexión Inteligente

- **Backoff Exponencial en Webhooks**: Si `cronogramas` o el receptor de webhooks cae, `baileys_esam` debe reintentar con backoff exponencial y guardar los eventos en una tabla `webhook_queue` para no perder `message.ack` o `message.received`.
- **Reconexión de Baileys**: Mejorar el manejo de `connection.update`. Si el estado es `close` con código de error de red, reconectar inmediatamente. Si es por logout/ban, marcar la sesión como `DEAD` y notificar al admin por correo/panel.

### 4.3. Limpieza de Media y Almacenamiento

- **Política de Retención**: Configurar en `.env` o panel cuántos días se conservan los archivos en `data/media/`. Un script cron diario borrará archivos huérfanos o mayores a X días para evitar que el disco del VPS se llene y tumbe el servicio.

---

## 5. Roadmap de Implementación (Fases)

### Fase 1: Núcleo Anti-Baneo y Base de Datos (Semanas 1-2)

- [x] Implementar modo WAL en SQLite y optimizar queries de lotes. _(WAL + `synchronous=NORMAL` + `busy_timeout` en `src/db/index.ts`)_
- [x] Crear tabla `anti_ban_policies` y `session_health_metrics`. _(con presets de riesgo bajo/medio/alto y override por sesión)_
- [x] Desarrollar el motor de "Warm-up" y "Pacing con Jitter" en el _runner_ de lotes. _(`src/core/anti-ban.ts`, `src/core/pacing.ts`, límites diario/horario y pausas por fatiga en `src/core/batches.ts`)_
- [x] Implementar detección automática de `BLOCKED` y `OPTED_OUT` desde los eventos de Baileys. _(`looksLikeBlock`/`markBlocked` en `src/core/optout.ts` + reset de confianza)_

### Fase 2: Panel de Administración (Semanas 3-4)

- [x] Crear vistas en el panel Velzon para "Políticas Anti-Baneo". _(`/anti-ban` en `src/panel/anti-ban.ts`: perfil de riesgo, límites, delays, ventana, warm-up, pausas, por sesión y global)_
- [x] Implementar el Dashboard de "Salud de Sesiones" (Semáforos y métricas). _(`healthDashboard()` con métricas 24h y acciones de cuarentena/reset)_
- [x] Añadir formulario de importación de Lista Negra (Blacklist). _(alta manual, importación por líneas y exportación CSV)_

### Fase 3: Variación de Contenido y Rotación (Semana 5)

- [x] Implementar motor de _Spinning_ de texto (sintaxis `{opción1|opción2}`) en las plantillas. _(`spin()`/`renderTemplate()` en `src/core/templates.ts`)_
- [x] Crear lógica de "Pool de Sesiones" para rotar lotes si una sesión entra en cuarentena. _(`src/core/session-pool.ts` + cuarentena automática por fallos consecutivos en el runner y acciones en el panel)_

### Fase 4: Optimización de Colas y Webhooks (Semana 6)

- [x] Migrar el procesamiento de lotes a un sistema de colas persistente (evitar pérdida de memoria). _(`batches`/`batch_items` ya son la cola persistente: el runner reanuda `running`/`scheduled` con `resumePending()` y marca cada destinatario; no se pierde nada al reiniciar. Cola externa dedicada solo si se superan ~10k msgs/h.)_
- [x] Implementar cola de reintentos para webhooks salientes. _(`webhook_queue` + `src/core/webhook-queue.ts` con backoff exponencial y worker; `dispatchEvent` encola al fallar)_
- [x] Configurar tarea de limpieza automática de `data/media/`. _(`src/core/retention.ts`: borra archivos > `MEDIA_RETENTION_DAYS` a diario y hace `VACUUM` semanal)_

---

## 6. Métricas y KPIs de Éxito

Para validar que el plan funciona, se medirá mensualmente:

1. **Tasa de Baneos/Desvinculaciones**: Debe reducirse a < 2% mensual.
2. **Tasa de Entregabilidad**: Mantenerse > 90% en lotes en caliente.
3. **Tasa de Reportes/Bloqueos**: Debe mantenerse < 5% (WhatsApp permite un margen, pero por encima de eso activa alertas en la API oficial y baneos en no-oficial).
4. **Uptime del Servicio**: > 99.5% (gracias a las mejoras de reconexión y colas).

---

_Documento generado como extensión de `PLAN.md` y `IMPLEMENTACION.md` para `baileys_esam`._

---

## Anexo — Estado de implementación

Todas las fases (1–4) y el _spinning_ de texto se implementaron.

**Ampliación (2026-10-06, `CAMBIOS.md` §14.3):**

- Se corrigió un error que hacía que **los lotes salieran sin ninguna espera** entre
  mensajes: ahora el ritmo (jitter, pausas por cansancio, enfriamiento entre
  programas) se calcula en cada envío, también tras pausas o la espera de la ventana.
- Nuevas reglas configurables por política (global o por sesión, con presets):
  simular "escribiendo…/grabando", separación mínima entre envíos automáticos, tope
  de envíos por minuto (incluye el panel), **tope diario de contactos nuevos**,
  verificación de que el número tenga WhatsApp, pausa automática del lote si cae la
  entregabilidad (§2.3) y cantidad de fallos seguidos para la cuarentena.
- El motivo de una pausa automática se muestra en la tarjeta y en el detalle del lote.
- Diagnóstico de mensajes que no se pudieron descifrar en el tablero de salud. Para el detalle de archivos,
decisiones y correcciones posteriores (integración SSO con cronogramas, resolución de chats `@lid`,
monitoreo/reportes con filtros y gráficos, cuarentena/pool de sesiones, cola de webhooks, retención de
media), ver **`CAMBIOS.md`** (raíz de `baileys_esam`). En cronogramas, ver **`CAMBIOS.md`**.
