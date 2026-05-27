// AI ゲートウェイ クライアント (= Azure OpenAI / Anthropic 互換 chat/completions)
//
// relay (= mac-relay.mjs) を経由して上流の AI API にフォワードする。
// 上流の選択・API キーはブラウザ側 (= Settings) で持っており、relay は受け取った
// ヘッダ通りに転送する透過プロキシとして動作する。
//
// 送信ヘッダ:
//   - Authorization: Bearer <key>           ← 上流の API キー (画面で設定)
//   - X-MG-Upstream-Base: <URL>             ← 上流のベース URL (画面で設定)
//   - X-MG-Provider: openai | anthropic     ← プロトコル種別 (= 翻訳要否)

import { Settings } from '../types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  response_format?: { type: 'json_object' };
}

export interface ChatResponse {
  choices: Array<{ message: { role: string; content: string } }>;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function buildHeaders(settings: Settings): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-MG-Provider': settings.provider,
    'X-MG-Upstream-Base': settings.upstreamBase,
  };
  if (settings.apiKey) h['Authorization'] = `Bearer ${settings.apiKey}`;
  return h;
}

export async function chatCompletion(settings: Settings, req: ChatRequest): Promise<ChatResponse> {
  const url = `${settings.relayUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(settings),
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI relay HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json() as Promise<ChatResponse>;
}

/** relay の /v1/models で利用可能モデルを取得 (= 未対応な relay なら null) */
export async function fetchModels(settings: Settings): Promise<string[] | null> {
  try {
    const url = `${settings.relayUrl.replace(/\/+$/, '')}/v1/models`;
    const headers = buildHeaders(settings);
    // GET なので Content-Type は不要
    delete headers['Content-Type'];
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const j = await res.json() as { data?: Array<{ id: string }> };
    return (j.data ?? []).map(d => d.id).filter(Boolean);
  } catch { return null; }
}
