/**
 * GET /api/studio/quota → the price reminder of the generators (staff):
 *   { quotas, today: { team: { usd, images }, user: { usd, images } } }
 */

import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { readQuotas, spentToday } from "@/lib/quotas";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const [quotas, today] = await Promise.all([readQuotas(), spentToday(guard.session.userId)]);
  return NextResponse.json({ quotas, today }, { headers: { "Cache-Control": "no-store" } });
}
