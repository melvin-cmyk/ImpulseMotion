/**
 * GET /api/studio/assets/[id]/file — downloads the image or the video (staff).
 * Read from the copy on the relay when there is one (it outlives Agnes' link), else from Agnes.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { RELAY_URLS } from "@/lib/relay-server";
import { mediaUrl } from "@/lib/studio";

export const maxDuration = 60;

const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "creation";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const a = await prisma.creativeAsset.findUnique({ where: { id } });
  if (!a || a.deletedAt || a.status !== "completed") return NextResponse.json({ error: "introuvable" }, { status: 404 });

  const sources: string[] = [];
  if (a.file) for (const base of RELAY_URLS) sources.push(mediaUrl(base, a.file, 300));
  if (a.url) sources.push(a.url);
  const ext = a.kind === "video" ? "mp4" : "png";
  const name = `${slug(a.clientName || "studio")}-${slug(a.prompt).slice(0, 24)}-${a.id.slice(-6)}.${ext}`;
  const inline = new URL(req.url).searchParams.get("inline") === "1";

  for (const src of sources) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(src.includes("localhost") ? 3000 : 30_000) });
      if (!res.ok || !res.body) continue;
      return new Response(res.body, {
        headers: {
          "Content-Type": res.headers.get("content-type") ?? (a.kind === "video" ? "video/mp4" : "image/png"),
          ...(res.headers.get("content-length") ? { "Content-Length": res.headers.get("content-length")! } : {}),
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`,
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch { /* next source */ }
  }
  return NextResponse.json({ error: "Fichier introuvable (copie et lien Agnes indisponibles)." }, { status: 404 });
}
