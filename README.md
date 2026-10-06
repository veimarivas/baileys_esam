# baileys_esam

Gateway de WhatsApp basado en **Baileys** (WebSocket, **sin Chromium**) para
**Seguimiento ESAM**. Reemplaza de forma liviana a OpenWA y al motor de envíos de
`openwa_basico`, y es *drop-in*: expone el mismo contrato REST que consume
`openwa_basico` (puerto `2785`) y la misma API de integración v1 que consume
**cronogramas** (puerto `8020`), más un **panel web** propio (puerto `8030`).

> **Instalación y puesta en producción:** ver **[IMPLEMENTACION.md](IMPLEMENTACION.md)**.

## Funcionalidades

- **Gateway WhatsApp multi-número**: QR o código de vinculación, número
  autorizado por sesión (bloquea si se vincula otro), reconexión automática,
  recuperación de mensajes recibidos con el sistema cerrado e historial al vincular.
- **API de integración v1** para cronogramas: cuentas, grupos, lotes con
  plantillas/media/idempotencia, importación CSV, PDFs, salud por usuario.
- **Lotes con anti-baneo**: perfiles de riesgo, calentamiento de números, ritmo
  aleatorio y pausas por cansancio, ventana horaria, límites diario/horario, tope
  de contactos nuevos, verificación de que el número tenga WhatsApp, "escribiendo…"
  simulado, pausa automática por entregabilidad baja, cuarentena y rotación de
  sesiones, lista negra y opt-out.
- **Panel web** (plantilla Velzon, paleta institucional, modo oscuro):
  - **Conversaciones** en tiempo real (SSE): individuales y grupos, imágenes,
    video, audio con transcripción, documentos, stickers, citas, reacciones,
    notas de voz, plantillas rápidas. La media que no llegó en vivo se descarga
    al abrirla; si WhatsApp ya no la tiene, se avisa en lugar de quedar cargando.
  - **Notas internas** por contacto con etiquetas y **seguimiento con fecha**
    (marcar hecho, vencidas, para hoy) y un tablero en `/notes`.
  - Lotes, plantillas, auto-respuestas, stickers, monitoreo, reportes, actividad
    por usuario, auditoría, usuarios y conexión.
  - Acceso por **SSO de cronogramas** o admin local; cada usuario ve solo las
    conversaciones de su número.
- **Operación segura**: instancia única (bloqueo sobre las credenciales),
  `npm run restart` que solo reinicia si compila, versión visible en el panel,
  **respaldo diario** automático, retención de media y cola de reintentos de
  webhooks.

## Ventajas frente a la pila OpenWA

| Aspecto | OpenWA (whatsapp-web.js) | baileys_esam |
| --- | --- | --- |
| Motor | Chromium headless por sesión | Socket WebSocket (sin navegador) |
| RAM por sesión | ~250-500 MB | ~40-80 MB |
| Dependencias | NestJS + TypeORM + Redis + puppeteer | Express + Baileys + SQLite |
| Base de datos | SQLite/Postgres + Redis | SQLite (`node:sqlite`, cero config) |

## Inicio rápido (desarrollo)

Requiere **Node.js ≥ 22.5** (recomendado 24) y una copia licenciada de la
plantilla **Velzon** (no se incluye en el repositorio; ver
[IMPLEMENTACION.md §3](IMPLEMENTACION.md#3-obtener-el-código-y-la-plantilla-velzon)).

```bash
git clone https://github.com/veimarivas/baileys_esam.git
cd baileys_esam
npm ci
cp .env.example .env          # completar los secretos
# copiar la carpeta assets de Velzon en public/assets
npm run check:assets
npm run dev
```

- Gateway compatible OpenWA: `http://127.0.0.1:2785` (`/health` público)
- API de integración v1: `http://127.0.0.1:8020/api/v1`
- Panel: `http://127.0.0.1:8030` (admin local: `LOCAL_ADMIN_USER` / `LOCAL_ADMIN_PASSWORD` del `.env`)

> `npm run dev` es solo para desarrollo. En un equipo donde el servicio ya está
> corriendo, el bloqueo de instancia única lo rechaza (dos procesos con las mismas
> credenciales corrompen la sesión de WhatsApp).

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Desarrollo con recarga (tsx watch) |
| `npm run build` | Compila TypeScript a `dist/` |
| `npm start` | Arranca `dist/index.js` en primer plano |
| `npm run serve` | Arranca con reinicio automático (`scripts/run-forever.cjs`) |
| `npm run restart` | Compila y, si compila bien, reinicia el servicio en marcha |
| `npm run backup` | Respaldo manual de la base y las credenciales |
| `npm run check:assets` | Verifica que esté la plantilla Velzon |
| `npm run admin:password -- <clave> [usuario]` | Cambia la clave de un usuario local |
| `npm run typecheck` | Verificación de tipos |
| `start-baileys.bat` | Windows: servicio en segundo plano (pm2 o wrapper) |

## Motor Baileys

Usa `@whiskeysockets/baileys` **6.7.24** (serie estable). La 7.0.0-rc presentó
cierres en bucle durante el QR. La versión de WhatsApp Web puede fijarse con
`BAILEYS_WA_VERSION` (formato `2,3000,1043857760`).

Se aplica un parche a `libsignal` (`src/baileys/signal-patch.ts`) para tolerar
cadenas de cifrado muy adelantadas después de un apagado largo; sin él, los
mensajes enviados desde el propio teléfono dejaban de llegar al panel.

## Estructura

```
src/
  index.ts                 Arranque: bloqueo de instancia, migración, servidores, workers
  config.ts                Configuración desde .env
  baileys/
    session.ts             Una sesión Baileys (QR, pairing, envío, historial, media diferida)
    manager.ts             Multi-sesión, persistencia, guardas anti-baneo de envío, media
    signal-patch.ts        Parche de libsignal (cadenas adelantadas)
  core/
    anti-ban.ts pacing.ts  Políticas, calentamiento, límites y ritmo de envío
    batches.ts             Runner de lotes (cola persistente)
    health.ts session-pool.ts  Salud, cuarentena y rotación de sesiones
    conversations.ts contacts.ts note-tags.ts  Inbox, contactos, notas y etiquetas
    backup.ts retention.ts Respaldo diario y retención de media
    instance-lock.ts runtime.ts  Instancia única y datos del proceso
    webhooks.ts webhook-queue.ts  Webhooks firmados con reintentos
    …                      plantillas, opt-out, CSV, PDF, stickers, transcripción, etc.
  gateway/server.ts        REST compatible OpenWA (:2785)
  api/server.ts            API de integración v1 (:8020)
  auth/                    Usuarios, sesiones del panel y SSO (HMAC)
  panel/                   Panel web (:8030): server, inbox, anti-ban, layout, vistas
  cli/                     Comandos: backup, admin:password
scripts/                   run-forever, restart, autostart (Windows), check-assets
public/app.css · app.js    Estilos y lógica del panel (sobre Velzon en public/assets)
```

## Documentación

| Documento | Contenido |
| --- | --- |
| [IMPLEMENTACION.md](IMPLEMENTACION.md) | **Guía de implementación**: instalación, configuración, servicio, integración, operación, respaldos y solución de problemas |
| [CAMBIOS.md](CAMBIOS.md) | Registro detallado de cambios y correcciones |
| [PLAN.md](PLAN.md) | Alcance, contrato REST replicado y fases |
| [MEJORAS.md](MEJORAS.md) | Estrategia anti-baneo y su implementación |
| [PLAN_INBOX.md](PLAN_INBOX.md) | Plan histórico del inbox (F11) |
| [docs/superpowers/specs/](docs/superpowers/specs/) | Diseños técnicos (grupos, historial) |

## Licencia y terceros

- Código propio del proyecto: uso interno de Seguimiento ESAM.
- **Velzon** (Themesbrand) es una plantilla comercial y **no** se redistribuye.
- Incluidos: fuente **Inter** (SIL Open Font License) y **opus-recorder** (MIT).
