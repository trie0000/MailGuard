import { el } from '../utils/dom';
import { Settings, DEFAULT_SETTINGS } from '../types';
import { getSettings, setSettings } from '../settings';
import { fetchModels } from '../relay/ai-client';

/** 設定モーダルを開く。閉じる時に最新値を localStorage に保存して onClose 呼出し。 */
export function openSettingsModal(onClose: (newSettings: Settings) => void): void {
  const current = getSettings();

  const overlay = el('div', {
    style: 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1000;'
         + 'display:flex;align-items:flex-start;justify-content:center;padding:48px 20px;overflow:auto',
  });

  const modal = el('div', {
    style: 'background:#fff;border-radius:12px;width:100%;max-width:600px;padding:24px 28px;'
         + 'box-shadow:0 10px 40px rgba(0,0,0,0.2)',
  });

  // 入力ヘルパ
  const inputRow = (label: string, hint: string, value: string, type: 'text' | 'password' = 'text') => {
    const input = el('input', {
      type, class: 'mg-input', value,
      style: 'width:100%;padding:8px 12px;border:1px solid #c0bdb0;border-radius:6px;'
           + 'font-size:13px;font-family:ui-monospace,Menlo,monospace',
    }) as HTMLInputElement;
    const wrap = el('div', { style: 'margin-bottom:14px' }, [
      el('label', { style: 'display:block;font-size:12px;font-weight:600;color:#2a2a26;margin-bottom:4px' }, [label]),
      input,
      el('div', { style: 'font-size:11px;color:#a8a39a;margin-top:3px' }, [hint]),
    ]);
    return { wrap, input };
  };

  const r1 = inputRow('Relay URL (= ローカル loopback)',
    '例: http://127.0.0.1:18100', current.relayUrl);

  // プロバイダ (= dropdown)
  const providerSel = el('select', {
    class: 'mg-select',
    style: 'width:100%;padding:8px 12px;border:1px solid #c0bdb0;border-radius:6px;font-size:13px;background:#fff',
  }) as HTMLSelectElement;
  providerSel.appendChild(el('option', { value: 'anthropic' }, ['Anthropic (Claude)']));
  providerSel.appendChild(el('option', { value: 'openai' }, ['OpenAI 互換 (= 社内 AI ゲートウェイ含む)']));
  providerSel.value = current.provider;
  const r2 = {
    wrap: el('div', { style: 'margin-bottom:14px' }, [
      el('label', { style: 'display:block;font-size:12px;font-weight:600;color:#2a2a26;margin-bottom:4px' }, ['プロバイダ']),
      providerSel,
      el('div', { style: 'font-size:11px;color:#a8a39a;margin-top:3px' }, [
        'プロトコル種別。社内 AI ゲートウェイが OpenAI 互換なら OpenAI を選択。',
      ]),
    ]),
  };

  const r3 = inputRow('上流 API ベース URL',
    '例 (Anthropic): https://api.anthropic.com / 社内 AI ゲートウェイ URL も可',
    current.upstreamBase);

  const r4 = inputRow('API キー',
    'Anthropic: sk-ant-... / OpenAI: sk-... / 社内: 管理者発行のキー',
    current.apiKey, 'password');

  // プロバイダ切替で上流 URL のヒントとデフォルトを動的更新
  providerSel.addEventListener('change', () => {
    const provider = providerSel.value;
    const cur = r3.input.value.trim();
    if (provider === 'anthropic' && (!cur || /openai\.com$/i.test(cur))) {
      r3.input.value = 'https://api.anthropic.com';
    } else if (provider === 'openai' && (!cur || /anthropic\.com$/i.test(cur))) {
      r3.input.value = 'https://api.openai.com';
    }
  });

  const r5 = inputRow('Model (= モデル ID)',
    '例 (Anthropic): claude-sonnet-4-5 / claude-haiku-4-5 / claude-opus-4-5\n'
    + '例 (OpenAI):    gpt-4o-mini / gpt-4o',
    current.model);

  // モデル候補のドロップダウン (= relay 対応時)
  const modelHint = el('div', { style: 'font-size:11px;color:#a8a39a;margin-top:3px' }, [
    'relay からモデル取得中…',
  ]);
  const refreshModels = async () => {
    modelHint.textContent = 'relay からモデル取得中…';
    const snap: Settings = {
      ...current,
      relayUrl: r1.input.value,
      provider: (providerSel.value as 'openai' | 'anthropic'),
      upstreamBase: r3.input.value,
      apiKey: r4.input.value,
    };
    const models = await fetchModels(snap);
    if (models && models.length > 0) {
      const sel = el('select', {
        style: 'width:100%;padding:8px 12px;border:1px solid #c0bdb0;border-radius:6px;font-size:13px;margin-top:6px',
        onchange: () => { r5.input.value = sel.value; },
      }) as HTMLSelectElement;
      sel.appendChild(el('option', { value: '' }, ['— 候補から選ぶ —']));
      for (const m of models) sel.appendChild(el('option', { value: m }, [m]));
      modelHint.replaceWith(sel);
    } else {
      modelHint.textContent = '※ relay からモデル一覧を取得できませんでした (手入力してください)';
    }
  };
  void refreshModels();
  r5.wrap.appendChild(modelHint);

  const r6 = inputRow('自社ドメイン',
    'カンマ区切り (例: example.co.jp, example.com)。内部メンバー判定 + 内部混入検出に使用',
    current.ownDomains.join(', '));
  const r7 = inputRow('機密キーワード',
    'カンマ区切り。本文に出現 + 外部宛で high リスク扱い',
    current.internalKeywords.join(', '));

  const btnSave = el('button', {
    style: 'padding:8px 18px;background:#7a8a78;color:#fff;border:0;border-radius:6px;'
         + 'font-size:13px;font-weight:600;cursor:pointer',
    onclick: () => {
      const next: Settings = {
        relayUrl: r1.input.value.trim() || DEFAULT_SETTINGS.relayUrl,
        provider: (providerSel.value as 'openai' | 'anthropic'),
        upstreamBase: r3.input.value.trim() || DEFAULT_SETTINGS.upstreamBase,
        apiKey: r4.input.value.trim(),
        model: r5.input.value.trim() || DEFAULT_SETTINGS.model,
        ownDomains: r6.input.value.split(',').map(s => s.trim()).filter(Boolean),
        internalKeywords: r7.input.value.split(',').map(s => s.trim()).filter(Boolean),
        typoDomains: current.typoDomains,
      };
      setSettings(next);
      overlay.remove();
      onClose(next);
    },
  }, ['保存']);
  const btnCancel = el('button', {
    style: 'padding:8px 18px;background:#fff;color:#7a766c;border:1px solid #c0bdb0;'
         + 'border-radius:6px;font-size:13px;cursor:pointer',
    onclick: () => { overlay.remove(); },
  }, ['キャンセル']);

  modal.appendChild(el('h2', { style: 'margin:0 0 6px;font-size:18px;font-weight:700' }, ['⚙ 設定']));
  modal.appendChild(el('p', { style: 'margin:0 0 18px;font-size:12px;color:#7a766c;line-height:1.6' }, [
    'localStorage に保存されます (= このブラウザのみ)。',
    el('br'),
    'API キー / 上流 URL / プロバイダ はリクエストごとに relay 経由で上流に渡されます。',
  ]));
  modal.appendChild(r1.wrap);
  modal.appendChild(r2.wrap);
  modal.appendChild(r3.wrap);
  modal.appendChild(r4.wrap);
  modal.appendChild(r5.wrap);
  modal.appendChild(r6.wrap);
  modal.appendChild(r7.wrap);
  modal.appendChild(el('div', { style: 'display:flex;gap:10px;justify-content:flex-end;margin-top:20px' }, [
    btnCancel, btnSave,
  ]));
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });

  document.body.appendChild(overlay);
}
