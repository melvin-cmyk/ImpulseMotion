/** GET /api/cron/ads-ai-tags — nightly AI tagging of the creatives delivered recently (see lib/ads-warehouse/ai-tags.ts). `AI_TAGS=off` pauses it. */

import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { runAiTagging } from "@/lib/ads-warehouse/ai-tags";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if ((process.env.AI_TAGS ?? "on").toLowerCase() === "off") return NextResponse.json({ skipped: true, reason: "AI_TAGS=off" });
  try { return NextResponse.json(await runAiTagging({ limit: 120, deadline: Date.now() + 270_000 })); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 }); }
}
