// Outlook GAL 連携 クライアント (= relay /outlook/* エンドポイントを叩く)
//
// 動作:
//   1. AI チェック直前に To+Cc のメアドを一括 resolve
//   2. 結果は localStorage に 1 日キャッシュ (= 連発時の COM 往復回避)
//   3. AI プロンプトに部署・役職情報を添付 (= 同姓 別部署 検出)
//
// 必要環境:
//   - 利用者の Windows で Outlook が起動している
//   - 社内 Exchange 環境 (= GAL アクセス可能)
//
// relay 未対応 / Outlook 未起動 の場合は静かに [] を返す (= 検出機能が縮退するだけ)。

import { RecipientInfo, Settings } from '../types';

// v2: ml-csv type 追加 / external キャッシュを短く (CSV を後から置いたケース対応)
const CACHE_KEY = 'mailguard.outlook.resolve.v2';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 1 日 (resolved な GAL ユーザ)
const CACHE_TTL_UNRESOLVED_MS = 5 * 60 * 1000;   // 5 分 (external / unresolved → CSV 追加で即反映できるよう短く)

interface CacheEntry {
  info: RecipientInfo;
  ts: number;
}

function loadCache(): Record<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, CacheEntry>;
  } catch { return {}; }
}

function saveCache(cache: Record<string, CacheEntry>): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }
}

function getCached(email: string): RecipientInfo | null {
  const cache = loadCache();
  const entry = cache[email.toLowerCase().trim()];
  if (!entry) return null;
  // external / unresolved は CSV を後から追加するケースを考慮して短い TTL
  const isStale = entry.info.type === 'external' || entry.info.type === 'unresolved' || !entry.info.resolved;
  const ttl = isStale ? CACHE_TTL_UNRESOLVED_MS : CACHE_TTL_MS;
  if (Date.now() - entry.ts > ttl) return null;
  return entry.info;
}

/** Outlook GAL / CSV ML キャッシュを全クリア (= 設定画面から呼出し) */
export function clearOutlookCache(): void {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}

function setCached(email: string, info: RecipientInfo): void {
  const cache = loadCache();
  cache[email.toLowerCase().trim()] = { info, ts: Date.now() };
  saveCache(cache);
}

/** メアド配列を 一括 resolve。キャッシュにあるものは relay 呼出しせず返す。
 *  relay 失敗 / Outlook 未起動 時は resolved=false で各メアド分の placeholder を返す。 */
export async function batchResolveRecipients(
  settings: Settings,
  emails: string[],
): Promise<RecipientInfo[]> {
  const unique = Array.from(new Set(
    emails.map(e => e.toLowerCase().trim()).filter(Boolean),
  ));
  if (unique.length === 0) return [];

  // キャッシュ参照
  const resolved: Record<string, RecipientInfo> = {};
  const toFetch: string[] = [];
  for (const e of unique) {
    const c = getCached(e);
    if (c) resolved[e] = c;
    else toFetch.push(e);
  }

  // 未キャッシュ分を relay で取得
  if (toFetch.length > 0) {
    try {
      const url = `${settings.relayUrl.replace(/\/+$/, '')}/outlook/batch-resolve`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: toFetch }),
      });
      if (res.ok) {
        const data = await res.json() as { results: RecipientInfo[] };
        for (const info of (data.results ?? [])) {
          const key = info.email.toLowerCase().trim();
          resolved[key] = info;
          setCached(key, info);
        }
      } else {
        console.warn('[mailguard] batch-resolve HTTP', res.status);
      }
    } catch (e) {
      console.warn('[mailguard] outlook batch-resolve failed:', (e as Error).message);
    }
  }

  // 元の email 配列の順序を維持して返す
  return emails.map(e => {
    const key = e.toLowerCase().trim();
    return resolved[key] ?? { email: e, resolved: false, type: 'unresolved' };
  });
}

/** GAL 内で部分一致検索 (= 苗字 で 同姓 別人候補を探す)。 */
export async function searchSimilarName(
  settings: Settings,
  namePart: string,
  excludeEmail?: string,
  max = 10,
): Promise<RecipientInfo[]> {
  const n = namePart.trim();
  if (!n) return [];
  try {
    const url = `${settings.relayUrl.replace(/\/+$/, '')}/outlook/search-similar`
      + `?name=${encodeURIComponent(n)}&max=${max}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as { results: RecipientInfo[] };
    const excl = excludeEmail?.toLowerCase().trim();
    return (data.results ?? []).filter(r => r.email && r.email.toLowerCase() !== excl);
  } catch { return []; }
}

/** ML / DL 系の RecipientInfo か判定 (= メンバー展開を持つもの) */
export function isDistributionList(r: RecipientInfo): boolean {
  return r.type === 'exchange-dl' || r.type === 'personal-dl' || r.type === 'ml-csv';
}

/** RecipientInfo から AI プロンプト用の 1 行サマリを作る。
 *  ML (= exchange-dl / ml-csv) の場合はメンバーリストも展開して返す。 */
export function formatRecipientInfo(r: RecipientInfo): string {
  if (!r.resolved) return `${r.email} (= GAL 未解決 / 外部メアド)`;
  if (isDistributionList(r)) {
    const srcLabel = r.source === 'csv' ? 'CSV 提供 ML' : 'ML / 配布リスト';
    const header = `${r.email} [${srcLabel}: ${r.displayName ?? '(no name)'}, メンバー ${r.memberCount ?? 0} 名]`;
    if (!r.members || r.members.length === 0) return header;
    const memberLines = r.members.slice(0, 30).map(m => {
      const meta: string[] = [];
      if (m.displayName) meta.push(m.displayName);
      if (m.department) meta.push(m.department);
      if (m.jobTitle) meta.push(m.jobTitle);
      return `      • ${m.email ?? '(no email)'} (${meta.join(' / ')})`;
    });
    const more = (r.memberCount ?? r.members.length) > r.members.length
      ? `\n      … 他 ${(r.memberCount ?? r.members.length) - r.members.length} 名`
      : '';
    return `${header}\n${memberLines.join('\n')}${more}`;
  }
  const parts: string[] = [];
  if (r.displayName) parts.push(r.displayName);
  if (r.department) parts.push(r.department);
  if (r.jobTitle) parts.push(r.jobTitle);
  if (r.officeLocation) parts.push(r.officeLocation);
  if (r.manager) parts.push(`上長: ${r.manager}`);
  return `${r.email}: ${parts.join(' / ')}`;
}

/** ML メンバー全員の displayName を平坦化して返す (= 「○○様」 照合用) */
export function flattenMemberNames(r: RecipientInfo): string[] {
  if (!isDistributionList(r)) return [];
  if (!r.members) return [];
  const names: string[] = [];
  for (const m of r.members) {
    if (m.displayName) names.push(m.displayName);
    if (m.lastName) names.push(m.lastName);
    if (m.firstName) names.push(m.firstName);
  }
  return names;
}
