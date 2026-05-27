// Outlook (= 特に Mac Outlook) からのドラッグを受け取ったが ファイル化できなかった
// 時に出す案内モーダル。フォーカス済みの textarea を出して ⌘V でメッセージ
// ソースを貼り付ければそのまま取り込めるようにする。

import { el } from '../utils/dom';
import { ParsedMail } from '../types';
import { parseRawText } from '../parser/raw-text';

export interface PromptOpts {
  onMail: (mail: ParsedMail) => void;
  /** ドラッグ時に拾えた一部テキスト (= 件名等)。あれば textarea のプレフィルに使う */
  hint?: string;
  /** 検出されたドラッグの dataTransfer.types (= デバッグ表示) */
  detectedTypes?: string[];
}

export function openOutlookPastePrompt(opts: PromptOpts): void {
  const overlay = el('div', {
    style: 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1100;'
         + 'display:flex;align-items:flex-start;justify-content:center;padding:48px 20px;overflow:auto',
  });

  const ta = el('textarea', {
    rows: '14',
    placeholder: 'ここに ⌘V で貼り付け…',
    style: 'width:100%;padding:12px 14px;border:2px solid #7a8a78;border-radius:8px;'
         + 'font:13px/1.6 ui-monospace,Menlo,Consolas,monospace;background:#fafaf7;'
         + 'resize:vertical;color:#2a2a26;min-height:200px',
  }) as HTMLTextAreaElement;
  if (opts.hint) ta.value = opts.hint;

  const status = el('div', {
    style: 'font-size:12px;color:#7a766c;min-height:18px;line-height:1.6',
  });

  const tryParse = () => {
    const text = ta.value.trim();
    if (text.length < 30) {
      status.textContent = '✗ テキストが短すぎます (= 30 文字以上必要)';
      status.style.color = '#dc2626';
      return;
    }
    try {
      const mail = parseRawText(text);
      status.textContent = '✓ パース成功 — 取り込みます';
      status.style.color = '#065f46';
      setTimeout(() => {
        overlay.remove();
        opts.onMail(mail);
      }, 150);
    } catch (e) {
      status.textContent = `✗ パース失敗: ${(e as Error).message}`;
      status.style.color = '#dc2626';
    }
  };

  ta.addEventListener('paste', () => {
    // 貼り付け直後に自動パースを試みる
    setTimeout(tryParse, 0);
  });
  ta.addEventListener('input', () => {
    if (ta.value.trim().length === 0) {
      status.textContent = '';
    }
  });

  const close = () => overlay.remove();

  const modal = el('div', {
    style: 'background:#fff;border-radius:12px;width:100%;max-width:640px;padding:28px;'
         + 'box-shadow:0 12px 50px rgba(0,0,0,0.25)',
  }, [
    el('div', { style: 'display:flex;align-items:flex-start;gap:14px;margin-bottom:8px' }, [
      el('div', { style: 'font-size:32px;line-height:1' }, ['📨']),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('h2', { style: 'margin:0;font-size:18px;font-weight:700' }, [
          'Outlook からのメール取り込み',
        ]),
        el('p', { style: 'margin:4px 0 0;font-size:12px;color:#7a766c;line-height:1.6' }, [
          'Mac Outlook はメール一覧からのドラッグでブラウザに本文を渡せません。',
          el('br'),
          '下記の手順でソースをコピー&貼り付けすると自動取り込みします。',
        ]),
      ]),
    ]),

    // 手順 (= 視覚的に)
    el('div', {
      style: 'margin:16px 0 14px;background:#fef3c7;border-left:4px solid #f59e0b;'
           + 'border-radius:6px;padding:12px 16px;font-size:13px;line-height:1.9;color:#7c2d12',
    }, [
      el('div', { style: 'font-weight:700;margin-bottom:4px' }, ['手順']),
      el('div', {}, [
        '① Mac Outlook で対象メールを選択',
      ]),
      el('div', {}, [
        '② メニュー: ',
        el('strong', {}, ['表示']),
        ' → ',
        el('strong', {}, ['メッセージのソース']),
        '  (キーボード: ⌥⌘U)',
      ]),
      el('div', {}, [
        '③ ソース ウィンドウで ',
        el('strong', {}, ['⌘A']),
        ' (全選択) → ',
        el('strong', {}, ['⌘C']),
        ' (コピー)',
      ]),
      el('div', {}, [
        '④ 下の枠を ',
        el('strong', {}, ['⌘V']),
        ' で貼り付け → 自動でパースされます',
      ]),
    ]),

    ta,
    el('div', { style: 'margin-top:8px;display:flex;gap:12px;align-items:center' }, [
      status,
      el('div', { style: 'flex:1' }),
      el('button', {
        style: 'padding:8px 16px;background:#fff;color:#7a766c;border:1px solid #c0bdb0;'
             + 'border-radius:6px;font-size:13px;cursor:pointer',
        onclick: close,
      }, ['キャンセル']),
      el('button', {
        style: 'padding:8px 18px;background:#7a8a78;color:#fff;border:0;border-radius:6px;'
             + 'font-size:13px;font-weight:600;cursor:pointer',
        onclick: tryParse,
      }, ['取り込む']),
    ]),

    ...(opts.detectedTypes && opts.detectedTypes.length > 0 ? [
      el('details', { style: 'margin-top:14px' }, [
        el('summary', {
          style: 'cursor:pointer;font-size:11px;color:#a8a39a;letter-spacing:0.04em',
        }, ['🔍 検出したドラッグ データ (デバッグ用)']),
        el('div', {
          style: 'margin-top:6px;font-family:ui-monospace,Menlo,monospace;font-size:11px;'
               + 'color:#7a766c;padding:8px 10px;background:#f3f1ea;border-radius:4px;'
               + 'word-break:break-all',
        }, [opts.detectedTypes.join(', ')]),
      ]),
    ] : []),
  ]);

  overlay.appendChild(modal);

  // Esc / 外部クリックで閉じる
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  document.body.appendChild(overlay);
  // 自動フォーカス → ユーザはモーダル表示直後に ⌘V するだけ
  setTimeout(() => ta.focus(), 50);
}
