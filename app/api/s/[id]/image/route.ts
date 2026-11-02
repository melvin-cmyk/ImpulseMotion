/**
 * GET /api/s/:id/image?adId=… — PUBLIC visual of an ad of a snapshot: only
 * ads frozen in that (non-revoked) snapshot, redirected to a fresh Meta URL.
 */

import { NextRequest, NextResponse } from "next/server";
import { snapshotHasAd } from "@/lib/ads-warehouse/snapshots";
import { freshMetaAdImage } from "@/lib/ads-warehouse/preview";

export const maxDuration = 30;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const adId = req.nextUrl.searchParams.get("adId") ?? "";
  if (!/^\d{5,30}$/.test(adId) || !(await snapshotHasAd(id, adId))) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const img = await freshMetaAdImage(adId);
  if (!img?.url) return NextResponse.json({ error: "image indisponible" }, { status: 404 });
  return NextResponse.redirect(img.url, { status: 302, headers: { "Cache-Control": "public, max-age=3600" } });
}
