# Arranca baileys_esam si no esta corriendo.
# Pensado para el arranque de Windows (carpeta Inicio) o una tarea programada:
# mantiene el servicio activo siempre, para capturar los mensajes de WhatsApp
# aunque el panel web este cerrado.
$ErrorActionPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$port = 2785

# Si el gateway ya escucha, no arrancamos otra instancia.
if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
  exit 0
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($candidate in @(
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  )) {
    if (Test-Path -LiteralPath $candidate) { $node = $candidate; break }
  }
}
if (-not $node) { exit 1 }

$logs = Join-Path $root 'storage\logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null

# Rota los logs antes de que el servicio los abra (en Windows no se pueden
# renombrar mientras estan abiertos).
& $node (Join-Path $root 'scripts\rotate-logs.cjs')

Start-Process -FilePath $node `
  -ArgumentList 'scripts\run-forever.cjs' `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logs 'service.out.log') `
  -RedirectStandardError  (Join-Path $logs 'service.err.log')
