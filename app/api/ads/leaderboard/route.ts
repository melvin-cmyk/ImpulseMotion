/**
 * POST /api/ads/leaderboard — Motion's Leaderboard for the week ending at
 * `range.until` (lib/ads-warehouse/leaderboard.ts). Same body and scope rules
 * as /api/ads/query; `range.since` is ignored.
 */

import { NextRequest, NextResponse } from "next/server";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";
import { queryLeaderboard } from "@/lib/ads-warehouse/leaderboard";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  const result = await queryLeaderboard(parsed.q);
  return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=60" } });
}
