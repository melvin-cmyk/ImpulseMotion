/**
 * POST /api/pilot/ad-image { image: dataURI } — an image sent from the form
 * « Nouvelle publicité » (staff): the visual of an image ad, or the thumbnail
 * of a video ad. Kept on the relay and given back as a signed HTTPS link Meta
 * downloads when the ad is created (valid 24 hours: the preview, the send and
 * the processing of a video by Meta).
 *
 * Videos are not sent through here: a browser cannot post a 200 MB file to a
 * Vercel function (4.5 MB body limit). A video ad takes a Studio video
 * (by asset id, re-signed by the server) or the public https address of an mp4.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { dataUriOk, publicMediaUrl, relayUpload } from "@/lib/studio";
import { PUBLICATION_LINK_TTL_S } from "@/lib/pilot/new-ad";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => null);
  if (!dataUriOk(body?.image)) return NextResponse.json({ error: "Image invalide (PNG, JPEG ou WebP)." }, { status: 400 });
  try {
    const { file } = await relayUpload(body.image);
    const imageUrl = publicMediaUrl(file, PUBLICATION_LINK_TTL_S);
    if (!imageUrl) return NextResponse.json({ error: "Adresse publique de l'application inconnue." }, { status: 503 });
    return NextResponse.json({ imageUrl });
  } catch (e) {
    return NextResponse.json({ error: `L'image n'a pas pu être envoyée : ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}
