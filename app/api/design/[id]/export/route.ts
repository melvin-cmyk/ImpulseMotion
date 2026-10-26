/**
 * GET /api/design/[id]/export?format=png|jpg|webp|svg|pdf&scale=1..4
 * → the design's page rendered by the relay (a headless FigCraft joins the
 *   file and exports it), as a download.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { EXPORT_FORMATS, type ExportFormat } from "@/lib/design/model";
import { loadDesign } from "@/lib/design/access";
import { exportDesignFile } from "@/lib/design/relay";
import { uploadDesignExport } from "@/lib/design/drive-sync";

export const maxDuration = 120;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const design = await loadDesign(id);
  if (!design) return NextResponse.json({ error: "not found" }, { status: 404 });
  const fmtParam = req.nextUrl.searchParams.get("format") || "png";
  const format = (EXPORT_FORMATS as readonly string[]).includes(fmtParam) ? (fmtParam as ExportFormat) : "png";
  const scale = Math.min(4, Math.max(0.5, Number(req.nextUrl.searchParams.get("scale")) || 1));
  try {
    const out = await exportDesignFile({ link: design.viewLink, format, scale });
    const base = design.name.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._ -]/g, "_").trim().slice(0, 80) || "design";
    const filename = `${base}.${out.format}`;
    // A design of a client: the export also lands in the client's Drive folder (best effort).
    let driveLink: string | null = null;
    if (design.clientDashboardId) {
      try { driveLink = (await uploadDesignExport(design.id, { name: filename, mimeType: out.mimeType, data: out.bytes }))?.webViewLink ?? null; }
      catch (e) { console.error(`[design] export → Drive refusé (${design.id}) : ${e instanceof Error ? e.message : e}`); }
    }
    return new Response(new Uint8Array(out.bytes), {
      status: 200,
      headers: {
        "Content-Type": out.mimeType,
        "Content-Length": String(out.bytes.length),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        ...(driveLink ? { "X-Drive-Link": driveLink } : {}),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Export impossible (${msg}).` }, { status: 502 });
  }
}
