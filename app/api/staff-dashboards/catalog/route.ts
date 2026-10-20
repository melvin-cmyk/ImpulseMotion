/**
 * GET /api/staff-dashboards/catalog → { metrics, dimensions, reference }
 * The team's catalogue of metrics and dimensions (staff only), plus the static
 * reference of the platforms' fields. Writes: ./metrics and ./dimensions.
 */

import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { FIELD_REFERENCE, loadStaffCatalog } from "@/lib/staff-dashboards/catalog";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const catalog = await loadStaffCatalog();
  return NextResponse.json({ ...catalog, reference: FIELD_REFERENCE }, { headers: { "Cache-Control": "no-store" } });
}
