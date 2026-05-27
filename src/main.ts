// MailGuard — メール誤送信検出ツールのエントリ ポイント
//
// 全体フロー:
//   1. ドラッグ&ドロップ受付ゾーンを表示
//   2. .eml / .msg がドロップされる → パーサで構造化
//   3. プレビュー表示 + 「AI で チェック」ボタン
//   4. ボタン押下 → A 段 (決定論ルール) + B 段 (AI) を並列実行
//   5. 結果カードを表示

import { el, clear } from './utils/dom';
import { ParsedMail, CombinedResult } from './types';
import { getSettings } from './settings';
import { createDropzone } from './ui/dropzone';
import { renderPreview } from './ui/preview';
import { renderResult } from './ui/result';
import { openSettingsModal } from './ui/settings';
import { runDeterministicChecks } from './checks/deterministic';
import { runAICheck } from './checks/ai';

const root = document.getElementById('mailguard-root');
if (!root) throw new Error('#mailguard-root not found');

let currentMail: ParsedMail | null = null;

mount();

function mount(): void {
  clear(root!);
  root!.appendChild(buildShell());
  refreshDropzone();
}

function buildShell(): HTMLElement {
  return el('div', {
    style: 'max-width:760px;margin:0 auto;padding:32px 20px 80px',
  }, [
    // ヘッダ
    el('header', {
      style: 'display:flex;align-items:center;gap:14px;margin-bottom:28px;'
           + 'padding-bottom:18px;border-bottom:2px solid #7a8a78',
    }, [
      el('div', { style: 'font-size:34px;line-height:1' }, ['📨']),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('h1', { style: 'margin:0;font-size:22px;font-weight:800;letter-spacing:-0.01em' }, [
          'MailGuard',
        ]),
        el('p', { style: 'margin:2px 0 0;font-size:12px;color:#7a766c' }, [
          'メール送信前の AI 誤送信チェッカー — 宛先と本文の矛盾を検出',
        ]),
      ]),
      el('button', {
        style: 'padding:6px 14px;background:#fff;color:#7a766c;border:1px solid #c0bdb0;'
             + 'border-radius:6px;font-size:13px;cursor:pointer',
        onclick: () => openSettingsModal((newSettings) => {
          console.log('[mailguard] settings updated:', newSettings);
        }),
      }, ['⚙ 設定']),
    ]),

    // 設定済みチェック バナー (= 未設定なら案内)
    settingsBanner(),

    // ドロップ ゾーン (= ID を持たせて差し替え可能に)
    el('div', { id: 'mg-dropzone-host' }),

    // プレビュー + チェック ボタン エリア
    el('div', { id: 'mg-preview-host' }),

    // 結果エリア
    el('div', { id: 'mg-result-host' }),

    // フッタ
    el('footer', {
      style: 'margin-top:60px;padding-top:18px;border-top:1px solid #f3f1ea;'
           + 'font-size:11px;color:#a8a39a;text-align:center;line-height:1.7',
    }, [
      'MailGuard ' + __MG_BUILD_ID__, el('br'),
      'パース・解析はすべてブラウザ内で完結。AI 呼出しのみ relay 経由で社内ゲートウェイへ送信。',
    ]),
  ]);
}

function settingsBanner(): HTMLElement {
  const s = getSettings();
  const issues: string[] = [];
  if (!s.relayUrl) issues.push('Relay URL 未設定');
  if (!s.model) issues.push('Model 未設定');
  if (s.ownDomains.length === 0) issues.push('自社ドメイン 未設定 (= 内部混入検出が無効)');
  if (issues.length === 0) return el('div');
  return el('div', {
    style: 'background:#fef3c7;border-left:4px solid #f59e0b;border-radius:6px;'
         + 'padding:10px 14px;margin-bottom:20px;font-size:13px;color:#92400e;line-height:1.7',
  }, [
    el('strong', {}, ['⚙ 設定をご確認ください: ']),
    issues.join(' / '),
    ' (右上の「設定」ボタンから)',
  ]);
}

function refreshDropzone(): void {
  const host = document.getElementById('mg-dropzone-host');
  if (!host) return;
  clear(host);
  host.appendChild(createDropzone({
    onMail: (mail) => { currentMail = mail; showPreviewAndCheckButton(mail); },
    onError: (msg) => { showError(msg); },
  }));
}

function showError(msg: string): void {
  const host = document.getElementById('mg-preview-host');
  if (!host) return;
  clear(host);
  host.appendChild(el('div', {
    style: 'background:#fee2e2;border-left:4px solid #dc2626;color:#991b1b;'
         + 'padding:10px 14px;border-radius:6px;font-size:13px;line-height:1.6',
  }, ['✗ ' + msg]));
}

function showPreviewAndCheckButton(mail: ParsedMail): void {
  const host = document.getElementById('mg-preview-host');
  const resHost = document.getElementById('mg-result-host');
  if (!host || !resHost) return;
  clear(host);
  clear(resHost);

  host.appendChild(renderPreview(mail));
  host.appendChild(el('div', { style: 'display:flex;gap:10px;margin-bottom:20px' }, [
    el('button', {
      style: 'padding:10px 22px;background:#7a8a78;color:#fff;border:0;border-radius:6px;'
           + 'font-size:14px;font-weight:600;cursor:pointer;flex-shrink:0',
      onclick: () => runChecks(mail),
    }, ['🤖 AI で誤送信チェック']),
    el('button', {
      style: 'padding:10px 18px;background:#fff;color:#7a766c;border:1px solid #c0bdb0;'
           + 'border-radius:6px;font-size:13px;cursor:pointer',
      onclick: () => { currentMail = null; refreshDropzone(); clear(host); clear(resHost); },
    }, ['別のファイルを選ぶ']),
  ]));
}

async function runChecks(mail: ParsedMail): Promise<void> {
  const resHost = document.getElementById('mg-result-host');
  if (!resHost) return;
  clear(resHost);
  resHost.appendChild(el('div', {
    style: 'padding:20px;text-align:center;color:#7a766c;font-size:13px',
  }, [
    el('div', { style: 'font-size:28px;margin-bottom:8px' }, ['⏳']),
    'AI に問合せ中… (= 10〜30 秒)',
  ]));

  const settings = getSettings();
  const det = runDeterministicChecks(mail, settings);

  let aiResult: CombinedResult['ai'];
  try {
    aiResult = await runAICheck(mail, det, settings);
  } catch (e) {
    aiResult = { error: (e as Error).message };
  }

  clear(resHost);
  resHost.appendChild(renderResult({ deterministic: det, ai: aiResult }));
  resHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 開発時の console 露出 (= テスト時に直接叩けるように)
(window as unknown as { mailguard: unknown }).mailguard = {
  getCurrentMail: () => currentMail,
  rerun: () => currentMail && runChecks(currentMail),
};

// ── グローバル paste ハンドラ ─────────────────────────────────────────
//   ページ内の入力フィールド以外で Cmd+V/Ctrl+V された時、クリップボード内容を
//   メールとしてパースを試みる。
//   Mac Outlook のように .eml ドラッグできない環境で「ソースをコピペ」する
//   ワークフローを補強する。
document.addEventListener('paste', async (e) => {
  // textarea / input にフォーカスがある場合はそちらの処理を優先
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (text.trim().length < 50) return;   // 短いテキストはノイズとして無視
  e.preventDefault();
  try {
    const { parseRawText } = await import('./parser/raw-text');
    const mail = parseRawText(text);
    currentMail = mail;
    showPreviewAndCheckButton(mail);
  } catch (err) {
    showError(`貼り付けテキストのパース失敗: ${(err as Error).message}`);
  }
});
