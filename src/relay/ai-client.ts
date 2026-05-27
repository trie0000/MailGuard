// AI ゲートウェイ クライアント (= Azure OpenAI 互換 chat/completions)
// Spira の relay (= spira-ai-relay.ps1) 経由で社内ゲートウェイにフォワード。

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

export async function chatCompletion(settings: Settings, req: ChatRequest): Promise<ChatResponse> {
  const url = `${settings.relayUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
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
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const j = await res.json() as { data?: Array<{ id: string }> };
    return (j.data ?? []).map(d => d.id).filter(Boolean);
  } catch { return null; }
}
