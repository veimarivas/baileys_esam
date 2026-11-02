# Plan de implementación · URLs limpias y seguras

Spec: `docs/superpowers/specs/2026-11-01-urls-limpias-y-seguras-design.md`

## Fase 1 · Fundamentos

1. Crear `src/panel/urls.ts` con constructores, slugs y validadores puros.
2. Crear `src/panel/flash.ts` con cookie firmada de mensajes.
3. Crear `src/panel/page.ts` con `sendPage` (renderLayout + flash).
4. Endurecer `safeNext` en `src/auth/sso.ts`.
5. Agregar cabeceras de seguridad y cookie `Secure` cuando corresponda.
6. Tests: `urls.test.ts`, `flash.test.ts`, `sso.test.ts`.

## Fase 2 · Redirecciones y mensajes

1. Crear `src/panel/legacy-redirects.ts` y registrarlo antes de las rutas.
2. Reemplazar `?ok=`/`?error=` por `setFlash` en todos los POST.
3. Convertir los GET de páginas a `sendPage` para consumir el flash.
4. Quitar la lectura de `ok`/`error` de query.

## Fase 3 · Anti-Baneo

1. Rutas canónicas de pestañas, estado, área y fuente de lista negra.
2. Validar slugs y sesiones; 404 en valores inválidos.
3. Actualizar enlaces internos y redirecciones a `antiBanUrl`.
4. Mantener el comportamiento actual de filtros y tarjetas.

## Fase 4 · Seguimiento y Reportes

1. Rutas canónicas `/<pestaña>/<período>[/<sesión>]`.
2. Mapear presets a slugs (`hoy`, `ayer`, `7d`, `30d`, `mes`, `rango`).
3. Refactorizar `periodBar`, `tabsNav` y enlaces de `followup-views.ts`.
4. Actualizar fichas de usuario y descargas CSV.

## Fase 5 · Auditoría, Plantillas y Notas

1. `/audit/:categoría` y enlaces internos.
2. `/templates/:id` para editar plantillas.
3. `/notes/:id` y `/notes/estado/:estado`.
4. Leer foco/estado inicial en `public/app.js` desde atributos `data-*`.
5. Actualizar enlaces de notificaciones y seguimientos.

## Fase 6 · Historial de notificaciones

1. Rutas `/notifications/history[/categoría[/estado[/página]]]`.
2. Validar slugs y página; redirigir URLs viejas.

## Fase 7 · Cierre

1. Buscar restos de `?ok=`, `?error=`, `?tab=`, `?nota=`, `?edit=`, `?cat=`, `?source=` en enlaces generados.
2. Typecheck, ESLint, suite completa.
3. Prueba manual/smoke de las páginas principales.
4. Build, reinicio del servicio, commit y push.
