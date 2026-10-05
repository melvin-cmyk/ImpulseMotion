/**
 * GET /api/studio/media/<file>?exp=&sig= — a relay file behind a signed,
 * short-lived HTTPS link (no session). Agnes AI only downloads reference
 * media from HTTPS addresses; the relay is reachable in plain HTTP only, so
 * the photo to animate goes through here. Same signature as the relay's
 * /media links (lib/studio.ts mediaUrl), checked before anything is read.
 */

import { NextRequest, NextResponse } from "next/server";
import { RELAY_URLS } from "@/lib/relay-server";
import { mediaUrl, verifyMediaSignature } from "@/lib/studio";

export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const q = new URL(req.url).searchParams;
  if (!verifyMediaSignature(file, Number(q.get("exp")), q.get("sig") ?? "")) return new NextResponse("403", { status: 403 });
  for (const base of RELAY_URLS) {
    try {
      const res = await fetch(mediaUrl(base, file, 120), { signal: AbortSignal.timeout(base.includes("localhost") ? 3000 : 30_000) });
      if (!res.ok || !res.body) continue;
      return new Response(res.body, {
        headers: {
          "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
          ...(res.headers.get("content-length") ? { "Content-Length": res.headers.get("content-length")! } : {}),
          "Cache-Control": "private, max-age=600",
        },
      });
    } catch { /* next relay address */ }
  }
  return new NextResponse("404", { status: 404 });
}
