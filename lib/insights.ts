/**
 * Cached wrappers around the Meta insight fetchers. Account-level KPI reads
 * are by far the hottest path (one Graph API call per account per render in
 * the cockpit/portfolio). TTL follows `ttlForRange`: 15 min while the window
 * touches today, 24 h once every day of the window is closed.
 *
 * Errors propagate (typed MetaApiError) — nothing is cached on failure.
 * "No data" yields a zero-filled row (`hasData: false`) cached 60 s.
 */

import { cached, cachedWithMeta, ttlForRange, type CachedResult, type CacheOptions } from "@/lib/kpi-cache";
import {
  getAdAccounts,
  getAccountInsights,
  getAccountProfile,
  type MetaAdAccount,
  type MetaAccountInsight,
  type MetaAccountProfile,
} from "@/lib/meta-api";
import { lastFullDays } from "@/lib/date-ranges";
import { prisma } from "@/lib/prisma";

const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

const norm = (id: string) => id.replace(/^act_/, "");

export function accountInsightsCacheKey(adAccountId: string, timeRange?: { since: string; until: string }): string {
  const rangeKey = timeRange ? `${timeRange.since}_${timeRange.until}` : "last_30d";
  return `meta:account:${norm(adAccountId)}:${rangeKey}`;
}

/** Account insights with cache metadata (fetchedAt / fromCache). */
export async function getAccountInsightsCachedWithMeta(
  accessToken: string,
  adAccountId: string,
  timeRange?: { since: string; until: string },
  opts: Pick<CacheOptions, "refresh"> = {},
): Promise<CachedResult<MetaAccountInsight>> {
  const range = timeRange ?? lastFullDays(30);
  return cachedWithMeta(
    accountInsightsCacheKey(adAccountId, timeRange),
    () => getAccountInsights(accessToken, adAccountId, timeRange),
    { ttlMs: ttlForRange(range), refresh: opts.refresh },
  );
}

/** Account insights (never null — see getAccountInsights). */
export async function getAccountInsightsCached(
  accessToken: string,
  adAccountId: string,
  timeRange?: { since: string; until: string },
): Promise<MetaAccountInsight> {
  return (await getAccountInsightsCachedWithMeta(accessToken, adAccountId, timeRange)).data;
}

/** Account profile (name, currency, timezone) cached 24 h. */
export async function getAccountProfileCached(
  accessToken: string,
  adAccountId: string,
  opts: Pick<CacheOptions, "refresh"> = {},
): Promise<MetaAccountProfile> {
  return cached(
    `meta:profile:${norm(adAccountId)}`,
    () => getAccountProfile(accessToken, adAccountId),
    { ttlMs: PROFILE_TTL_MS, refresh: opts.refresh },
  );
}

const AD_ACCOUNTS_TTL_MS = 15 * 60 * 1000;
const AD_ACCOUNTS_LAST_KNOWN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Ad accounts behind the token, cached 15 min. `/me/adaccounts` fails as a
 * whole as soon as ONE account of the business is rate limited, which used to
 * blank every account picker: on failure the last list seen (≤ 30 days) is
 * served instead, and the error propagates only when there is none.
 */
export async function getAdAccountsCached(accessToken: string): Promise<MetaAdAccount[]> {
  try {
    return await cached("meta:adaccounts", async () => {
      const list = await getAdAccounts(accessToken);
      if (list.length > 0) {
        await cached("meta:adaccounts:last-known", async () => list, {
          ttlMs: AD_ACCOUNTS_LAST_KNOWN_TTL_MS, refresh: true, cacheEmpty: false,
        }).catch(() => {});
      }
      return list;
    }, { ttlMs: AD_ACCOUNTS_TTL_MS });
  } catch (err) {
    const stale = await cached<MetaAdAccount[] | null>("meta:adaccounts:last-known", async () => null, {
      ttlMs: AD_ACCOUNTS_LAST_KNOWN_TTL_MS, cacheEmpty: false,
    }).catch(() => null);
    if (stale && stale.length > 0) {
      console.warn("[meta] /me/adaccounts unavailable, serving last known list:", err instanceof Error ? err.message : err);
      return stale;
    }
    const known = await accountsKnownInDb().catch(() => []);
    if (known.length > 0) {
      console.warn("[meta] /me/adaccounts unavailable, serving accounts known in DB:", err instanceof Error ? err.message : err);
      return known;
    }
    throw err;
  }
}

/** Meta accounts the app already knows (ACL rows + dashboards), named by their label. */
async function accountsKnownInDb(): Promise<MetaAdAccount[]> {
  const [acl, dashboards] = await Promise.all([
    prisma.userAdAccount.findMany({ where: { platform: "meta" }, select: { accountId: true, label: true } }),
    prisma.dashboard.findMany({ where: { metaAccountId: { not: null } }, select: { metaAccountId: true, name: true } }),
  ]);
  const byId = new Map<string, string>();
  for (const d of dashboards) byId.set(norm(d.metaAccountId!), d.name);
  for (const a of acl) if (a.label || !byId.has(norm(a.accountId))) byId.set(norm(a.accountId), a.label ?? byId.get(norm(a.accountId)) ?? "");
  return [...byId].map(([id, name]) => ({ id: `act_${id}`, name: name || `act_${id}`, currency: "" }));
}
