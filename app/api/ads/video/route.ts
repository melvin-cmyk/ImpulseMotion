/**
 * GET /api/ads/video?adId=… — redirects to the playable MP4 of a catalogued
 * Meta video ad, so cards can use it directly as <video src> (Motion's inline
 * preview: hover to scrub, click to play). Staff only; the ad's account must
 * be in the viewer's scope. 404 when Meta does not expose the file.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { getMetaVideoSource } from "@/lib/ads-warehouse/preview";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const adId = req.nextUrl.searchParams.get("adId") ?? "";
  if (!/^\d{5,30}$/.test(adId)) return NextResponse.json({ error: "adId invalide" }, { status: 400 });
  const row = await prisma.adCatalog.findUnique({ where: { id: `meta:${adId}` }, select: { accountId: true, videoId: true } });
  if (!row?.videoId) return NextResponse.json({ error: "pas de vidéo" }, { status: 404 });
  const scope = await getAccountScope(guard.session);
  if (!platformAccountInScope(scope, "meta", row.accountId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const src = await getMetaVideoSource(row.videoId, row.accountId).catch(() => null);
  if (!src) return NextResponse.json({ error: "vidéo indisponible" }, { status: 404 });
  return NextResponse.redirect(src, { status: 302, headers: { "Cache-Control": "private, max-age=3600" } });
}
