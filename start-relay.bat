@echo off
REM ============================================================================
REM MailGuard relay launcher (Windows .bat)
REM ============================================================================
REM
REM 起動方法:
REM   このファイルをダブルクリック、または cmd で実行
REM
REM 必要環境:
REM   - PowerShell 5.1 以上 (= Windows 10/11 に標準で入っている)
REM   - Node.js は 不要
REM
REM 設定:
REM   - API キー / 上流 URL / モデル → ブラウザの MailGuard 設定画面で
REM   - ポート等 → 同じフォルダの .env で (任意)
REM ============================================================================

REM コンソール出力を UTF-8 に
chcp 65001 > nul

REM スクリプトのあるディレクトリに移動
cd /d "%~dp0"

REM PowerShell が存在するか確認
where powershell.exe > nul 2>&1
if errorlevel 1 (
  echo.
  echo [!] PowerShell が見つかりません。Windows 標準で入っているはずです。
  echo     管理者に確認してください。
  echo.
  pause
  exit /b 1
)

REM PowerShell relay を起動
REM -ExecutionPolicy Bypass で社内ポリシーの制約を回避 (= スクリプト署名不要)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0relay\mailguard-relay.ps1"

REM エラー時はウィンドウを開いたままに
if errorlevel 1 (
  echo.
  echo [!] relay が異常終了しました。
  pause
)
