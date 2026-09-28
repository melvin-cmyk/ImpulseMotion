/**
 * GET /api/cockpit/global — the Global Cockpit as the caller may see it
 * (staff only): latest snapshot, evolution over the previous builds, and the
 * team's follow-up per client. Reads the stored snapshot, computes nothing.
 */

import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { loadCockpitView } from "@/lib/cockpit/view";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const scope = await getAccountScope(guard.session);
  const view = await loadCockpitView(scope);
  return NextResponse.json({ ...view, canEdit: guard.session.role === "admin" }, { headers: { "Cache-Control": "no-store" } });
}
