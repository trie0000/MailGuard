// MailGuard Mac/Linux relay — OpenAI 互換プロキシ (CORS 付き)
//
// 役割:
//   ブラウザの MailGuard (= mailguard.html) から /v1/chat/completions を受け取り、
//   上流の AI API (OpenAI / Azure OpenAI / 互換プロバイダ) に Authorization 付きで
//   転送する薄いプロキシ。
//
//   ブラウザ単独だと CORS で外部 AI API を直接呼べないため、loopback で受けて
//   CORS ヘッダを付けて返す必要がある。これが「relay」の責務。
//
// 起動:
//   export MG_API_KEY=sk-...                            # 上流の API キー (必須)
//   export MG_UPSTREAM_BASE=https://api.openai.com      # 任意 (デフォルト: OpenAI)
//   export MG_PORT=18100                                 # 任意 (デフォルト: 18100)
//   node relay/mac-relay.mjs
//
// 上流の例:
//   - OpenAI:            https://api.openai.com         (= デフォルト)
//   - Azure OpenAI:      https://<resource>.openai.azure.com   ※ deployment 名は MailGuard 側 model に入れる
//   - Together AI:       https://api.together.xyz
//   - 社内 AI ゲートウェイ: そのまま指定可能 (OpenAI 互換なら)
//
// エンドポイント:
//   POST /v1/chat/completions  → 上流に転送
//   GET  /v1/models             → 上流から取得
//   GET  /health                → 200 OK (= 起動確認)
//   OPTIONS *                   → CORS preflight 応答

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const PORT = parseInt(process.env.MG_PORT || '18100', 10);
const UPSTREAM = (process.env.MG_UPSTREAM_BASE || 'https://api.openai.com').replace(/\/+$/, '');
const API_KEY = process.env.MG_API_KEY || '';

if (!API_KEY) {
  console.error('⚠ MG_API_KEY が未設定です。上流の API キーを環境変数で渡してください。');
  console.error('   例: export MG_API_KEY=sk-... && node relay/mac-relay.mjs');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  'Access-Control-Max-Age': '86400',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // CORS プリフライト
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // ヘルス チェック (= 起動確認)
  if (url.pathname === '/health' || url.pathname === '/spira/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      relay: 'mailguard-mac-relay',
      upstream: UPSTREAM,
      hasApiKey: !!API_KEY,
    }));
    return;
  }

  // /v1/* を上流に転送
  if (url.pathname.startsWith('/v1/')) {
    await proxyToUpstream(req, res, url);
    return;
  }

  res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not Found' } }));
});

async function proxyToUpstream(req, res, url) {
  const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM);

  // リクエスト ボディを集める
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  console.log(`[relay] ${req.method} ${url.pathname} → ${upstreamUrl.href} (${body.length} bytes)`);

  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    'Accept': 'application/json',
  };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const proto = upstreamUrl.protocol === 'https:' ? https : http;
  const upstreamReq = proto.request(upstreamUrl, { method: req.method, headers }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, {
      ...CORS,
      'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
    });
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (e) => {
    console.error('[relay] upstream error:', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream error: ' + e.message } }));
    }
  });

  if (body.length > 0) upstreamReq.write(body);
  upstreamReq.end();
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`  📨 MailGuard Mac/Linux relay`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Listen   : http://127.0.0.1:${PORT}`);
  console.log(`  Upstream : ${UPSTREAM}`);
  console.log(`  API key  : ${API_KEY ? '✓ configured (' + API_KEY.slice(0, 6) + '…)' : '✗ NOT SET (export MG_API_KEY=sk-...)'}`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Test     : curl http://127.0.0.1:${PORT}/health`);
  console.log(`  MailGuard: dist/mailguard.html → 設定 → Relay URL = http://127.0.0.1:${PORT}`);
  console.log('');
});
