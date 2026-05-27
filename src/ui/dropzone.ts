import { el } from '../utils/dom';
import { ParsedMail } from '../types';
import { parseEml } from '../parser/eml';
import { parseMsg } from '../parser/msg';
import { parseRawText } from '../parser/raw-text';
import { openOutlookPastePrompt } from './outlook-prompt';

export interface DropzoneOpts {
  onMail: (mail: ParsedMail) => void;
  onError: (msg: string) => void;
}

// ── グローバル ドラッグ ハンドラ (= ウィンドウ全体で drop を受け付ける) ──
//   旧コードは dropzone div の上でしか dragover を preventDefault してなかったので
//   Outlook 等の外部 drag をブラウザが「🚫 受け付けない」と表示する問題があった。
//   document レベルで preventDefault + dropEffect='copy' を返すことで、どこに
//   ドロップされても drop イベントが発火する状態にする。
let globalSetupDone = false;
function setupGlobalDragHandlers(opts: DropzoneOpts): void {
  if (globalSetupDone) return;
  globalSetupDone = true;

  let dragDepth = 0;
  const overlay = createDragOverlay();

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    if (dragDepth === 1) {
      document.body.appendChild(overlay);
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('dragleave', (e) => {
    // dragleave は子要素間遷移でも発火するので、relatedTarget が null
    // (= ウィンドウから完全に出た) もしくは depth が 0 以下になった時だけ非表示。
    if (!e.relatedTarget) {
      dragDepth = 0;
      overlay.remove();
    } else {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) overlay.remove();
    }
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.remove();
    handleDrop(e, opts);
  });
}

function createDragOverlay(): HTMLElement {
  return el('div', {
    style: 'position:fixed;inset:0;background:rgba(122,138,120,0.15);z-index:900;'
         + 'border:6px dashed #7a8a78;pointer-events:none;'
         + 'display:flex;align-items:center;justify-content:center',
  }, [
    el('div', {
      style: 'background:#fff;padding:32px 48px;border-radius:14px;'
           + 'box-shadow:0 16px 48px rgba(0,0,0,0.2);text-align:center',
    }, [
      el('div', { style: 'font-size:64px;line-height:1;margin-bottom:12px' }, ['📥']),
      el('div', { style: 'font-size:18px;font-weight:700;color:#2a2a26;margin-bottom:6px' }, [
        'ここにドロップしてください',
      ]),
      el('div', { style: 'font-size:13px;color:#7a766c;line-height:1.6' }, [
        'ファイルでなくても OK — Outlook の場合は案内モーダルが開きます',
      ]),
    ]),
  ]);
}

/** ドラッグ&ドロップ / クリックでファイル選択 / 貼り付け (paste) / 直接入力
 *  の 4 経路でメール下書きを受け取る入力 UI。
 *
 *  Mac Outlook (= 特に New Outlook for Mac) はドラッグ&ドロップが効かない
 *  ケースが多いため、paste / 直接入力の経路を併設している。
 *
 *  ★ ウィンドウ全体で drag を受け付けるよう document レベルの handler も登録。
 *    旧版は dropzone div の上だけで dragover.preventDefault() していたため、
 *    Outlook の drag をブラウザが「受け付けない」(= 🚫 カーソル) 表示になる
 *    バグがあった。 */
export function createDropzone(opts: DropzoneOpts): HTMLElement {
  setupGlobalDragHandlers(opts);
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
      'Outlook メール一覧 / メッセージ ウィンドウから直接ドロップも可',
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

  // Mac Outlook 用 paste UI は廃止 (Windows Outlook ドラッグが本筋のため)。
  // ★ ⌘V / Ctrl+V でのグローバル paste 受付は main.ts に残しているため、
  //    Outlook 以外のソース (= メッセージのソース表示してコピペ) も依然受け取れる。
  // ★ ドラッグでファイル化できなかった時の救済モーダル (openOutlookPastePrompt)
  //    は handleDrop の最後に保険として呼ばれる (= 通常時は出ない)。
  return dropEl;
}

// ── ドロップ ハンドリング ────────────────────────────────────────────
//   優先順位:
//   1. dataTransfer.files / items の file kind → .eml / .msg として読込
//   2. text/plain / text/html / text/uri-list が 500 文字以上 → raw eml パース
//   3. items.string (= async API) を非同期で集める → 同上
//   4. Outlook っぽい drag を検出 → 案内モーダルを開いて利用者に paste させる
//   5. それ以外は generic な onError 表示
//
//  Mac Outlook は (1)(2)(3) 全部失敗するケースが多い (= 件名だけ、または空のドラッグ)
//  ため、(4) のフォールバックが重要。
//
//  dataTransfer は drop イベントの同期処理中しか有効でないので、必要情報を
//  全て同期的にスナップショットしてから async 処理する。
function handleDrop(e: DragEvent, opts: DropzoneOpts): void {
  const dt = e.dataTransfer;
  if (!dt) {
    opts.onError('ドラッグ データを取得できませんでした');
    return;
  }

  const types = Array.from(dt.types);
  const filesSnap = Array.from(dt.files);
  const itemsSnap = Array.from(dt.items).map(i => ({ kind: i.kind, type: i.type, item: i }));
  const syncText: Record<string, string> = {};
  for (const t of types) syncText[t] = dt.getData(t);

  const stringPromises: Promise<{ type: string; text: string }>[] = [];
  for (const it of itemsSnap) {
    if (it.kind === 'string') {
      stringPromises.push(new Promise(resolve => {
        it.item.getAsString(text => resolve({ type: it.type, text }));
      }));
    }
  }
  const itemFiles: File[] = [];
  for (const it of itemsSnap) {
    if (it.kind === 'file') {
      const f = it.item.getAsFile();
      if (f) itemFiles.push(f);
    }
  }

  console.group('[mailguard] drop event diagnostics');
  console.log('types:', types);
  console.log('items:', itemsSnap.map(i => ({ kind: i.kind, type: i.type })));
  console.log('files:', filesSnap.map(f => ({ name: f.name, type: f.type, size: f.size })));
  console.log('item-files:', itemFiles.map(f => ({ name: f.name, type: f.type, size: f.size })));
  console.log('sync-text-lengths:', Object.fromEntries(
    Object.entries(syncText).map(([k, v]) => [k, v.length]),
  ));
  console.groupEnd();

  void processDropAsync({ types, filesSnap, itemFiles, syncText, stringPromises }, opts);
}

interface DropSnapshot {
  types: string[];
  filesSnap: File[];
  itemFiles: File[];
  syncText: Record<string, string>;
  stringPromises: Promise<{ type: string; text: string }>[];
}

async function processDropAsync(snap: DropSnapshot, opts: DropzoneOpts): Promise<void> {
  // 1. ファイル (= 通常パターン)
  const file = snap.filesSnap[0] ?? snap.itemFiles[0];
  if (file && file.size > 0) {
    await handleFile(file, opts);
    return;
  }

  // 2. 同期取得した text/* で十分な長さなら raw eml パースを試す
  const syncBest = pickBest(snap.syncText);
  if (syncBest && syncBest.text.length >= 500) {
    if (tryParseText(syncBest.text, syncBest.type, opts)) return;
  }

  // 3. items.string (async) を全部集める
  const asyncTexts = await Promise.all(snap.stringPromises);
  const asyncMap: Record<string, string> = {};
  for (const at of asyncTexts) if (at.text) asyncMap[at.type] = at.text;
  const asyncBest = pickBest(asyncMap);
  if (asyncBest && asyncBest.text.length >= 500) {
    if (tryParseText(asyncBest.text, asyncBest.type, opts)) return;
  }

  // 4. Outlook っぽいドラッグ or 短いテキストしか無い → 案内モーダル
  const hint = (asyncBest?.text || syncBest?.text || '').slice(0, 500);
  const looksOutlook = detectOutlook(snap.types, hint);
  if (looksOutlook || snap.types.length > 0) {
    openOutlookPastePrompt({
      onMail: opts.onMail,
      hint: hint.length >= 30 ? '' : hint,    // 件名だけ等のノイズは pre-fill しない
      detectedTypes: snap.types,
    });
    return;
  }

  // 5. 完全に何もない (= 非常に稀)
  opts.onError(
    'ドラッグされたデータをメールとして認識できませんでした。\n'
    + '対処: Outlook → ファイル → 名前を付けて保存 → .eml で保存 → そのファイルをドロップ',
  );
}

function pickBest(texts: Record<string, string>): { type: string; text: string } | null {
  let best: { type: string; text: string } | null = null;
  for (const [t, v] of Object.entries(texts)) {
    if (!v) continue;
    if (!best || v.length > best.text.length) best = { type: t, text: v };
  }
  return best;
}

function tryParseText(text: string, type: string, opts: DropzoneOpts): boolean {
  try {
    const cleaned = type === 'text/html' ? stripHtmlIfNeeded(text) : text;
    const mail = parseRawText(cleaned);
    opts.onMail(mail);
    return true;
  } catch (err) {
    console.warn('[mailguard] parseRawText failed:', (err as Error).message);
    return false;
  }
}

function stripHtmlIfNeeded(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || '').replace(/ /g, ' ');
}

/** ドラッグ元が Outlook っぽいかを推定する。
 *  - 既知の専用 MIME / UTI (= application/x-mac-outlook-data, dyn.*, message/rfc822 等)
 *  - text に件名らしき 'Re:' / 'Fwd:' / 'RE:' 頭字 */
function detectOutlook(types: string[], hint: string): boolean {
  const t = types.join(' ').toLowerCase();
  if (/outlook|x-mac-outlook|dyn\.|com\.microsoft|message\/rfc822|com\.apple\.mail/i.test(t)) return true;
  if (/^\s*(re|fw|fwd|aw|tr)\s*:/i.test(hint)) return true;
  return false;
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
