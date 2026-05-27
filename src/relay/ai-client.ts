// AI ゲートウェイ クライアント — Spira と同じ "claude / corp" 二系統。
//
// relay (= mailguard-relay.ps1 / mac-relay.mjs) に送る共通エンドポイントは
// /v1/chat/completions。リクエスト毎にヘッダで上流の差分を渡し、relay 側で
// 翻訳・URL 組み立てを実施する。
//
// 送信ヘッダ:
//   X-MG-Provider: 'claude' | 'corp'
//   X-MG-Upstream-Base: 上流ベース URL (= claude: api.anthropic.com / corp: ゲートウェイ URL)
//   X-MG-Deployment: corp 時のみ — Azure OpenAI deployment ID (= prefix + model)
//   X-MG-Api-Version: corp 時のみ — Azure OpenAI api-version
//   Authorization: Bearer <API キー>

import {
  Settings, activeApiKey, activeModel,
  corpDeploymentIdFor, corpApiVersionFor,
} from '../types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  response_format?: { type: 'json_object' };
  /** 呼出側は model を渡さなくて良い (= settings から自動解決) */
  model?: string;
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
  };
  const apiKey = activeApiKey(settings);
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;

  if (settings.provider === 'claude') {
    h['X-MG-Upstream-Base'] = 'https://api.anthropic.com';
  } else {
    h['X-MG-Upstream-Base'] = settings.corpBaseUrl;
    h['X-MG-Deployment'] = corpDeploymentIdFor(settings.corpModel, settings.corpDeployPrefix);
    h['X-MG-Api-Version'] = corpApiVersionFor(settings.corpModel);
  }
  return h;
}

export async function chatCompletion(settings: Settings, req: ChatRequest): Promise<ChatResponse> {
  const url = `${settings.relayUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const model = req.model || activeModel(settings);
  const body = JSON.stringify({ ...req, model });
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(settings),
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI relay HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json() as Promise<ChatResponse>;
}
