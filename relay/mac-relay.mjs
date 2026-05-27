// MailGuard relay — OpenAI 互換 + Anthropic (Claude) プロキシ
//
// 役割:
//   ブラウザの MailGuard (= mailguard.html) から /v1/chat/completions を受け取り、
//   ヘッダで指定された上流 AI API に転送する loopback プロキシ。
//
//   ブラウザ単独だと CORS で外部 AI API を直接呼べないため、loopback で受けて
//   CORS ヘッダを付けて返す必要がある。これが「relay」の責務。
//
// 設定方針:
//   - API キー / 上流 URL / プロバイダ → ブラウザ UI (= Settings 画面 + localStorage)
//     からヘッダ (Authorization / X-MG-Upstream-Base / X-MG-Provider) で受け取る
//   - relay 自体の起動設定 (= ポート) は .env で
//   - 旧版にあった MG_API_KEY / MG_UPSTREAM_BASE / MG_PROVIDER env も
//     後方互換のため fallback として読む (= ブラウザから来ない場合の最終手段)
//
// 起動 (Windows):
//   start-relay.bat をダブルクリック
//
// 起動 (Mac/Linux):
//   node relay/mac-relay.mjs        (= 直接実行)
//   sh start-relay.sh               (= ラッパー)
//
// エンドポイント:
//   POST /v1/chat/completions  → 上流に転送 (provider=anthropic 時は /v1/messages に翻訳)
//   GET  /v1/models             → 上流から取得 (透過)
//   GET  /health                → 200 OK + 設定状況
//   OPTIONS *                   → CORS preflight 応答

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

// ── .env ローダ (= 軽量・依存なし) ─────────────────────────────────────
//  カレントディレクトリ + relay ディレクトリ + 1 階層上 を順に探す。
//  既に process.env にセットされてる値は上書きしない (= 環境変数優先)。
function loadEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(here, '../.env'),
    path.resolve(here, '.env'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
      }
      console.log(`[relay] loaded env from: ${file}`);
      return;
    } catch (_) { /* try next */ }
  }
}
loadEnv();

const PORT = parseInt(process.env.MG_PORT || '18100', 10);

// 環境変数 fallback (= UI から送られて来ない場合)
const FALLBACK_API_KEY = process.env.MG_API_KEY || '';
const FALLBACK_UPSTREAM = process.env.MG_UPSTREAM_BASE || '';
const FALLBACK_PROVIDER = (process.env.MG_PROVIDER || '').toLowerCase();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, x-api-key, anthropic-version, X-MG-Provider, X-MG-Upstream-Base',
  'Access-Control-Max-Age': '86400',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (url.pathname === '/health' || url.pathname === '/spira/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      relay: 'mailguard-relay',
      port: PORT,
      note: 'API key / upstream / provider は ブラウザ UI から送信される X-MG-* / Authorization ヘッダで受信',
      fallbackProvider: FALLBACK_PROVIDER || null,
      fallbackUpstream: FALLBACK_UPSTREAM || null,
      hasFallbackApiKey: !!FALLBACK_API_KEY,
    }));
    return;
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const ctx = resolveContext(req);
    if (ctx.provider === 'anthropic') await proxyChatToAnthropic(req, res, ctx);
    else await proxyOpenAIChat(req, res, ctx);
    return;
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    const ctx = resolveContext(req);
    await proxyModels(req, res, ctx);
    return;
  }

  res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not Found: ' + url.pathname } }));
});

// ── リクエスト ごとの上流 設定解決 ─────────────────────────────────────
function resolveContext(req) {
  // 1. ブラウザから X-MG-* / Authorization ヘッダで受け取る
  const provider = (
    (req.headers['x-mg-provider'] || '').toString().toLowerCase()
    || FALLBACK_PROVIDER
    || 'openai'
  );
  const isAnthropic = (provider === 'anthropic' || provider === 'claude');
  const upstream = (
    (req.headers['x-mg-upstream-base'] || '').toString()
    || FALLBACK_UPSTREAM
    || (isAnthropic ? 'https://api.anthropic.com' : 'https://api.openai.com')
  ).replace(/\/+$/, '');
  const apiKey = extractBearer(req.headers['authorization']) || FALLBACK_API_KEY;
  return { provider: isAnthropic ? 'anthropic' : 'openai', upstream, apiKey };
}

function extractBearer(authHeader) {
  if (!authHeader) return '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader));
  return m ? m[1].trim() : String(authHeader).trim();
}

// ── 透過プロキシ ─────────────────────────────────────────────────────
async function proxyOpenAIChat(req, res, ctx) {
  const body = await readBody(req);
  const upstreamUrl = new URL('/v1/chat/completions', ctx.upstream + '/');
  console.log(`[relay] POST /v1/chat/completions → ${upstreamUrl.href} (openai, ${body.length} bytes)`);
  const headers = buildUpstreamHeaders(ctx);
  doUpstream(upstreamUrl, 'POST', headers, body, (upstreamRes, fullBody) => {
    res.writeHead(upstreamRes.statusCode || 502, {
      ...CORS,
      'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
    });
    res.end(fullBody);
  }, (err) => relayErr(res, err));
}

async function proxyModels(req, res, ctx) {
  const upstreamUrl = new URL('/v1/models', ctx.upstream + '/');
  console.log(`[relay] GET /v1/models → ${upstreamUrl.href} (${ctx.provider})`);
  const headers = buildUpstreamHeaders(ctx);
  doUpstream(upstreamUrl, 'GET', headers, null, (upstreamRes, fullBody) => {
    res.writeHead(upstreamRes.statusCode || 502, {
      ...CORS,
      'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
    });
    res.end(fullBody);
  }, (err) => relayErr(res, err));
}

// ── Anthropic 翻訳プロキシ ───────────────────────────────────────────
async function proxyChatToAnthropic(req, res, ctx) {
  const body = await readBody(req);
  let openaiReq;
  try { openaiReq = JSON.parse(body.toString('utf8')); }
  catch (e) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid JSON: ' + e.message } }));
    return;
  }
  const anthropicReq = translateOpenAIToAnthropic(openaiReq);
  const upstreamUrl = new URL('/v1/messages', ctx.upstream + '/');
  console.log(`[relay] POST /v1/chat/completions → ${upstreamUrl.href} (anthropic, model=${anthropicReq.model})`);
  const headers = buildUpstreamHeaders(ctx);
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
      console.warn(`[relay] anthropic HTTP ${upstreamRes.statusCode}: ${fullBody.toString('utf8').slice(0, 200)}`);
      res.writeHead(upstreamRes.statusCode || 502, {
        ...CORS,
        'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
      });
      res.end(fullBody);
    }
  }, (err) => relayErr(res, err));
}

function relayErr(res, err) {
  if (!res.headersSent) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream error: ' + err.message } }));
  }
}

function buildUpstreamHeaders(ctx) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (!ctx.apiKey) return h;
  if (ctx.provider === 'anthropic') {
    h['x-api-key'] = ctx.apiKey;
    h['anthropic-version'] = '2023-06-01';
  } else {
    h['Authorization'] = `Bearer ${ctx.apiKey}`;
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
  }
  const out = {
    model: openaiReq.model || 'claude-sonnet-4-5',
    max_tokens: openaiReq.max_tokens || 4096,
    messages,
  };
  if (system) out.system = system;
  if (typeof openaiReq.temperature === 'number') out.temperature = openaiReq.temperature;
  return out;
}

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
  if (anthropicReason === 'end_turn' || anthropicReason === 'stop_sequence') return 'stop';
  if (anthropicReason === 'max_tokens') return 'length';
  return anthropicReason || 'stop';
}

// ── HTTP 共通 ──────────────────────────────────────────────────────────
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
  console.log('  📨 MailGuard relay');
  console.log('  ─────────────────────────────────────────');
  console.log(`  Listen  : http://127.0.0.1:${PORT}`);
  console.log(`  設定方針 : API キー / 上流 URL / プロバイダ は ブラウザ UI から送信`);
  console.log(`  Test    : curl http://127.0.0.1:${PORT}/health`);
  if (FALLBACK_API_KEY || FALLBACK_UPSTREAM || FALLBACK_PROVIDER) {
    console.log('  ─────────────────────────────────────────');
    console.log('  env fallback (= UI 未設定時に使用):');
    if (FALLBACK_PROVIDER) console.log(`    MG_PROVIDER      = ${FALLBACK_PROVIDER}`);
    if (FALLBACK_UPSTREAM) console.log(`    MG_UPSTREAM_BASE = ${FALLBACK_UPSTREAM}`);
    if (FALLBACK_API_KEY)  console.log(`    MG_API_KEY       = ${FALLBACK_API_KEY.slice(0, 8)}…`);
  }
  console.log('  ─────────────────────────────────────────');
  console.log('');
});
