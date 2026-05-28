import { el } from '../utils/dom';
import { CombinedResult, DeterministicHit, AIIssue, RecipientInfo } from '../types';

export function renderResult(result: CombinedResult): HTMLElement {
  const aiOk = !('error' in result.ai);
  const aiResult = aiOk ? (result.ai as Exclude<typeof result.ai, { error: string }>) : null;
  const aiError = !aiOk ? (result.ai as { error: string }).error : null;

  // ── 総合リスク 算定 ──────────────────────────────────────────────────
  //   ルールベース検出を 2 種類に分けて扱う:
  //
  //     Hard (= 確定事実): タイポ / 内部混入 / 機密外部
  //        正規表現・辞書で機械的に確定する事実なので、AI でも下げられない floor。
  //
  //     Soft (= 推測 heuristic): 宛名不一致 / 件名タグ不一致 / 新規参加者
  //        文脈次第で正当な可能性があるため、AI が成功していれば AI の総合判断
  //        (= riskLevel) に委ねる。AI はプロンプトで これら hit を受け取った上で
  //        最終判断しているので、AI が low と言うなら soft hit で上書きしない。
  //
  //   これにより「ML 宛の "ご担当者様" を 宛名不一致 (soft) が high にしても、
  //   AI が low と判断すれば overall=low」 となり、サマリと バナーの矛盾が消える。
  //   一方で タイポ等の hard は AI が見落としても必ず効く。
  const order: Record<string, number> = { ok: 0, low: 1, medium: 2, high: 3 };
  const HARD_CATEGORIES = new Set<DeterministicHit['category']>(['タイポ', '内部混入', '機密外部']);
  const maxSev = (hits: { severity: 'high' | 'medium' | 'low' }[]): 'ok' | 'low' | 'medium' | 'high' =>
    hits.length === 0 ? 'ok'
      : hits.some(h => h.severity === 'high') ? 'high'
      : hits.some(h => h.severity === 'medium') ? 'medium'
      : 'low';

  const hardHits = result.deterministic.filter(h => HARD_CATEGORIES.has(h.category));
  const softHits = result.deterministic.filter(h => !HARD_CATEGORIES.has(h.category));
  const hardMax = maxSev(hardHits);
  const softMax = maxSev(softHits);
  const aiLevel: 'ok' | 'low' | 'medium' | 'high' = aiResult?.riskLevel ?? 'ok';

  // AI 成功時: soft は AI に委譲 (= max(hard, AI))。AI 失敗時: 安全側で全ルール採用。
  const pickMax = (...lv: ('ok' | 'low' | 'medium' | 'high')[]) =>
    lv.reduce((m, c) => (order[c]! > order[m]!) ? c : m, 'ok' as 'ok' | 'low' | 'medium' | 'high');
  const overall = aiOk
    ? pickMax(hardMax, aiLevel)
    : pickMax(hardMax, softMax);

  // AI が soft ルールの判定を 下方修正したか (= バナーで「AI が再評価して降格」と注記用)
  const aiDowngradedSoft = aiOk && order[softMax]! > order[overall]!;

  return el('div', {
    style: 'background:#fff;border-radius:10px;padding:20px;border:1px solid #e8e4d8',
  }, [
    renderOverallBanner(
      overall,
      aiResult?.confidence ?? null,
      aiResult?.summary ?? null,
      result.deterministic,
      aiOk,
      aiError,
      aiDowngradedSoft,
    ),

    // 決定論ルール ヒット
    el('div', { style: 'margin-top:18px' }, [
      sectionHeader('🔧 ルールベース検出', `${result.deterministic.length} 件`),
      result.deterministic.length === 0
        ? el('div', { style: 'font-size:13px;color:#7a766c;padding:6px 0' }, ['(検出なし)'])
        : el('div', {}, result.deterministic.map(renderDetHit)),
    ]),

    // Outlook GAL 解決結果 (= 部署 / 役職 / 同姓候補 / 過去参加者)
    ...(result.recipientInfo || result.similarNameCandidates || result.pastParticipantInfo
       ? [renderGalSection(result)] : []),

    // AI 結果
    el('div', { style: 'margin-top:18px' }, [
      sectionHeader('🤖 AI 解析結果',
        aiOk ? `${aiResult!.issues.length} 件 / 判定: ${aiRiskLabel(aiResult!.riskLevel)} / 信頼度 ${Math.round((aiResult!.confidence ?? 0) * 100)}%`
             : '失敗 (= スキップではなく エラーで未完了)'),
      aiError
        ? el('div', { style: 'font-size:13px;color:#991b1b;padding:10px 12px;background:#fee2e2;border-radius:6px;line-height:1.6' }, [
            el('div', { style: 'font-weight:700;margin-bottom:4px' }, ['✗ AI 解析が失敗しました']),
            el('div', {}, [aiError]),
            el('div', { style: 'margin-top:6px;font-size:11px;opacity:0.85' }, [
              '対処: 設定で API キーと プロバイダ / モデルを確認。 社内環境なら .env に MAILGUARD_AI_PROXY を設定。',
            ]),
          ])
        : renderAiOkBlock(aiResult!),
    ]),
  ]);
}

/** AI が成功した時のブロック (= 0 件でも「実行完了したこと」を必ず示す) */
function renderAiOkBlock(ai: { riskLevel: string; confidence: number; issues: AIIssue[]; summary: string; raw?: string }): HTMLElement {
  const noIssues = ai.issues.length === 0;
  return el('div', {}, [
    // 必ず表示する確認バナー (= AI が動いたかどうかを一目で判別)
    el('div', {
      style: 'padding:8px 12px;background:#ecfdf5;border-left:3px solid #10b981;border-radius:0 6px 6px 0;'
           + 'margin-bottom:8px;font-size:12px;color:#065f46;line-height:1.6',
    }, [
      el('div', { style: 'font-weight:700' }, [
        `✓ AI 解析 完了 — 判定: ${aiRiskLabel(ai.riskLevel)} / 検出 ${ai.issues.length} 件 / 信頼度 ${Math.round((ai.confidence ?? 0) * 100)}%`,
      ]),
      ai.summary
        ? el('div', { style: 'margin-top:4px' }, ['💬 ' + ai.summary])
        : el('div', { style: 'margin-top:4px;font-style:italic;opacity:0.85' }, [
            noIssues ? '(AI から問題指摘なし — 件名 / 本文 / 宛先 / 添付 を解析した結果、誤送信の兆候は検出されませんでした)' : '(総評なし)',
          ]),
    ]),
    // 個別 issue
    noIssues
      ? el('div', { style: 'font-size:13px;color:#7a766c;padding:6px 0' }, ['(個別の指摘なし)'])
      : el('div', {}, ai.issues.map(renderAIIssue)),
    // 生応答 (= 開いて中身を確認できる details/summary)
    ...(ai.raw ? [
      el('details', { style: 'margin-top:8px' }, [
        el('summary', { style: 'cursor:pointer;font-size:11px;color:#a8a39a;user-select:none' }, [
          '🔍 AI 生応答を表示 (= 判定根拠の確認用)',
        ]),
        el('pre', {
          style: 'margin:6px 0 0;padding:10px;background:#f3f1ea;border-radius:6px;'
               + 'font-size:11px;color:#555;line-height:1.5;white-space:pre-wrap;word-break:break-all;'
               + 'max-height:240px;overflow:auto',
        }, [ai.raw]),
      ]),
    ] : []),
  ]);
}

function aiRiskLabel(level: string): string {
  switch (level) {
    case 'high': return '🔴 高リスク';
    case 'medium': return '🟡 中リスク';
    case 'low': return '🔵 低リスク';
    case 'ok': return '✅ 問題なし';
    default: return level || '?';
  }
}

function sectionHeader(label: string, badge: string): HTMLElement {
  return el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:8px' }, [
    el('div', { style: 'font-size:13px;font-weight:700;color:#2a2a26' }, [label]),
    el('div', { style: 'font-size:11px;color:#a8a39a;padding:2px 8px;background:#f3f1ea;border-radius:10px' }, [badge]),
  ]);
}

function renderOverallBanner(
  level: string,
  confidence: number | null,
  aiSummary: string | null,
  detHits: DeterministicHit[],
  aiOk: boolean,
  aiError: string | null,
  aiDowngradedSoft: boolean,
): HTMLElement {
  const palette: Record<string, { bg: string; border: string; color: string; icon: string; label: string }> = {
    high: { bg: '#fef2f2', border: '#dc2626', color: '#991b1b', icon: '🚨', label: '高リスク — 送信前に必ず確認' },
    medium: { bg: '#fef3c7', border: '#f59e0b', color: '#92400e', icon: '⚠', label: '中リスク — 一度確認をおすすめ' },
    low: { bg: '#fef3c7', border: '#f59e0b', color: '#92400e', icon: '💡', label: '低リスク — 軽微な指摘あり' },
    ok: { bg: '#ecfdf5', border: '#10b981', color: '#065f46', icon: '✅', label: '問題なし — 送信して OK' },
  };
  const p = palette[level] ?? palette.ok!;

  // ── ルールベース 集計 (= severity 別の件数 + カテゴリ一覧) ─────────────
  const detBySev = { high: 0, medium: 0, low: 0 };
  const detCategories: string[] = [];
  for (const h of detHits) {
    detBySev[h.severity]++;
    if (!detCategories.includes(h.category)) detCategories.push(h.category);
  }
  const detSummary = detHits.length === 0
    ? '🔧 ルールベース: 検出なし (= 機械判定で異常なし)'
    : `🔧 ルールベース: ${detHits.length} 件 検出`
      + ` (${[
          detBySev.high   ? `🔴 高 ${detBySev.high}` : '',
          detBySev.medium ? `🟡 中 ${detBySev.medium}` : '',
          detBySev.low    ? `🔵 低 ${detBySev.low}` : '',
        ].filter(Boolean).join(' / ')})`
      + ` — ${detCategories.join(', ')}`;

  // ── AI サマリ ──────────────────────────────────────────────────────
  const aiLine = !aiOk
    ? `🤖 AI: 解析失敗 (${(aiError ?? '').slice(0, 80)}…)`
    : aiSummary
      ? `🤖 AI: ${aiSummary}`
      : '🤖 AI: 解析完了 — 個別指摘なし';

  return el('div', {
    style: `background:${p.bg};border-left:6px solid ${p.border};color:${p.color};`
         + 'padding:16px 20px;border-radius:8px;display:flex;gap:14px;align-items:flex-start',
  }, [
    el('div', { style: 'font-size:30px;line-height:1' }, [p.icon]),
    el('div', { style: 'flex:1;min-width:0' }, [
      el('div', { style: 'font-size:16px;font-weight:700;margin-bottom:6px' }, [p.label]),
      ...(confidence !== null ? [
        el('div', { style: 'font-size:12px;opacity:0.85;margin-bottom:6px' }, [`AI 信頼度: ${Math.round(confidence * 100)}%`]),
      ] : []),
      // ★ ルールベース と AI の 2 行サマリ (= 必ず両方表示)
      el('div', { style: 'font-size:13px;line-height:1.7;margin-top:4px' }, [detSummary]),
      el('div', { style: 'font-size:13px;line-height:1.7' }, [aiLine]),
      // AI が推測ルール (soft) を再評価して総合リスクを下げた場合の注記
      ...(aiDowngradedSoft ? [
        el('div', { style: 'font-size:12px;line-height:1.6;margin-top:4px;opacity:0.9' }, [
          'ℹ ルールベースの推測検出 (宛名 / 件名タグ / 新規参加者) は AI が文脈を踏まえて'
          + '再評価し、総合リスクを上記レベルに調整しました (= タイポ / 内部混入 / 機密漏洩 の'
          + '確定検出はこの調整の対象外で、常に総合リスクへ反映されます)。',
        ]),
      ] : []),
    ]),
  ]);
}

function renderDetHit(hit: DeterministicHit): HTMLElement {
  return renderIssue(hit.severity, hit.category, hit.detail);
}
function renderAIIssue(issue: AIIssue): HTMLElement {
  return renderIssue(issue.severity, issue.category, issue.detail);
}

// ── Outlook GAL 解決結果セクション ────────────────────────────────────
function renderGalSection(result: CombinedResult): HTMLElement {
  const info = result.recipientInfo || [];
  const past = result.pastParticipantInfo || [];
  const similar = result.similarNameCandidates || [];
  const resolvedCount = info.filter(r => r.resolved).length;
  return el('div', { style: 'margin-top:18px' }, [
    sectionHeader('📇 宛先の組織情報 (Outlook GAL)',
      `今回 ${resolvedCount}/${info.length}`
      + (past.length > 0 ? ` / 過去参加者 ${past.filter(r => r.resolved).length}/${past.length}` : '')
      + (similar.length > 0 ? ` / 同姓候補 ${similar.length}` : '')),
    el('div', { style: 'font-size:11px;color:#a8a39a;margin-bottom:6px' }, ['【今回の宛先】']),
    info.length === 0
      ? el('div', { style: 'font-size:13px;color:#7a766c;padding:6px 0' }, ['(取得なし)'])
      : el('div', {}, info.map(r => renderRecipientRow(r))),

    ...(past.length > 0 ? [
      el('div', { style: 'font-size:11px;color:#a8a39a;margin:10px 0 6px' }, [
        '【過去履歴の参加者】 (= 引用部から抽出、AI が今回宛先との所属差をチェック)',
      ]),
      el('div', {}, past.map(r => renderRecipientRow(r))),
    ] : []),

    ...(similar.length > 0 ? [
      el('div', { style: 'margin-top:10px;padding:10px 12px;background:#fef3c7;border-left:3px solid #f59e0b;border-radius:0 6px 6px 0' }, [
        el('div', { style: 'font-size:12px;font-weight:700;color:#92400e;margin-bottom:6px' }, [
          `⚠ 同姓候補 (GAL に同名の別人が ${similar.length} 名います)`,
        ]),
        el('div', {}, similar.map(r => renderRecipientRow(r, true))),
      ]),
    ] : []),
  ]);
}

function renderRecipientRow(r: RecipientInfo, isCandidate = false): HTMLElement {
  const palette = !r.resolved
    ? { bg: '#fafaf7', border: '#c0bdb0', color: '#7a766c', icon: '◌' }
    : r.type === 'exchange-user'
      ? (isCandidate
        ? { bg: '#fef3c7', border: '#f59e0b', color: '#7c2d12', icon: '🔍' }
        : { bg: '#dbeafe', border: '#3b82f6', color: '#1e40af', icon: '🟢' })
      : { bg: '#f3f1ea', border: '#a8a39a', color: '#7a766c', icon: '🌐' };
  const parts: HTMLElement[] = [];
  parts.push(el('div', { style: 'font-weight:700;font-size:13px' }, [r.email]));
  if (r.resolved) {
    const meta: string[] = [];
    if (r.displayName) meta.push(r.displayName);
    if (r.department) meta.push('部署: ' + r.department);
    if (r.jobTitle) meta.push('役職: ' + r.jobTitle);
    if (r.officeLocation) meta.push('拠点: ' + r.officeLocation);
    if (r.manager) meta.push('上長: ' + r.manager);
    parts.push(el('div', { style: 'font-size:12px;margin-top:2px;color:' + palette.color + ';opacity:0.9' }, [meta.join(' / ') || '(詳細なし)']));
  } else {
    parts.push(el('div', { style: 'font-size:12px;margin-top:2px;color:' + palette.color }, ['(GAL 未解決 / 外部メアド)']));
  }
  return el('div', {
    style: `background:${palette.bg};border-left:3px solid ${palette.border};color:${palette.color};`
         + 'padding:6px 12px;border-radius:0 6px 6px 0;margin-bottom:6px;'
         + 'display:flex;gap:10px;align-items:flex-start',
  }, [
    el('div', { style: 'font-size:13px;line-height:1.4' }, [palette.icon]),
    el('div', { style: 'flex:1;min-width:0' }, parts),
  ]);
}

function renderIssue(severity: 'high' | 'medium' | 'low', category: string, detail: string): HTMLElement {
  const palette = {
    high:   { bg: '#fee2e2', border: '#dc2626', color: '#991b1b', icon: '🔴' },
    medium: { bg: '#fef3c7', border: '#f59e0b', color: '#92400e', icon: '🟡' },
    low:    { bg: '#dbeafe', border: '#3b82f6', color: '#1e40af', icon: '🔵' },
  }[severity];
  return el('div', {
    style: `background:${palette.bg};border-left:3px solid ${palette.border};color:${palette.color};`
         + 'padding:8px 12px;border-radius:0 6px 6px 0;margin-bottom:6px;font-size:13px;line-height:1.6;'
         + 'display:flex;gap:10px;align-items:flex-start',
  }, [
    el('div', { style: 'font-size:14px;line-height:1.4' }, [palette.icon]),
    el('div', { style: 'flex:1;min-width:0' }, [
      el('div', { style: 'font-weight:700;margin-bottom:2px' }, [category]),
      el('div', { style: 'font-size:12px' }, [detail]),
    ]),
  ]);
}
