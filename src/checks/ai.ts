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
import { chatCompletion, ChatRequest } from '../relay/ai-client';

const SYSTEM_PROMPT = `あなたはメール誤送信検出の専門家です。
日本のビジネスメールを中心に、ヘッダ / 本文 / 過去履歴を比較して
「別人・別案件に誤って送ろうとしている可能性」を判定してください。

判定軸 (= 必ず全て見る):
  1. 本文冒頭の宛名 (例: 「田中様」) と To の名前は一致するか
  2. 本文の話題と過去履歴の話題は連続しているか
  3. 本文に固有名詞 (会社名 / 案件 ID / 製品名) が出る場合、To と整合するか
  4. 文体・敬語レベルは過去スレッドと一貫しているか

★ 注意: 宛先メアドの新規/既知判定は決定論ルール (= 別途実行済) が機械的に
   担当しているため、AI 側ではドメイン一致 / メアド一致の機械的判定は行わない。
   AI は文脈解釈・固有名詞・話題連続性 等の "意味" 判定に集中すること。

応答は必ず以下の JSON のみ (= 説明文や前置きを付けないこと):
{
  "riskLevel": "high" | "medium" | "low" | "ok",
  "confidence": 0.0〜1.0 の数値,
  "issues": [
    {
      "category": "宛名不一致" | "話題乖離" | "固有名詞不整合" | "文体急変" | "その他",
      "detail": "具体的にどう問題か (1〜2 文)",
      "severity": "high" | "medium" | "low"
    }
  ],
  "summary": "総評 (1〜2 文)"
}

各 issue の severity 基準:
  - high: 誤送信の可能性が極めて高い (= 別人・別案件)
  - medium: 違和感はあるが正当な可能性も残る (= 要確認)
  - low: 軽微 (= 表記ゆれ・敬称差 等)

問題なし時は { "riskLevel": "ok", "confidence": ..., "issues": [], "summary": "..." } を返してください。`;

export async function runAICheck(
  mail: ParsedMail,
  detHits: DeterministicHit[],
  settings: Settings,
): Promise<AICheckResult> {
  const userPrompt = buildUserPrompt(mail, detHits);
  // reasoning モデル (= gpt-5 / o3 / o4-mini 系) は temperature カスタム値を
  // 受け付けず、明示するとエラー (= "temperature does not support 0 with this model")
  // になるため、条件付きで省略する。
  const req: ChatRequest = {
    model: activeModel(settings),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  };
  if (supportsTemperature(settings)) req.temperature = 0.0;
  const resp = await chatCompletion(settings, req);
  const content = resp.choices?.[0]?.message?.content ?? '';
  return parseAIResponse(content);
}

function buildUserPrompt(mail: ParsedMail, detHits: DeterministicHit[]): string {
  const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max) + '\n…(以下省略)' : s;
  const fmtAddr = (a: { name: string; email: string }) => a.name ? `${a.name} <${a.email}>` : a.email;

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
    truncate(mail.latestReply || mail.bodyText || '(なし)', 4000),
    '',
    '【過去のやり取り (引用部から抽出)】',
    truncate(mail.quotedHistory || '(なし)', 4000),
    '',
    '【添付ファイル名】',
    mail.attachments.length === 0 ? '(なし)' : mail.attachments.join(', '),
    '',
    '【決定論ルールによる事前検出】',
    detSummary,
    '',
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
