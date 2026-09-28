/**
 * Automatic alerting — Google Ads reads: one GAQL query for the daily series
 * (same relay path as the dashboards), a second one only when delivery
 * stopped, to tell a real stop from campaigns paused on purpose.
 */

import { relayDirectTool } from "@/lib/relay-tool";
import { costFrom, extractRows } from "@/lib/dashboard-widgets";
import { addDays, todayIn } from "@/lib/date-ranges";
import { detectFromDays, fillDays, type DayPoint } from "@/lib/auto-alerts/detect";
import { hourIn, type ScanResult } from "@/lib/auto-alerts/meta";

const FULL_DAYS = 10;
const TZ = "Europe/Paris";
const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? ""))) || 0;

async function gaql(customerId: string, query: string): Promise<Array<Record<string, unknown>>> {
  return extractRows(await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", { input: JSON.stringify({ customer_id: customerId, gaql_query: query.replace(/\s+/g, " ") }) }, 25_000));
}

export function toDayPoint(row: Record<string, unknown>): DayPoint {
  const m = (row.metrics as Record<string, unknown>) ?? {};
  const s = (row.segments as Record<string, unknown>) ?? {};
  const value = num(m.conversionsValue ?? m.conversions_value);
  return { date: String(s.date ?? ""), spend: costFrom(m), conversions: num(m.conversions), revenue: value > 0 ? value : null };
}

export async function scanGoogleAccount(customerId: string, currency: string, now: Date = new Date(), rates: Record<string, number> = {}): Promise<ScanResult> {
  const out: ScanResult = { findings: [], evaluated: new Set(), errors: [], currency, series: [] };
  const today = todayIn(TZ, now);
  const since = addDays(today, -FULL_DAYS);
  try {
    const rows = await gaql(customerId, `SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM customer WHERE segments.date BETWEEN '${since}' AND '${today}'`);
    const raw = rows.map(toDayPoint);
    // A day without value is a day at 0, not an account without conversion value.
    const tracksValue = raw.some((d) => d.revenue !== null);
    const points = fillDays(raw, since, today).map((d) => ({ ...d, revenue: tracksValue ? d.revenue ?? 0 : null }));
    const full = points.slice(0, -1);
    const todayPoint = points[points.length - 1];
    out.series = full;
    let found = detectFromDays({ platform: "google", full, today: { spend: todayPoint.spend, hour: hourIn(TZ, now) }, currency, eurRate: rates[currency] });
    if (found.some((f) => f.kind === "spend_stopped")) {
      const enabled = await gaql(customerId, "SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED' LIMIT 1");
      if (!enabled.length) found = found.filter((f) => f.kind !== "spend_stopped");
    }
    out.findings.push(...found);
    out.evaluated.add("google:days");
  } catch (e) {
    out.errors.push(`google jours : ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}
