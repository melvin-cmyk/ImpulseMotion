/**
 * Automatic alerting — Meta Ads reads. Four small Graph calls per account and
 * per run (account, daily series, ad daily series, recent rejections), plus one
 * status lookup only when some ads stopped. Each group fails on its own: a
 * group that could not be read is simply not part of `evaluated`, so its open
 * incidents are neither confirmed nor closed.
 */

import { getMetaSystemToken, metaGraphGet, getAccountDailyInsights, purchasesFor, computeRevenue } from "@/lib/meta-api";
import { MetaApiError } from "@/lib/meta-errors";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { findBudgetForMetaAccount, computePacing, monthProgress } from "@/lib/budgets";
import { addDays, todayIn } from "@/lib/date-ranges";
import {
  accessLost, classifyStoppedAds, detectBlockedAds, detectFromAccount, detectFromDays, detectFromPacing, fillDays, findStoppedAds, heavyAds,
  type AdStatus, type DayPoint, type Finding, type Scope,
} from "@/lib/auto-alerts/detect";

export interface ScanResult {
  findings: Finding[];
  evaluated: Set<Scope>;
  errors: string[];
  currency: string;
  /** Daily spend, oldest first — the only raw data the AI ever sees. */
  series: DayPoint[];
}

const FULL_DAYS = 10;
const act = (id: string) => (id.startsWith("act_") ? id : `act_${id}`);
const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? ""))) || 0;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Hour of day (0–23.99) in the account timezone. */
export function hourIn(tz: string | null, now: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz ?? "UTC", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isFinite(h) && Number.isFinite(m)) return (h % 24) + m / 60;
  } catch { /* UTC below */ }
  return now.getUTCHours() + now.getUTCMinutes() / 60;
}

interface RawAd {
  id: string;
  name?: string;
  effective_status?: string;
  issues_info?: Array<{ error_summary?: string; error_message?: string }>;
  ad_review_feedback?: { global?: Record<string, string> };
  adset?: { name?: string; end_time?: string };
  campaign?: { name?: string; stop_time?: string };
}

const AD_FIELDS = "id,name,effective_status,issues_info,ad_review_feedback,adset{name,end_time},campaign{name,stop_time}";

export function toAdStatus(a: RawAd): AdStatus {
  const issue = a.issues_info?.[0]?.error_summary || a.issues_info?.[0]?.error_message || Object.keys(a.ad_review_feedback?.global ?? {})[0] || null;
  return {
    id: a.id,
    name: a.name ?? a.id,
    effectiveStatus: a.effective_status ?? "UNKNOWN",
    adsetName: a.adset?.name ?? null,
    campaignName: a.campaign?.name ?? null,
    adsetEndTime: a.adset?.end_time ?? null,
    campaignStopTime: a.campaign?.stop_time ?? null,
    issue: issue ? String(issue).slice(0, 200) : null,
  };
}

export async function scanMetaAccount(accountId: string, now: Date = new Date(), rates: Record<string, number> = {}): Promise<ScanResult> {
  const token = getMetaSystemToken();
  const settings = await getAccountProfileSettings("meta", accountId);
  const currency = settings.currency ?? "EUR";
  const tz = settings.timezone;
  const today = todayIn(tz, now);
  const range = { since: addDays(today, -FULL_DAYS), until: today };
  const out: ScanResult = { findings: [], evaluated: new Set(), errors: [], currency, series: [] };

  // ── Account status, billing, spend cap ────────────────────────────────────
  const account = (async () => {
    const a = await metaGraphGet<{ account_status?: number; disable_reason?: number; spend_cap?: string; amount_spent?: string }>(
      `/${act(accountId)}`, token, { fields: "account_status,disable_reason,spend_cap,amount_spent" },
    );
    out.findings.push(...detectFromAccount({
      accountStatus: typeof a.account_status === "number" ? a.account_status : null,
      disableReason: typeof a.disable_reason === "number" ? a.disable_reason : null,
      spendCap: a.spend_cap ? num(a.spend_cap) : null,
      amountSpent: a.amount_spent !== undefined ? num(a.amount_spent) : null,
    }, currency));
    out.evaluated.add("meta:account");
  })().catch((e) => {
    out.errors.push(`meta compte : ${msg(e)}`);
    // Only a refusal on THIS account: a dead token would raise it for every client.
    if (e instanceof MetaApiError && e.kind === "permission") {
      out.findings.push(accessLost());
      out.evaluated.add("meta:account");
    }
  });

  // ── Daily series, then the ads behind it ──────────────────────────────────
  const days = (async () => {
    const rows = await getAccountDailyInsights(token, accountId, range);
    const points = fillDays(rows.map((r): DayPoint => {
      const rev = computeRevenue(r, settings.aov, settings.conversionEvent);
      return { date: r.date_start ?? "", spend: num(r.spend), conversions: purchasesFor(r, settings.conversionEvent), revenue: rev.unavailable ? null : rev.revenue };
    }), range.since, today);
    const full = points.slice(0, -1);
    const todayPoint = points[points.length - 1];
    out.series = full;
    let found = detectFromDays({ platform: "meta", full, today: { spend: todayPoint.spend, hour: hourIn(tz, now) }, currency, eurRate: rates[currency] });

    // A stop is only worth a message if something is still supposed to run.
    if (found.some((f) => f.kind === "spend_stopped")) {
      const active = await metaGraphGet<{ data?: unknown[] }>(`/${act(accountId)}/ads`, token, { fields: "id", effective_status: JSON.stringify(["ACTIVE"]), limit: "1" });
      if (!active.data?.length) found = found.filter((f) => f.kind !== "spend_stopped");
    }
    out.findings.push(...found);
    out.evaluated.add("meta:days");
    return full;
  })().catch((e) => { out.errors.push(`meta jours : ${msg(e)}`); return null; });

  const ads = (async () => {
    const full = await days;
    if (!full) return;
    // Two light reads instead of every ad × every day: the 20 biggest ads of
    // the 7 days before yesterday, then what those spent yesterday.
    const yesterday = addDays(today, -1);
    const adRows = (timeRange: { since: string; until: string }, extra: Record<string, string>) =>
      metaGraphGet<{ data?: Array<{ ad_id?: string; spend?: string }> }>(`/${act(accountId)}/insights`, token, {
        level: "ad", fields: "ad_id,spend", time_range: JSON.stringify(timeRange), ...extra,
      });
    const base = await adRows({ since: addDays(yesterday, -7), until: addDays(yesterday, -1) }, { sort: JSON.stringify(["spend_descending"]), limit: "50" });
    const heavy = heavyAds((base.data ?? []).map((r) => ({ adId: String(r.ad_id ?? ""), spend: num(r.spend) })), full);
    let cands: ReturnType<typeof findStoppedAds> = [];
    if (heavy.length) {
      const y = await adRows({ since: yesterday, until: yesterday }, {
        limit: "50", filtering: JSON.stringify([{ field: "ad.id", operator: "IN", value: heavy.map((h) => h.adId) }]),
      });
      cands = findStoppedAds(heavy, new Set((y.data ?? []).filter((r) => num(r.spend) > 0).map((r) => String(r.ad_id ?? ""))));
    }
    const keyed = new Set<string>();
    if (cands.length) {
      const byId = await metaGraphGet<Record<string, RawAd>>("/", token, { ids: cands.map((c) => c.adId).join(","), fields: AD_FIELDS });
      const stopped = classifyStoppedAds(cands, Object.values(byId ?? {}).map(toAdStatus), currency, now);
      for (const f of stopped) keyed.add(f.key);
      out.findings.push(...stopped);
    }
    // Rejections of the last 3 days, including ads that never delivered.
    const since = Math.floor(now.getTime() / 1000) - 3 * 86_400;
    const recent = await metaGraphGet<{ data?: RawAd[] }>(`/${act(accountId)}/ads`, token, {
      fields: AD_FIELDS, limit: "25",
      filtering: JSON.stringify([
        { field: "effective_status", operator: "IN", value: ["DISAPPROVED", "WITH_ISSUES"] },
        { field: "updated_time", operator: "GREATER_THAN", value: since },
      ]),
    });
    out.findings.push(...detectBlockedAds((recent.data ?? []).map(toAdStatus), keyed));
    out.evaluated.add("meta:ads");
  })().catch((e) => { out.errors.push(`meta créas : ${msg(e)}`); });

  // ── Budget pacing (only when a budget is set for the client) ──────────────
  const pacing = (async () => {
    const budget = await findBudgetForMetaAccount(accountId, currency);
    if (!budget) { out.evaluated.add("meta:pacing"); return; }
    const p = await computePacing(accountId, budget.monthlyTarget, budget.currency, { tz, now, source: budget.source });
    if (p.status === "unknown") return;
    const progress = monthProgress({ tz, now });
    out.findings.push(...detectFromPacing({
      status: p.status, pacingPct: p.pacingPct, projectedSpend: p.projectedSpend, monthlyTarget: p.monthlyTarget,
      currency: p.currency, fullDays: progress.fullDays, daysInMonth: progress.daysInMonth, month: today.slice(0, 7),
    }));
    out.evaluated.add("meta:pacing");
  })().catch((e) => { out.errors.push(`meta budget : ${msg(e)}`); });

  await Promise.all([account, days, ads, pacing]);
  return out;
}
