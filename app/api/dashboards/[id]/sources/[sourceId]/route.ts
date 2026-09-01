/**
 * DELETE /api/dashboards/[id]/sources/[sourceId] → staff: detach a stored source
 * (HubSpot…). Legacy Meta / Google links live on the Dashboard itself (PATCH /api/dashboards/[id]).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { removeSource, SourceNotFoundError } from "@/lib/sources";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; sourceId: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id, sourceId } = await params;
  const dashboard = await prisma.dashboard.findUnique({ where: { id }, select: { id: true } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    await removeSource(id, sourceId);
  } catch (e) {
    if (e instanceof SourceNotFoundError) return NextResponse.json({ error: "source not found" }, { status: 404 });
    throw e;
  }
  return NextResponse.json({ ok: true });
}
