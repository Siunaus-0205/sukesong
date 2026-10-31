@echo off
setlocal
cd /d "%~dp0"

if not exist "tools\cloudflared.exe" (
  echo [1/2] Downloading cloudflared...
  if not exist "tools" mkdir "tools"
  powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'tools\cloudflared.exe'"
  if errorlevel 1 (
    echo Download failed. Check network and retry.
    pause
    exit /b 1
  )
)

echo [2/2] Starting tunnel to http://127.0.0.1:43125
echo Make sure "node server.mjs" is already running in another window.
echo.
tools\cloudflared.exe tunnel --url http://127.0.0.1:43125 --no-autoupdate
echo.
echo Tunnel closed.
pause
