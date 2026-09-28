/**
 * GET /api/cron/cockpit — scheduled build of the Global Cockpit (twice a day,
 * see vercel.json). `?retry=1` is the follow-up run: it only builds when the
 * latest snapshot is partial or missing, so an interrupted build is completed
 * a few minutes later with the help of the cache.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runCockpitBuild } from "@/lib/cockpit/build";

export const maxDuration = 300;

const FRESH_MS = 3 * 3600 * 1000;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (req.nextUrl.searchParams.get("retry") === "1") {
    const latest = await prisma.cockpitSnapshot.findFirst({ orderBy: { createdAt: "desc" }, select: { status: true, createdAt: true } });
    if (latest && latest.status === "full" && Date.now() - latest.createdAt.getTime() < FRESH_MS) {
      return NextResponse.json({ skipped: true, reason: "dernier instantané complet et récent" });
    }
  }
  try {
    return NextResponse.json(await runCockpitBuild({ deadline: Date.now() + 240_000 }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
