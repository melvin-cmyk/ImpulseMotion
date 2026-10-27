/**
 * POST /api/ads/query — Analyse Ads v2 (creative warehouse). Body = AdsQuery
 * ({ platforms?, accounts|accountIds, range, compare?, groupBy?, filters?,
 * sort?, limit?, offset? }). Staff only; the accounts are intersected with the
 * viewer's scope (lib/ads-warehouse/api.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { queryAds, tagKeys } from "@/lib/ads-warehouse/query";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  const [result, keys] = await Promise.all([queryAds(parsed.q), tagKeys(parsed.q.platforms, parsed.q.accountIds)]);
  return NextResponse.json({ ...result, tagKeys: keys }, { headers: { "Cache-Control": "private, max-age=30" } });
}
