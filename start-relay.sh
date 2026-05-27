#!/bin/bash
# ============================================================================
# MailGuard relay launcher (Mac / Linux)
# ============================================================================
#
# 起動方法:
#   ./start-relay.sh
#   (初回のみ:  chmod +x start-relay.sh)
#
# 必要なもの:
#   - Node.js (https://nodejs.org/ja)
#   - npm install は不要 (= 依存なし)
# ============================================================================

cd "$(dirname "$0")"

if ! command -v node > /dev/null 2>&1; then
  echo ""
  echo "[!] Node.js が見つかりません。https://nodejs.org/ja からインストールしてください。"
  echo ""
  exit 1
fi

# .env を読み込み (任意)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Open MailGuard UI in default browser (non-blocking)
if [ -f dist/mailguard.html ]; then
  if command -v xdg-open > /dev/null 2>&1; then
    xdg-open dist/mailguard.html > /dev/null 2>&1 &
  elif command -v open > /dev/null 2>&1; then
    open dist/mailguard.html > /dev/null 2>&1 &
  fi
else
  echo "[!] dist/mailguard.html not found. Run 'npm run build' first."
fi

node relay/mac-relay.mjs
