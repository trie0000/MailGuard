// A 段: 決定論的ルールベースの誤送信検出
//
// AI を使わずに正規表現 / 辞書 突合で確実に拾えるパターンだけ高精度に拾う。
// 偽陽性ゼロを目指す (= 「絶対これは問題」というケースだけ flag)。

import { ParsedMail, DeterministicHit, Settings } from '../types';

export function runDeterministicChecks(mail: ParsedMail, settings: Settings): DeterministicHit[] {
  const hits: DeterministicHit[] = [];
  hits.push(...checkInternalInCcOnExternal(mail, settings));
  hits.push(...checkTypoDomains(mail, settings));
  hits.push(...checkConfidentialKeywords(mail, settings));
  hits.push(...checkSalutationVsTo(mail));
  hits.push(...checkSubjectTagInBody(mail));
  hits.push(...checkNewParticipants(mail));
  return hits;
}

// ── 1. 外部宛なのに Cc に内部メンバーが入っている ──────────────────────
function checkInternalInCcOnExternal(mail: ParsedMail, settings: Settings): DeterministicHit[] {
  const own = new Set(settings.ownDomains.map(d => d.toLowerCase().replace(/^@/, '').trim()).filter(Boolean));
  if (own.size === 0) return [];
  const isInternal = (e: string) => {
    const dom = e.split('@')[1]?.toLowerCase();
    return dom ? own.has(dom) : false;
  };
  const externalTo = mail.to.some(t => !isInternal(t.email));
  if (!externalTo) return [];   // 全員社内なら関係ない
  const internalCc = mail.cc.filter(c => isInternal(c.email));
  if (internalCc.length === 0) return [];
  return [{
    category: '内部混入',
    severity: 'high',
    detail: `外部宛なのに Cc に内部メンバーが ${internalCc.length} 名含まれています: ${internalCc.map(c => c.email).join(', ')}`,
  }];
}

// ── 2. タイポ ドメイン ─────────────────────────────────────────────
function checkTypoDomains(mail: ParsedMail, settings: Settings): DeterministicHit[] {
  const all = [...mail.to, ...mail.cc, ...mail.bcc];
  const hits: DeterministicHit[] = [];
  for (const addr of all) {
    const dom = addr.email.split('@')[1]?.toLowerCase() ?? '';
    if (!dom) continue;
    const correction = settings.typoDomains[dom];
    if (correction) {
      hits.push({
        category: 'タイポ',
        severity: 'high',
        detail: `${addr.email} のドメイン "${dom}" は "${correction}" のタイポではありませんか?`,
      });
    }
  }
  return hits;
}

// ── 3. 機密キーワード × 外部宛 ─────────────────────────────────────
function checkConfidentialKeywords(mail: ParsedMail, settings: Settings): DeterministicHit[] {
  if (settings.internalKeywords.length === 0) return [];
  const own = new Set(settings.ownDomains.map(d => d.toLowerCase().replace(/^@/, '').trim()).filter(Boolean));
  const hasExternal = [...mail.to, ...mail.cc].some(r => {
    const dom = r.email.split('@')[1]?.toLowerCase();
    return dom && !own.has(dom);
  });
  if (!hasExternal) return [];
  const body = (mail.latestReply || mail.bodyText || '');
  const hits: string[] = [];
  for (const kw of settings.internalKeywords) {
    if (kw && body.includes(kw)) hits.push(kw);
  }
  if (hits.length === 0) return [];
  return [{
    category: '機密外部',
    severity: 'high',
    detail: `本文に機密キーワード (${hits.join(', ')}) が含まれている状態で外部宛に送信しようとしています`,
  }];
}

// ── 4. 本文冒頭の宛名 vs 実 To ─────────────────────────────────────
function checkSalutationVsTo(mail: ParsedMail): DeterministicHit[] {
  const salutation = extractSalutation(mail.latestReply);
  if (!salutation) return [];
  if (mail.to.length === 0) {
    return [{ category: '宛名不一致', severity: 'high', detail: `本文冒頭は "${salutation}" 宛だが、To が空です` }];
  }
  // 名前の正規化: 「○○ 株式会社」「○○様」のような表記から抽出済みなので
  // 構成要素 (= 苗字 / 会社名) のいずれかが To の name 部分に含まれるか確認。
  const targetNames = mail.to.map(t => t.name).filter(Boolean);
  const targetEmailLocals = mail.to.map(t => t.email.split('@')[0] ?? '').filter(Boolean);
  if (targetNames.length === 0 && targetEmailLocals.every(l => !l)) return [];
  // salutation を細かく分解 (= 「ABC 株式会社 田中様」 → ABC, 株式会社, 田中)
  const tokens = tokenizeSalutation(salutation);
  if (tokens.length === 0) return [];

  const hayNames = targetNames.join(' ').toLowerCase();
  const hayLocals = targetEmailLocals.join(' ').toLowerCase();
  const matched = tokens.some(tok => {
    const t = tok.toLowerCase();
    return hayNames.includes(t) || hayLocals.includes(t);
  });
  if (matched) return [];
  return [{
    category: '宛名不一致',
    severity: 'high',
    detail: `本文冒頭の宛名 "${salutation}" と To の名前 "${targetNames.join(', ') || mail.to.map(t => t.email).join(', ')}" に一致が見つかりません`,
  }];
}

/** 「○○様」「○○ 株式会社」など本文冒頭の宛名を抽出 */
export function extractSalutation(latestReply: string): string | null {
  if (!latestReply) return null;
  const head = latestReply.split('\n').slice(0, 4).join('\n').trim();
  if (!head) return null;
  // パターン 1: 「○○ 様」「○○ 御中」「○○ 殿」「○○ さん」
  const m1 = head.match(/^[\s　]*([^\s　、,。\n]{1,40}?)[ 　]*(様|御中|殿|さん|さま)\b/);
  if (m1) return (m1[1]! + m1[2]!).trim();
  // パターン 2: 「○○ 株式会社 御中」(複数語)
  const m2 = head.match(/^[\s　]*([^\n]{1,60}?)(株式会社|有限会社|合同会社|合資会社)(.*?(御中|殿))?/);
  if (m2) return (m2[0] ?? '').trim();
  // パターン 3: 英語 "Dear Mr/Ms ..."
  const m3 = head.match(/^Dear\s+(?:Mr|Ms|Mrs|Dr)\.?\s+([A-Za-z][A-Za-z\-' ]{1,40})/i);
  if (m3) return 'Dear ' + (m3[1] ?? '').trim();
  return null;
}

function tokenizeSalutation(s: string): string[] {
  // 「ABC 株式会社 田中様」→ ["ABC", "株式会社", "田中"]
  return s
    .replace(/[様御中殿さんさま]/g, ' ')
    .replace(/(株式会社|有限会社|合同会社)/g, ' $1 ')
    .split(/[\s　,、]/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);    // 1 文字は誤マッチ多いので除外
}

// ── 5. 件名のチケット タグ vs 本文中の言及タグ ──────────────────────
function checkSubjectTagInBody(mail: ParsedMail): DeterministicHit[] {
  const subjTag = mail.subject.match(/\[?\s*([A-Z]{1,6}#?\d{2,8})\s*\]?/i);
  if (!subjTag) return [];
  const tagInSubj = subjTag[1]!.toUpperCase();
  const bodyTags = Array.from(mail.latestReply.matchAll(/\[?\s*([A-Z]{1,6}#?\d{2,8})\s*\]?/gi))
    .map(m => m[1]!.toUpperCase());
  const distinct = bodyTags.filter(t => t !== tagInSubj);
  if (distinct.length === 0) return [];
  return [{
    category: '件名タグ不一致',
    severity: 'high',
    detail: `件名のチケット タグ "${tagInSubj}" と本文中の言及タグ ${distinct.map(t => `"${t}"`).join(', ')} が異なります`,
  }];
}

// ── 6. 過去履歴に登場しない新規参加者 ───────────────────────────────
//   過去メールの To / Cc / From / 差出人 / 宛先 / 送信者 ヘッダから登場した
//   全メアド (= ドメインではなく完全一致) を集合化し、新メールの To+Cc に
//   含まれるメアドが 1 つでも履歴に出てこなければ「新規参加者」として flag。
//
//   想定する誤送信:
//     - 過去の人全員 ＋ 別案件の関係者を Cc にうっかり追加
//     - 履歴の人と似たメアド (= タイポ) を打って送ろうとしている
//     - 別人だが Reply-All で広がった先が正当でない可能性
//
//   検出基準は「ドメイン」ではなく「メアド完全一致」(= 厳格)。
function checkNewParticipants(mail: ParsedMail): DeterministicHit[] {
  if (!mail.quotedHistory) return [];

  // 引用部から To / Cc / From / 差出人 / 宛先 / 送信者 ヘッダ行を抽出
  //   1 行に複数アドレスが入っているケース (= "To: a@x.com, b@y.com") に対応するため
  //   ヘッダ行の値を取り出してから email regex で個別抽出する
  const HEADER_RE = /(?:差出人|送信者|宛先|From|To|Cc)\s*[:：]\s*([^\n]*)/gi;
  const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
  const known = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = HEADER_RE.exec(mail.quotedHistory)) !== null) {
    const line = m[1] ?? '';
    const emails = line.match(EMAIL_RE) ?? [];
    for (const e of emails) known.add(e.toLowerCase().trim());
  }
  if (known.size === 0) return [];   // 履歴ヘッダなし (= 比較基準が無いので不発)

  // 新メールの To / Cc を 1 件ずつ照合
  const recipients = [...mail.to, ...mail.cc];
  const novel = recipients
    .map(r => ({ email: r.email.toLowerCase().trim(), name: r.name }))
    .filter(r => r.email && !known.has(r.email));
  if (novel.length === 0) return [];

  const novelLabels = novel.map(r => r.name ? `${r.name} <${r.email}>` : r.email);
  return [{
    category: '新規参加者',
    severity: 'high',
    detail: `過去履歴 (To / Cc / From) に登場しないメアドが宛先に含まれています: `
          + `${novelLabels.join(', ')}`,
  }];
}
