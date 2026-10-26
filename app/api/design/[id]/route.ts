/**
 * /api/design/[id] — one design file, staff only.
 *   GET    → { design: DesignDetail } (editor URL, AI thread, reply being produced)
 *   PATCH  { name?, clientDashboardId? } → { design } (owner or admin)
 *   DELETE → { ok } (owner or admin): the file leaves the collaboration server
 *            (its links stop working at once), then the row.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { DESIGN_NAME_MAX } from "@/lib/design/model";
import { DESIGN_SELECT, canManageDesign, loadDesign, toDesignDetail, toDesignListItem } from "@/lib/design/access";
import { parseDesignMessages } from "@/lib/design/thread";
import { deleteDesignFile } from "@/lib/design/relay";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await loadDesign(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  // A reply being produced by anyone on this design: only its asker can follow
  // it live (jobs are per person); the others reload the thread when it ends.
  const job = await prisma.aiJob.findFirst({ where: { conversationId: row.id, surface: "design", status: "running" }, orderBy: { startedAt: "desc" }, select: { id: true, userId: true } });
  const detail = toDesignDetail(row, guard.session, parseDesignMessages(row.messagesJson), job?.id ?? null);
  return NextResponse.json({ design: detail, jobOwner: job ? job.userId === guard.session.userId : null }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await loadDesign(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!canManageDesign(row, guard.session)) return NextResponse.json({ error: "Seul le créateur du design (ou un admin) peut le modifier." }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; clientDashboardId?: unknown };
  const data: { name?: string; clientDashboardId?: string | null } = {};
  if (typeof body.name === "string") {
    const name = body.name.trim().slice(0, DESIGN_NAME_MAX);
    if (!name) return NextResponse.json({ error: "Le nom ne peut pas être vide." }, { status: 400 });
    data.name = name;
  }
  if (body.clientDashboardId === null || body.clientDashboardId === "") data.clientDashboardId = null;
  else if (typeof body.clientDashboardId === "string") {
    const d = await prisma.dashboard.findUnique({ where: { id: body.clientDashboardId }, select: { id: true } });
    if (!d) return NextResponse.json({ error: "Client introuvable." }, { status: 400 });
    data.clientDashboardId = d.id;
  }
  if (!Object.keys(data).length) return NextResponse.json({ error: "Rien à modifier." }, { status: 400 });
  const updated = await prisma.designFile.update({ where: { id: row.id }, data, select: DESIGN_SELECT });
  return NextResponse.json({ design: toDesignListItem(updated, guard.session) });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await loadDesign(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!canManageDesign(row, guard.session)) return NextResponse.json({ error: "Seul le créateur du design (ou un admin) peut le supprimer." }, { status: 403 });
  try {
    await deleteDesignFile(row.fileId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Le fichier n'a pas pu être retiré du serveur (${msg}). Réessayez.` }, { status: 502 });
  }
  await prisma.designFile.delete({ where: { id: row.id } });
  return NextResponse.json({ ok: true });
}
