/** POST /api/ads/daily — day-by-day series of one group ({ ...AdsQuery, key? }). Staff, scoped like /api/ads/query. */

import { NextRequest, NextResponse } from "next/server";
import { queryDaily } from "@/lib/ads-warehouse/query";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const clone = req.clone();
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  const body = (await clone.json().catch(() => ({}))) as { key?: string | null };
  return NextResponse.json({ points: await queryDaily(parsed.q, body.key ?? null) }, { headers: { "Cache-Control": "private, max-age=30" } });
}
