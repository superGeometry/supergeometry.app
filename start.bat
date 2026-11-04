@echo off
rem Starts the supergeometry.app dev server and opens it in Chrome.
title supergeometry.app dev server
cd /d "%~dp0"

rem Node may not be on PATH in older terminals right after installing it.
where npm >nul 2>nul || set "PATH=%PATH%;C:\Program Files\nodejs"
where npm >nul 2>nul || (echo Node.js not found. Install it from https://nodejs.org & pause & exit /b 1)

rem Already running? Just open the browser.
powershell -NoProfile -Command "try { Invoke-WebRequest http://localhost:5173 -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  call :open
  exit /b 0
)

if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install || (pause & exit /b 1)
)

rem Open Chrome in the background as soon as the server answers.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i=0; $i -lt 60; $i++) { try { Invoke-WebRequest http://localhost:5173 -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 1 } }; try { Start-Process chrome 'http://localhost:5173' } catch { Start-Process 'http://localhost:5173' }"

echo Starting supergeometry.app at http://localhost:5173  (close this window or press Ctrl+C to stop)
call npm run dev -- --port 5173 --strictPort
pause
exit /b

:open
powershell -NoProfile -Command "try { Start-Process chrome 'http://localhost:5173' } catch { Start-Process 'http://localhost:5173' }"
exit /b
