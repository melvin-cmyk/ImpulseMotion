/**
 * GET /api/portfolio?since&until&refresh=1 → staff: every client (deduped by
 * ad account) with KPIs vs previous period, alerts, pacing, last report and
 * an attention score. Default window: last 30 full days (account timezone).
 * Partial results (summary.timedOut) when the 100 s time budget is hit.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { loadPortfolio } from "@/lib/portfolio";
import { validateRange, type DateRange } from "@/lib/date-ranges";

export const maxDuration = 120;
const TIME_BUDGET_MS = 100_000;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const params = req.nextUrl.searchParams;
  let range: DateRange | null = null;
  if (params.get("since") || params.get("until")) {
    const v = validateRange(params.get("since"), params.get("until"));
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    range = v.range;
  }
  const refresh = params.get("refresh") === "1";

  const result = await loadPortfolio({ range, refresh, deadlineMs: TIME_BUDGET_MS });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
