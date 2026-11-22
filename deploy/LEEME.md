# Despliegue en el servidor — referencia versionada

El `Dockerfile` sí está en este repositorio. El **`docker-compose.yml` no**: vive
en el servidor, en `/opt/sis/seguimiento_baileys_deploy/`. Y ahí es donde se
deciden los límites de memoria, la rotación de logs y el reinicio — justamente
las cosas que no estaban escritas en ninguna parte que se pueda revisar o
comparar.

Este archivo es esa referencia. **No se aplica solo**: hay que editar el
`docker-compose.yml` del servidor y hacer `docker compose up -d`.

> ⚠️ Nunca `docker compose down -v` ni `docker volume rm`: el volumen
> `seguimiento-test-data` tiene la base SQLite (457 MB), la media de WhatsApp
> (5.5 GB) y **las sesiones de las 7 líneas** (206 MB). Si se borran las
> sesiones, hay que volver a escanear los 7 códigos QR.

## 1. Límite de memoria — ✅ APLICADO el 22/11/2026

Antes: **sin `mem_limit`**, es decir el contenedor podía tomar los 3.3 GB del
host. Consumo real medido: 162 MB.

En un servidor con 1.1 GB de swap ya en uso, un contenedor sin límite no es "uno
que puede crecer": es el que se lleva a los demás cuando crece. Y este es el
único que ya está en producción.

Quedó en el **override** del deploy
(`/opt/sis/seguimiento_baileys_deploy/docker-compose.override.yml`), que es el
archivo que describe este despliegue; el `docker-compose.yml` base no se tocó.
Se guardó una copia previa como `docker-compose.override.yml.bak-AAAAMMDD-HHMM`.

```yaml
services:
  seguimiento-test:
    mem_limit: 384m
```

Se aplicó recreando el contenedor:

```bash
cd /opt/sis/seguimiento_baileys
docker compose -f docker-compose.yml   -f /opt/sis/seguimiento_baileys_deploy/docker-compose.override.yml up -d
```

**Resultado medido:** `healthy` en 51 s, `HostConfig.Memory=402653184` (384 MiB),
red `esam-crm` intacta, `OOMKilled=false`, `RestartCount=0`, 0 líneas de error en
el arranque, y **las sesiones volvieron solas** (`sessions.ready` igual antes y
después: las credenciales viven en el volumen, no en el contenedor). Consumo con
el límite puesto: **108.8 MiB / 384 MiB = 28 %**.

Vigilar los primeros días:

```bash
docker stats --no-stream seguimiento-test
# MEM % sostenido arriba del 85 % -> subir a 512m. No bajar de 384m.

docker inspect seguimiento-test --format '{{.State.OOMKilled}} {{.RestartCount}}'
# 'true' alguna vez = el limite quedo corto y hay que subirlo.
```

## 2. Copia del respaldo fuera del servidor (falta configurar el destino)

Los respaldos diarios quedan en `data/backups`, **dentro del mismo volumen que
respaldan**. `scripts/backup-offsite.sh` manda la última copia a otro host.

**Es un script de shell, no de Node, y eso no es una preferencia:** este
servidor **no tiene Node instalado** (todo se compila dentro de Docker) y los
respaldos están en un volumen de Docker, que solo lee root — y este usuario está
en el grupo `docker` pero **no tiene sudo**. El único camino que existe acá es:

```
docker run --rm -v volumen:/data:ro <imagen> tar ...  |  ssh destino 'cat > ...'
```

El contenedor efímero lee el volumen y escribe un tar a su salida estándar; el
`ssh` **del host** lo manda al destino. La clave del destino nunca entra a un
contenedor, y menos al que mira internet.

Un tar y no rsync de archivos sueltos porque cada respaldo trae **~51.000
archivos de credenciales**: 51.000 transferencias chicas tardan muchísimo más
que un stream.

```bash
cd /opt/sis/seguimiento_baileys_deploy
./backup-offsite.sh --dry-run    # muestra los comandos exactos, no mueve nada
OFFSITE_DEST=usuario@host:/ruta ./backup-offsite.sh
```

Sin `OFFSITE_DEST` informa y sale con 0: un cron que no tiene nada que hacer no
es un error.

**Cron sugerido — ojo con la hora:** el host va en **UTC** y el contenedor en
**America/La_Paz**. El respaldo interno corre a las 03:00 La Paz, que son las
**07:00 UTC**. Así que el cron del host va a las 08:00 UTC (04:00 La Paz), una
hora después:

```
0 8 * * * /opt/sis/seguimiento_baileys_deploy/backup-offsite.sh >> /var/log/backup-offsite.log 2>&1
```

Variables en `.env.example`. Falta decidir **a dónde** se copia (D3 del plan).

### Lo que se verificó el 22/11/2026

El respaldo del día anterior pesaba **416 KB** para una base de **456 MB**, lo
que parecía un respaldo roto. No lo era: esas copias son **de antes de la
migración de datos de ayer**, cuando el volumen estaba casi vacío.

Corriendo uno a mano para comprobarlo:

```bash
docker exec seguimiento-test node dist/cli/backup.js
# base 426.7 MB, 51.440 archivos de credenciales, 21 s
```

El mecanismo funciona. **Pero ahora cada copia pesa ~636 MB**, y con
`BACKUP_KEEP=7` el volumen va a crecer ~4.5 GB solo en respaldos. Con 61 GB
libres no es urgente, y conviene decidirlo junto con la retención de media:
bajar `BACKUP_KEEP` a 3 deja ~1.9 GB y sigue cubriendo tres días.

## 3. Retención de media (decisión pendiente)

`MEDIA_RETENTION_DAYS` está en 30. La media crece **~185 MB/día** (medido:
1.7 GB en octubre, 3.9 GB en los primeros 21 días de noviembre), así que la
retención de 30 días estabiliza el volumen alrededor de **5.5 GB**.

Bajarla a 14 días libera entre 2 y 4 GB y es un cambio de una línea:

```
MEDIA_RETENTION_DAYS=14
```

No se aplicó porque es una decisión del negocio, no técnica: define cuánto
tiempo atrás puede un asesor abrir el audio o la foto que le mandó un postulante.
La alternativa sin pérdida es mover la media a almacenamiento de objetos
(S3/R2), que es más trabajo y cuesta dinero.

---

Referencia completa del ecosistema, con las mediciones y el plan por fases:
`PLAN_ECOSISTEMA_Y_DESPLIEGUE.md` en el repositorio del komo.
