/**
 * GET /api/mo/ad-image/[platform]/[adId] — the picture of a platform ad known
 * to the warehouse (AdCatalog imageUrl, else thumbnailUrl), for the cards of
 * Mo: the model writes this 40-character handle instead of copying a
 * 500-character CDN link. Staff only; the account must be in the caller's scope.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";

export async function GET(req: NextRequest, { params }: { params: Promise<{ platform: string; adId: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { platform, adId } = await params;
  if (!/^(meta|google|tiktok|linkedin)$/.test(platform) || !/^[A-Za-z0-9_-]{3,40}$/.test(adId)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const ad = await prisma.adCatalog.findFirst({ where: { platform, adId }, select: { accountId: true, imageUrl: true, thumbnailUrl: true } });
  const src = ad?.imageUrl || ad?.thumbnailUrl;
  if (!ad || !src) return NextResponse.json({ error: "no picture" }, { status: 404 });
  const scope = await getAccountScope(guard.session);
  if (!platformAccountInScope(scope, platform, ad.accountId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const upgrade = platform === "meta" ? "&upgrade=1" : "";
  return NextResponse.redirect(new URL(`/api/media/proxy-image?url=${encodeURIComponent(src)}${upgrade}`, req.url), 302);
}
