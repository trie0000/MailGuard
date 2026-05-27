import { el } from '../utils/dom';
import { ParsedMail } from '../types';
import { parseEml } from '../parser/eml';
import { parseMsg } from '../parser/msg';

/** ドラッグ&ドロップ受付ゾーンを作る。onMail でパース結果を返す。 */
export function createDropzone(opts: {
  onMail: (mail: ParsedMail) => void;
  onError: (msg: string) => void;
}): HTMLElement {
  const zone = el('div', {
    class: 'mg-dropzone',
    style: 'border:2px dashed #c0bdb0;border-radius:12px;padding:48px 24px;text-align:center;background:#fff;'
         + 'transition:all 0.15s;cursor:pointer;margin-bottom:24px',
  }, [
    el('div', { style: 'font-size:48px;line-height:1;margin-bottom:12px' }, ['📩']),
    el('div', { style: 'font-size:16px;font-weight:600;color:#2a2a26;margin-bottom:6px' }, [
      'メール下書きをここにドロップ',
    ]),
    el('div', { style: 'font-size:13px;color:#7a766c' }, [
      '.eml / .msg ファイルに対応 (Outlook → ファイル → 名前を付けて保存)',
    ]),
    el('input', {
      type: 'file', accept: '.eml,.msg,message/rfc822,application/vnd.ms-outlook',
      style: 'display:none', id: 'mg-file-input',
    }) as HTMLInputElement,
  ]);

  const fileInput = zone.querySelector<HTMLInputElement>('#mg-file-input')!;
  zone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0], opts);
    fileInput.value = '';
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.style.borderColor = '#7a8a78';
    zone.style.background = '#f3f1ea';
  });
  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    zone.style.borderColor = '#c0bdb0';
    zone.style.background = '#fff';
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.style.borderColor = '#c0bdb0';
    zone.style.background = '#fff';
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file, opts);
  });

  return zone;
}

async function handleFile(
  file: File,
  opts: { onMail: (mail: ParsedMail) => void; onError: (msg: string) => void },
): Promise<void> {
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
