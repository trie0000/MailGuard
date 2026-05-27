// 共通型定義
//
// AI 設定の構造は Spira (src/api/aiSettings.ts) に揃えている:
//   - provider = 'claude' (Anthropic 直接) / 'corp' (社内 AI = Azure OpenAI 互換)
//   - プロバイダ毎に独立した model / apiKey / baseUrl / deployPrefix を保持
//   - 切替時に各プロバイダの状態は維持される (= キーや URL を打ち直し不要)

export interface ParsedMail {
  from: { name: string; email: string };
  to: Array<{ name: string; email: string }>;
  cc: Array<{ name: string; email: string }>;
  bcc: Array<{ name: string; email: string }>;
  subject: string;
  date: string | null;
  bodyText: string;
  bodyHtml: string | null;
  latestReply: string;
  quotedHistory: string;
  attachments: string[];
  format: 'eml' | 'msg';
}

export interface DeterministicHit {
  category: '内部混入' | 'タイポ' | '機密外部' | '宛名不一致' | '件名タグ不一致' | 'ドメイン乖離';
  severity: 'high' | 'medium' | 'low';
  detail: string;
}

export interface AIIssue {
  category: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

export interface AICheckResult {
  riskLevel: 'high' | 'medium' | 'low' | 'ok';
  confidence: number;
  issues: AIIssue[];
  summary: string;
  raw?: string;
}

export interface CombinedResult {
  deterministic: DeterministicHit[];
  ai: AICheckResult | { error: string };
}

// ─── AI モデル候補 (Spira と完全一致) ────────────────────────────────
export interface ClaudeAiModel { id: string; label: string }
export const CLAUDE_MODELS: ClaudeAiModel[] = [
  { id: 'claude-opus-4-5',          label: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5',        label: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5',         label: 'Claude Haiku 4.5' },
];

export interface CorpAiModel {
  id: string;
  /** reasoning モデル (= gpt-5 / o3 / o4-mini 系) — max_completion_tokens を使う + api-version 違い */
  reasoning: boolean;
}
export const CORP_AI_MODELS: CorpAiModel[] = [
  { id: 'gpt-5',           reasoning: true  },
  { id: 'gpt-5-mini',      reasoning: true  },
  { id: 'gpt-5-nano',      reasoning: true  },
  { id: 'o3',              reasoning: true  },
  { id: 'o4-mini',         reasoning: true  },
  { id: 'gpt-4.1',         reasoning: false },
  { id: 'gpt-4.1-mini',    reasoning: false },
  { id: 'gpt-4.1-nano',    reasoning: false },
  { id: 'gpt-4o',          reasoning: false },
  { id: 'gpt-4o-mini',     reasoning: false },
];

// ─── 設定 (Spira 互換のスキーマ) ─────────────────────────────────────
export type Provider = 'claude' | 'corp';

export interface Settings {
  relayUrl: string;

  provider: Provider;

  // Claude (Anthropic 直接)
  claudeApiKey: string;
  claudeModel: string;

  // 社内 AI (Azure OpenAI 互換 ゲートウェイ)
  corpApiKey: string;
  corpModel: string;
  corpBaseUrl: string;        // 例: https://gateway.example.com/myapi
  corpDeployPrefix: string;   // 例: spira-

  // チェック設定
  ownDomains: string[];
  internalKeywords: string[];
  typoDomains: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  relayUrl: 'http://127.0.0.1:18100',
  provider: 'claude',
  claudeApiKey: '',
  claudeModel: 'claude-sonnet-4-5',
  corpApiKey: '',
  corpModel: 'gpt-4o-mini',
  corpBaseUrl: '',
  corpDeployPrefix: '',
  ownDomains: [],
  internalKeywords: ['社外秘', '機密', 'マル秘', '秘扱', '人事評価', '給与', '社内限り', 'Confidential', 'Internal Only'],
  typoDomains: {
    'gmial.com': 'gmail.com',
    'gmal.com': 'gmail.com',
    'yahooo.co.jp': 'yahoo.co.jp',
    'yhaoo.co.jp': 'yahoo.co.jp',
    'outlok.com': 'outlook.com',
    'hotmial.com': 'hotmail.com',
  },
};

// ─── 現在 アクティブな model / apiKey を解決 ─────────────────────────
export function activeModel(s: Settings): string {
  return s.provider === 'claude' ? s.claudeModel : s.corpModel;
}
export function activeApiKey(s: Settings): string {
  return s.provider === 'claude' ? s.claudeApiKey : s.corpApiKey;
}

/** corp の deployment ID を組み立てる ('.' を除去 + prefix を頭に付ける、Spira と同じロジック) */
export function corpDeploymentIdFor(model: string, prefix: string): string {
  return prefix + model.replace(/\./g, '');
}
export function corpApiVersionFor(model: string): string {
  const info = CORP_AI_MODELS.find(m => m.id === model);
  return info?.reasoning ? '2024-12-01-preview' : '2024-06-01';
}

/** 現在の設定で temperature カスタム値が送れるか?
 *  ★ Azure/OpenAI の reasoning モデル (= gpt-5 / o3 / o4-mini 系) は
 *    "temperature does not support 0 with this model. Only the default (1)
 *    value is supported." を返すため、これらでは temperature 自体を省略する。
 *  Claude は 0〜1 を普通に受け付けるので true。 */
export function supportsTemperature(s: Settings): boolean {
  if (s.provider === 'claude') return true;
  const info = CORP_AI_MODELS.find(m => m.id === s.corpModel);
  return !info?.reasoning;
}

declare global {
  const __MG_BUILD_ID__: string;
}
