/**
 * Comments under a creative's Meta ads (Motion shows them in the creative's
 * sheet). Staff only; the ads must be in the warehouse (no arbitrary Graph
 * ids). Readable only for Pages assigned to the system user.
 *   GET ?adIds=123,456 → { open, comments, errors }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { metaCommentsOpen, readAdComments } from "@/lib/meta-comments";

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  if (!metaCommentsOpen()) return NextResponse.json({ open: false, comments: [], errors: 0 });
  const asked = (req.nextUrl.searchParams.get("adIds") ?? "").split(",").filter((id) => /^\d{5,25}$/.test(id)).slice(0, 20);
  if (!asked.length) return NextResponse.json({ error: "adIds attendu" }, { status: 400 });
  const known = await prisma.adCatalog.findMany({ where: { platform: "meta", adId: { in: asked } }, select: { adId: true } });
  const { comments, errors } = await readAdComments(known.map((k) => k.adId));
  return NextResponse.json({ open: true, comments, errors }, { headers: { "Cache-Control": "private, max-age=600" } });
}
