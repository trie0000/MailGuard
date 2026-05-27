import { DEFAULT_SETTINGS, Settings } from './types';

const KEY = 'mailguard.settings.v1';

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
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
