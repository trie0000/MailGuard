// A 段: 決定論的ルールベースの誤送信検出
//
// AI を使わずに正規表現 / 辞書 突合で確実に拾えるパターンだけ高精度に拾う。
// 偽陽性ゼロを目指す (= 「絶対これは問題」というケースだけ flag)。

import { ParsedMail, DeterministicHit, Settings, RecipientInfo } from '../types';
import { flattenMemberNames, isDistributionList } from '../relay/outlook-client';

export function runDeterministicChecks(
  mail: ParsedMail,
  settings: Settings,
  recipientInfo: RecipientInfo[] = [],
): DeterministicHit[] {
  const hits: DeterministicHit[] = [];
  hits.push(...checkInternalInCcOnExternal(mail, settings));
  hits.push(...checkTypoDomains(mail, settings));
  hits.push(...checkConfidentialKeywords(mail, settings));
  hits.push(...checkSalutationVsTo(mail, recipientInfo));
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
//   ルール:
//     - To と本文の宛名が一致しない → 誤送信 high リスク
//     - To が ML の場合は、ML メンバー (= displayName / lastName / firstName) に
//       本文の宛名が含まれていれば 問題なし (= 警告しない)
//     - ML メンバー情報が GAL / CSV から取得できなかった場合は判断保留 (= 警告しない)
//     - 過去履歴 (= 同じスレッドの引用部) に「同じ To + 同じ宛名」の組合せが
//       既に出ていれば → low に降格 (= メンバー情報を取得できない ML の偽陽性回避)
//
//   例:
//     OK : To=tanaka@xxx <田中 太郎>, 本文「田中様」
//     NG : To=tanaka@xxx, 本文「鈴木様」
//     OK : To=sales-team@xxx (メンバー: 田中/鈴木/山田), 本文「鈴木様」
//     NG : To=sales-team@xxx (メンバー: 田中/鈴木/山田), 本文「佐藤様」
//     LOW: To=external-ml@xxx (メンバー不明), 本文「鈴木様」、
//          かつ 過去履歴に「To=external-ml@xxx, 本文『鈴木様』」が既出
function checkSalutationVsTo(mail: ParsedMail, recipientInfo: RecipientInfo[]): DeterministicHit[] {
  const salutation = extractSalutation(mail.latestReply);
  if (!salutation) return [];
  if (mail.to.length === 0) {
    return [{ category: '宛名不一致', severity: 'high', detail: `本文冒頭は "${salutation}" 宛ですが、To が空です (= 送信先未設定の誤送信リスク)` }];
  }

  // 照合対象を構築:
  //   - To の displayName (= "山田 太郎 <yamada@...>" の "山田 太郎")
  //   - To のメアド local part (= "tanaka.taro@..." → "tanaka.taro")
  //   - ML 宛の場合: ML メンバー全員の displayName / lastName / firstName
  const targetNames: string[] = [];
  const targetEmailLocals: string[] = [];
  let hasMlExpansion = false;
  let hasMlWithoutMembers = false;   // ML だがメンバー情報が無い (= GAL/CSV 未解決)
  for (const t of mail.to) {
    if (t.name) targetNames.push(t.name);
    const local = t.email.split('@')[0];
    if (local) targetEmailLocals.push(local);
    // GAL / CSV から ML 情報があれば、メンバー名も照合候補に追加
    const info = recipientInfo.find(r => r.email.toLowerCase() === t.email.toLowerCase());
    if (info && isDistributionList(info)) {
      const memberNames = flattenMemberNames(info);
      if (memberNames.length > 0) {
        targetNames.push(...memberNames);
        hasMlExpansion = true;
      } else {
        hasMlWithoutMembers = true;
      }
    }
  }

  if (targetNames.length === 0 && targetEmailLocals.every(l => !l)) return [];

  const tokens = tokenizeSalutation(salutation);
  if (tokens.length === 0) return [];

  const hayNames = targetNames.join(' ').toLowerCase();
  const hayLocals = targetEmailLocals.join(' ').toLowerCase();
  const matched = tokens.some(tok => {
    const t = tok.toLowerCase();
    return hayNames.includes(t) || hayLocals.includes(t);
  });
  if (matched) return [];

  // ★ 判断保留: ML 宛で メンバー情報が取れなかった場合は警告しない (= 偽陽性を避ける)
  //   例: 外部 ML で GAL に無く、CSV も登録されてない → メンバー不明 → high と
  //       決めるには情報不足。AI 側で文脈判断に委ねる。
  if (hasMlWithoutMembers && !hasMlExpansion) return [];

  // ★ 過去履歴チェック: 同じ To + 同じ宛名 の組合せが過去にあれば low に降格
  //    (= こちらで メンバーを把握できない ML の誤検出対策)
  //    例: To=external-ml@xxx, 本文「鈴木様」 で 一致しないが、
  //        引用部の過去メールが「To=external-ml@xxx, 本文『鈴木様』」だった場合
  //        → ML 内の正しい宛先名と判明済 → low
  const toLabel = mail.to.map(t => t.name ? `${t.name} <${t.email}>` : t.email).join(', ');
  const currentToLower = mail.to.map(t => t.email.toLowerCase().trim());
  const salutationTokensLower = tokens.map(t => t.toLowerCase());
  const pastSegments = parseQuotedSegments(mail.quotedHistory);
  const pastHadSamePair = pastSegments.some(seg => {
    const sharedTo = seg.to.some(e => currentToLower.includes(e));
    if (!sharedTo || !seg.salutation) return false;
    const pastTokens = tokenizeSalutation(seg.salutation).map(t => t.toLowerCase());
    return salutationTokensLower.some(s => pastTokens.includes(s));
  });

  if (pastHadSamePair) {
    return [{
      category: '宛名不一致',
      severity: 'low',
      detail: `本文宛名 "${salutation}" と To "${toLabel}" は直接一致しませんが、`
            + `過去履歴で 同じ To + 同じ宛名 の組合せが既出のため low に降格しました `
            + `(= ML メンバー情報を取得できないケースの偽陽性回避)。`,
    }];
  }

  // 不一致 → high
  const detail = hasMlExpansion
    ? `本文冒頭の宛名 "${salutation}" が To の ML メンバー (${targetNames.length} 名) に存在しません。`
      + ` To=${toLabel}。 別の人宛のメールを ML に投げている可能性があります (= 誤送信 high リスク)。`
    : `本文冒頭の宛名 "${salutation}" と To "${toLabel}" の名前が一致しません。`
      + ` 別人宛の下書きを誤った宛先に送ろうとしている可能性があります (= 誤送信 high リスク)。`;
  return [{ category: '宛名不一致', severity: 'high', detail }];
}

// ── 過去履歴 (引用部) のセグメント パーサ ─────────────────────────────
//   引用部を 1 メッセージずつに分割し、各メッセージの To/Cc と本文冒頭の宛名を抽出。
//   メッセージ境界: "From:" / "差出人:" / "送信者:" ヘッダ行 or
//                  "-----Original Message-----" / "----- Forwarded message -----"
interface PastSegment {
  to: string[];               // 各メッセージの To/Cc/宛先 (= lowercase)
  salutation: string | null;  // そのメッセージの本文冒頭の宛名
}
export function parseQuotedSegments(quotedHistory: string): PastSegment[] {
  if (!quotedHistory) return [];
  // 引用記号 "> " を剥がす (= Gmail / メール クライアントの quote 表記)
  const cleaned = quotedHistory.split('\n').map(l => l.replace(/^[> 　]+/, '')).join('\n');

  // メッセージ境界で分割
  //   1. "-----Original Message-----" / "----- Forwarded message -----" 等
  //   2. 行頭の "From:" / "差出人:" / "送信者:" ヘッダ (= 新メッセージ開始の合図)
  const SEP_RE = /(?:^|\n)(?:[-=]{2,}\s*(?:Original Message|Forwarded message|転送されたメッセージ)[^\n]*[-=]*\s*\n|(?=(?:From|差出人|送信者)\s*[:：]))/i;
  const parts = cleaned.split(SEP_RE).filter(p => p && p.trim());

  const segments: PastSegment[] = [];
  const HEADER_LINE = /^(From|To|Cc|Subject|Date|差出人|宛先|送信者|件名|送信日時|Sent)\s*[:：]\s*(.*)$/i;
  const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;

  for (const part of parts) {
    const lines = part.split('\n');
    const toEmails: string[] = [];
    let bodyStart = 0;
    // ヘッダ ブロック (= 連続するヘッダ行) を読み取り、その後を本文とする
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const m = line.match(HEADER_LINE);
      if (m) {
        if (/^(To|Cc|宛先)$/i.test(m[1]!)) {
          const emails = m[2]!.match(EMAIL_RE) ?? [];
          for (const e of emails) toEmails.push(e.toLowerCase().trim());
        }
        bodyStart = i + 1;
      } else if (line.trim() === '' && bodyStart > 0) {
        // ヘッダ ブロックの後の空行 → ここから本文
        bodyStart = i + 1;
        break;
      } else if (bodyStart === 0) {
        // 最初からヘッダ無し → ファイル全体を本文扱い
        break;
      } else {
        // ヘッダ ブロック途中の非ヘッダ行 → 本文開始
        break;
      }
    }
    const body = lines.slice(bodyStart).join('\n');
    const salutation = extractSalutation(body);
    if (toEmails.length > 0 || salutation) {
      segments.push({ to: toEmails, salutation });
    }
  }
  return segments;
}

/** 「○○様」「○○ 株式会社」など本文冒頭の宛名を抽出。
 *  本文の最初 10 行を 1 行ずつ走査し、定型挨拶 (= 「お世話になっております」等) を
 *  スキップして最初の宛名行を返す。 */
export function extractSalutation(latestReply: string): string | null {
  if (!latestReply) return null;
  const lines = latestReply.split('\n').slice(0, 10).map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  // 純粋な挨拶のみの行 (= 宛名を含まない) は skip
  const greetingOnly = /^(お世話に|いつもお世話|平素は|拝啓|拝復|ご返信|ご連絡|ご対応|お疲れ|お忙しい)/;

  for (const line of lines) {
    // スキップ: 挨拶のみで「様/御中/殿」を含まない行
    if (greetingOnly.test(line) && !/(様|御中|殿|さん|さま|Dear\s)/i.test(line)) continue;

    // パターン 1: 「○○ 様」「○○ 御中」「○○ 殿」「○○ さん」
    //   行頭スペース可。1 行内のどこに現れてもよい (= 「拝啓 田中様」のような前置きも拾う)
    const m1 = line.match(/(?:^|[\s　])([^\s　、,。\n]{1,40}?)[ 　]*(様|御中|殿|さん|さま)(?:[、,。\s　]|$)/);
    if (m1) return (m1[1]! + m1[2]!).trim();

    // パターン 2: 「○○ 株式会社 御中」 (= 行に法人格を含む場合は行全体を宛名扱い)
    const m2 = line.match(/^([^\n]{1,60}?)(株式会社|有限会社|合同会社|合資会社)(.*?(御中|殿))?/);
    if (m2) return (m2[0] ?? '').trim();

    // パターン 3: 英語 "Dear Mr/Ms ..."
    const m3 = line.match(/Dear\s+(?:Mr|Ms|Mrs|Dr)\.?\s+([A-Za-z][A-Za-z\-' ]{1,40})/i);
    if (m3) return 'Dear ' + (m3[1] ?? '').trim();
  }
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
