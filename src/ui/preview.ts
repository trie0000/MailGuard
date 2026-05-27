import { el } from '../utils/dom';
import { ParsedMail } from '../types';

/** パース済みメールのプレビュー カードを描画 */
export function renderPreview(mail: ParsedMail): HTMLElement {
  const fmtAddr = (a: { name: string; email: string }) =>
    a.name ? `${a.name} <${a.email}>` : a.email;

  const row = (label: string, value: string | HTMLElement) =>
    el('div', { style: 'display:flex;gap:12px;padding:6px 0;font-size:13px;line-height:1.7' }, [
      el('div', { style: 'flex-shrink:0;width:60px;color:#7a766c;font-weight:600' }, [label]),
      typeof value === 'string'
        ? el('div', { style: 'flex:1;min-width:0;color:#2a2a26;word-break:break-word' }, [value])
        : value,
    ]);

  return el('div', {
    class: 'mg-preview',
    style: 'background:#fff;border:1px solid #e8e4d8;border-radius:10px;padding:18px;margin-bottom:20px',
  }, [
    el('div', { style: 'font-size:11px;color:#a8a39a;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;font-weight:600' }, [
      `📄 解析結果 (${mail.format.toUpperCase()})`,
    ]),
    row('From', fmtAddr(mail.from) || '(なし)'),
    row('To', mail.to.length ? mail.to.map(fmtAddr).join(', ') : '(なし)'),
    ...(mail.cc.length ? [row('Cc', mail.cc.map(fmtAddr).join(', '))] : []),
    ...(mail.bcc.length ? [row('Bcc', mail.bcc.map(fmtAddr).join(', '))] : []),
    row('件名', mail.subject || '(なし)'),
    ...(mail.date ? [row('日時', new Date(mail.date).toLocaleString('ja-JP'))] : []),
    ...(mail.attachments.length ? [row('添付', mail.attachments.join(', '))] : []),

    el('div', { style: 'margin-top:14px;border-top:1px solid #f3f1ea;padding-top:12px' }),
    el('div', { style: 'font-size:11px;color:#a8a39a;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;font-weight:600' }, [
      '✍ 最新の返信本文',
    ]),
    el('div', {
      style: 'background:#fafaf7;border-left:3px solid #7a8a78;padding:10px 14px;border-radius:0 6px 6px 0;'
           + 'font-size:13px;line-height:1.8;white-space:pre-wrap;word-break:break-word;'
           + 'max-height:260px;overflow:auto',
    }, [mail.latestReply || '(返信本文を検出できませんでした)']),

    ...(mail.quotedHistory ? [
      el('details', { style: 'margin-top:12px' }, [
        el('summary', { style: 'cursor:pointer;font-size:11px;color:#a8a39a;text-transform:uppercase;letter-spacing:0.06em;font-weight:600' }, [
          `📜 過去の引用部 (${mail.quotedHistory.length} 文字) — クリックで展開`,
        ]),
        el('div', {
          style: 'background:#f3f1ea;border-left:3px solid #c0bdb0;padding:10px 14px;border-radius:0 6px 6px 0;'
               + 'font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:#7a766c;'
               + 'max-height:300px;overflow:auto;margin-top:8px',
        }, [mail.quotedHistory]),
      ]),
    ] : []),
  ]);
}
