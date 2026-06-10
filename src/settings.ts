import { DEFAULT_SETTINGS, Settings } from './types';

const KEY = 'mailguard.settings.v2';   // v1 から構造変更したので新キー
const DEV_KEY = 'mailguard.devmode';

/** 開発者モード判定。
 *  有効化: URL に ?dev=1 を付けて開く (= localStorage に永続化)
 *  無効化: ?dev=0 で開く
 *  普段の配布利用では OFF (= プロバイダは社内 AI のみ表示)。 */
export function isDevMode(): boolean {
  try {
    const p = new URLSearchParams(location.search).get('dev');
    if (p === '1') { localStorage.setItem(DEV_KEY, '1'); return true; }
    if (p === '0') { localStorage.removeItem(DEV_KEY); return false; }
    return localStorage.getItem(DEV_KEY) === '1';
  } catch { return false; }
}

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    let provider = (parsed.provider === 'claude' || parsed.provider === 'corp')
      ? parsed.provider : DEFAULT_SETTINGS.provider;
    // 開発者モード OFF なら claude は使わせない (= 社内 AI に強制)
    if (provider === 'claude' && !isDevMode()) provider = 'corp';
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      provider,
      ownDomains: parsed.ownDomains ?? DEFAULT_SETTINGS.ownDomains,
      internalKeywords: parsed.internalKeywords ?? DEFAULT_SETTINGS.internalKeywords,
      typoDomains: parsed.typoDomains ?? DEFAULT_SETTINGS.typoDomains,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* noop */ }
}
