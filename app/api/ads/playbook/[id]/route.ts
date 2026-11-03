/**
 * One playbook entry. Staff only.
 *   PATCH { status?: "saved"|"declined", title?, userNote? } — accept / decline an AI proposal, edit the note
 *   DELETE — removes it
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { toEntry } from "@/lib/ads-warehouse/playbook";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { status?: string; title?: string; userNote?: string };
  const data: { status?: string; statusById?: string; statusByName?: string; title?: string; userNote?: string } = {};
  if (b.status === "saved" || b.status === "declined") { data.status = b.status; data.statusById = guard.session.userId; data.statusByName = guard.session.user?.name ?? guard.session.user?.email ?? ""; }
  if (typeof b.title === "string" && b.title.trim()) data.title = b.title.trim().slice(0, 140);
  if (typeof b.userNote === "string") data.userNote = b.userNote.trim().slice(0, 4000);
  if (!Object.keys(data).length) return NextResponse.json({ error: "rien à modifier" }, { status: 400 });
  const exists = await prisma.adPlaybookEntry.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const row = await prisma.adPlaybookEntry.update({ where: { id }, data });
  return NextResponse.json({ entry: toEntry(row) });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  await prisma.adPlaybookEntry.deleteMany({ where: { id } });
  return NextResponse.json({ ok: true });
}
