@echo off
REM ---------------------------------------------------------------
REM  Arranca el gateway baileys_esam (gateway :2785 + API v1 :8020).
REM  Requiere Node >= 22.5 (usa node:sqlite integrado).
REM ---------------------------------------------------------------
cd /d "%~dp0"

if not exist "node_modules" (
  echo Instalando dependencias...
  call npm install
)

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo Creado .env desde .env.example - revisa API_KEY e INTEGRATION_TOKEN.
)

echo Arrancando baileys_esam...
call npm run dev
