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

## 1. Límite de memoria (pendiente de aplicar)

Hoy el contenedor corre **sin `mem_limit`**. Consumo real medido el 21/11/2026:
**198 MB**.

En un servidor de 3.3 GB con 1.1 GB de swap ya en uso, un contenedor sin límite
no es "uno que puede crecer": es el que se lleva a los demás cuando crece. Y
este es justamente el que no conviene que caiga, porque es el único que ya está
en producción.

```yaml
services:
  seguimiento:
    # ... lo que ya está ...
    mem_limit: 384m
    logging:
      driver: json-file
      options: { max-size: '10m', max-file: '3' }
```

384m y no 256m: deja casi el doble del consumo medido de margen para un pico de
sincronización de historial, y sigue siendo la mitad de lo que hoy podría tomar
sin que nada lo frene.

**Cómo verificar que no quedó corto**, los primeros días:

```bash
docker stats --no-stream seguimiento-test
# Si MEM % pasa del 85 % de forma sostenida, subir a 512m — no bajarlo de 384m.
```

Si el proceso muere por OOM, Docker lo reinicia (`restart: unless-stopped`) y
queda registrado:

```bash
docker inspect seguimiento-test --format '{{.State.OOMKilled}} {{.RestartCount}}'
```

## 2. Copia del respaldo fuera del servidor (pendiente de aplicar)

Los respaldos diarios quedan en `data/backups`, **dentro del mismo volumen que
respaldan**. `scripts/backup-offsite.cjs` manda la última copia a otro lado.

Corre en el **host**, no en el contenedor: necesita la clave SSH del destino, y
una clave que puede escribir en el respaldo no tiene por qué estar dentro de un
proceso expuesto a internet.

```bash
# en el host, una vez configurado OFFSITE_DEST en el .env del deploy
cd /opt/sis/seguimiento_baileys_deploy
npm run backup:offsite -- --dry-run   # muestra qué haría, sin tocar nada
npm run backup:offsite
```

Cron sugerido (04:00, después del respaldo interno de las 03:00):

```
0 4 * * * cd /opt/sis/seguimiento_baileys_deploy && npm run backup:offsite >> /var/log/backup-offsite.log 2>&1
```

Las variables están documentadas en `.env.example`.

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
