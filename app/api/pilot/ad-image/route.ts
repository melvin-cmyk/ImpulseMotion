/**
 * POST /api/pilot/ad-image { image: dataURI } — an image sent from the form
 * « Nouvelle publicité » (staff): kept on the relay and given back as a
 * signed HTTPS link Meta downloads when the ad is created (valid 6 hours,
 * enough for the preview and the send).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { dataUriOk, publicMediaUrl, relayUpload } from "@/lib/studio";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => null);
  if (!dataUriOk(body?.image)) return NextResponse.json({ error: "Image invalide (PNG, JPEG ou WebP)." }, { status: 400 });
  try {
    const { file } = await relayUpload(body.image);
    const imageUrl = publicMediaUrl(file, 6 * 3600);
    if (!imageUrl) return NextResponse.json({ error: "Adresse publique de l'application inconnue." }, { status: 503 });
    return NextResponse.json({ imageUrl });
  } catch (e) {
    return NextResponse.json({ error: `L'image n'a pas pu être envoyée : ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}
