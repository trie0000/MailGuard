// .eml (RFC 5322 MIME) パーサ — MVP 用の軽量実装
//
// 対応:
//   - ヘッダ: From / To / Cc / Bcc / Subject / Date (= 主要だけ)
//   - エンコード: utf-8 / iso-2022-jp(部分) / shift_jis(部分)
//   - 転送エンコード: 7bit / 8bit / quoted-printable / base64
//   - multipart/* (= text/plain と text/html の両方を抽出)
//   - RFC 2047 ヘッダ encoded-word (= =?charset?B?...?= / =?charset?Q?...?=)
//
// 未対応 (= MVP では割愛):
//   - 添付ファイル本体の保持 (= 名前だけ抽出)
//   - S/MIME 暗号化
//   - 巨大ファイル ストリーミング

import { ParsedMail } from '../types';
import { splitLatestAndQuoted, extractAttachmentNames, parseAddress } from './common';

export async function parseEml(file: File): Promise<ParsedMail> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const ascii = new TextDecoder('latin1').decode(buf);  // バイト透過な読み込み
  const { headers, bodyRaw } = splitHeadersBody(ascii);

  const from = parseAddressList(headers['from'] ?? '');
  const to = parseAddressList(headers['to'] ?? '');
  const cc = parseAddressList(headers['cc'] ?? '');
  const bcc = parseAddressList(headers['bcc'] ?? '');
  const subject = decodeWord(headers['subject'] ?? '');
  const date = headers['date'] ? new Date(headers['date']).toISOString() : null;

  const ct = headers['content-type'] ?? 'text/plain; charset=utf-8';
  const cte = (headers['content-transfer-encoding'] ?? '7bit').toLowerCase();
  const { plain, html, attachments } = parseBody(bodyRaw, ct, cte);

  const bodyText = plain || (html ? stripHtml(html) : '');
  const { latest, quoted } = splitLatestAndQuoted(bodyText);

  return {
    from: from[0] ?? { name: '', email: '' },
    to,
    cc,
    bcc,
    subject,
    date,
    bodyText,
    bodyHtml: html || null,
    latestReply: latest,
    quotedHistory: quoted,
    attachments: attachments.length > 0 ? attachments : extractAttachmentNames(bodyText),
    format: 'eml',
  };
}

// ── ヘッダ + 本文 分離 ────────────────────────────────────────────────
function splitHeadersBody(raw: string): { headers: Record<string, string>; bodyRaw: string } {
  const sep = raw.match(/\r?\n\r?\n/);
  if (!sep || sep.index === undefined) return { headers: {}, bodyRaw: raw };
  const headerPart = raw.slice(0, sep.index);
  const bodyRaw = raw.slice(sep.index + sep[0].length);

  // ヘッダ行: 続行行 (= 先頭が空白) は結合
  const lines: string[] = [];
  for (const ln of headerPart.split(/\r?\n/)) {
    if (/^[ \t]/.test(ln) && lines.length > 0) lines[lines.length - 1] += ' ' + ln.trim();
    else lines.push(ln);
  }
  const headers: Record<string, string> = {};
  for (const ln of lines) {
    const idx = ln.indexOf(':');
    if (idx < 0) continue;
    const key = ln.slice(0, idx).trim().toLowerCase();
    const value = ln.slice(idx + 1).trim();
    if (!headers[key]) headers[key] = value;
    else headers[key] += '; ' + value;
  }
  return { headers, bodyRaw };
}

// ── アドレス リスト パース ───────────────────────────────────────────
function parseAddressList(raw: string): Array<{ name: string; email: string }> {
  if (!raw) return [];
  const decoded = decodeWord(raw);
  // 単純な分割 (= カンマ区切り、引用符内のカンマは無視)
  const parts: string[] = [];
  let buf = '';
  let inQ = false;
  for (const ch of decoded) {
    if (ch === '"') inQ = !inQ;
    if (ch === ',' && !inQ) { parts.push(buf); buf = ''; }
    else buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map(p => parseAddress(p.trim())).filter(a => a.email);
}

// ── RFC 2047 encoded-word デコード ───────────────────────────────────
function decodeWord(input: string): string {
  if (!input) return '';
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, enc: string, data: string) => {
    try {
      let bytes: Uint8Array;
      if (enc.toLowerCase() === 'b') {
        const binStr = atob(data);
        bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      } else {
        // Q-encoding (= quoted-printable variant: '_' = space, =XX = hex)
        const replaced = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        bytes = new Uint8Array(replaced.length);
        for (let i = 0; i < replaced.length; i++) bytes[i] = replaced.charCodeAt(i);
      }
      return decodeBytes(bytes, charset);
    } catch { return _; }
  }).replace(/\?= +=\?/g, '?==?');  // 隣接 encoded-word の空白除去
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    const cs = charset.toLowerCase().replace(/_/g, '-');
    return new TextDecoder(cs).decode(bytes);
  } catch {
    try { return new TextDecoder('utf-8').decode(bytes); } catch { return ''; }
  }
}

// ── 本文 (multipart 含む) パース ──────────────────────────────────────
function parseBody(
  bodyRaw: string,
  contentType: string,
  cte: string,
): { plain: string; html: string; attachments: string[] } {
  const ct = contentType.toLowerCase();
  const boundaryMatch = contentType.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);

  if (ct.startsWith('multipart/') && boundaryMatch) {
    const boundary = boundaryMatch[1]!;
    const parts = splitMultipart(bodyRaw, boundary);
    let plain = '';
    let html = '';
    const attachments: string[] = [];
    for (const part of parts) {
      const { headers: ph, bodyRaw: pb } = splitHeadersBody(part);
      const pct = ph['content-type'] ?? 'text/plain';
      const pcte = (ph['content-transfer-encoding'] ?? '7bit').toLowerCase();
      const cd = ph['content-disposition'] ?? '';
      // 添付ファイル
      if (/attachment/i.test(cd) || /name\s*=/i.test(pct)) {
        const fnMatch = (cd + ' ' + pct).match(/(?:filename|name)\s*=\s*"?([^";\r\n]+)"?/i);
        if (fnMatch) attachments.push(decodeWord(fnMatch[1]!));
        continue;
      }
      // ネストした multipart は再帰
      if (pct.toLowerCase().startsWith('multipart/')) {
        const nested = parseBody(pb, pct, pcte);
        if (nested.plain && !plain) plain = nested.plain;
        if (nested.html && !html) html = nested.html;
        attachments.push(...nested.attachments);
        continue;
      }
      const decoded = decodeContent(pb, pcte, pct);
      if (pct.toLowerCase().startsWith('text/html') && !html) html = decoded;
      else if (pct.toLowerCase().startsWith('text/plain') && !plain) plain = decoded;
    }
    return { plain, html, attachments };
  }

  // singlepart
  const decoded = decodeContent(bodyRaw, cte, contentType);
  if (ct.startsWith('text/html')) return { plain: '', html: decoded, attachments: [] };
  return { plain: decoded, html: '', attachments: [] };
}

function splitMultipart(body: string, boundary: string): string[] {
  const delim = '--' + boundary;
  const out: string[] = [];
  let i = body.indexOf(delim);
  while (i >= 0) {
    const next = body.indexOf(delim, i + delim.length);
    if (next < 0) break;
    const slice = body.slice(i + delim.length, next).replace(/^\r?\n/, '');
    if (!slice.startsWith('--')) out.push(slice);
    i = next;
  }
  return out;
}

function decodeContent(raw: string, cte: string, contentType: string): string {
  let bytes: Uint8Array;
  const t = cte.toLowerCase();
  if (t === 'base64') {
    const clean = raw.replace(/\s+/g, '');
    try {
      const bin = atob(clean);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch { return raw; }
  } else if (t === 'quoted-printable') {
    const decoded = raw
      .replace(/=\r?\n/g, '')                                  // soft line break
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  } else {
    bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  }
  const csMatch = contentType.match(/charset\s*=\s*"?([^";\r\n]+)"?/i);
  return decodeBytes(bytes, csMatch?.[1] ?? 'utf-8');
}

function stripHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
  div.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,li,tr').forEach(b => {
    b.appendChild(document.createTextNode('\n'));
  });
  return (div.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}
