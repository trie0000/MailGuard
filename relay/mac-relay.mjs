// MailGuard Mac/Linux relay — OpenAI 互換 + Anthropic (Claude) プロキシ
//
// 役割:
//   ブラウザの MailGuard (= mailguard.html) から OpenAI 互換 API
//   (/v1/chat/completions) を受け取り、上流の AI プロバイダに転送する loopback プロキシ。
//
//   ブラウザ単独だと CORS で外部 AI API を直接呼べないため、loopback で受けて
//   CORS ヘッダを付けて返す必要がある。これが「relay」の責務。
//
//   MG_PROVIDER=anthropic にすると、Claude API (= /v1/messages) との
//   リクエスト・レスポンス スキーマ差を吸収して MailGuard には OpenAI 形式で返す。
//
// 起動例:
//   ─── OpenAI (デフォルト) ────────────────────────────
//   export MG_API_KEY=sk-...
//   npm run relay
//   ─── Anthropic (Claude API) ────────────────────────
//   export MG_PROVIDER=anthropic
//   export MG_API_KEY=sk-ant-...
//   npm run relay
//   ─── Azure OpenAI / 互換プロバイダ ─────────────────
//   export MG_UPSTREAM_BASE=https://<resource>.openai.azure.com
//   export MG_API_KEY=...
//   npm run relay
//
// 環境変数:
//   MG_PROVIDER       : 'openai' (デフォルト) | 'anthropic' | 'claude'
//   MG_API_KEY        : 上流 API キー (必須)
//   MG_UPSTREAM_BASE  : 上流ベース URL (= provider に応じて自動設定、上書き可)
//   MG_PORT           : リッスン ポート (デフォルト 18100)
//
// エンドポイント (MailGuard から見た外形):
//   POST /v1/chat/completions  → 上流に転送 (Anthropic 時は内部で翻訳)
//   GET  /v1/models             → 上流から取得 (= 両プロバイダとも data[].id 形式)
//   GET  /health                → 200 OK + 設定状況
//   OPTIONS *                   → CORS preflight 応答

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const PORT = parseInt(process.env.MG_PORT || '18100', 10);
const PROVIDER = (process.env.MG_PROVIDER || 'openai').toLowerCase();
const isAnthropic = (PROVIDER === 'anthropic' || PROVIDER === 'claude');
const DEFAULT_UPSTREAM = isAnthropic ? 'https://api.anthropic.com' : 'https://api.openai.com';
const UPSTREAM = (process.env.MG_UPSTREAM_BASE || DEFAULT_UPSTREAM).replace(/\/+$/, '');
const API_KEY = process.env.MG_API_KEY || '';

if (!API_KEY) {
  console.error('⚠ MG_API_KEY が未設定です。上流の API キーを環境変数で渡してください。');
  console.error('   例 (OpenAI):    export MG_API_KEY=sk-...');
  console.error('   例 (Anthropic): export MG_API_KEY=sk-ant-... && export MG_PROVIDER=anthropic');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, x-api-key, anthropic-version',
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
      provider: isAnthropic ? 'anthropic' : 'openai',
      upstream: UPSTREAM,
      hasApiKey: !!API_KEY,
    }));
    return;
  }

  // /v1/chat/completions: provider に応じて翻訳経由 or 透過
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (isAnthropic) await proxyChatToAnthropic(req, res);
    else await proxyPassthrough(req, res, '/v1/chat/completions');
    return;
  }

  // /v1/models: 両プロバイダとも { data: [{id}, ...] } 形式で透過 OK
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    await proxyPassthrough(req, res, '/v1/models');
    return;
  }

  // その他は 404
  res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not Found: ' + url.pathname } }));
});

// ── 透過プロキシ (= OpenAI 互換時 + models 取得時) ─────────────────────
async function proxyPassthrough(req, res, upstreamPath) {
  const upstreamUrl = new URL(upstreamPath, UPSTREAM + '/');
  const body = await readBody(req);
  console.log(`[relay] ${req.method} ${upstreamPath} → ${upstreamUrl.href} (${body.length} bytes, passthrough)`);

  const headers = buildUpstreamHeaders(req);
  doUpstream(upstreamUrl, req.method, headers, body, (upstreamRes, fullBody) => {
    res.writeHead(upstreamRes.statusCode || 502, {
      ...CORS,
      'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
    });
    res.end(fullBody);
  }, (err) => {
    res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream error: ' + err.message } }));
  });
}

// ── Anthropic 翻訳プロキシ ───────────────────────────────────────────
async function proxyChatToAnthropic(req, res) {
  const body = await readBody(req);
  let openaiReq;
  try {
    openaiReq = JSON.parse(body.toString('utf8'));
  } catch (e) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid JSON request: ' + e.message } }));
    return;
  }
  const anthropicReq = translateOpenAIToAnthropic(openaiReq);
  const upstreamUrl = new URL('/v1/messages', UPSTREAM + '/');
  console.log(`[relay] POST /v1/chat/completions → ${upstreamUrl.href} (翻訳: openai → anthropic, model=${anthropicReq.model})`);

  const headers = buildUpstreamHeaders(req);
  const bodyBuf = Buffer.from(JSON.stringify(anthropicReq), 'utf8');
  doUpstream(upstreamUrl, 'POST', headers, bodyBuf, (upstreamRes, fullBody) => {
    if (upstreamRes.statusCode === 200) {
      try {
        const anthropicResp = JSON.parse(fullBody.toString('utf8'));
        const openaiResp = translateAnthropicToOpenAI(anthropicResp);
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(openaiResp));
      } catch (e) {
        console.error('[relay] response translation failed:', e.message);
        res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'response translation failed: ' + e.message } }));
      }
    } else {
      // エラーは透過 (= Anthropic のエラー形式そのまま)
      console.warn(`[relay] anthropic upstream HTTP ${upstreamRes.statusCode}: ${fullBody.toString('utf8').slice(0, 200)}`);
      res.writeHead(upstreamRes.statusCode || 502, {
        ...CORS,
        'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
      });
      res.end(fullBody);
    }
  }, (err) => {
    res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream error: ' + err.message } }));
  });
}

// ── ヘッダ構築 (= provider 毎に認証方式が違う) ────────────────────────
function buildUpstreamHeaders(req) {
  const h = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    'Accept': 'application/json',
  };
  if (!API_KEY) return h;
  if (isAnthropic) {
    h['x-api-key'] = API_KEY;
    h['anthropic-version'] = '2023-06-01';
  } else {
    h['Authorization'] = `Bearer ${API_KEY}`;
  }
  return h;
}

// ── OpenAI chat/completions → Anthropic messages 変換 ──────────────────
function translateOpenAIToAnthropic(openaiReq) {
  const messages = [];
  let system = '';
  for (const m of openaiReq.messages || []) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + (m.content || '');
    } else if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content || '' });
    }
    // 'tool' / 'function' 等は MailGuard では使っていないので無視
  }
  const out = {
    model: openaiReq.model || 'claude-sonnet-4-5',
    // Anthropic は max_tokens 必須。未指定なら大きめのデフォルトを与える。
    max_tokens: openaiReq.max_tokens || 4096,
    messages,
  };
  if (system) out.system = system;
  if (typeof openaiReq.temperature === 'number') out.temperature = openaiReq.temperature;
  // response_format / tools / tool_choice 等は Anthropic と非互換。MailGuard は
  // JSON 出力をプロンプトで強制しているのでフィールドは捨ててよい。
  return out;
}

// ── Anthropic messages → OpenAI chat/completions レスポンス 変換 ───────
function translateAnthropicToOpenAI(anthropicResp) {
  const textBlocks = (anthropicResp.content || []).filter(c => c && c.type === 'text');
  const content = textBlocks.map(c => c.text || '').join('');
  return {
    id: anthropicResp.id || `cmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicResp.model || '',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: mapStopReason(anthropicResp.stop_reason),
    }],
    usage: {
      prompt_tokens: anthropicResp.usage?.input_tokens || 0,
      completion_tokens: anthropicResp.usage?.output_tokens || 0,
      total_tokens: (anthropicResp.usage?.input_tokens || 0) + (anthropicResp.usage?.output_tokens || 0),
    },
  };
}

function mapStopReason(anthropicReason) {
  if (anthropicReason === 'end_turn') return 'stop';
  if (anthropicReason === 'max_tokens') return 'length';
  if (anthropicReason === 'stop_sequence') return 'stop';
  return anthropicReason || 'stop';
}

// ── 上流 HTTP リクエスト共通処理 ─────────────────────────────────────
function doUpstream(upstreamUrl, method, headers, body, onResponse, onError) {
  const proto = upstreamUrl.protocol === 'https:' ? https : http;
  const upstreamReq = proto.request(upstreamUrl, { method, headers }, (upstreamRes) => {
    const chunks = [];
    upstreamRes.on('data', c => chunks.push(c));
    upstreamRes.on('end', () => onResponse(upstreamRes, Buffer.concat(chunks)));
    upstreamRes.on('error', onError);
  });
  upstreamReq.on('error', (e) => {
    console.error('[relay] upstream error:', e.message);
    onError(e);
  });
  if (body && body.length > 0) upstreamReq.write(body);
  upstreamReq.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ── 起動 ──────────────────────────────────────────────────────────────
server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`  📨 MailGuard Mac/Linux relay`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Listen   : http://127.0.0.1:${PORT}`);
  console.log(`  Provider : ${isAnthropic ? 'Anthropic (Claude)' : 'OpenAI 互換'}`);
  console.log(`  Upstream : ${UPSTREAM}`);
  console.log(`  API key  : ${API_KEY ? '✓ configured (' + API_KEY.slice(0, 8) + '…)' : '✗ NOT SET (export MG_API_KEY=...)'}`);
  if (isAnthropic) {
    console.log(`  推奨モデル: claude-sonnet-4-5 / claude-haiku-4-5 / claude-opus-4-5`);
  } else {
    console.log(`  推奨モデル: gpt-4o / gpt-4o-mini`);
  }
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Test     : curl http://127.0.0.1:${PORT}/health`);
  console.log(`  MailGuard: dist/mailguard.html → 設定 → Relay URL = http://127.0.0.1:${PORT}`);
  console.log('');
});
