/**
 * GET /api/cockpit/global — the Global Cockpit as the caller may see it
 * (staff only): latest snapshot, evolution over the previous builds, and the
 * team's follow-up per client. `?period=day|week|month` picks the reading
 * (the week by default). Reads the stored snapshot, computes nothing.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { loadCockpitView } from "@/lib/cockpit/view";

const PERIODS = new Set(["day", "week", "month"]);

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const scope = await getAccountScope(guard.session);
  const asked = req.nextUrl.searchParams.get("period") ?? "week";
  const view = await loadCockpitView(scope, PERIODS.has(asked) ? (asked as "day" | "week" | "month") : "week");
  return NextResponse.json({ ...view, canEdit: guard.session.role === "admin" }, { headers: { "Cache-Control": "no-store" } });
}
