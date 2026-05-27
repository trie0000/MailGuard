// B 段: AI に文脈解析させる誤送信チェック
//
// プロンプト設計:
//   - 解析対象 (= 下書きメール) を構造化して提示
//   - 評価軸を 5 つに明示
//   - JSON 必須応答 (= 後処理しやすく)
//   - LLM の自由度は temperature=0.0 に絞って再現性確保
//
// 入力サイズが大きいとコスト・遅延が膨らむため、quotedHistory は 4KB 程度に切詰める。

import { ParsedMail, AICheckResult, Settings, DeterministicHit, activeModel, supportsTemperature } from '../types';
import { DEFAULT_SYSTEM_PROMPT } from '../prompts';
import { chatCompletion, ChatRequest } from '../relay/ai-client';

// SYSTEM_PROMPT は src/prompts.ts の DEFAULT_SYSTEM_PROMPT を組込デフォルトとして使い、
// settings.systemPrompt が非空ならそちらで上書き (= 設定画面でカスタマイズ可能)。

export async function runAICheck(
  mail: ParsedMail,
  detHits: DeterministicHit[],
  settings: Settings,
): Promise<AICheckResult> {
  const userPrompt = buildUserPrompt(mail, detHits);
  // ★ system プロンプトは settings.systemPrompt が空文字なら組込デフォルトに fallback。
  //   設定画面の textarea で利用者が自由にカスタマイズできる。
  const systemPrompt = (settings.systemPrompt ?? '').trim() || DEFAULT_SYSTEM_PROMPT;
  // reasoning モデル (= gpt-5 / o3 / o4-mini 系) は temperature カスタム値を
  // 受け付けず、明示するとエラー (= "temperature does not support 0 with this model")
  // になるため、条件付きで省略する。
  const req: ChatRequest = {
    model: activeModel(settings),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
  if (supportsTemperature(settings)) req.temperature = 0.0;
  const resp = await chatCompletion(settings, req);
  const content = resp.choices?.[0]?.message?.content ?? '';
  return parseAIResponse(content);
}

// メール本文 (= 最新返信文 + 引用履歴) を AI に渡す際の合計上限。
// 最新返信文を優先して使い、残った文字数で引用履歴を埋める。
const BODY_AI_MAX = 5000;

function buildUserPrompt(mail: ParsedMail, detHits: DeterministicHit[]): string {
  const trunc = (s: string, max: number) => s.length > max ? s.slice(0, max) + '\n…(以下省略)' : s;
  const fmtAddr = (a: { name: string; email: string }) => a.name ? `${a.name} <${a.email}>` : a.email;

  // ★ 本文 5000 文字制限: latestReply を 先に確保し、残りを quotedHistory に割当
  const latestRaw = mail.latestReply || mail.bodyText || '';
  const latestForAi = trunc(latestRaw, BODY_AI_MAX);
  const remainingBudget = Math.max(0, BODY_AI_MAX - latestForAi.length);
  const quotedForAi = remainingBudget > 0
    ? trunc(mail.quotedHistory || '', remainingBudget)
    : '(本文上限到達のため省略)';

  const detSummary = detHits.length === 0
    ? '(なし)'
    : detHits.map(h => `- [${h.severity}] ${h.category}: ${h.detail}`).join('\n');

  return [
    '【宛先 (To)】',
    mail.to.length === 0 ? '(なし)' : mail.to.map(fmtAddr).join(', '),
    '',
    '【宛先 (Cc)】',
    mail.cc.length === 0 ? '(なし)' : mail.cc.map(fmtAddr).join(', '),
    '',
    '【件名】',
    mail.subject || '(なし)',
    '',
    '【最新の返信本文】',
    latestForAi || '(なし)',
    '',
    '【過去のやり取り (引用部から抽出)】',
    quotedForAi || '(なし)',
    '',
    '【添付ファイル名】',
    mail.attachments.length === 0 ? '(なし)' : mail.attachments.join(', '),
    '',
    '【決定論ルールによる事前検出】',
    detSummary,
    '',
    `※ 本文の AI 投入上限: ${BODY_AI_MAX} 文字 (= 最新返信文 + 引用履歴 合計)。`,
    '上記を踏まえて、JSON 形式 (前置きなし) で判定結果を出力してください。',
  ].join('\n');
}

function parseAIResponse(raw: string): AICheckResult {
  let json: Partial<AICheckResult> | null = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // JSON ブロックを正規表現で救出
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { json = JSON.parse(m[0]); } catch { /* noop */ }
    }
  }
  if (!json) {
    return {
      riskLevel: 'medium',
      confidence: 0.3,
      issues: [{ category: 'その他', detail: 'AI 応答を JSON として解釈できませんでした', severity: 'low' }],
      summary: '応答パース失敗',
      raw,
    };
  }
  return {
    riskLevel: (json.riskLevel as AICheckResult['riskLevel']) ?? 'medium',
    confidence: typeof json.confidence === 'number' ? json.confidence : 0.5,
    issues: Array.isArray(json.issues) ? json.issues : [],
    summary: typeof json.summary === 'string' ? json.summary : '',
    raw,
  };
}
