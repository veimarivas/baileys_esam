# Guía de implementación — baileys_esam

Guía paso a paso para instalar, configurar, poner en producción y operar
**baileys_esam**: gateway de WhatsApp sobre Baileys, con API de integración
para **cronogramas**, compatibilidad con **openwa_basico** y panel web propio.

> Tiempo estimado de una instalación nueva: 30–45 minutos, incluida la
> vinculación del número.

## Índice

1. [Arquitectura y puertos](#1-arquitectura-y-puertos)
2. [Requisitos](#2-requisitos)
3. [Obtener el código y la plantilla Velzon](#3-obtener-el-código-y-la-plantilla-velzon)
4. [Configuración (`.env`)](#4-configuración-env)
5. [Compilar y primer arranque](#5-compilar-y-primer-arranque)
6. [Vincular el número de WhatsApp](#6-vincular-el-número-de-whatsapp)
7. [Integración con cronogramas y openwa_basico](#7-integración-con-cronogramas-y-openwa_basico)
8. [Ejecutar como servicio](#8-ejecutar-como-servicio)
9. [Seguridad y red](#9-seguridad-y-red)
10. [Configuración inicial del panel](#10-configuración-inicial-del-panel)
11. [Operación diaria](#11-operación-diaria)
12. [Respaldos y restauración](#12-respaldos-y-restauración)
13. [Migrar a otro servidor](#13-migrar-a-otro-servidor)
14. [Solución de problemas](#14-solución-de-problemas)
15. [Checklist de puesta en producción](#15-checklist-de-puesta-en-producción)

---

## 1. Arquitectura y puertos

Un **único proceso Node.js** levanta tres servidores HTTP y mantiene las
sesiones de WhatsApp (WebSocket, sin navegador):

```
                 ┌──────────────────────── baileys_esam (Node.js) ────────────────────────┐
cronogramas ───► │ :8020  API de integración v1  (Bearer + lista de IP)                    │
openwa_basico ─► │ :2785  Gateway compatible OpenWA (X-API-Key)  · /health público         │
navegador ─────► │ :8030  Panel web (login local o SSO de cronogramas)                     │
                 │                                                                          │
                 │ SQLite (data/baileys_esam.sqlite) · credenciales WA (data/baileys/)      │
                 │ media (data/media/) · respaldos (data/backups/) · logs (storage/logs/)   │
                 └──────────────────────────────┬───────────────────────────────────────────┘
                                                │ WebSocket (Baileys)
                                                ▼
                                       Servidores de WhatsApp
```

| Puerto | Servicio | Quién lo usa | Exponer |
| --- | --- | --- | --- |
| 2785 | Gateway OpenWA | openwa_basico | Solo red interna |
| 8020 | API v1 | cronogramas | Solo red interna (o IP de cronogramas) |
| 8030 | Panel | Usuarios | Red interna o detrás de HTTPS |

Los webhooks salientes (`message.received`, `message.ack`, `session.status`…)
van firmados con `X-OpenWA-Signature: sha256=<hmac>`.

## 2. Requisitos

| Requisito | Detalle |
| --- | --- |
| Sistema | Windows 10/11/Server o Linux (Ubuntu 22.04+ / Debian 12+) |
| Node.js | **≥ 22.5** (usa `node:sqlite` integrado). Recomendado **Node 24 LTS** |
| Git | Para clonar y actualizar |
| Hardware | 1 vCPU y 1 GB de RAM por cada ~5 números; disco: 2 GB + media (≈ 350 MB/mes por número activo) + respaldos (≈ 7 × tamaño de la base) |
| Red | Salida a internet (443) hacia WhatsApp; puertos 2785/8020/8030 libres |
| WhatsApp | Un número **dedicado** con WhatsApp (o WhatsApp Business) en un teléfono que quede **encendido y con internet** |
| Plantilla | Copia licenciada de **Velzon** (versión HTML) — ver §3 |

No hace falta Chromium, Redis ni compilar módulos nativos (`sharp` trae binarios
precompilados).

## 3. Obtener el código y la plantilla Velzon

### 3.1 Clonar e instalar dependencias

```bash
git clone https://github.com/veimarivas/baileys_esam.git
cd baileys_esam
npm ci
```

> En Windows con XAMPP la ruta habitual es `C:\xampp_82_12\htdocs\baileys_esam`,
> pero puede ir en cualquier carpeta.

### 3.2 Copiar la plantilla Velzon

El panel usa la plantilla **Velzon** (Themesbrand), que tiene **licencia
comercial** y por eso **no está en el repositorio**. Copiá la carpeta `assets`
de la versión **HTML** de tu paquete licenciado de Velzon dentro de
`public/assets/`, **sin borrar** lo que ya está ahí (la fuente Inter y
`libs/opus-recorder`, que sí vienen en el repositorio):

```
Velzon_vX/HTML/.../assets/   ──copiar contenido──►   baileys_esam/public/assets/
```

Windows (PowerShell), ajustando la ruta de origen:

```powershell
robocopy "C:\ruta\Velzon\HTML\Default\assets" "public\assets" /E /XC /XN /XO
```

Linux:

```bash
cp -rn /ruta/Velzon/HTML/Default/assets/. public/assets/
```

Verificá que esté todo lo que usa el panel:

```bash
npm run check:assets
```

Archivos que necesita el panel: `css/{bootstrap,icons,app,custom}.min.css`,
`js/{layout,plugins,app}.js`, `libs/{bootstrap,simplebar,node-waves,feather-icons,apexcharts}`,
`images/favicon.ico` y las fuentes de iconos (`remixicon`, `boxicons`,
`la-*`, `materialdesignicons`).

## 4. Configuración (`.env`)

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

### 4.1 Generar los secretos

Ejecutá esta línea **una vez por cada secreto** y pegá el resultado:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4.2 Variables obligatorias en producción

| Variable | Qué poner |
| --- | --- |
| `HOST` | `127.0.0.1` si todo corre en el mismo servidor; `0.0.0.0` solo si otros equipos de la red deben llegar (y con firewall, §9) |
| `API_KEY` | Secreto aleatorio. Lo usa openwa_basico (`X-API-Key`). **Vacío = gateway sin autenticación** |
| `INTEGRATION_TOKEN` | Secreto aleatorio. El mismo valor va en cronogramas (`SEGUIMIENTO_ESAM_TOKEN`) |
| `INTEGRATION_ALLOWED_IPS` | IP(s) desde donde llama cronogramas, separadas por coma |
| `SSO_SECRET` | Secreto aleatorio. El mismo valor va en cronogramas (`SEGUIMIENTO_ESAM_SSO_SECRET`) |
| `APP_KEY` | Secreto aleatorio para firmar la cookie del panel. No usar el valor de ejemplo |
| `LOCAL_ADMIN_USER` / `LOCAL_ADMIN_PASSWORD` | Admin del panel. **Se crea solo en el primer arranque**; después se cambia con `npm run admin:password` |
| `AUTO_START_SESSIONS` | `true` en producción (reconecta los números al arrancar) |

### 4.3 Variables recomendadas (con sus valores por defecto)

| Grupo | Variables | Por defecto |
| --- | --- | --- |
| Almacenamiento | `DB_PATH`, `BAILEYS_AUTH_DIR`, `STORAGE_DIR` | `./data/...` |
| Historial | `BAILEYS_SYNC_FULL_HISTORY`, `HISTORY_SYNC_*` | historial completo al vincular |
| Media | `MEDIA_RETENTION_DAYS`, `MEDIA_DOWNLOAD_OFFLINE`, `MEDIA_DOWNLOAD_TIMEOUT` | 30 días, sí, 20 s |
| Respaldos | `BACKUP_ENABLED`, `BACKUP_DIR`, `BACKUP_KEEP`, `BACKUP_HOUR` | sí, `./data/backups`, 7, 3 h |
| Webhooks | `WEBHOOK_TIMEOUT`, `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_RETRY_BASE_MS` | 10 s, 8, 30 s |
| Transcripción | `TRANSCRIBE_*` (API compatible con OpenAI) | deshabilitada sin API key |
| Diagnóstico | `LOG_LEVEL`, `BAILEYS_LOG`, `DEBUG_DUMP_MESSAGES` | `info`, `silent`, `false` |

La política **anti-baneo** (ritmos, límites, ventanas, calentamiento) se
configura desde el panel (§10), no desde `.env`. Las variables `PACING_*` son
solo los valores iniciales.

> `.env` contiene secretos: nunca lo subas al repositorio (ya está en `.gitignore`).

## 5. Compilar y primer arranque

```bash
npm run build          # compila TypeScript a dist/
npm start              # arranque en primer plano (solo para esta prueba)
```

Comprobaciones:

```bash
curl http://127.0.0.1:2785/health
```

Debe responder `{"ok":true, ... "runtime": {"version": ..., "pendingRestart": false}}`.

Abrí `http://127.0.0.1:8030`, ingresá con `LOCAL_ADMIN_USER` /
`LOCAL_ADMIN_PASSWORD` y detené con `Ctrl+C`.

> **Una sola instancia.** El servicio toma `data/baileys/.instance.lock`; si ya
> hay otra corriendo (incluido un `npm run dev`), el arranque se cancela con un
> error claro. Dos procesos con las mismas credenciales corrompen el cifrado
> ("Bad MAC") y obligan a volver a vincular.

## 6. Vincular el número de WhatsApp

1. Panel → **Conexión** → **Crear sesión** (p. ej. `esam-principal`).
2. **Número autorizado** (con código de país, solo dígitos: `591XXXXXXXX`). No se
   carga en ese formulario; se fija de alguna de estas formas:
   - desde cronogramas: `PUT /api/v1/config/numero` (número principal) o
     `POST /api/v1/accounts` (número de cada usuario);
   - al ingresar un usuario (login o SSO) cuyo `numero` coincide, su sesión se
     vincula sola a ese número.

   Si se escanea otro número, la sesión se desvincula y queda **bloqueada**. Sin
   número autorizado definido se acepta el primero que se vincule.
3. **Mostrar QR** y escanealo desde el teléfono: WhatsApp → *Dispositivos
   vinculados* → *Vincular un dispositivo*. Alternativa: **Código de vinculación**.
4. Al vincular llega el historial (puede tardar unos minutos con muchos chats).
   La media del historial se descarga cuando alguien la abre.

Recomendaciones:

- El teléfono debe quedar **encendido y con internet**: los mensajes enviados
  desde el celular y el historial bajo demanda pasan por él.
- No uses el mismo número en otro WhatsApp Web/Desktop de forma simultánea si
  no es necesario.
- Números nuevos: dejá activo el **calentamiento** (§10) las primeras semanas.

## 7. Integración con cronogramas y openwa_basico

### 7.1 cronogramas (API v1 + SSO)

En el `.env` de cronogramas:

```dotenv
SEGUIMIENTO_ESAM_URL=http://127.0.0.1:8020
SEGUIMIENTO_ESAM_TOKEN=<INTEGRATION_TOKEN de baileys_esam>
SEGUIMIENTO_ESAM_SSO_SECRET=<SSO_SECRET de baileys_esam>
```

- Las llamadas a `/api/v1/*` llevan `Authorization: Bearer <INTEGRATION_TOKEN>`
  y deben salir de una IP de `INTEGRATION_ALLOWED_IPS`.
- Endpoints: `health` (`?uid=`/`?phone=`), `config/numero`, `accounts`,
  `groups`, `groups/resolve`, `batches`, `batches/{id}`, `batches/{id}/retry`,
  `batches/import`, `pdf/statement`, `pdf/boletin`.
- `POST /api/v1/accounts` da de alta al usuario del panel (espejo) y su número
  autorizado.

**SSO** (ingreso al panel desde cronogramas): `GET http://<panel>:8030/sso?token=<token>`

```
token   = base64url(JSON) + "." + HMAC_SHA256_hex(JSON, SSO_SECRET)
JSON    = { uid, name, email, username, autorizado, area, numero, roles[], next,
            exp (epoch en segundos, p. ej. ahora + 120), nonce (único) }
```

El `nonce` es de un solo uso. Si el usuario no está autorizado, responde 403.
Cada usuario ve **solo** las conversaciones de su número (`numero`).

### 7.2 openwa_basico (gateway)

En `openwa_configs`: `base_url = http://127.0.0.1:2785` y `api_key` = `API_KEY`
de baileys_esam. El contrato REST de OpenWA (`/api/sessions/...`) no cambia.

## 8. Ejecutar como servicio

### 8.1 Windows

Arranque en segundo plano con reinicio automático:

```bat
start-baileys.bat
```

Usa **pm2** si está instalado; si no, `scripts/run-forever.cjs` (reinicia con
espera creciente si el proceso cae). Logs en `storage\logs\`.

**Arranque automático al iniciar Windows**: creá
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\baileys_esam.cmd` con:

```bat
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ruta\baileys_esam\scripts\autostart.ps1"
```

`autostart.ps1` no arranca una segunda instancia si el gateway ya responde.
En servidores sin sesión iniciada, usá en su lugar una **tarea programada**
("Al iniciar el sistema", usuario de servicio) que ejecute ese mismo comando.

### 8.2 Linux con systemd

`/etc/systemd/system/baileys_esam.service`:

```ini
[Unit]
Description=baileys_esam (gateway WhatsApp Baileys)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=baileys
WorkingDirectory=/opt/baileys_esam
ExecStart=/usr/bin/node /opt/baileys_esam/dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/baileys_esam baileys
sudo chown -R baileys:baileys /opt/baileys_esam
sudo systemctl daemon-reload
sudo systemctl enable --now baileys_esam
journalctl -u baileys_esam -f
```

### 8.3 pm2 (Windows o Linux)

```bash
npm i -g pm2
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup          # Linux: genera el servicio de arranque
```

## 9. Seguridad y red

- **Secretos**: `API_KEY`, `INTEGRATION_TOKEN`, `SSO_SECRET`, `APP_KEY` y la
  clave del admin, todos aleatorios y distintos (§4.1).
- **Firewall**: abrí 2785/8020 solo para los servidores de openwa_basico y
  cronogramas; 8030 solo a la red interna.
- **HTTPS** si el panel se usa fuera de la red local (ejemplo con nginx):

  ```nginx
  server {
    listen 443 ssl;
    server_name whatsapp.tu-dominio;
    ssl_certificate     /etc/letsencrypt/live/whatsapp.tu-dominio/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/whatsapp.tu-dominio/privkey.pem;
    client_max_body_size 64m;
    location /events {                      # SSE del inbox en tiempo real
      proxy_pass http://127.0.0.1:8030;
      proxy_http_version 1.1;
      proxy_set_header Connection '';
      proxy_buffering off;
      proxy_read_timeout 1h;
    }
    location / {
      proxy_pass http://127.0.0.1:8030;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto https;
    }
  }
  ```

- **Datos sensibles**: `data/` contiene conversaciones y las credenciales del
  número (quien tenga `data/baileys/` puede usar la sesión). Restringí permisos
  de esa carpeta y de `data/backups/`.

## 10. Configuración inicial del panel

Ingresá como admin local y revisá:

1. **Conexión**: sesión vinculada y en estado *ready*.
2. **Anti-Baneo → Política global**: elegí el perfil (*Bajo* para números nuevos,
   *Medio* como estándar) y **Aplicar preset del perfil**. Revisá:
   - ventana horaria y días de envío;
   - límites diario / por hora y **contactos nuevos por día**;
   - **calentamiento** activo para números nuevos;
   - simular "escribiendo…", separación mínima y tope por minuto;
   - verificar que el número tenga WhatsApp y pausar el lote si cae la entregabilidad.
3. **Usuarios**: los usuarios de cronogramas aparecen al ingresar por SSO o al
   darlos de alta por `POST /api/v1/accounts`.
4. **Notas → Gestionar etiquetas**: creá las etiquetas del equipo (p. ej.
   *Interesado*, *Pago pendiente*, *Llamar*, *Documentos*).
5. **Plantillas** y **Plantillas rápidas** del equipo.

## 11. Operación diaria

| Tarea | Cómo |
| --- | --- |
| Estado del servicio | `curl http://127.0.0.1:2785/health` o el pie del panel ("v… · activo desde …") |
| Logs | `storage/logs/service.out.log` y `service.err.log` (o `journalctl` / `pm2 logs`) |
| Aplicar una actualización | ver abajo |
| Respaldo manual | `npm run backup` |
| Verificar plantilla | `npm run check:assets` |
| Cambiar clave del admin local | `npm run admin:password -- <nueva-clave> [usuario]` |
| Salud de los números | Panel → **Anti-Baneo** (semáforo, entregabilidad, mensajes sin descifrar) |

**Actualizar a una versión nueva:**

```bash
git pull
npm ci
npm run restart
```

`npm run restart` compila y, **solo si compila bien**, reinicia la instancia en
marcha (pm2 o el wrapper) y espera a que `/health` responda con el proceso
nuevo. Si en el pie del panel aparece **"Reinicio pendiente"**, hay código
compilado que todavía no se aplicó.

> No uses `npm run dev` en el servidor de producción: el bloqueo de instancia
> lo rechaza mientras el servicio esté activo.

## 12. Respaldos y restauración

- Automático todos los días a `BACKUP_HOUR` en
  `data/backups/backup-AAAAMMDD-HHMM/` (base + credenciales); se conservan
  `BACKUP_KEEP`. Si al arrancar no hay uno de las últimas 24 h, se hace a los
  2 minutos. El panel avisa **"Sin respaldo reciente"** pasadas 36 h.
- **Copiá `data/backups/` a otro disco o equipo** con regularidad (tarea
  programada, rsync, unidad de red).

**Restaurar:**

1. Detener el servicio (`pm2 stop baileys_esam`, `systemctl stop baileys_esam`
   o cerrar el proceso de `run-forever`).
2. Reemplazar `data/baileys_esam.sqlite` por el del respaldo y **borrar**
   `data/baileys_esam.sqlite-wal` y `-shm`.
3. Si hace falta recuperar la sesión, reemplazar `data/baileys/` por la carpeta
   `baileys/` del respaldo.
4. Arrancar el servicio y comprobar `/health`.

## 13. Migrar a otro servidor

1. En el servidor nuevo: §2 a §4 (mismo `.env`).
2. Detener el servicio en el servidor viejo **y no volver a arrancarlo**.
3. Copiar `data/` completa (base, credenciales, media) al servidor nuevo.
4. Arrancar el nuevo y verificar `/health`, la conexión y un mensaje de prueba.

> Nunca tengas los dos servidores activos con la misma carpeta `data/baileys/`:
> corrompe la sesión y obliga a volver a vincular.

## 14. Solución de problemas

| Síntoma | Causa probable | Qué hacer |
| --- | --- | --- |
| cronogramas muestra `cURL error 7 ... port 8020` | El servicio no está corriendo | Revisar `storage/logs/` y arrancar (§8) |
| Log: "Ya hay otra instancia de baileys_esam…" | Otro proceso tiene el bloqueo | Detener la otra instancia (a menudo un `npm run dev`) o usar `npm run restart` |
| Log: "No se pudo abrir el puerto; saliendo" | Puerto ocupado por otro programa o instancia | Liberar el puerto o cambiar `PORT`/`API_PORT`/`PANEL_PORT` |
| Los mensajes enviados desde el celular no aparecen; Anti-Baneo muestra "mensajes sin descifrar… del propio teléfono" | Sesión de cifrado con el teléfono rota (típico tras dos instancias a la vez) | Desvincular el dispositivo en el teléfono y volver a escanear el QR (§6) |
| Imagen/video "sin descargar" | Guardado sin referencia o llegado con el sistema cerrado | Pulsar **Descargar** con el teléfono conectado |
| Imagen/video "no disponible" | WhatsApp ya no tiene el archivo | Pedir al contacto que lo reenvíe |
| Pie del panel: **Reinicio pendiente** | Se compiló código nuevo sin reiniciar | `npm run restart` |
| Pie del panel: **Sin respaldo reciente** | Respaldo fallido o deshabilitado | Ver el log ("Falló el respaldo") y ejecutar `npm run backup` |
| La sesión queda **bloqueada** al vincular | El número escaneado no es el autorizado | Vincular el número correcto o corregir el número autorizado |
| El panel se ve sin estilos o sin iconos | Falta la plantilla Velzon | `npm run check:assets` y §3.2 |
| Un lote quedó **en pausa** | Límite diario, tope de contactos nuevos, entregabilidad baja o cuarentena | El motivo figura en el detalle del lote; revisar y reanudar |
| Muchos fallos de envío / número bloqueado | Envíos en frío o demasiado rápidos | Bajar a perfil *Bajo*, reducir contactos nuevos por día y revisar la lista |

## 15. Checklist de puesta en producción

- [ ] Node ≥ 22.5 instalado (`node -v`).
- [ ] `npm ci` sin errores y `npm run check:assets` en OK.
- [ ] `.env` con `API_KEY`, `INTEGRATION_TOKEN`, `SSO_SECRET`, `APP_KEY` aleatorios y `LOCAL_ADMIN_PASSWORD` fuerte.
- [ ] `AUTO_START_SESSIONS=true`.
- [ ] `npm run build` y `/health` responde.
- [ ] Número vinculado y en *ready*; número autorizado configurado.
- [ ] cronogramas apuntando a `:8020` con el token y el secreto SSO; SSO probado.
- [ ] openwa_basico apuntando a `:2785` (si se usa).
- [ ] Servicio con arranque automático (§8) y una sola instancia.
- [ ] Firewall / HTTPS configurados (§9).
- [ ] Política anti-baneo revisada (§10).
- [ ] Primer respaldo creado (`npm run backup`) y copia a otro disco programada.
