import { DEFAULT_SETTINGS, Settings } from './types';

const KEY = 'mailguard.settings.v2';   // v1 から構造変更したので新キー

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      provider: (parsed.provider === 'claude' || parsed.provider === 'corp')
        ? parsed.provider : DEFAULT_SETTINGS.provider,
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
