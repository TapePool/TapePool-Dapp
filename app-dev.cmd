@echo off
rem Start the TapePool app dev server in its own window and open the app in the default browser.
rem The dev build reads mainnet: anything you sign in your wallet is a real transaction.
setlocal
cd /d "%~dp0app"
if not exist node_modules (
  echo Installing the app dependencies...
  call npm ci --ignore-scripts
  if errorlevel 1 goto fail
)
start "TapePool app - dev server" cmd /k "npm run dev -- --port 5173 --strictPort"
rem give Vite a few seconds to start, then open the app
timeout /t 4 /nobreak >nul
start "" "http://localhost:5173/#/app"
exit /b 0
:fail
echo npm ci failed, see the messages above.
pause
exit /b 1
