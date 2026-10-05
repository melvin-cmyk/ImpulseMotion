/**
 * Pilotage assistant — the client's accounts as the AI reads them: structure
 * (lib/pilot/adapters.ts, read now) and, for the campaigns, the last 7 full
 * days against the 7 before (the same figures as the alerts). Never throws: an
 * account that cannot be read carries its error, and the conversation goes on.
 */

import { pilotAdapter } from "@/lib/pilot/adapters";
import { fetchEntityMetrics } from "@/lib/alert-entities";
import { fetchGoogleEntityMetrics } from "@/lib/alert-google";
import type { ComputedMetrics } from "@/lib/alerts";
import type { ContextAccount, ContextMetrics, ContextObject } from "@/lib/pilot/assistant";
import type { StructureRow } from "@/lib/pilot/meta";
import type { PilotPlatform } from "@/lib/pilot/ops";

const READ_TIMEOUT_MS = 45_000;

const metrics = (m: ComputedMetrics | undefined | null): ContextMetrics | null =>
  m ? { spend: m.spend, conversions: m.conversions, cpa: m.cpa, roas: m.roas, roasAvailable: m.roasAvailable } : null;

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("délai dépassé")), ms))]);
}

function toObject(r: StructureRow, perf?: { current: ComputedMetrics; previous: ComputedMetrics }): ContextObject {
  return {
    id: r.id, name: r.name, status: r.status, effectiveStatus: r.effectiveStatus,
    dailyBudget: r.dailyBudget, lifetimeBudget: r.lifetimeBudget, bidAmount: r.bidAmount, bidStrategy: r.bidStrategy,
    budgetLock: r.budgetLock ?? null, parentId: r.parentId, spend7d: r.spend7d,
    last7: metrics(perf?.current), prev7: metrics(perf?.previous),
  };
}

export async function readContextAccount(
  account: { platform: PilotPlatform; accountId: string; name: string },
): Promise<ContextAccount> {
  const adapter = pilotAdapter(account.platform)!;
  const key = adapter.accountKey(account.accountId) ?? account.accountId;
  const base = { platform: account.platform, accountId: key, name: account.name || key, writesOpen: adapter.writesOpen() };
  try {
    const [currency, perf] = await within(Promise.all([
      adapter.readCurrency(key),
      // Results are a plus: an account whose figures cannot be read is still shown with its structure.
      (account.platform === "meta" ? fetchEntityMetrics(key, "campaign", "7d") : fetchGoogleEntityMetrics(key, "campaign", "7d"))
        .then((r) => r.entities)
        .catch((e) => { console.error("[pilot-ai] figures unreadable", account.platform, key, e); return []; }),
    ]), READ_TIMEOUT_MS);
    const structure = await within(adapter.readStructure(key, currency), READ_TIMEOUT_MS);
    const byId = new Map(perf.map((e) => [e.id, e]));
    return {
      ...base, currency, error: null,
      campaigns: structure.campaigns.map((c) => toObject(c, byId.get(c.id))),
      adsets: structure.adsets.map((s) => toObject(s)),
    };
  } catch (e) {
    console.error("[pilot-ai] account unreadable", account.platform, key, e);
    return { ...base, currency: null, error: `${adapter.name} ne répond pas pour le moment`, campaigns: [], adsets: [] };
  }
}

/**
 * The same account read again within CONTEXT_TTL_MS is served from memory:
 * a conversation of several turns does not read the platforms (and their
 * call limits) at every message, and the context sent to the relay stays the
 * same between close turns. An unreadable account is never kept.
 */
const CONTEXT_TTL_MS = 90_000;
const contextCache = new Map<string, { at: number; value: Promise<ContextAccount> }>();

export function cachedContextAccount(account: { platform: PilotPlatform; accountId: string; name: string }, now: number = Date.now()): Promise<ContextAccount> {
  const key = `${account.platform}:${account.accountId}`;
  const hit = contextCache.get(key);
  if (hit && now - hit.at < CONTEXT_TTL_MS) return hit.value;
  for (const [k, v] of contextCache) if (now - v.at >= CONTEXT_TTL_MS) contextCache.delete(k);
  const value = readContextAccount(account).then((r) => {
    if (r.error) contextCache.delete(key);
    return r;
  });
  contextCache.set(key, { at: now, value });
  return value;
}
