/**
 * POST /api/ads/opportunities — Motion's Opportunities of the selected
 * accounts: detects the new ones over the 14 days ending at range.until, then
 * lists those of the requested status (active | completed | archived) that
 * have not expired. Same body and scope rules as /api/ads/query, plus
 * { status?, refresh? }.
 */

import { NextRequest, NextResponse } from "next/server";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";
import { listOpportunities, refreshOpportunities } from "@/lib/ads-warehouse/opportunities-store";
import type { OpportunityStatus } from "@/lib/ads-warehouse/opportunities";

export const maxDuration = 60;

const STATUSES: OpportunityStatus[] = ["active", "completed", "archived"];

export async function POST(req: NextRequest) {
  const extra = (await req.clone().json().catch(() => ({}))) as { status?: string; refresh?: boolean };
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  const status = STATUSES.includes(extra.status as OpportunityStatus) ? (extra.status as OpportunityStatus) : "active";
  const created = extra.refresh === false ? 0 : await refreshOpportunities(parsed.q);
  const items = await listOpportunities(parsed.q, status);
  return NextResponse.json({ items, created }, { headers: { "Cache-Control": "private, no-store" } });
}
