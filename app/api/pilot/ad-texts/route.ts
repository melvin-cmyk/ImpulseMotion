/**
 * GET /api/pilot/ad-texts?clientId=…&accountId=…&adId=… — the texts of a Meta
 * ad's creative as Meta holds them now (primary text, headline, description,
 * link, button), for the editor « Textes » of Pilotage (staff, account of the
 * client and of the scope). Null `texts` when the ad is not an image or video
 * link ad: those are edited in Ads Manager. Read only.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAccount } from "@/lib/pilot/service";
import { readAdCreative } from "@/lib/pilot/meta";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = new URL(req.url).searchParams;
  const resolved = await resolveAccount(guard.session, q.get("clientId") ?? "", q.get("accountId") ?? "", "meta");
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  const adId = q.get("adId") ?? "";
  if (!/^\d{5,25}$/.test(adId)) return NextResponse.json({ error: "Annonce invalide." }, { status: 400 });
  try {
    const read = await readAdCreative(adId);
    if (!read || read.accountId !== resolved.account.digits) return NextResponse.json({ error: "Cette annonce n'appartient pas au compte." }, { status: 404 });
    const c = read.creative;
    return NextResponse.json({
      adName: read.adName,
      texts: c ? { kind: c.kind, primaryText: c.primaryText, headline: c.headline, description: c.description, linkUrl: c.linkUrl, callToAction: c.callToAction } : null,
      creativeId: c?.creativeId ?? null,
      media: c ? (c.kind === "video" ? `vidéo ${c.videoId}` : c.imageHash ? `image ${c.imageHash.slice(0, 8)}…` : c.picture ? "image (lien)" : "image") : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[pilot] ad texts unreadable", e);
    return NextResponse.json({ error: "Les textes n'ont pas pu être lus sur Meta : réessayez dans quelques minutes." }, { status: 503 });
  }
}
