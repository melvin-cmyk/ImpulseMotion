/**
 * GET /api/bot/[botId]/video?ad=meta:<adId> — the MP4 of one of the client's
 * Meta video ads (same checks as the image route, lib/bot-media.ts). 404 when
 * the Page that published it is not assigned to the system user: the chat's
 * player then falls back to the image.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { botAd, metaVideoSource } from "@/lib/bot-media";

export const maxDuration = 30;

export async function GET(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { botId } = await params;
  const r = await botAd(guard.session, botId, req.nextUrl.searchParams.get("ad") ?? "");
  if ("status" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  if (r.ad.platform !== "meta" || !r.ad.videoId) return NextResponse.json({ error: "pas de vidéo" }, { status: 404 });
  const url = await metaVideoSource(r.ad.adId, r.ad.videoId);
  if (!url) return NextResponse.json({ error: "vidéo indisponible" }, { status: 404 });
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "private, max-age=1800" } });
}
