/**
 * GET /api/meta/wow?accountId=…[&since&until]
 *
 * Week-over-week on the SAME data as /api/meta/creatives (lib/creatives-server
 * light rows: same conversion event, same AOV / revenue policy):
 *   - current  = the 7 full days ending at `until` (yesterday when omitted or
 *     when `until` touches today in the account timezone) — never a partial day
 *   - previous = prevRange(current): the 7 days right before, same length
 * Account totals use aggregate() (Σ then ratio, never average of ratios).
 * Returns per-ad % changes plus the account-level summary.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { assertAccountAllowed } from "@/lib/acl";
import { loadCreativeRows } from "@/lib/creatives-server";
import { aggregate } from "@/lib/creative-stats";
import { addDays, lastFullDays, prevRange, validateRange, yesterdayIn, type DateRange } from "@/lib/date-ranges";
import { getAccountProfileSettings } from "@/lib/account-settings";
import type { WowMetrics } from "@/lib/creative-types";

export const maxDuration = 120;

const WINDOW_DAYS = 7;

function pctChange(current: number | null, prev: number | null): number | null {
  if (current === null || prev === null || !Number.isFinite(current) || !Number.isFinite(prev) || prev === 0) return null;
  return Math.round(((current - prev) / prev) * 1000) / 10;
}

const nz = (v: number | null): number | null => (v !== null && v > 0 ? v : null);

export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("accountId");
  if (!accountId) return NextResponse.json({ error: "accountId is required" }, { status: 400 });

  if (guard.session.role !== "admin") {
    const allowed = await assertAccountAllowed(guard.session.userId, "meta", accountId);
    if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const settings = await getAccountProfileSettings("meta", accountId);
  const tz = settings.timezone;
  const yesterday = yesterdayIn({ tz });

  let current: DateRange = lastFullDays(WINDOW_DAYS, { tz });
  const since = searchParams.get("since");
  const until = searchParams.get("until");
  if (since || until) {
    const v = validateRange(since ?? until, until ?? since);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    const end = v.range.until > yesterday ? yesterday : v.range.until;
    current = { since: addDays(end, -(WINDOW_DAYS - 1)), until: end };
  }
  const previous = prevRange(current);
  const refresh = searchParams.get("refresh") === "1";

  try {
    const [cur, prev] = await Promise.all([
      loadCreativeRows(accountId, current, refresh),
      loadCreativeRows(accountId, previous, refresh),
    ]);

    const prevById = new Map(prev.creatives.map((c) => [c.id, c]));
    const wowByAdId: Record<string, WowMetrics> = {};
    for (const c of cur.creatives) {
      const p = prevById.get(c.id);
      if (!p) {
        wowByAdId[c.id] = { spendChange: null, ctrChange: null, cpaChange: null, roasChange: null, hookRateChange: null };
        continue;
      }
      wowByAdId[c.id] = {
        spendChange: pctChange(c.spend, p.spend),
        ctrChange: pctChange(c.ctr, p.ctr),
        cpaChange: pctChange(nz(c.cpa), nz(p.cpa)),
        roasChange: pctChange(c.roasUnavailable ? null : c.roas, p.roasUnavailable ? null : p.roas),
        hookRateChange: c.format === "Video" ? pctChange(nz(c.hookRate), nz(p.hookRate)) : null,
      };
    }

    const a = aggregate(cur.creatives);
    const b = aggregate(prev.creatives);
    const cpm = (s: typeof a) => (s.impressions > 0 ? Math.round((s.spend / s.impressions) * 1000 * 100) / 100 : null);

    const aggregateWow: WowMetrics = {
      spendChange: pctChange(a.spend, b.spend),
      ctrChange: pctChange(a.ctr, b.ctr),
      cpaChange: pctChange(a.cpa, b.cpa),
      roasChange: a.unavailable || b.unavailable ? null : pctChange(a.roas, b.roas),
      hookRateChange: pctChange(a.hookRate, b.hookRate),
    };

    const summary = (s: typeof a) => ({
      spend: s.spend,
      impressions: s.impressions,
      clicks: s.clicks,
      conversions: s.conversions,
      cpa: s.cpa,
      ctr: s.ctr,
      cpm: cpm(s),
      roas: s.unavailable ? null : s.roas,
      roasEstimated: s.estimated,
      hookRate: s.hookRate,
      adCount: s.count,
    });

    return NextResponse.json({
      wowByAdId,
      aggregateWow,
      currentPeriod: current,
      prevPeriod: previous,
      current: summary(a),
      previous: summary(b),
      // Legacy aliases (WoWBanner)
      currentRange: current,
      previousRange: previous,
      meta: {
        currency: cur.meta.currency,
        timezone: tz,
        conversionEvent: cur.meta.conversionEvent,
        fetchedAt: cur.meta.fetchedAt,
        truncated: cur.meta.truncated || prev.meta.truncated,
        accountTotals: { current: cur.meta.accountTotals, previous: prev.meta.accountTotals },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[wow route] unhandled error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
