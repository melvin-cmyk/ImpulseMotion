/**
 * POST /api/ads/organic — organic Facebook posts of the client's Pages (90 days).
 * Same body and scope rules as /api/ads/query. Staff only.
 */

import { NextRequest, NextResponse } from "next/server";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";
import { requireStaff } from "@/lib/auth-helpers";
import { readOrganic } from "@/lib/ads-warehouse/organic";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  try {
    return NextResponse.json(await readOrganic(parsed.q), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Lecture impossible" }, { status: 502 });
  }
}
