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
REM Supported layouts (auto-detected):
REM   A) Hierarchical (repository layout):
REM        MailGuard\
REM          MailGuard.bat
REM          .env
REM          relay\mailguard-relay.ps1
REM          dist\mailguard.html
REM
REM   B) Flat (single-folder distribution):
REM        MailGuard\
REM          MailGuard.bat
REM          .env
REM          mailguard-relay.ps1
REM          mailguard.html
REM
REM Both layouts work. The .env file lives next to MailGuard.bat in either case.
REM
REM Required: PowerShell 5.1 or newer (= bundled with Windows 10 / 11).
REM           Node.js is NOT required.
REM ============================================================================

cd /d "%~dp0"

where powershell.exe > nul 2>&1
if errorlevel 1 (
  echo.
  echo [!] PowerShell not found. It ships with Windows 10/11 by default.
  echo.
  pause
  exit /b 1
)

REM Locate the relay .ps1: prefer hierarchical, fall back to flat
set "PS_SCRIPT="
if exist "%~dp0relay\mailguard-relay.ps1" (
  set "PS_SCRIPT=%~dp0relay\mailguard-relay.ps1"
) else if exist "%~dp0mailguard-relay.ps1" (
  set "PS_SCRIPT=%~dp0mailguard-relay.ps1"
)
if "%PS_SCRIPT%"=="" (
  echo.
  echo [!] mailguard-relay.ps1 not found.
  echo     Expected: relay\mailguard-relay.ps1 OR mailguard-relay.ps1
  echo.
  pause
  exit /b 1
)

REM Locate the UI HTML: prefer hierarchical, fall back to flat
REM (HTML auto-open is best-effort; relay starts regardless.)
set "HTML_FILE="
if exist "%~dp0dist\mailguard.html" (
  set "HTML_FILE=%~dp0dist\mailguard.html"
) else if exist "%~dp0mailguard.html" (
  set "HTML_FILE=%~dp0mailguard.html"
)
if not "%HTML_FILE%"=="" (
  start "" "%HTML_FILE%"
) else (
  echo [!] mailguard.html not found - skipping browser auto-open.
)

REM -ExecutionPolicy Bypass: skip script signing requirement for THIS process only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

if errorlevel 1 (
  echo.
  echo [!] relay exited with an error. See messages above.
  pause
)
