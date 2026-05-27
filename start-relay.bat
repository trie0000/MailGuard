@echo off
REM ============================================================================
REM MailGuard relay launcher (Windows)
REM ============================================================================
REM
REM NOTE: Keep this .bat ASCII-only. cmd.exe parses .bat files using the system
REM ANSI code page (CP932 on JP Windows), not UTF-8. Japanese text in REM/echo
REM lines gets mis-decoded and stray bytes (&, |, <, >) can split the line.
REM All Japanese messages live in mailguard-relay.ps1.
REM
REM What it does:
REM   1) Start mailguard-relay.ps1 (PowerShell relay)
REM   2) Listens on http://127.0.0.1:18100 (default; configurable via .env)
REM
REM Required: PowerShell 5.1 or newer (= bundled with Windows 10 / 11).
REM           Node.js is NOT required.
REM
REM Config:   API key / upstream URL / model / provider are set in the
REM           MailGuard browser UI (Settings panel).
REM           Port / proxy are read from .env in this folder. See .env.example.
REM ============================================================================

cd /d "%~dp0"

where powershell.exe > nul 2>&1
if errorlevel 1 (
  echo.
  echo [!] PowerShell not found. It ships with Windows 10/11 by default.
  echo     Please contact your administrator.
  echo.
  pause
  exit /b 1
)

REM Open MailGuard UI in the default browser (non-blocking).
REM The HTML loads without needing relay; relay is hit only on "AI check" button.
REM By the time the user clicks the button (a few seconds later), relay is up.
if exist "%~dp0dist\mailguard.html" (
  start "" "%~dp0dist\mailguard.html"
) else (
  echo [!] dist\mailguard.html not found. Run "npm run build" first.
)

REM -ExecutionPolicy Bypass: skip script signing requirement for THIS process only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0relay\mailguard-relay.ps1"

if errorlevel 1 (
  echo.
  echo [!] relay exited with an error. See messages above.
  pause
)
