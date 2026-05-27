// 設定モーダル — Spira の AI 設定モーダル (src/views/aiSettingsModal.ts) と
// 同じ二系統 (Claude / Corp) レイアウト + 共通項目。

import { el } from '../utils/dom';
import {
  Settings, DEFAULT_SETTINGS, Provider,
  CLAUDE_MODELS, CORP_AI_MODELS,
} from '../types';
import { DEFAULT_SYSTEM_PROMPT } from '../prompts';
import { getSettings, setSettings } from '../settings';

const LABEL_STYLE =
  'color:#7a766c;font-size:13px;align-self:center;justify-self:end;text-align:right;white-space:nowrap';

export function openSettingsModal(onClose: (newSettings: Settings) => void): void {
  const current = getSettings();

  const overlay = el('div', {
    style: 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1000;'
         + 'display:flex;align-items:flex-start;justify-content:center;padding:48px 20px;overflow:auto',
  });

  const modal = el('div', {
    style: 'background:#fff;border-radius:12px;width:100%;max-width:620px;padding:24px 28px;'
         + 'box-shadow:0 10px 40px rgba(0,0,0,0.2)',
  });

  // ── 共通ヘルパ ────────────────────────────────────────────────────────
  const inputCss = 'width:100%;padding:7px 10px;border:1px solid #c0bdb0;border-radius:6px;'
                 + 'font:13px/1.4 ui-monospace,Menlo,monospace;color:#2a2a26;background:#fff';
  const mkInput = (type: 'text' | 'password' | 'url', placeholder: string, value: string) =>
    el('input', { type, placeholder, value, style: inputCss }) as HTMLInputElement;
  const mkSelect = (opts: Array<{ value: string; label: string; selected?: boolean }>) => {
    const sel = el('select', { style: inputCss }) as HTMLSelectElement;
    for (const o of opts) {
      const op = el('option', { value: o.value }, [o.label]);
      if (o.selected) op.setAttribute('selected', 'selected');
      sel.appendChild(op);
    }
    return sel;
  };
  const hint = (text: string) =>
    el('p', { style: 'font-size:11px;color:#a8a39a;margin:6px 0 0;line-height:1.6' }, [text]);

  // ── Provider セレクタ ─────────────────────────────────────────────────
  const providerSel = mkSelect([
    { value: 'claude', label: 'Claude (Anthropic)', selected: current.provider === 'claude' },
    { value: 'corp', label: '社内 AI (Azure OpenAI 互換)', selected: current.provider === 'corp' },
  ]);
  providerSel.style.width = '280px';

  // ── Claude block ──────────────────────────────────────────────────────
  const claudeKeyInput = mkInput('password', 'sk-ant-... (Anthropic API キー)', current.claudeApiKey);
  const claudeModelSel = mkSelect(CLAUDE_MODELS.map(m => ({
    value: m.id, label: m.label, selected: m.id === current.claudeModel,
  })));
  const claudeBlock = el('div', { style: 'margin-top:14px' }, [
    el('div', {
      style: 'display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px 14px;align-items:center',
    }, [
      el('label', { style: LABEL_STYLE }, ['API キー']),
      claudeKeyInput,
      el('label', { style: LABEL_STYLE }, ['モデル']),
      claudeModelSel,
    ]),
    hint('※ ブラウザから relay 経由で Anthropic API を呼び出します。API キーは localStorage に保存されます (= mailguard.settings.v2)。'),
  ]);

  // ── Corp AI block ─────────────────────────────────────────────────────
  const corpKeyInput = mkInput('password', 'Azure OpenAI 互換 API キー', current.corpApiKey);
  const corpBaseUrlInput = mkInput('url', 'https://gateway.example.com/myapi', current.corpBaseUrl);
  const corpPrefixInput = mkInput('text', 'spira- (deployment id プレフィクス)', current.corpDeployPrefix);
  const corpModelSel = mkSelect(CORP_AI_MODELS.map(m => ({
    value: m.id, label: m.id, selected: m.id === current.corpModel,
  })));
  const corpBlock = el('div', { style: 'margin-top:14px' }, [
    el('div', {
      style: 'display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px 14px;align-items:center',
    }, [
      el('label', { style: LABEL_STYLE }, ['API キー']),
      corpKeyInput,
      el('label', { style: LABEL_STYLE }, ['ベース URL']),
      corpBaseUrlInput,
      el('label', { style: LABEL_STYLE }, ['デプロイ prefix']),
      corpPrefixInput,
      el('label', { style: LABEL_STYLE }, ['モデル']),
      corpModelSel,
    ]),
    hint('※ デプロイ ID は <prefix><モデル名 (.除く)> で組み立てます。例: prefix=spira- + gpt-4.1 → spira-gpt-41。\n'
       + '   api-version は reasoning モデル (gpt-5 / o3 / o4-mini 等) は 2024-12-01-preview、それ以外は 2024-06-01 を自動使用。'),
  ]);

  // Provider 切替で表示出し分け
  const blockArea = el('div', { style: 'margin-top:6px' }, [claudeBlock, corpBlock]);
  const syncVisibility = (): void => {
    claudeBlock.style.display = providerSel.value === 'claude' ? '' : 'none';
    corpBlock.style.display = providerSel.value === 'corp' ? '' : 'none';
  };
  providerSel.addEventListener('change', syncVisibility);
  syncVisibility();

  // ── relay URL / 自社ドメイン / 機密キーワード ─────────────────────
  const relayUrlInput = mkInput('text', DEFAULT_SETTINGS.relayUrl, current.relayUrl);
  const ownDomainsInput = mkInput('text', 'example.co.jp, example.com', current.ownDomains.join(', '));
  const keywordsInput = mkInput('text', '社外秘, 機密, ...', current.internalKeywords.join(', '));

  const commonBlock = el('div', { style: 'margin-top:18px;padding-top:14px;border-top:1px solid #e8e4d8' }, [
    el('div', {
      style: 'display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px 14px;align-items:center',
    }, [
      el('label', { style: LABEL_STYLE }, ['Relay URL']),
      relayUrlInput,
      el('label', { style: LABEL_STYLE }, ['自社ドメイン']),
      ownDomainsInput,
      el('label', { style: LABEL_STYLE }, ['機密キーワード']),
      keywordsInput,
    ]),
    hint('Relay URL = ローカル loopback (例: http://127.0.0.1:18100)\n'
       + '自社ドメイン = カンマ区切り。内部混入検出に使用 (= 空だと検出無効)。\n'
       + '機密キーワード = 本文出現 + 外部宛で high リスク扱い。'),
  ]);

  // ── システム プロンプト (= AI に渡す指示) ────────────────────────────
  //   空欄 = 組込デフォルトを使用。「既定を挿入」で textarea にデフォルト値を
  //   流し込み、編集の起点にできる (= Spira aiSettingsModal と同じパターン)。
  const sysPromptTa = el('textarea', {
    rows: '8',
    placeholder: '(空欄なら組込デフォルトを使用)',
    style: 'width:100%;padding:10px 12px;border:1px solid #c0bdb0;border-radius:6px;'
         + 'font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#2a2a26;'
         + 'background:#fff;resize:vertical;min-height:160px',
  }) as HTMLTextAreaElement;
  sysPromptTa.value = current.systemPrompt;

  const insertDefaultBtn = el('button', {
    type: 'button',
    style: 'padding:5px 12px;background:#fff;color:#7a766c;border:1px solid #c0bdb0;'
         + 'border-radius:4px;font-size:11px;cursor:pointer',
    title: '組込の既定システムプロンプトを textarea に挿入 (= 編集の起点用)',
    onclick: () => {
      sysPromptTa.value = DEFAULT_SYSTEM_PROMPT;
      sysPromptTa.dispatchEvent(new Event('input', { bubbles: true }));
    },
  }, ['既定を挿入']);

  const resetSysPromptBtn = el('button', {
    type: 'button',
    style: 'padding:5px 12px;background:#fff;color:#7a766c;border:1px solid #c0bdb0;'
         + 'border-radius:4px;font-size:11px;cursor:pointer',
    title: 'textarea を空にして組込デフォルトに戻す (= 保存時に空文字 = デフォルト使用)',
    onclick: () => {
      sysPromptTa.value = '';
      sysPromptTa.dispatchEvent(new Event('input', { bubbles: true }));
    },
  }, ['デフォルトに戻す']);

  const sysPromptBlock = el('div', { style: 'margin-top:18px;padding-top:14px;border-top:1px solid #e8e4d8' }, [
    el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:6px' }, [
      el('div', { style: 'font-size:13px;font-weight:600;color:#2a2a26' }, ['AI システム プロンプト']),
      insertDefaultBtn,
      resetSysPromptBtn,
    ]),
    hint('AI への基本指示。判定軸 / 出力形式 / 役割 を記述します。\n'
       + '空欄なら組込デフォルト (= 5 軸 JSON 応答強制) を使用。\n'
       + '「既定を挿入」で雛形を入れて編集 → 「デフォルトに戻す」で空に戻せます。'),
    sysPromptTa,
  ]);

  // ── ボタン ────────────────────────────────────────────────────────────
  const btnSave = el('button', {
    style: 'padding:9px 22px;background:#7a8a78;color:#fff;border:0;border-radius:6px;'
         + 'font-size:13px;font-weight:600;cursor:pointer',
    onclick: () => {
      const next: Settings = {
        relayUrl: relayUrlInput.value.trim() || DEFAULT_SETTINGS.relayUrl,
        provider: providerSel.value as Provider,
        claudeApiKey: claudeKeyInput.value.trim(),
        claudeModel: claudeModelSel.value || DEFAULT_SETTINGS.claudeModel,
        corpApiKey: corpKeyInput.value.trim(),
        corpModel: corpModelSel.value || DEFAULT_SETTINGS.corpModel,
        corpBaseUrl: corpBaseUrlInput.value.trim().replace(/\/+$/, ''),
        corpDeployPrefix: corpPrefixInput.value.trim(),
        systemPrompt: sysPromptTa.value,    // 空文字なら ai.ts 側で組込デフォルトに fallback
        ownDomains: ownDomainsInput.value.split(',').map(s => s.trim()).filter(Boolean),
        internalKeywords: keywordsInput.value.split(',').map(s => s.trim()).filter(Boolean),
        typoDomains: current.typoDomains,
      };
      setSettings(next);
      overlay.remove();
      onClose(next);
    },
  }, ['保存']);
  const btnCancel = el('button', {
    style: 'padding:9px 18px;background:#fff;color:#7a766c;border:1px solid #c0bdb0;'
         + 'border-radius:6px;font-size:13px;cursor:pointer',
    onclick: () => { overlay.remove(); },
  }, ['キャンセル']);

  // ── 組み立て ────────────────────────────────────────────────────────
  modal.appendChild(el('h2', { style: 'margin:0 0 4px;font-size:18px;font-weight:700' }, ['⚙ AI 設定']));
  modal.appendChild(el('p', { style: 'margin:0 0 14px;font-size:12px;color:#7a766c;line-height:1.6' }, [
    'プロバイダ (Claude / 社内 AI) と API キー / モデル / 社内 AI のベース URL ・ デプロイプレフィクスを設定します。',
    el('br'),
    '設定は localStorage に保存されます (= このブラウザのみ)。',
  ]));

  modal.appendChild(el('div', {
    style: 'display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px 14px;align-items:center',
  }, [
    el('label', { style: LABEL_STYLE }, ['プロバイダ']),
    providerSel,
  ]));
  modal.appendChild(blockArea);
  modal.appendChild(commonBlock);
  modal.appendChild(sysPromptBlock);
  modal.appendChild(el('div', { style: 'display:flex;gap:10px;justify-content:flex-end;margin-top:22px' }, [
    btnCancel, btnSave,
  ]));
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });

  document.body.appendChild(overlay);
}
