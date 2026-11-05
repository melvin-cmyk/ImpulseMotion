/**
 * GET /api/bot/[botId]/image?ad=<platform>:<adId> — the visual of one of the
 * client's ads, for the creatives a client bot shows (lib/bot-ads-pack.ts).
 * Allowed on the bot AND ad of the bot's own accounts (lib/bot-media.ts): a
 * crafted address cannot reach another client's creative.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { botAd, botAdByName } from "@/lib/bot-media";
import { freshMetaAdImage } from "@/lib/ads-warehouse/preview";

export const maxDuration = 30;

export async function GET(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { botId } = await params;
  const byName = req.nextUrl.searchParams.get("name");
  const r = byName ? await botAdByName(guard.session, botId, byName) : await botAd(guard.session, botId, req.nextUrl.searchParams.get("ad") ?? "");
  if ("status" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const url = r.ad.platform === "meta" ? (await freshMetaAdImage(r.ad.adId))?.url ?? null : r.ad.imageUrl || r.ad.thumbnailUrl;
  if (!url || !/^https:\/\//.test(url)) return NextResponse.json({ error: "visuel indisponible" }, { status: 404 });
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "private, max-age=3600" } });
}
