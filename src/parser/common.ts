// 共通: アドレス分解 / 引用部分離 / 添付名抽出

export function parseAddress(raw: string): { name: string; email: string } {
  if (!raw) return { name: '', email: '' };
  const s = raw.trim();
  // "Name" <email@x.com> パターン
  const m1 = s.match(/^(?:"?([^"<>]*?)"?\s*)?<([^<>\s]+)>\s*$/);
  if (m1) return { name: (m1[1] ?? '').trim(), email: (m1[2] ?? '').trim() };
  // email@x.com (Name) パターン
  const m2 = s.match(/^([^\s()]+@[^\s()]+)\s*\(([^)]+)\)\s*$/);
  if (m2) return { name: (m2[2] ?? '').trim(), email: (m2[1] ?? '').trim() };
  // 単なる email
  if (/@/.test(s)) return { name: '', email: s.replace(/[<>]/g, '') };
  return { name: s, email: '' };
}

/** 引用部 (= 過去スレッド) を本文から分離。Spira の split-quoted ロジックを移植。 */
export function splitLatestAndQuoted(text: string): { latest: string; quoted: string } {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let cutIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    // 1. ----- Original Message -----
    if (/^-{2,}\s*(Original Message|元のメッセージ|転送されたメッセージ|Forwarded message)\s*-{2,}$/i.test(line)) {
      cutIdx = i; break;
    }
    // 2. Outlook 区切り (___ や ===) + 次行付近にヘッダ
    if (/^[_=]{20,}$/.test(line)) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const ln = (lines[j] ?? '').trim();
        if (/^(差出人|From|送信者|送信日時|Sent|To|宛先|Subject|件名)\s*[:：]/.test(ln)) {
          cutIdx = i; break;
        }
      }
      if (cutIdx >= 0) break;
    }
    // 3. "差出人:" / "From:" ヘッダ + 直後 5 行に他ヘッダ
    if (/^(差出人|From|送信者)\s*[:：]/.test(line)) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const ln = (lines[j] ?? '').trim();
        if (/^(送信日時|Sent|To|宛先|Cc|Subject|件名)\s*[:：]/.test(ln)) {
          cutIdx = i; break;
        }
      }
      if (cutIdx >= 0) break;
    }
    // 4. "On <date> ... wrote:" / 日本語版
    if (/^On\b.+\bwrote\s*:?\s*$/i.test(line)
        || /^\d{4}[\/年\-].+(さん|様)?[\s　]*(が|より)?[\s　]*(書きました|書いた|wrote)[\s　]*[:：]?\s*$/.test(line)) {
      cutIdx = i; break;
    }
    // 5. `>` 引用行が 2 行以上連続
    if (/^>/.test(lines[i]!)) {
      let consec = 1;
      for (let j = i + 1; j < lines.length && consec < 2; j++) {
        const ln = lines[j] ?? '';
        if (/^>/.test(ln)) consec++;
        else if (ln.trim() === '') continue;
        else break;
      }
      if (consec >= 2) { cutIdx = i; break; }
    }
  }
  if (cutIdx < 0) return { latest: text, quoted: '' };
  const latest = lines.slice(0, cutIdx).join('\n').replace(/\s+$/, '');
  const quoted = lines.slice(cutIdx).join('\n');
  if (!latest.trim()) return { latest: text, quoted: '' };
  return { latest, quoted };
}

/** 本文中に書かれた「添付:」「Attached:」みたいな宣言から候補抽出 (= eml で添付パートが無かった時のフォールバック) */
export function extractAttachmentNames(text: string): string[] {
  const out: string[] = [];
  const re = /(?:添付|Attach(?:ment|ed)?)\s*[:：]\s*([^\n]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const names = m[1]!.split(/[,、]/).map(s => s.trim()).filter(Boolean);
    out.push(...names);
  }
  return out;
}
