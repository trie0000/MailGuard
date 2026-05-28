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
import { seedFromEnvIfFirstRun } from './defaults';
import { createDropzone } from './ui/dropzone';
import { renderPreview } from './ui/preview';
import { renderResult } from './ui/result';
import { openSettingsModal } from './ui/settings';
import { runDeterministicChecks } from './checks/deterministic';
import { runAICheck } from './checks/ai';
import { batchResolveRecipients, searchSimilarName } from './relay/outlook-client';
import { extractSalutation } from './checks/deterministic';

const root = document.getElementById('mailguard-root');
if (!root) throw new Error('#mailguard-root not found');

let currentMail: ParsedMail | null = null;

// 起動時に組織共通デフォルトを env から seed (= 初回のみ。既存設定があれば touch しない)
// その後 UI を mount。seed は非同期だが mount を阻害しない (= relay 未起動でもとりあえず UI 表示)。
void (async () => {
  try {
    const seeded = await seedFromEnvIfFirstRun();
    if (seeded) {
      console.log('[mailguard] 初回起動: env デフォルト値で localStorage を初期化');
      // seed 反映のため UI 再描画
      mount();
      return;
    }
  } catch (e) {
    console.warn('[mailguard] env defaults seed 失敗:', (e as Error).message);
  }
  mount();
})();

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
  if (s.provider === 'claude') {
    if (!s.claudeApiKey) issues.push('Claude API キー 未設定');
  } else {
    if (!s.corpApiKey) issues.push('社内 AI API キー 未設定');
    if (!s.corpBaseUrl) issues.push('社内 AI ベース URL 未設定');
  }
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
    'GAL 問合せ + AI 解析中… (= 数秒〜30 秒)',
  ]));

  const settings = getSettings();

  // ── Outlook GAL 連携を先に走らせる ────────────────────────────────────
  //   ★ 順序が重要: 決定論チェック (= 宛名 vs To) が ML メンバー情報を必要とするため、
  //     GAL 解決を 先 に完了させてから決定論チェックに渡す。
  //     これで「To=sales-team@xxx, 本文『鈴木様』」のケースで、ML メンバーに
  //     鈴木さんがいれば 宛名一致と判定できる。
  const currentRecipients = [...mail.to, ...mail.cc].map(r => r.email).filter(Boolean);
  const pastParticipantEmails = extractPastParticipantEmails(mail.quotedHistory, currentRecipients);
  const salutation = extractSalutation(mail.latestReply);
  const lastNameForSearch = extractLastNameToken(salutation);

  const [recipientInfo, pastParticipantInfo, similarCandidates] = await Promise.all([
    batchResolveRecipients(settings, currentRecipients).catch(() => []),
    pastParticipantEmails.length > 0
      ? batchResolveRecipients(settings, pastParticipantEmails).catch(() => [])
      : Promise.resolve([]),
    lastNameForSearch
      ? searchSimilarName(settings, lastNameForSearch, mail.to[0]?.email, 10).catch(() => [])
      : Promise.resolve([]),
  ]);
  console.log('[mailguard] GAL — current:', recipientInfo,
    '/ past participants:', pastParticipantInfo,
    '/ similar candidates:', similarCandidates);

  // 決定論チェック (= ML メンバー情報を渡せるようになった)
  const det = runDeterministicChecks(mail, settings, recipientInfo);

  // ── AI チェック: 全情報を渡す ──────────────────────────────────────
  let aiResult: CombinedResult['ai'];
  try {
    aiResult = await runAICheck(mail, det, settings, recipientInfo, similarCandidates, pastParticipantInfo);
  } catch (e) {
    aiResult = { error: (e as Error).message };
  }

  clear(resHost);
  resHost.appendChild(renderResult({
    deterministic: det,
    ai: aiResult,
    recipientInfo,
    similarNameCandidates: similarCandidates,
    pastParticipantInfo,
  }));
  resHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 引用部 (= 過去履歴) のヘッダ行から メアドを抽出。
 *  現在の To/Cc に既に含まれてるメアドは除外 (= 重複 resolve を避ける)。
 *  対象ヘッダ: From / 差出人 / 送信者 / To / 宛先 / Cc */
function extractPastParticipantEmails(quotedHistory: string, currentRecipients: string[]): string[] {
  if (!quotedHistory) return [];
  const HEADER_RE = /(?:差出人|送信者|宛先|From|To|Cc)\s*[:：]\s*([^\n]*)/gi;
  const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = HEADER_RE.exec(quotedHistory)) !== null) {
    const line = m[1] ?? '';
    const emails = line.match(EMAIL_RE) ?? [];
    for (const e of emails) set.add(e.toLowerCase().trim());
  }
  const current = new Set(currentRecipients.map(e => e.toLowerCase().trim()));
  return Array.from(set).filter(e => !current.has(e));
}

/** 「○○様」 から GAL 検索用の苗字 トークンを抽出。
 *   - "田中様" → "田中"
 *   - "田中太郎様" → "田中" (= 先頭の漢字 2 文字)
 *   - "ABC 株式会社 田中様" → "田中"
 *   - 英語 "Dear Mr. Tanaka" → "Tanaka"
 *   抽出できなければ null。 */
function extractLastNameToken(salutation: string | null): string | null {
  if (!salutation) return null;
  // 末尾の敬称を剥がす
  const stripped = salutation.replace(/(様|御中|殿|さん|さま|Mr\.?|Ms\.?|Mrs\.?|Dr\.?)$/i, '').trim();
  if (!stripped) return null;
  // 「ABC 株式会社 田中」 のような形なら最後のトークン (= 個人名と推定)
  // または "Dear Mr. Tanaka" の "Tanaka" 部分
  const tokens = stripped.split(/[\s 　,、・]+/).filter(t => t.length >= 2);
  if (tokens.length === 0) return null;
  const last = tokens[tokens.length - 1]!;
  // 「株式会社」「有限会社」等の組織名は除外
  if (/(株式|有限|合同|合資)会社$/.test(last)) return null;
  return last;
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
