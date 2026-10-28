/**
 * GET /api/mo/ad-image/[platform]/[adId] — the picture of a platform ad known
 * to the warehouse (AdCatalog imageUrl, else thumbnailUrl), for the cards of
 * Mo: the model writes this 40-character handle instead of copying a
 * 500-character CDN link. Staff only; the account must be in the caller's scope.
 *
 * Meta CDN links carry their expiry (`oe=<hex unix seconds>`); an expired one
 * is refreshed from the creative (1200 px rendition) and stored back before
 * redirecting, so a card never shows a blank visual because the sync is behind.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { getMetaSystemToken } from "@/lib/meta-api";
import { fetchLargeThumbnails } from "@/lib/ads-warehouse/meta";

/** Unix seconds of a Meta CDN link's expiry (`oe=` hex), or null. */
function metaLinkExpiry(url: string): number | null {
  const m = url.match(/[?&]oe=([0-9A-Fa-f]{6,10})(?:&|$)/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return Number.isFinite(n) && n > 1_500_000_000 && n < 4_000_000_000 ? n : null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ platform: string; adId: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { platform, adId } = await params;
  if (!/^(meta|google|tiktok|linkedin)$/.test(platform) || !/^[A-Za-z0-9_-]{3,40}$/.test(adId)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const ad = await prisma.adCatalog.findFirst({ where: { platform, adId }, select: { id: true, accountId: true, creativeId: true, imageUrl: true, thumbnailUrl: true } });
  let src = ad?.imageUrl || ad?.thumbnailUrl;
  if (!ad || !src) return NextResponse.json({ error: "no picture" }, { status: 404 });
  const scope = await getAccountScope(guard.session);
  if (!platformAccountInScope(scope, platform, ad.accountId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // Expired (or about to) Meta link: a fresh rendition from the creative, kept for the next time.
  if (platform === "meta" && ad.creativeId) {
    const exp = metaLinkExpiry(src);
    if (exp !== null && exp < Date.now() / 1000 + 3600) {
      try {
        const fresh = (await fetchLargeThumbnails(getMetaSystemToken(), [ad.creativeId], Date.now() + 8000)).get(ad.creativeId);
        if (fresh) {
          src = fresh;
          await prisma.adCatalog.update({ where: { id: ad.id }, data: { thumbnailUrl: fresh, ...(ad.imageUrl && metaLinkExpiry(ad.imageUrl) !== null ? { imageUrl: fresh } : {}) } }).catch(() => undefined);
        }
      } catch { /* the stored link is tried anyway */ }
    }
  }
  const upgrade = platform === "meta" ? "&upgrade=1" : "";
  return NextResponse.redirect(new URL(`/api/media/proxy-image?url=${encodeURIComponent(src)}${upgrade}`, req.url), 302);
}
