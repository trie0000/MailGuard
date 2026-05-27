import { el } from '../utils/dom';
import { ParsedMail } from '../types';
import { parseEml } from '../parser/eml';
import { parseMsg } from '../parser/msg';
import { parseRawText } from '../parser/raw-text';

export interface DropzoneOpts {
  onMail: (mail: ParsedMail) => void;
  onError: (msg: string) => void;
}

/** ドラッグ&ドロップ / クリックでファイル選択 / 貼り付け (paste) / 直接入力
 *  の 4 経路でメール下書きを受け取る入力 UI。
 *
 *  Mac Outlook (= 特に New Outlook for Mac) はドラッグ&ドロップが効かない
 *  ケースが多いため、paste / 直接入力の経路を併設している。 */
export function createDropzone(opts: DropzoneOpts): HTMLElement {
  const dropEl = el('div', {
    class: 'mg-dropzone',
    style: 'border:2px dashed #c0bdb0;border-radius:12px;padding:36px 24px;text-align:center;'
         + 'background:#fff;transition:all 0.15s;cursor:pointer;margin-bottom:12px',
  }, [
    el('div', { style: 'font-size:42px;line-height:1;margin-bottom:10px' }, ['📩']),
    el('div', { style: 'font-size:15px;font-weight:600;color:#2a2a26;margin-bottom:4px' }, [
      '.eml / .msg をドロップ or クリックで選択',
    ]),
    el('div', { style: 'font-size:12px;color:#7a766c;line-height:1.6' }, [
      'Outlook → ファイル → 名前を付けて保存 → eml/msg 形式で保存',
    ]),
    el('input', {
      type: 'file', accept: '.eml,.msg,message/rfc822,application/vnd.ms-outlook',
      style: 'display:none', id: 'mg-file-input',
    }) as HTMLInputElement,
  ]);

  const fileInput = dropEl.querySelector<HTMLInputElement>('#mg-file-input')!;
  dropEl.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0], opts);
    fileInput.value = '';
  });

  dropEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropEl.style.borderColor = '#7a8a78';
    dropEl.style.background = '#f3f1ea';
  });
  dropEl.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropEl.style.borderColor = '#c0bdb0';
    dropEl.style.background = '#fff';
  });
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropEl.style.borderColor = '#c0bdb0';
    dropEl.style.background = '#fff';
    handleDrop(e, opts);
  });

  // ── 貼り付け (paste) 用エリア ─────────────────────────────────────
  const pasteArea = el('textarea', {
    class: 'mg-paste',
    rows: '6',
    placeholder: 'もしくは、メール本文 (= ヘッダ込みのソース) をここに貼り付け…\n'
                + '\n'
                + 'Mac Outlook の場合: メール選択 → メニュー → 表示 → メッセージの\n'
                + 'ソースを表示 → 全選択 → コピー → ここに貼り付け',
    style: 'width:100%;padding:12px 14px;border:1px dashed #c0bdb0;border-radius:10px;'
         + 'font:13px/1.6 ui-monospace,Menlo,Consolas,monospace;background:#fff;'
         + 'resize:vertical;color:#2a2a26;min-height:120px;margin-bottom:12px',
  }) as HTMLTextAreaElement;
  pasteArea.addEventListener('paste', () => {
    // テキストが貼り付けられたら即座にパースを試みる
    // (= ユーザが追加で textarea 内に書き足すケースは想定しない)
    setTimeout(() => {
      const text = pasteArea.value;
      if (!text.trim()) return;
      try {
        const mail = parseRawText(text);
        opts.onMail(mail);
      } catch (err) {
        opts.onError(`貼り付けテキストのパース失敗: ${(err as Error).message}`);
      }
    }, 0);
  });

  const wrapper = el('div', { class: 'mg-drop-wrapper' }, [
    dropEl,
    el('div', {
      style: 'font-size:11px;color:#a8a39a;text-align:center;margin:6px 0 8px;line-height:1.6',
    }, ['────────  または  ────────']),
    pasteArea,
  ]);

  return wrapper;
}

// ── ドロップ ハンドリング ────────────────────────────────────────────
//   1. dataTransfer.files があれば .eml / .msg として読込
//   2. なければ text/plain / text/html を確認 → 貼り付け扱い
//   3. それでもダメな場合はデバッグ ログを出して案内
async function handleDrop(e: DragEvent, opts: DropzoneOpts): Promise<void> {
  const dt = e.dataTransfer;
  if (!dt) {
    opts.onError('ドラッグ データを取得できませんでした');
    return;
  }

  console.group('[mailguard] drop event diagnostics');
  console.log('types:', Array.from(dt.types));
  console.log('items:', Array.from(dt.items).map(i => ({ kind: i.kind, type: i.type })));
  console.log('files:', Array.from(dt.files).map(f => ({ name: f.name, type: f.type, size: f.size })));
  console.groupEnd();

  if (dt.files && dt.files.length > 0) {
    await handleFile(dt.files[0]!, opts);
    return;
  }

  // テキストとして取得を試す (= Mac Outlook が pasteboard 経由でテキストを渡すケース)
  for (const fmt of ['text/plain', 'text/html', 'text/uri-list']) {
    const txt = dt.getData(fmt);
    if (txt && txt.length > 50) {
      try {
        const mail = parseRawText(stripHtmlIfNeeded(txt, fmt));
        opts.onMail(mail);
        return;
      } catch (err) {
        console.warn('[mailguard] paste fallback parse failed:', (err as Error).message);
      }
    }
  }

  opts.onError(
    'ドラッグされたデータをメールとして認識できませんでした。\n\n'
    + '【Mac Outlook の対処法】\n'
    + '  方法 1: Outlook → ファイル → 名前を付けて保存 → .eml で保存 → そのファイルをドロップ\n'
    + '  方法 2: Outlook で表示メニュー → メッセージのソース → 全選択 → コピー → 下の枠に貼り付け\n'
    + '\n'
    + '【受信したドラッグ データ形式】 ' + Array.from(dt.types).join(', '),
  );
}

function stripHtmlIfNeeded(text: string, fmt: string): string {
  if (fmt !== 'text/html') return text;
  // 簡易的に HTML タグを剥がす (= 詳細解析は parseRawText 側で)
  const tmp = document.createElement('div');
  tmp.innerHTML = text;
  return (tmp.textContent || '').replace(/ /g, ' ');
}

async function handleFile(file: File, opts: DropzoneOpts): Promise<void> {
  try {
    const name = file.name.toLowerCase();
    let mail: ParsedMail;
    if (name.endsWith('.msg')) {
      mail = await parseMsg(file);
    } else if (name.endsWith('.eml') || name.endsWith('.txt') || file.type === 'message/rfc822') {
      mail = await parseEml(file);
    } else {
      // 拡張子不明でも先頭バイトで判定 (= .msg は OLE 構造で D0 CF 11 E0 始まり)
      const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      if (head[0] === 0xD0 && head[1] === 0xCF && head[2] === 0x11 && head[3] === 0xE0) {
        mail = await parseMsg(file);
      } else {
        mail = await parseEml(file);
      }
    }
    opts.onMail(mail);
  } catch (e) {
    opts.onError(`パース失敗: ${(e as Error).message}`);
  }
}
