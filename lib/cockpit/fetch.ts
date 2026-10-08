/**
 * Global Cockpit — data access: the accounts the agency can read, and the
 * daily figures of one account over the cockpit window. Everything goes
 * through the KPI cache: a build that is cut by its time budget resumes
 * where it stopped, and the second build of the day reuses closed days.
 */

import { cached } from "@/lib/kpi-cache";
import { relayDirectTool } from "@/lib/relay-tool";
import { costFrom, extractRows } from "@/lib/dashboard-widgets";
import { getAccountDailyInsightsPaged, getActionValue, getMetaSystemToken, type MetaAccountInsight } from "@/lib/meta-api";
import { getAdAccountsCached } from "@/lib/insights";
import { fetchTikTokDaily, listTikTokAdvertisers } from "@/lib/tiktok-data";
import { checkAdvertiser } from "@/lib/tiktok-accounts";
import type { AccountMode } from "@/lib/cockpit/engine";
import type { AvailableAccount } from "@/lib/cockpit/match";
import type { DailyPoint } from "@/lib/cockpit/weeks";

const HOUR = 3600 * 1000;
const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
};

// ── Accounts the agency can read ─────────────────────────────────────────────

export async function listMetaAccounts(): Promise<AvailableAccount[]> {
  const accounts = await getAdAccountsCached(getMetaSystemToken());
  return accounts.map((a) => ({
    platform: "meta" as const,
    accountId: String(a.id ?? "").replace(/^act_/, ""),
    name: a.name || String(a.id ?? ""),
    currency: a.currency ?? null,
    active: true,
  })).filter((a) => a.accountId);
}

type GaqlPage = { results?: Array<{ customerClient?: { id?: string; descriptiveName?: string; currencyCode?: string; manager?: boolean; status?: string } }> };

/**
 * Top-level customers the agency login lists but cannot read (a manager
 * account shared without access): querying them only fills the relay log
 * with « The caller does not have permission ». Comma-separated ids.
 * 6928213043 = seen refused at every cockpit run since 2026-10-02.
 */
const GOOGLE_UNREADABLE_TOPS = new Set((process.env.GOOGLE_UNREADABLE_CUSTOMERS ?? "6928213043").split(",").map((s) => s.trim()).filter(Boolean));

export async function listGoogleAccounts(): Promise<AvailableAccount[]> {
  return cached("cockpit:google-accounts", async () => {
    const list = await relayDirectTool("mcp-google-ads.List_Customers", {}, 30_000);
    const names = (Array.isArray(list) ? list : [list]).flatMap((l) => ((l as { resourceNames?: string[] })?.resourceNames ?? []));
    const out = new Map<string, AvailableAccount>();
    for (const top of names.map((r) => r.replace(/^customers\//, "")).filter((id) => id && !GOOGLE_UNREADABLE_TOPS.has(id))) {
      try {
        const raw = await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", {
          customer_id: top,
          gaql_query: "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status FROM customer_client",
        }, 40_000);
        for (const page of (Array.isArray(raw) ? raw : [raw]) as GaqlPage[]) {
          for (const row of page?.results ?? []) {
            const c = row.customerClient;
            if (!c?.id || c.manager) continue;
            out.set(String(c.id), {
              platform: "google",
              accountId: String(c.id),
              name: c.descriptiveName || String(c.id),
              currency: c.currencyCode ?? null,
              active: !c.status || c.status === "ENABLED",
            });
          }
        }
      } catch {
        // a manager account the agency cannot read: the others still count
      }
    }
    return [...out.values()];
  }, { ttlMs: 6 * HOUR, cacheEmpty: false });
}

/**
 * TikTok accounts of the agency (every Business Center its token reads). The
 * listing carries no currency: it is read per account when its figures are
 * (tiktokCurrency).
 */
export async function listTikTokAccounts(): Promise<AvailableAccount<"tiktok">[]> {
  const advertisers = await listTikTokAdvertisers();
  return advertisers.map((a) => ({ platform: "tiktok" as const, accountId: a.id, name: a.name, currency: null, active: true }));
}

/** Currency of a TikTok account (get_advertiser_info), cached a week; null when TikTok does not answer. */
export async function tiktokCurrency(advertiserId: string): Promise<string | null> {
  try {
    const ccy = await cached(`cockpit:tiktok:currency:${advertiserId}`, async () => {
      const check = await checkAdvertiser(advertiserId);
      // A failed check throws so that nothing is cached: the next build asks again.
      if (!check.ok) throw new Error(check.error);
      return check.advertiser.currency ?? "";
    }, { ttlMs: 7 * 24 * HOUR, cacheEmpty: false });
    return ccy || null;
  } catch {
    return null;
  }
}

// ── Daily figures of one account ─────────────────────────────────────────────

/** Meta action types read as « the conversion » of a CPA account, most specific first. */
const LEAD_TYPES = [
  "lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead",
  "complete_registration", "offsite_conversion.fb_pixel_complete_registration",
  "start_trial", "subscribe", "omni_purchase", "purchase",
];
const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];

/** First action type of `candidates` that counted anything over the window. */
export function pickConversionType(rows: Array<Pick<MetaAccountInsight, "actions">>, candidates: string[]): string | null {
  for (const type of candidates) {
    if (rows.some((r) => getActionValue(r.actions, type) > 0)) return type;
  }
  return null;
}

export interface AccountSeries {
  days: DailyPoint[];
  currency: string | null;
  /** what was counted as a conversion (Meta action type, or « conversions » for Google) */
  convEvent: string | null;
}

export async function metaSeries(
  accountId: string,
  range: { since: string; until: string },
  opts: { mode: AccountMode; conversionEvent?: string | null; refresh?: boolean },
): Promise<AccountSeries> {
  const paged = await cached(
    `cockpit:meta:daily:${accountId}:${range.since}_${range.until}`,
    () => getAccountDailyInsightsPaged(getMetaSystemToken(), `act_${accountId}`, range),
    { ttlMs: 6 * HOUR, refresh: opts.refresh },
  );
  const rows = paged.data;
  // The account's own setting wins when an admin chose one; otherwise the
  // model decides: purchases for a ROAS account, the lead-type event that
  // actually fires for a CPA account.
  const custom = opts.conversionEvent?.startsWith("custom:") ? opts.conversionEvent.slice(7).trim() : null;
  const explicit = custom || (opts.conversionEvent && opts.conversionEvent !== "purchase" ? opts.conversionEvent : null);
  const type = explicit
    ? pickConversionType(rows, explicit === "lead" ? LEAD_TYPES.slice(0, 3) : explicit === "complete_registration" ? LEAD_TYPES.slice(3, 5) : [explicit]) ?? explicit
    : pickConversionType(rows, opts.mode === "roas" ? PURCHASE_TYPES : LEAD_TYPES);

  const days = rows.map((r) => {
    let value = 0;
    for (const t of PURCHASE_TYPES) {
      value = getActionValue(r.action_values, t);
      if (value > 0) break;
    }
    return {
      date: r.date_start,
      spend: num(r.spend),
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      conv: type ? getActionValue(r.actions, type) : 0,
      value,
    };
  });
  return { days, currency: rows.find((r) => r.currency)?.currency ?? null, convEvent: type };
}

export async function googleSeries(
  customerId: string,
  range: { since: string; until: string },
  opts: { refresh?: boolean } = {},
): Promise<AccountSeries> {
  const query = `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM customer WHERE segments.date BETWEEN '${range.since}' AND '${range.until}' ORDER BY segments.date`;
  const rows = await cached(
    `cockpit:google:daily:${customerId}:${range.since}_${range.until}`,
    async () => extractRows(await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", { customer_id: customerId, gaql_query: query }, 40_000)),
    { ttlMs: 6 * HOUR, refresh: opts.refresh },
  );
  const days = rows.map((row) => {
    const m = ((row.metrics as Record<string, unknown>) ?? row) as Record<string, unknown>;
    const seg = ((row.segments as Record<string, unknown>) ?? row) as Record<string, unknown>;
    return {
      date: String(seg.date ?? ""),
      spend: costFrom(m),
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      conv: num(m.conversions),
      value: num(m.conversionsValue ?? m.conversions_value),
    };
  }).filter((d) => d.date);
  return { days, currency: null, convEvent: "conversions" };
}

/**
 * TikTok: the value is `total_purchase_value`. Read in ROAS, the conversion is
 * the purchase (TikTok's optimisation event when no purchase is counted); in
 * CPA, the optimisation event of the campaigns. Without a model, an account
 * that tracks a purchase value is read in ROAS — as for Google.
 */
export async function tiktokSeries(
  advertiserId: string,
  range: { since: string; until: string },
  opts: { mode: AccountMode | null; refresh?: boolean },
): Promise<AccountSeries & { mode: AccountMode }> {
  const [rows, currency] = await Promise.all([
    cached(
      `cockpit:tiktok:daily:${advertiserId}:${range.since}_${range.until}`,
      () => fetchTikTokDaily(advertiserId, range.since, range.until),
      { ttlMs: 6 * HOUR, refresh: opts.refresh },
    ),
    tiktokCurrency(advertiserId),
  ]);
  const mode = opts.mode ?? (rows.some((r) => r.purchaseValue > 0) ? "roas" : "cpa");
  const byPurchase = mode === "roas" && rows.some((r) => r.purchases > 0);
  const days = rows.map((r) => ({
    date: r.date,
    spend: r.spend,
    impressions: r.impressions,
    clicks: r.clicks,
    conv: byPurchase ? r.purchases : r.conversions,
    value: r.purchaseValue,
  }));
  return { days, currency, convEvent: byPurchase ? "total_purchase" : "conversion", mode };
}
