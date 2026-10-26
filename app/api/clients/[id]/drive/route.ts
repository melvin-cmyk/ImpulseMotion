/**
 * /api/clients/[id]/drive — the client's Google Drive folder (staff).
 *   GET  → { folder: { id, name, url } | null, files: DriveFileRef[], reason? }
 *          The folder is created on the first visit of a client bound to an
 *          ad account (Meta or Google); null (with `reason`) otherwise.
 *   POST → { folder } creates it even for a client without accounts.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { dashboardIdInScope, getAccountScope } from "@/lib/scope";
import { driveFolderUrl, ensureClientFolder, listClientFiles } from "@/lib/clients/drive";

async function guardClient(id: string) {
  const guard = await requireStaff();
  if ("error" in guard) return guard;
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return { error: NextResponse.json({ error: "not found" }, { status: 404 }) } as const;
  if (!(await dashboardIdInScope(await getAccountScope(guard.session), id))) return { error: NextResponse.json({ error: "not found" }, { status: 404 }) } as const;
  return guard;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guardClient(id);
  if ("error" in g) return g.error;
  try {
    const folder = await ensureClientFolder(id);
    if (!folder) return NextResponse.json({ folder: null, files: [], reason: "Ce client n'a pas encore de compte Meta ou Google : son dossier Drive sera créé dès qu'il en aura un (ou maintenant, avec le bouton)." }, { headers: { "Cache-Control": "no-store" } });
    const files = await listClientFiles(folder.id, 100);
    return NextResponse.json({ folder: { id: folder.id, name: folder.name, url: folder.webViewLink ?? driveFolderUrl(folder.id) }, files }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ folder: null, files: [], error: `Drive indisponible (${msg}).` }, { status: 502 });
  }
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guardClient(id);
  if ("error" in g) return g.error;
  try {
    const folder = await ensureClientFolder(id, { force: true });
    if (!folder) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
    return NextResponse.json({ folder: { id: folder.id, name: folder.name, url: folder.webViewLink ?? driveFolderUrl(folder.id) } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Le dossier n'a pas pu être créé (${msg}).` }, { status: 502 });
  }
}
