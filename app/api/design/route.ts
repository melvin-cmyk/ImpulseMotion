/**
 * /api/design — the agency's design files (FigCraft), staff only.
 *   GET  → { designs: DesignListItem[] } (every design, most recent first)
 *   POST { name, preset? | width?, height?, clientDashboardId? } → { design: DesignListItem }
 *        The relay creates the file on the collaboration server (with an
 *        artboard of the chosen size) and hands back its share links.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { DESIGN_NAME_MAX, presetByKey } from "@/lib/design/model";
import { DESIGN_SELECT, toDesignListItem } from "@/lib/design/access";
import { createDesignFile } from "@/lib/design/relay";

const MAX_LIST = 200;
const MAX_DESIGNS = 1000;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  // ?client=<dashboardId> → the designs of one client (its cockpit, the filtered list).
  const client = req.nextUrl.searchParams.get("client");
  const where = client && /^[a-z0-9]{10,40}$/i.test(client) ? { clientDashboardId: client } : {};
  const rows = await prisma.designFile.findMany({ where, select: DESIGN_SELECT, orderBy: { updatedAt: "desc" }, take: MAX_LIST });
  return NextResponse.json({ designs: rows.map((r) => toDesignListItem(r, guard.session)) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; preset?: unknown; width?: unknown; height?: unknown; clientDashboardId?: unknown };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, DESIGN_NAME_MAX) : "";
  if (!name) return NextResponse.json({ error: "Donnez un nom au design." }, { status: 400 });

  let width = 0, height = 0;
  const preset = presetByKey(body.preset);
  if (preset) { width = preset.width; height = preset.height; }
  else {
    const w = Number(body.width), h = Number(body.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w >= 16 && h >= 16 && w <= 16384 && h <= 16384) { width = Math.round(w); height = Math.round(h); }
  }

  let clientDashboardId: string | null = null;
  if (typeof body.clientDashboardId === "string" && body.clientDashboardId) {
    const d = await prisma.dashboard.findUnique({ where: { id: body.clientDashboardId }, select: { id: true } });
    if (!d) return NextResponse.json({ error: "Client introuvable." }, { status: 400 });
    clientDashboardId = d.id;
  }

  if ((await prisma.designFile.count()) >= MAX_DESIGNS) {
    return NextResponse.json({ error: `Limite de ${MAX_DESIGNS} designs atteinte : supprimez-en avant d'en créer.` }, { status: 429 });
  }

  let created;
  try {
    created = await createDesignFile({ name, ...(width && height ? { width, height, frameName: name } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Le fichier n'a pas pu être créé (${msg}).` }, { status: 502 });
  }

  const row = await prisma.designFile.create({
    data: { ownerId: guard.session.userId, name, clientDashboardId, fileId: created.fileId, editLink: created.editLink, viewLink: created.viewLink },
    select: DESIGN_SELECT,
  });
  return NextResponse.json({ design: toDesignListItem(row, guard.session) }, { status: 201 });
}
