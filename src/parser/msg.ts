// .msg (Outlook 専用バイナリ形式) パーサ — @kenjiuno/msgreader 流用
//
// ★ esbuild の __toESM(..., 1) interop の挙動で default 二重ラップが起きる
//   ケースがあり、`import MsgReader from '@kenjiuno/msgreader'` → バンドル後に
//   `Ee.default is not constructor` 例外を吐く。namespace import + 動的アンラップ
//   で確実にクラスを取り出す。

import * as MsgReaderModule from '@kenjiuno/msgreader';
import { ParsedMail } from '../types';
import { splitLatestAndQuoted, parseAddress } from './common';

/** バンドラーの interop 差異を吸収して MsgReader クラスを取り出す。
 *   - 通常 ESM-CJS interop: mod.default が class
 *   - esbuild isNodeMode=1 wraps: mod.default.default が class (= 我々が踏んだバグ)
 *   - bare namespace: mod 自身が class */
function resolveMsgReaderClass(): new (buf: ArrayBuffer) => { getFileData(): unknown } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = MsgReaderModule;
  if (typeof mod === 'function') return mod;
  if (mod.default && typeof mod.default === 'function') return mod.default;
  if (mod.default && mod.default.default && typeof mod.default.default === 'function') {
    return mod.default.default;
  }
  if (mod.MsgReader && typeof mod.MsgReader === 'function') return mod.MsgReader;
  throw new Error('MsgReader クラスをパッケージから解決できませんでした (= 内部 import エラー)');
}

const MsgReader = resolveMsgReaderClass();

interface MsgRecipient {
  name?: string;
  email?: string;
  smtpAddress?: string;
  recipType?: string;        // 'to' | 'cc' | 'bcc'
  dataType?: string;
}

interface MsgFileData {
  subject?: string;
  body?: string;              // プレーン
  bodyHtml?: string;          // HTML (= 存在することあり)
  bodyRTF?: string;
  senderName?: string;
  senderEmail?: string;
  recipients?: MsgRecipient[];
  attachments?: Array<{ fileName?: string; name?: string }>;
  messageDeliveryTime?: string | Date;
  clientSubmitTime?: string | Date;
}

export async function parseMsg(file: File): Promise<ParsedMail> {
  const buf = await file.arrayBuffer();
  const reader = new MsgReader(buf);
  const data = reader.getFileData() as MsgFileData;

  const from = {
    name: data.senderName ?? '',
    email: (data.senderEmail ?? '').trim(),
  };

  const toList: Array<{ name: string; email: string }> = [];
  const ccList: Array<{ name: string; email: string }> = [];
  const bccList: Array<{ name: string; email: string }> = [];
  for (const r of data.recipients ?? []) {
    const addr = {
      name: r.name ?? '',
      email: (r.smtpAddress ?? r.email ?? '').trim(),
    };
    if (!addr.email) continue;
    const kind = (r.recipType ?? 'to').toLowerCase();
    if (kind === 'cc') ccList.push(addr);
    else if (kind === 'bcc') bccList.push(addr);
    else toList.push(addr);
  }

  // sender が email として space 区切りや LDAP 形式の場合に正規化
  if (from.email && !from.email.includes('@')) {
    const reparsed = parseAddress(from.email);
    if (reparsed.email) Object.assign(from, reparsed);
  }

  const bodyHtml = data.bodyHtml || null;
  const bodyText = (data.body ?? '').replace(/\r\n/g, '\n');

  const { latest, quoted } = splitLatestAndQuoted(bodyText);
  const attachments = (data.attachments ?? [])
    .map(a => a.fileName || a.name || '')
    .filter(Boolean);

  let date: string | null = null;
  if (data.clientSubmitTime) {
    try { date = new Date(data.clientSubmitTime).toISOString(); } catch { /* noop */ }
  } else if (data.messageDeliveryTime) {
    try { date = new Date(data.messageDeliveryTime).toISOString(); } catch { /* noop */ }
  }

  return {
    from,
    to: toList,
    cc: ccList,
    bcc: bccList,
    subject: data.subject ?? '',
    date,
    bodyText,
    bodyHtml,
    latestReply: latest,
    quotedHistory: quoted,
    attachments,
    format: 'msg',
  };
}
