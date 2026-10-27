/**
 * GET /api/ads/preview?adId=…&format=MOBILE_FEED_STANDARD — official preview
 * iframe of a catalogued ad (+ direct video URL when readable). Staff only;
 * the ad's account must be in the viewer's scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { getMetaAdPreview, getMetaVideoSource, META_PREVIEW_FORMATS, type MetaPreviewFormat } from "@/lib/ads-warehouse/preview";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const adId = req.nextUrl.searchParams.get("adId") ?? "";
  const fmt = (req.nextUrl.searchParams.get("format") ?? "MOBILE_FEED_STANDARD") as MetaPreviewFormat;
  if (!/^\d{5,30}$/.test(adId)) return NextResponse.json({ error: "adId invalide" }, { status: 400 });
  if (!META_PREVIEW_FORMATS.includes(fmt)) return NextResponse.json({ error: "format invalide" }, { status: 400 });
  const row = await prisma.adCatalog.findUnique({ where: { id: `meta:${adId}` }, select: { accountId: true, videoId: true } });
  if (!row) return NextResponse.json({ error: "annonce inconnue" }, { status: 404 });
  const scope = await getAccountScope(guard.session);
  if (!platformAccountInScope(scope, "meta", row.accountId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const [preview, videoUrl] = await Promise.all([getMetaAdPreview(adId, fmt), row.videoId ? getMetaVideoSource(row.videoId) : Promise.resolve(null)]);
    return NextResponse.json({ ...preview, videoUrl }, { headers: { "Cache-Control": "private, max-age=600" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Aperçu indisponible" }, { status: 502 });
  }
}
