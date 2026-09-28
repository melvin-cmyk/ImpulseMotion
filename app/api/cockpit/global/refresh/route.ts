/**
 * POST /api/cockpit/global/refresh — rebuilds the Global Cockpit now (admin).
 * `?fresh=1` also drops the cached figures of every account.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { runCockpitBuild } from "@/lib/cockpit/build";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  try {
    const result = await runCockpitBuild({
      deadline: Date.now() + 240_000,
      refresh: req.nextUrl.searchParams.get("fresh") === "1",
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
