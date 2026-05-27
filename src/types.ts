// 共通型定義

export interface ParsedMail {
  from: { name: string; email: string };
  to: Array<{ name: string; email: string }>;
  cc: Array<{ name: string; email: string }>;
  bcc: Array<{ name: string; email: string }>;
  subject: string;
  date: string | null;          // ISO 文字列
  bodyText: string;              // プレーン化済み本文 (= 引用部含む生テキスト)
  bodyHtml: string | null;       // 元 HTML (= あれば)
  /** 最新返信文 (= 引用ヘッダ より前の部分) */
  latestReply: string;
  /** 引用部 (= 過去スレッド) */
  quotedHistory: string;
  /** 添付ファイル名のみ (= 中身は読まない) */
  attachments: string[];
  /** 解析元のフォーマット */
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
  confidence: number;       // 0.0 - 1.0
  issues: AIIssue[];
  summary: string;
  /** raw response for debugging */
  raw?: string;
}

export interface CombinedResult {
  deterministic: DeterministicHit[];
  ai: AICheckResult | { error: string };
}

export interface Settings {
  relayUrl: string;          // 例: http://127.0.0.1:18080
  model: string;             // 例: gpt-4o-mini
  apiKey: string;            // (relay 構成によっては不要)
  ownDomains: string[];       // 自社ドメイン (= 内部判定用)
  internalKeywords: string[];// 機密キーワード辞書
  typoDomains: Record<string, string>; // タイポ辞書 (= bad → correct)
}

export const DEFAULT_SETTINGS: Settings = {
  relayUrl: 'http://127.0.0.1:18100',
  model: 'gpt-4o-mini',
  apiKey: '',
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

declare global {
  const __MG_BUILD_ID__: string;
}
