// 組織共通デフォルト (= relay の .env で管理される値) を取得する。
//
// 初回起動時に localStorage が空なら、relay の GET /defaults を叩いて返ってきた
// 値を localStorage に seed する仕組み。配布時は relay 同梱の .env に
// 組織の AI ゲートウェイ URL / deploy prefix / 自社ドメイン 等を書いておけば、
// 利用者は API キーだけ入れれば動く。
//
// 後から変更したい場合は、設定画面の「env デフォルトに戻す」ボタンで再シード可能。

import { Settings, DEFAULT_SETTINGS, Provider } from './types';

export interface EnvDefaults {
  provider?: string;
  corpBaseUrl?: string;
  corpDeployPrefix?: string;
  corpModel?: string;
  claudeModel?: string;
  ownDomains?: string[];
  internalKeywords?: string[];
}

/** relay の /defaults エンドポイントから組織共通デフォルトを取得。
 *  relay 未起動 / フェッチ失敗時は空オブジェクト。 */
export async function fetchEnvDefaults(relayUrl: string): Promise<EnvDefaults> {
  try {
    const url = `${relayUrl.replace(/\/+$/, '')}/defaults`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return {};
    const j = await res.json() as EnvDefaults;
    return j ?? {};
  } catch { return {}; }
}

/** provider の別名を吸収して 'claude' | 'corp' に正規化。
 *  Spira / 旧コードから来た値 (= 'anthropic' / 'openai') にも対応。 */
export function normalizeProvider(raw: string | undefined | null): Provider | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'claude' || v === 'anthropic') return 'claude';
  if (v === 'corp' || v === 'openai') return 'corp';
  return null;
}

/** env defaults を既存 settings に上書きマージして返す (= 非破壊)。
 *  空文字 / 空配列は無視 (= env で未設定なら base の値を維持)。 */
export function mergeEnvDefaults(base: Settings, env: EnvDefaults): Settings {
  const next = { ...base };
  const p = normalizeProvider(env.provider);
  if (p) next.provider = p;
  if (env.corpBaseUrl) next.corpBaseUrl = env.corpBaseUrl;
  if (env.corpDeployPrefix) next.corpDeployPrefix = env.corpDeployPrefix;
  if (env.corpModel) next.corpModel = env.corpModel;
  if (env.claudeModel) next.claudeModel = env.claudeModel;
  if (env.ownDomains && env.ownDomains.length > 0) next.ownDomains = env.ownDomains;
  if (env.internalKeywords && env.internalKeywords.length > 0) next.internalKeywords = env.internalKeywords;
  return next;
}

/** 初回起動時に localStorage が空なら env defaults を seed する。
 *  既に保存済みの場合は何もしない (= 利用者の変更を尊重)。 */
export async function seedFromEnvIfFirstRun(): Promise<boolean> {
  const KEY = 'mailguard.settings.v2';
  if (localStorage.getItem(KEY)) return false;
  // 初回起動: relay にデフォルト URL でフェッチを試みる
  const env = await fetchEnvDefaults(DEFAULT_SETTINGS.relayUrl);
  if (Object.keys(env).length === 0) {
    // relay 未起動 / defaults 提供なし → ハードコード DEFAULT_SETTINGS で初期化
    localStorage.setItem(KEY, JSON.stringify(DEFAULT_SETTINGS));
    return false;
  }
  const seeded = mergeEnvDefaults(DEFAULT_SETTINGS, env);
  localStorage.setItem(KEY, JSON.stringify(seeded));
  return true;
}
