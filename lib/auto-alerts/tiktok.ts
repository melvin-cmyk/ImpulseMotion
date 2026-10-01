/**
 * Automatic alerting — TikTok Ads reads: one daily report per account and per
 * run (lib/tiktok-data.ts, through the relay's direct call), nothing else.
 *
 * Only the clean breaks are looked for: spend stopped, sharp drop, spike, and
 * conversions at zero on an account that usually converts. No account status
 * nor billing (TikTok gives neither in a report), no drift.
 *
 * Unlike Google, a stop cannot be told from campaigns paused on purpose: the
 * relay does not open the campaign list to direct calls. The detector already
 * asks for a big enough account that spent the same weekday one week before.
 */

import { fetchTikTokDaily, type TikTokDailyRow } from "@/lib/tiktok-data";
import { addDays, todayIn } from "@/lib/date-ranges";
import { detectFromDays, fillDays, type DayPoint, type FindingKind } from "@/lib/auto-alerts/detect";
import { hourIn, type ScanResult } from "@/lib/auto-alerts/meta";

const FULL_DAYS = 10;
/** Account timezone not stored with the client: the agency's, as for Google. */
const TZ = "Europe/Paris";
const CLEAN_BREAKS = new Set<FindingKind>(["spend_stopped", "spend_drop", "spend_spike", "conversions_zero"]);

export function tiktokDayPoint(row: TikTokDailyRow): DayPoint {
  return { date: row.date, spend: row.spend, conversions: row.conversions, revenue: row.purchaseValue > 0 ? row.purchaseValue : null };
}

export async function scanTikTokAccount(advertiserId: string, currency: string, now: Date = new Date(), rates: Record<string, number> = {}): Promise<ScanResult> {
  const out: ScanResult = { findings: [], evaluated: new Set(), errors: [], currency, series: [] };
  const today = todayIn(TZ, now);
  const since = addDays(today, -FULL_DAYS);
  try {
    const raw = (await fetchTikTokDaily(advertiserId, since, today)).map(tiktokDayPoint);
    // TikTok leaves out the days without activity: they are days at 0.
    const tracksValue = raw.some((d) => d.revenue !== null);
    const points = fillDays(raw, since, today).map((d) => ({ ...d, revenue: tracksValue ? d.revenue ?? 0 : null }));
    const full = points.slice(0, -1);
    const todayPoint = points[points.length - 1];
    out.series = full;
    const found = detectFromDays({ platform: "tiktok", full, today: { spend: todayPoint.spend, hour: hourIn(TZ, now) }, currency, eurRate: rates[currency] });
    out.findings.push(...found.filter((f) => CLEAN_BREAKS.has(f.kind)));
    out.evaluated.add("tiktok:days");
  } catch (e) {
    out.errors.push(`tiktok jours : ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}
