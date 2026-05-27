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
    style: 'background:#fff;border-radius:12px;width:100%;max-width:560px;padding:24px 28px;'
         + 'box-shadow:0 10px 40px rgba(0,0,0,0.2)',
  });

  // 入力ヘルパ
  const inputRow = (label: string, hint: string, value: string, type: 'text' | 'password' = 'text') => {
    const input = el('input', {
      type,
      class: 'mg-input',
      value,
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

  const r1 = inputRow('Relay URL', 'AI ゲートウェイへの転送先 (= spira-ai-relay.ps1 の loopback)', current.relayUrl);
  const r2 = inputRow('Model', '使用する AI モデル ID (例: gpt-4o / gpt-4o-mini / claude-3-5-sonnet)', current.model);
  const r3 = inputRow('API Key', '(relay 側で認証している場合は不要)', current.apiKey, 'password');
  const r4 = inputRow('自社ドメイン', 'カンマ区切り (例: example.co.jp, example.com)', current.ownDomains.join(', '));
  const r5 = inputRow('機密キーワード', 'カンマ区切り。本文に出現 + 外部宛で high リスク扱い',
    current.internalKeywords.join(', '));

  // モデル候補のドロップダウン (= relay 対応時)
  const modelHint = el('div', { style: 'font-size:11px;color:#a8a39a;margin-top:3px' }, [
    'relay からモデル取得中…',
  ]);
  void (async () => {
    const settingsSnap: Settings = { ...current, relayUrl: r1.input.value };
    const models = await fetchModels(settingsSnap);
    if (models && models.length > 0) {
      const sel = el('select', {
        style: 'width:100%;padding:8px 12px;border:1px solid #c0bdb0;border-radius:6px;font-size:13px;margin-top:6px',
        onchange: () => { r2.input.value = sel.value; },
      }) as HTMLSelectElement;
      sel.appendChild(el('option', { value: '' }, ['— 候補から選ぶ —']));
      for (const m of models) sel.appendChild(el('option', { value: m }, [m]));
      modelHint.replaceWith(sel);
    } else {
      modelHint.textContent = '※ relay からモデル一覧を取得できませんでした (手入力してください)';
    }
  })();
  r2.wrap.appendChild(modelHint);

  const btnSave = el('button', {
    style: 'padding:8px 18px;background:#7a8a78;color:#fff;border:0;border-radius:6px;'
         + 'font-size:13px;font-weight:600;cursor:pointer',
    onclick: () => {
      const next: Settings = {
        relayUrl: r1.input.value.trim() || DEFAULT_SETTINGS.relayUrl,
        model: r2.input.value.trim() || DEFAULT_SETTINGS.model,
        apiKey: r3.input.value.trim(),
        ownDomains: r4.input.value.split(',').map(s => s.trim()).filter(Boolean),
        internalKeywords: r5.input.value.split(',').map(s => s.trim()).filter(Boolean),
        typoDomains: current.typoDomains,    // ←タイポ辞書は今回 UI 編集対象外 (MVP)
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
  modal.appendChild(el('p', { style: 'margin:0 0 18px;font-size:12px;color:#7a766c' }, [
    'localStorage に保存されます (= このブラウザのみ)。',
  ]));
  modal.appendChild(r1.wrap);
  modal.appendChild(r2.wrap);
  modal.appendChild(r3.wrap);
  modal.appendChild(r4.wrap);
  modal.appendChild(r5.wrap);
  modal.appendChild(el('div', { style: 'display:flex;gap:10px;justify-content:flex-end;margin-top:20px' }, [
    btnCancel, btnSave,
  ]));
  overlay.appendChild(modal);

  // Esc / オーバーレイ クリックで閉じる
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });

  document.body.appendChild(overlay);
}
