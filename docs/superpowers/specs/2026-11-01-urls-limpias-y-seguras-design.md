# URLs limpias y seguras · Diseño

Fecha: 2026-11-01
Estado: propuesto
Alcance: panel web completo (`src/panel` y `public/app.js`)

## 1. Problema

Hoy la navegación del panel mezcla estado de navegación con filtros y mensajes:

- Pestañas y secciones viajan como `?tab=`, `?cat=`, `?estado=`, `?area=`, `?edit=`, `?nota=`.
- Los avisos de éxito/error viajan como `?ok=` y `?error=`. Cualquiera puede inventar una URL con un mensaje falso y mostrarlo dentro del panel.
- `safeNext()` acepta valores como `//sitio-externo.com`, lo que permite una redirección abierta después del login/SSO.
- No hay validación uniforme de IDs, sesiones, áreas ni categorías en las rutas.

El resultado son URLs largas, difíciles de recordar y con datos de presentación que no deberían estar en la barra de direcciones.

## 2. Objetivos

1. Dejar en la ruta solo la navegación y las entidades seleccionadas.
2. Mantener en query únicamente búsquedas, rangos de fecha y filtros opcionales.
3. Sacar los mensajes de éxito/error de la URL.
4. Cerrar la redirección abierta y agregar validaciones/cabeceras básicas.
5. No romper enlaces guardados: las URLs viejas redirigen a las nuevas.
6. No migrar la base de datos.

## 3. No objetivos

- No se cambia el diseño visual de las pantallas.
- No se implementa CSRF ni autenticación nueva en esta etapa.
- No se renombran los endpoints JSON internos (`/inbox/*`, `/api/*`, `/events`).
- No se cambia el esquema de la base ni los IDs.

## 4. Principios de URL

- **Path = navegación.** Pestaña, sección, entidad seleccionada y página del historial van en el path.
- **Query = filtros.** Búsqueda (`q`), fechas (`from`, `to`), programa, cuenta, área, tipo y cursores de paginación pueden seguir en query.
- **Slugs en español, minúsculas y estables.** Los slugs no dependen del texto visible.
- **Sin mensajes en la URL.** `ok` y `error` dejan de leerse; los mensajes van por cookie firmada.
- **Rutas canónicas sin barra final.**
- **Parámetro inválido en path = 404.** Un filtro viejo inválido en query se descarta al redirigir.

## 5. Mapa canónico

### 5.1 Anti-Baneo

| Ruta canónica | Significado |
|---|---|
| `/anti-ban` | Redirige 302 a `/anti-ban/monitoreo` |
| `/anti-ban/monitoreo` | Todas las líneas, todas las áreas |
| `/anti-ban/monitoreo/todas` | Igual que la anterior (explícito) |
| `/anti-ban/monitoreo/vinculadas` | Solo líneas vinculadas |
| `/anti-ban/monitoreo/sin-vincular` | Solo líneas sin vincular |
| `/anti-ban/monitoreo/todas/<área>` | Todas las líneas de un área |
| `/anti-ban/monitoreo/<estado>/<área>` | Estado + área combinados |
| `/anti-ban/politicas` | Políticas |
| `/anti-ban/lista-negra` | Lista negra completa |
| `/anti-ban/lista-negra/<fuente>` | Filtrada por fuente: `manual`, `reply`, `blocked` |
| `/anti-ban/bitacora` | Bitácora |
| `/anti-ban/line/<id>` | Detalle de línea (ya existe) |
| `/anti-ban/session/<id>` | Política de línea (ya existe) |

- `<estado>` ∈ `todas`, `vinculadas`, `sin-vincular`.
- `<área>` es la clave del área en minúsculas y codificada; `sin-area` representa las líneas sin área.
- La búsqueda de la lista negra sigue en `?q=`.

### 5.2 Seguimiento

| Ruta canónica | Significado |
|---|---|
| `/monitoring` | Redirige 302 a `/monitoring/pendientes/hoy` |
| `/monitoring/<pestaña>/<período>` | Pestaña y período |
| `/monitoring/<pestaña>/<período>/<sesión>` | Además filtra por número |
| `/monitoring/<pestaña>/rango?from=...&to=...` | Rango personalizado |

- `<pestaña>` ∈ `pendientes`, `actividad`, `numeros`.
- `<período>` ∈ `hoy`, `ayer`, `7d`, `30d`, `mes`, `rango`.
- `<sesión>` es el ID de sesión codificado.

### 5.3 Reportes

| Ruta canónica | Significado |
|---|---|
| `/reports` | Redirige 302 a `/reports/atencion/30d` |
| `/reports/<pestaña>/<período>` | Pestaña y período |
| `/reports/<pestaña>/<período>/<sesión>` | Además filtra por número |
| `/reports/users/<id>/<período>` | Ficha de usuario |
| `/reports/users/<id>/<período>/<sesión>` | Ficha con número seleccionado |

- `<pestaña>` ∈ `atencion`, `equipo`, `seguimiento`, `envios`, `masivos`.
- Filtros que quedan en query: `programa`, `account`, `area`, `tipo`, `from`, `to`.
- `/reports/export.csv` y `/reports/masivos.csv` mantienen query (son descargas, no navegación).

### 5.4 Auditoría

| Ruta canónica | Significado |
|---|---|
| `/audit` | Todas las categorías |
| `/audit/<categoría>` | Categoría seleccionada |

- `<categoría>` ∈ `conexiones`, `lotes`, `anti-baneo`, `lista-negra`, `cuentas`, `contenido`.
- Búsqueda, fechas, `auto` y el cursor `before` siguen en query.

### 5.5 Plantillas

| Ruta canónica | Significado |
|---|---|
| `/templates` | Lista |
| `/templates/<id>` | Lista con el editor de esa plantilla abierto |

- `<id>` debe ser entero positivo; si no, 404.
- Categoría y búsqueda siguen en `?cat=` y `?q=`.

### 5.6 Notas

| Ruta canónica | Significado |
|---|---|
| `/notes` | Todas |
| `/notes/<id>` | Abre una nota |
| `/notes/estado/<estado>` | Filtro inicial de estado |

- `<id>` debe ser entero positivo; si no, 404.
- `<estado>` ∈ `vencidas`, `hoy`, `semana`, `importantes`, `pendientes`, `derivadas`, `resueltas`, `todas`.
- El estado se entrega a `public/app.js` como atributo `data-status` para que el tablero arranque en ese filtro.

### 5.7 Historial de notificaciones

| Ruta canónica | Significado |
|---|---|
| `/notifications/history` | Todas / todas / página 1 |
| `/notifications/history/<categoría>` | Categoría / todas / página 1 |
| `/notifications/history/<categoría>/<estado>` | Categoría / estado / página 1 |
| `/notifications/history/<categoría>/<estado>/<página>` | Página indicada |

- `<categoría>` ∈ `todas`, `notas`, `whatsapp`, `envios`, `chats`, `sistema`.
- `<estado>` ∈ `todas`, `sin-leer`, `leidas`.
- `<página>` debe ser entero positivo.

### 5.8 Rutas que ya son limpias

`/conversations`, `/conversations/:chat`, `/batches`, `/batches/:id`, `/batches/confirm/:group`, `/settings`, `/settings/lines`, `/import`, `/quick-replies`, `/autoreplies`, `/optouts`, `/stickers`, `/policies`, `/audit`, `/users`.

Solo se les quita el `?ok=`/`?error=` de los redirects y se valida el path.

## 6. Compatibilidad y redirecciones

- Se implementa una capa de redirecciones legadas antes de las rutas nuevas.
- Todas las redirecciones legadas responden **302** para no dejar cachés permanentes durante la transición.
- Se conservan los parámetros que no son de navegación (`q`, `from`, `to`, `auto`, `before`, filtros).
- `?ok=` y `?error=` se **ignoran**: no se convierten en mensajes ni se muestran.
- Ejemplos:

| URL vieja | URL nueva |
|---|---|
| `/anti-ban?tab=monitoreo&estado=sin-vincular&area=marketing` | `/anti-ban/monitoreo/sin-vincular/marketing` |
| `/anti-ban?tab=lista-negra&source=reply&q=591` | `/anti-ban/lista-negra/reply?q=591` |
| `/monitoring?tab=actividad&period=7d` | `/monitoring/actividad/7d` |
| `/reports?tab=equipo&period=30d&area=marketing` | `/reports/equipo/30d?area=marketing` |
| `/reports/users/12?tab=equipo&period=7d` | `/reports/users/12/7d` |
| `/audit?cat=lotes&q=12` | `/audit/lotes?q=12` |
| `/templates?edit=8` | `/templates/8` |
| `/notes?nota=55` | `/notes/55` |
| `/notes?status=overdue` | `/notes/estado/vencidas` |
| `/notifications/history?cat=notas&estado=sin-leer&p=2` | `/notifications/history/notas/sin-leer/2` |

- Si una URL legada trae un valor inválido, se descarta ese valor y se redirige a la ruta canónica por defecto.

## 7. Mensajes de éxito y error

### 7.1 Cookie firmada de un solo uso

- Nombre: `esam_flash`.
- Contenido: `base64url(JSON) + "." + HMAC_SHA256(base64url(JSON))` con `config.secretKey`.
- JSON: `{ kind: 'ok' | 'error', message: string, exp: number }`.
- `message` máximo 500 caracteres; `exp` máximo 5 minutos.
- Atributos: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=300`; `Secure` cuando el pedido es HTTPS.
- Al leer: se valida firma y expiración, se borra la cookie y se devuelve el mensaje una sola vez. Si la firma no valida, se borra y se ignora.

### 7.2 API del módulo `src/panel/flash.ts`

- `setFlash(res, kind, message)`.
- `takeFlash(req, res)`.
- `flashOptions(req, res)` para inyectar `flash`/`error` en `renderLayout`.

### 7.3 Uso

- Todos los POST que hoy redirigen con `?ok=` o `?error=` usan `setFlash` antes del `res.redirect`.
- Las páginas GET usan un helper `sendPage(req, res, title, active, body, opts)` que consume el flash y llama a `renderLayout`.
- `renderLayout` sigue escapando el mensaje.
- Los endpoints JSON mantienen `{ error }` en el cuerpo; no usan flash.

## 8. Seguridad

### 8.1 Redirección segura

`safeNext(next, fallback)` solo acepta rutas internas:

- Debe empezar con `/`.
- Rechaza `//`, `/\`, `\`, caracteres de control y URLs absolutas.
- Se parsea con `new URL(value, 'http://local.invalid')` y se exige que el origen siga siendo `http://local.invalid`.
- Devuelve `pathname + search + hash`; cualquier otro caso devuelve `fallback`.
- Se agregan tests para `//evil.com`, `/\evil.com`, `https://evil.com`, `javascript:...`, valores con saltos de línea y rutas internas válidas.

### 8.2 Cabeceras

Middleware global antes de las rutas:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`
- En `/sso`: `Referrer-Policy: no-referrer` (el token viaja en query).

No se agrega CSP en esta etapa porque el panel usa scripts y estilos inline.

### 8.3 Validación

- IDs numéricos: helper `positiveInt()`; inválido o inexistente = 404.
- IDs de sesión: patrón `^[A-Za-z0-9_-]{1,80}$`; inválido = 404.
- Slugs: allowlists por sección. Slug desconocido en path = 404.
- `q`: máximo 200 caracteres.
- `from`/`to`: solo `YYYY-MM-DD`; inválidos se ignoran.
- Todo valor dinámico de path se genera con `encodeURIComponent` y se valida al leerlo.

### 8.4 Cookies

- La cookie de sesión agrega `Secure` cuando el pedido llega por HTTPS (`req.secure` o `X-Forwarded-Proto: https`).
- Se mantiene `HttpOnly` y `SameSite=Lax`.

## 9. Arquitectura de código

### 9.1 Módulos nuevos

- `src/panel/urls.ts`: constructores y parsers puros de URLs.
  - `antiBanUrl`, `monitoringUrl`, `reportsUrl`, `reportsUserUrl`, `auditUrl`, `templatesUrl`, `notesUrl`, `notificationsHistoryUrl`.
  - `parse*` para slugs.
  - `withQuery(path, params)` que descarta valores vacíos y codifica.
- `src/panel/flash.ts`: cookie de mensajes.
- `src/panel/legacy-redirects.ts`: middleware de compatibilidad.
- `src/panel/page.ts` (o helper dentro de `server.ts`): `sendPage`.

### 9.2 Rutas nuevas

- Se agregan rutas GET canónicas y se mantienen las bases (`/anti-ban`, `/monitoring`, etc.) como redirectores a su valor por defecto.
- Las rutas específicas (`/anti-ban/line/:id`, `/anti-ban/session/:id`) se registran antes de las rutas con `:tab` para evitar capturas incorrectas.
- Los handlers existentes se reutilizan: solo cambia de dónde leen sus parámetros (path en lugar de query).

### 9.3 Vistas

- `followup-views.ts` deja de construir `?tab=`/`?period=` a mano y recibe/usa los helpers de `urls.ts`.
- `admin-views.ts`, `anti-ban.ts`, `notifications-view.ts`, `server.ts` e `inbox.ts` usan los helpers para todos los enlaces internos.
- `public/app.js`:
  - Lee el foco y el estado inicial de Notas desde atributos `data-*` del contenedor.
  - No lee `ok`/`error` de la URL.

## 10. Pruebas

- `test/urls.test.ts`: constructores, codificación, slugs válidos/inválidos, query preservada.
- `test/legacy-redirects.test.ts`: tabla de URLs viejas → nuevas, incluida la conservación de filtros y el descarte de valores inválidos.
- `test/flash.test.ts`: firma válida, manipulación, expiración, lectura única y borrado.
- `test/sso.test.ts`: `safeNext` con casos maliciosos y rutas internas.
- Pruebas existentes siguen pasando.
- Verificación manual: Anti-Baneo, Seguimiento, Reportes, Auditoría, Plantillas, Notas e Historial de notificaciones.

## 11. Criterios de aceptación

1. Ninguna página ni redirección genera `?ok=` ni `?error=`.
2. Las pestañas, filtros de navegación, entidades seleccionadas e historial usan las rutas canónicas de este documento.
3. Las URLs viejas de la tabla redirigen 302 y conservan búsqueda/fechas/filtros.
4. `safeNext('//evil.com')` y variantes devuelven el fallback.
5. Las cabeceras de seguridad están presentes en las respuestas HTML.
6. IDs, sesiones y slugs inválidos devuelven 404.
7. Typecheck, ESLint y toda la suite de tests pasan.
8. No hay migraciones de base de datos.

## 12. Despliegue

- El cambio es solo de código y assets.
- Al reiniciar, las URLs viejas siguen funcionando por las redirecciones.
- No se requiere limpiar cachés del navegador más allá de un refresco normal; `app.js` y `app.css` ya llevan versión por mtime.
