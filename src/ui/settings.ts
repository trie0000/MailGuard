// 設定モーダル — Spira の AI 設定モーダル (src/views/aiSettingsModal.ts) と
// 同じ二系統 (Claude / Corp) レイアウト + 共通項目。

import { el } from '../utils/dom';
import {
  Settings, DEFAULT_SETTINGS, Provider,
  CLAUDE_MODELS, CORP_AI_MODELS,
} from '../types';
import { DEFAULT_SYSTEM_PROMPT } from '../prompts';
import { getSettings, setSettings } from '../settings';
import { fetchEnvDefaults, normalizeProvider } from '../defaults';
import { clearOutlookCache } from '../relay/outlook-client';

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
  //   挙動:
  //     初期表示 → 保存済みカスタム値 があればそれを、無ければ組込デフォルトを表示
  //                (= 利用者に「何が実際 AI に渡るか」を視覚化)
  //     保存時 → 値が DEFAULT_SYSTEM_PROMPT と完全一致なら localStorage には
  //              空文字を入れる (= 将来 DEFAULT が更新された時に追従する)
  //              異なる場合だけ value をそのまま保存 (= カスタム扱い)
  //     「デフォルトに戻す」 → textarea を DEFAULT_SYSTEM_PROMPT で置き換え
  //                            → そのまま保存すると "" 扱いに戻る
  const sysPromptTa = el('textarea', {
    rows: '10',
    style: 'width:100%;padding:10px 12px;border:1px solid #c0bdb0;border-radius:6px;'
         + 'font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#2a2a26;'
         + 'background:#fff;resize:vertical;min-height:200px',
  }) as HTMLTextAreaElement;
  // current.systemPrompt が空 = デフォルト使用中 → DEFAULT_SYSTEM_PROMPT を表示
  sysPromptTa.value = current.systemPrompt && current.systemPrompt.trim()
    ? current.systemPrompt
    : DEFAULT_SYSTEM_PROMPT;

  const resetSysPromptBtn = el('button', {
    type: 'button',
    style: 'padding:5px 12px;background:#fff;color:#7a766c;border:1px solid #c0bdb0;'
         + 'border-radius:4px;font-size:11px;cursor:pointer',
    title: 'textarea を組込既定値で置換 (= 保存時に内部的に "" 扱いになり、'
         + '将来既定値が更新された時に自動追従する)',
    onclick: () => {
      sysPromptTa.value = DEFAULT_SYSTEM_PROMPT;
      sysPromptTa.dispatchEvent(new Event('input', { bubbles: true }));
    },
  }, ['デフォルトに戻す']);

  const sysPromptBlock = el('div', { style: 'margin-top:18px;padding-top:14px;border-top:1px solid #e8e4d8' }, [
    el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:6px' }, [
      el('div', { style: 'font-size:13px;font-weight:600;color:#2a2a26' }, ['AI システム プロンプト']),
      resetSysPromptBtn,
    ]),
    hint('AI への基本指示。判定軸 / 出力形式 / 役割 を記述します。\n'
       + '組込既定値が表示されています。編集すれば カスタム プロンプトとして保存されます。\n'
       + '「デフォルトに戻す」で組込既定値に戻ります (= 内部的に "" 保存され、将来既定値が更新された時に追従)。'),
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
        // 入力値が DEFAULT_SYSTEM_PROMPT と完全一致なら "" として保存 (= 将来既定が更新された時に追従)、
        // 異なる場合だけ value を そのまま保存 (= カスタム扱い)
        systemPrompt: sysPromptTa.value === DEFAULT_SYSTEM_PROMPT ? '' : sysPromptTa.value,
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

  // env デフォルトに戻す: relay の /defaults を取得 → 全フィールドを env 値に上書き
  // (= 配布時に admin が .env で組織共通の AI URL / deploy prefix 等を設定しておけば、
  //  個人が「リセット」したい時にいつでもここから戻せる)
  const envResetStatus = el('span', {
    style: 'font-size:11px;color:#7a766c;align-self:center;flex:1',
  });
  const btnEnvReset = el('button', {
    style: 'padding:9px 14px;background:#fff;color:#7a766c;border:1px dashed #c0bdb0;'
         + 'border-radius:6px;font-size:12px;cursor:pointer',
    title: 'relay の .env で設定された組織共通デフォルト値で各フィールドを上書き (= API キーは保持)',
    onclick: async () => {
      envResetStatus.textContent = '⏳ relay から /defaults を取得中…';
      envResetStatus.style.color = '#7a766c';
      const env = await fetchEnvDefaults(relayUrlInput.value.trim() || DEFAULT_SETTINGS.relayUrl);
      // 診断: 受信内容と適用結果を console に出す (= 利用者が F12 で確認可能)
      console.log('[mailguard] /defaults response:', env);
      if (!env || Object.keys(env).length === 0) {
        envResetStatus.textContent = '✗ relay 未起動 / defaults なし';
        envResetStatus.style.color = '#dc2626';
        return;
      }

      const applied: string[] = [];
      const skipped: string[] = [];

      // provider: 'claude' | 'corp' に正規化 (= 別名 anthropic/openai も吸収)
      const p = normalizeProvider(env.provider);
      if (p) {
        providerSel.value = p;
        providerSel.dispatchEvent(new Event('change', { bubbles: true }));
        applied.push(`provider=${p}`);
      } else {
        skipped.push(`provider (env="${env.provider ?? ''}")`);
      }

      // corp 系
      if (env.corpBaseUrl) { corpBaseUrlInput.value = env.corpBaseUrl; applied.push('corpBaseUrl'); }
      else skipped.push('corpBaseUrl');

      if (env.corpDeployPrefix) { corpPrefixInput.value = env.corpDeployPrefix; applied.push('corpDeployPrefix'); }
      else skipped.push('corpDeployPrefix');

      if (env.corpModel) { corpModelSel.value = env.corpModel; applied.push('corpModel'); }
      else skipped.push('corpModel');

      if (env.claudeModel) { claudeModelSel.value = env.claudeModel; applied.push('claudeModel'); }
      else skipped.push('claudeModel');

      // 自社ドメイン / 機密キーワード
      if (Array.isArray(env.ownDomains) && env.ownDomains.length > 0) {
        ownDomainsInput.value = env.ownDomains.join(', ');
        applied.push(`ownDomains(${env.ownDomains.length})`);
      } else skipped.push('ownDomains');

      if (Array.isArray(env.internalKeywords) && env.internalKeywords.length > 0) {
        keywordsInput.value = env.internalKeywords.join(', ');
        applied.push(`internalKeywords(${env.internalKeywords.length})`);
      } else skipped.push('internalKeywords');

      console.log('[mailguard] env-reset applied:', applied, 'skipped(env で未設定):', skipped);
      envResetStatus.innerHTML = `✓ 更新: ${applied.join(', ') || '(なし)'}`
        + `<br><span style="color:#a8a39a">スキップ (env 未設定): ${skipped.join(', ') || '(なし)'}</span>`;
      envResetStatus.style.color = '#065f46';
    },
  }, ['env デフォルトに戻す']);

  // Outlook GAL / CSV ML キャッシュ クリア (= CSV を後から置いたが反映されない時の救済)
  const btnClearCache = el('button', {
    style: 'padding:9px 14px;background:#fff;color:#7a766c;border:1px dashed #c0bdb0;'
         + 'border-radius:6px;font-size:12px;cursor:pointer',
    title: 'ブラウザに保存された Outlook GAL / CSV ML の解決結果キャッシュをクリア (= 次回チェックで relay に再問い合せ)',
    onclick: () => {
      clearOutlookCache();
      envResetStatus.textContent = '✓ GAL / ML キャッシュをクリアしました (= 次の AI チェックで再取得)';
      envResetStatus.style.color = '#065f46';
    },
  }, ['GAL/ML キャッシュ クリア']);

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
  modal.appendChild(el('div', {
    style: 'display:flex;gap:10px;align-items:center;margin-top:22px;flex-wrap:wrap',
  }, [
    btnEnvReset,
    btnClearCache,
    envResetStatus,
    btnCancel,
    btnSave,
  ]));
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });

  document.body.appendChild(overlay);
}
