/**
 * GET /api/version — build currently served. An open tab compares it with the
 * build it was loaded from (NEXT_PUBLIC_APP_BUILD) to know it is outdated.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { build: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.NEXT_PUBLIC_APP_BUILD ?? "dev" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
