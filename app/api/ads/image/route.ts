/**
 * GET /api/ads/image?adId=… — redirects to a usable image of a catalogued Meta
 * ad, refreshing it from Meta when the stored signed CDN URL has expired.
 * Staff only; the ad's account must be in the viewer's scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { freshMetaAdImage } from "@/lib/ads-warehouse/preview";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const adId = req.nextUrl.searchParams.get("adId") ?? "";
  if (!/^\d{5,30}$/.test(adId)) return NextResponse.json({ error: "adId invalide" }, { status: 400 });
  const img = await freshMetaAdImage(adId);
  if (!img) return NextResponse.json({ error: "annonce inconnue" }, { status: 404 });
  const scope = await getAccountScope(guard.session);
  if (!platformAccountInScope(scope, "meta", img.accountId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!img.url) return NextResponse.json({ error: "image indisponible" }, { status: 404 });
  return NextResponse.redirect(img.url, { status: 302, headers: { "Cache-Control": "private, max-age=3600" } });
}
