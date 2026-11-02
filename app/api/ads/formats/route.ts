/**
 * POST /api/ads/formats — « Formats visuels » (Motion's visual format
 * analysis). Body = /api/ads/query body + { action?: "list" | "tag" }.
 * tag: AI-tags the client's untagged creatives of the last 30 days (up to 40,
 * ≈ 2–4 min), then returns the analysis. Staff only, accounts in scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";
import { listFormats } from "@/lib/ads-warehouse/formats";
import { runAiTagging } from "@/lib/ads-warehouse/ai-tags";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const extra = (await req.clone().json().catch(() => ({}))) as { action?: string };
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  let tagged: number | undefined;
  if (extra.action === "tag" && parsed.q.accountIds.length) {
    const r = await runAiTagging({ limit: 40, accountIds: parsed.q.accountIds, deadline: Date.now() + 240_000 });
    tagged = r.tagged;
  }
  return NextResponse.json({ ...(await listFormats(parsed.q)), justTagged: tagged }, { headers: { "Cache-Control": "private, no-store" } });
}
