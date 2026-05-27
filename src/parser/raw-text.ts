// 貼り付けされた raw テキストを ParsedMail に変換するパーサ
//
// Mac Outlook はドラッグでブラウザに .eml を渡せないケースが多いため、
// 「メッセージのソースを表示 → コピー」して MailGuard に貼り付ける ワークフロー
// を提供する必要がある。
//
// 入力パターン:
//   A) 完全な RFC 5322 eml テキスト (= From:/To:/Subject: 等のヘッダ込み)
//      → parseEmlText に流して通常通り解析
//   B) ヘッダなしの本文のみ
//      → 本文だけ持つ ParsedMail を返す (= 宛先・件名は空、利用者が手で入力)

import { ParsedMail } from '../types';
import { parseEmlText } from './eml';
import { splitLatestAndQuoted } from './common';

const HEADER_HINTS = [
  /^From\s*:/im,
  /^差出人\s*[:：]/m,
  /^Subject\s*:/im,
  /^件名\s*[:：]/m,
  /^To\s*:/im,
  /^宛先\s*[:：]/m,
];

/** 貼り付けされた raw テキストから ParsedMail を作る。
 *  ヘッダ風の行が複数あれば eml としてパース、そうでなければ本文扱い。 */
export function parseRawText(text: string): ParsedMail {
  const hints = HEADER_HINTS.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  if (hints >= 2) {
    try {
      return parseEmlText(text, 'raw-paste');
    } catch (_) {
      // フォールバック: 本文のみ扱い
    }
  }
  const { latest, quoted } = splitLatestAndQuoted(text);
  return {
    from: { name: '', email: '' },
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    date: null,
    bodyText: text,
    bodyHtml: null,
    latestReply: latest,
    quotedHistory: quoted,
    attachments: [],
    format: 'eml',
  };
}
