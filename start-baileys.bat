@echo off
REM ---------------------------------------------------------------
REM  Arranca baileys_esam en SEGUNDO PLANO (independiente de esta
REM  consola) con reinicio automatico y logs en storage\logs.
REM  Cerrar esta ventana NO detiene el servicio.
REM ---------------------------------------------------------------
cd /d "%~dp0"

if not exist "node_modules" (
  echo Instalando dependencias...
  call npm install
)

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo Creado .env desde .env.example - revisa API_KEY, INTEGRATION_TOKEN y APP_KEY.
)

if not exist "storage\logs" mkdir "storage\logs"

where pm2 >nul 2>&1
if %errorlevel%==0 (
  echo Arrancando con pm2 (reinicio automatico)...
  call pm2 start ecosystem.config.cjs
  call pm2 save
  echo.
  echo Listo. Comandos utiles:
  echo   pm2 status           - estado
  echo   pm2 logs baileys_esam - logs en vivo
  echo   pm2 restart baileys_esam
  echo   pm2 stop baileys_esam
  exit /b 0
)

echo Arrancando con wrapper de reinicio (sin pm2)...
start "baileys_esam" /min cmd /c "node scripts\run-forever.cjs >> storage\logs\service.out.log 2>&1"

echo.
echo Servicio lanzado en segundo plano.
echo   Gateway:  http://127.0.0.1:2785
echo   API v1:   http://127.0.0.1:8020/api/v1
echo   Panel:    http://127.0.0.1:8030
echo   Logs:     storage\logs\service.out.log
echo.
echo Para detenerlo: taskkill /FI "WINDOWTITLE eq baileys_esam*" /T /F
