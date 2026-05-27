import { el } from '../utils/dom';
import { CombinedResult, DeterministicHit, AIIssue, RecipientInfo } from '../types';

export function renderResult(result: CombinedResult): HTMLElement {
  const aiOk = !('error' in result.ai);
  const aiResult = aiOk ? (result.ai as Exclude<typeof result.ai, { error: string }>) : null;
  const aiError = !aiOk ? (result.ai as { error: string }).error : null;

  // 総合リスク = max(decisive hits の最高 severity, ai.riskLevel)
  const allSev = [
    ...result.deterministic.map(h => h.severity),
    ...(aiResult ? aiResult.issues.map(i => i.severity) : []),
  ];
  const overall = aiResult?.riskLevel === 'ok' && result.deterministic.length === 0
    ? 'ok'
    : allSev.includes('high') ? 'high'
    : allSev.includes('medium') ? 'medium'
    : allSev.includes('low') ? 'low'
    : (aiResult?.riskLevel ?? 'ok');

  return el('div', {
    style: 'background:#fff;border-radius:10px;padding:20px;border:1px solid #e8e4d8',
  }, [
    renderOverallBanner(overall, aiResult?.confidence ?? null, aiResult?.summary ?? null),

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
        aiOk ? `${aiResult!.issues.length} 件 / 信頼度 ${Math.round((aiResult!.confidence ?? 0) * 100)}%`
             : '失敗'),
      aiError
        ? el('div', { style: 'font-size:13px;color:#991b1b;padding:8px 12px;background:#fee2e2;border-radius:6px' }, [aiError])
        : aiResult!.issues.length === 0
          ? el('div', { style: 'font-size:13px;color:#7a766c;padding:6px 0' }, ['(AI: 問題なし)'])
          : el('div', {}, aiResult!.issues.map(renderAIIssue)),
      ...(aiResult?.summary && aiResult.issues.length > 0 ? [
        el('div', {
          style: 'margin-top:10px;padding:8px 12px;background:#f3f1ea;border-radius:6px;'
               + 'font-size:12px;color:#7a766c;line-height:1.7;font-style:italic',
        }, ['💬 AI 総評: ' + aiResult.summary]),
      ] : []),
    ]),
  ]);
}

function sectionHeader(label: string, badge: string): HTMLElement {
  return el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:8px' }, [
    el('div', { style: 'font-size:13px;font-weight:700;color:#2a2a26' }, [label]),
    el('div', { style: 'font-size:11px;color:#a8a39a;padding:2px 8px;background:#f3f1ea;border-radius:10px' }, [badge]),
  ]);
}

function renderOverallBanner(level: string, confidence: number | null, summary: string | null): HTMLElement {
  const palette: Record<string, { bg: string; border: string; color: string; icon: string; label: string }> = {
    high: { bg: '#fef2f2', border: '#dc2626', color: '#991b1b', icon: '🚨', label: '高リスク — 送信前に必ず確認' },
    medium: { bg: '#fef3c7', border: '#f59e0b', color: '#92400e', icon: '⚠', label: '中リスク — 一度確認をおすすめ' },
    low: { bg: '#fef3c7', border: '#f59e0b', color: '#92400e', icon: '💡', label: '低リスク — 軽微な指摘あり' },
    ok: { bg: '#ecfdf5', border: '#10b981', color: '#065f46', icon: '✅', label: '問題なし — 送信して OK' },
  };
  const p = palette[level] ?? palette.ok!;
  return el('div', {
    style: `background:${p.bg};border-left:6px solid ${p.border};color:${p.color};`
         + 'padding:16px 20px;border-radius:8px;display:flex;gap:14px;align-items:flex-start',
  }, [
    el('div', { style: 'font-size:30px;line-height:1' }, [p.icon]),
    el('div', { style: 'flex:1;min-width:0' }, [
      el('div', { style: 'font-size:16px;font-weight:700;margin-bottom:4px' }, [p.label]),
      ...(confidence !== null ? [
        el('div', { style: 'font-size:12px;opacity:0.85' }, [`AI 信頼度: ${Math.round(confidence * 100)}%`]),
      ] : []),
      ...(summary ? [
        el('div', { style: 'font-size:13px;margin-top:6px;line-height:1.7' }, [summary]),
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
