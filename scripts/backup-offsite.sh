#!/bin/sh
# Copia del respaldo FUERA del servidor.
#
#   ./scripts/backup-offsite.sh [--dry-run]
#
# El respaldo diario (src/core/backup.ts) deja la base con VACUUM INTO y las
# credenciales de WhatsApp dentro del volumen. Eso resuelve "me equivoqué y
# quiero volver atrás" y no resuelve nada de lo que de verdad asusta: la copia
# vive en el MISMO volumen que respalda, así que un disco que falla se lleva los
# datos y los respaldos juntos, y un `docker volume rm` también.
#
# Esto manda la última copia a otro host y poda el destino.
#
# ------------------------------------------------------------------------
# POR QUÉ ESTO ES SHELL Y NO NODE
#
# La primera versión de este script era .cjs y se invocaba con
# `npm run backup:offsite`. No sirve: **el servidor no tiene Node instalado**
# (todo se compila dentro de Docker; está dicho en el LEEME.txt del deploy).
#
# Y tampoco puede leer los respaldos directamente: están en un volumen de
# Docker, y /var/lib/docker/volumes solo lo lee root — este usuario está en el
# grupo `docker` pero NO tiene sudo.
#
# Así que el camino es el único que existe acá:
#
#   docker run --rm -v volumen:/data:ro <imagen> tar ...  |  ssh destino 'cat > ...'
#
# El contenedor efímero lee el volumen y escribe un tar a su salida estándar;
# el `ssh` del HOST lo manda al destino. La clave del destino nunca entra a un
# contenedor, y menos al que mira internet.
#
# El host tiene rsync, ssh, scp, tar y gzip. No tiene node, npm ni rclone.
# ------------------------------------------------------------------------
#
# Variables (en el entorno o en el .env del deploy):
#   OFFSITE_DEST      destino, `usuario@host:/ruta`. SIN esto no hace nada.
#   OFFSITE_SSH_PORT  puerto SSH del destino (22 por defecto)
#   OFFSITE_SSH_KEY   clave privada para el destino (opcional)
#   OFFSITE_KEEP      cuántas copias conservar en el destino (14 por defecto)
#   VOLUME            volumen a leer (seguimiento-test-data por defecto)
#   CONTAINER         contenedor del que se toma la imagen (seguimiento-test)
#
# Cron sugerido en el host, 04:00 La Paz = 08:00 UTC — una hora después del
# respaldo interno, que corre a las 03:00 La Paz:
#
#   0 8 * * * /opt/sis/seguimiento_baileys_deploy/backup-offsite.sh >> /var/log/backup-offsite.log 2>&1
#
# El cifrado no está acá a propósito: lo decide el destino (un disco cifrado, un
# bucket con cifrado en reposo). Una passphrase acá es una passphrase más que
# alguien tiene que no perder, y un respaldo que no se puede descifrar es peor
# que no tenerlo.

set -eu

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

DEST="${OFFSITE_DEST:-}"
PORT="${OFFSITE_SSH_PORT:-22}"
KEY="${OFFSITE_SSH_KEY:-}"
KEEP="${OFFSITE_KEEP:-14}"
VOLUME="${VOLUME:-seguimiento-test-data}"
CONTAINER="${CONTAINER:-seguimiento-test}"

say() { echo "[backup-offsite] $*"; }
die() { echo "[backup-offsite] ERROR: $*" >&2; exit 1; }

if [ -z "$DEST" ]; then
  say 'OFFSITE_DEST no está definido: no hay a dónde copiar. Nada que hacer.'
  exit 0
fi

command -v docker >/dev/null 2>&1 || die 'no hay docker en este host.'
command -v ssh    >/dev/null 2>&1 || die 'no hay ssh en este host.'

# La imagen del contenedor que ya corre: así no se descarga nada y se usa algo
# que con seguridad existe en el host.
IMAGE="${OFFSITE_IMAGE:-$(docker inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true)}"
[ -n "$IMAGE" ] || die "no se pudo averiguar la imagen de '$CONTAINER'. Definí OFFSITE_IMAGE."

SSH_ARGS="-p $PORT"
[ -n "$KEY" ] && SSH_ARGS="$SSH_ARGS -i $KEY"

# --- cuál es la última copia -------------------------------------------
ULTIMA="$(docker run --rm -v "$VOLUME":/data:ro "$IMAGE" \
  sh -c 'ls -1d /data/backups/backup-* 2>/dev/null | sort | tail -1' | tr -d '\r')"

[ -n "$ULTIMA" ] || die "no hay ninguna carpeta backup-* en el volumen '$VOLUME'. ¿Corrió alguna vez el respaldo diario?"

NOMBRE="$(basename "$ULTIMA")"
TAMANO="$(docker run --rm -v "$VOLUME":/data:ro "$IMAGE" du -sh "$ULTIMA" | awk '{print $1}')"

say "copia $NOMBRE ($TAMANO) → $DEST vía tar sobre ssh"
say "imagen usada para leer el volumen: $IMAGE"

# --- destino listo ------------------------------------------------------
# La ruta se crea antes: si falla acá, falla antes de mover 450 MB.
RUTA="${DEST#*:}"
HOST="${DEST%%:*}"
[ "$HOST" != "$DEST" ] || die "OFFSITE_DEST tiene que ser 'usuario@host:/ruta' (falta el ':')."

if [ "$DRY_RUN" = 1 ]; then
  say "SIMULADO: ssh $SSH_ARGS $HOST \"mkdir -p '$RUTA'\""
  say "SIMULADO: docker run --rm -v $VOLUME:/data:ro $IMAGE tar -C /data/backups -cf - $NOMBRE | gzip -1 | ssh $SSH_ARGS $HOST \"cat > '$RUTA/$NOMBRE.tar.gz'\""
  say "SIMULADO: poda del destino conservando las últimas $KEEP copias"
  say 'simulación terminada. No se movió nada.'
  exit 0
fi

# shellcheck disable=SC2086
ssh $SSH_ARGS "$HOST" "mkdir -p '$RUTA'" || die 'no se pudo preparar la ruta en el destino.'

# --- la copia -----------------------------------------------------------
#
# Un tar y no rsync de archivos sueltos: cada respaldo trae ~51.000 archivos de
# credenciales, y 51.000 transferencias chicas tardan muchísimo más que un
# stream. gzip -1 porque la base SQLite comprime bien y el cuello de botella es
# la red, no el CPU (y de CPU hay 2 vCPU para todo el servidor).
#
# Se escribe primero a .parcial y se renombra al final: si se corta la
# conexión, en el destino queda un .parcial evidente y no un .tar.gz a medio
# escribir que parece una copia buena.
TMP="$RUTA/$NOMBRE.tar.gz.parcial"
FINAL="$RUTA/$NOMBRE.tar.gz"

# shellcheck disable=SC2086
docker run --rm -v "$VOLUME":/data:ro "$IMAGE" tar -C /data/backups -cf - "$NOMBRE" \
  | gzip -1 \
  | ssh $SSH_ARGS "$HOST" "cat > '$TMP'" \
  || die 'falló la transferencia. En el destino quedó un .parcial que se puede borrar.'

# shellcheck disable=SC2086
ssh $SSH_ARGS "$HOST" "mv '$TMP' '$FINAL' && ls -l '$FINAL'" || die 'no se pudo renombrar en el destino.'

# --- poda del destino ---------------------------------------------------
#
# Sin esto el destino crece para siempre y el "respaldo externo" se convierte en
# una factura que nadie revisa. Los nombres son fechas, así que el orden
# alfabético ES el cronológico.
# shellcheck disable=SC2086
ssh $SSH_ARGS "$HOST" "cd '$RUTA' 2>/dev/null && ls -1 backup-*.tar.gz 2>/dev/null | sort | head -n -$KEEP | while read -r f; do rm -f -- \"\$f\"; done; ls -1 backup-*.tar.gz 2>/dev/null | wc -l" \
  | while read -r quedan; do say "copias en el destino: $quedan (se conservan $KEEP)"; done

say 'listo.'
say 'Recordatorio: un respaldo que nunca se restauró no es un respaldo.'
say "Prueba de restore: traer el .tar.gz, descomprimirlo y abrir la base con 'sqlite3 baileys_esam.sqlite \"pragma integrity_check; select count(*) from messages;\"'."
