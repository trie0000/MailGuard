@echo off
REM ============================================================================
REM MailGuard relay launcher (Windows .bat)
REM ============================================================================
REM
REM 起動方法:
REM   このファイルをダブルクリック、または cmd で実行
REM
REM 必要なもの:
REM   - Node.js (https://nodejs.org/ja からインストール)
REM   - npm は不要 (= 依存パッケージなし。Node 単体で動く)
REM
REM 設定:
REM   - API キー / 上流 URL / モデル → ブラウザの MailGuard 設定画面で
REM   - ポート等 → 同じフォルダの .env で (任意)
REM ============================================================================

REM コンソール出力を UTF-8 に
chcp 65001 > nul

REM Node が PATH に無ければ案内
where node > nul 2>&1
if errorlevel 1 (
  echo.
  echo [!] Node.js が見つかりません。https://nodejs.org/ja からインストールしてください。
  echo.
  pause
  exit /b 1
)

REM スクリプトのあるディレクトリに移動
cd /d "%~dp0"

REM .env を読み込んで環境変数にセット (= 任意)
if exist .env (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if not "%%a"=="" if not "%%a:~0,1%"=="#" set "%%a=%%b"
  )
)

REM relay を起動
node relay\mac-relay.mjs

REM エラー時はウィンドウを開いたままに
if errorlevel 1 (
  echo.
  echo [!] relay が異常終了しました。
  pause
)
