/**
 * DELETE /api/dashboards/[id]/sources/[sourceId] → staff: detach a stored source
 * (HubSpot, TikTok Ads…). Legacy Meta / Google links live on the Dashboard itself (PATCH /api/dashboards/[id]).
 * Detaching a TikTok advertiser takes back the access it had opened (owner and
 * members), unless another of their dashboards still carries it.
 */

import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { removeSource, SourceNotFoundError } from "@/lib/sources";
import { revokeUncoveredAccess } from "@/lib/dashboard-members";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; sourceId: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id, sourceId } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;
  const dashboard = await prisma.dashboard.findUnique({
    where: { id },
    select: { id: true, userId: true, members: { select: { userId: true } }, sources: { where: { id: sourceId }, select: { kind: true, externalId: true } } },
  });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    await removeSource(id, sourceId);
  } catch (e) {
    if (e instanceof SourceNotFoundError) return NextResponse.json({ error: "source not found" }, { status: 404 });
    throw e;
  }
  const tiktok = dashboard.sources.filter((s) => s.kind === "tiktok").map((s) => s.externalId);
  if (tiktok.length) {
    for (const uid of new Set([dashboard.userId, ...dashboard.members.map((m) => m.userId)])) {
      await revokeUncoveredAccess(uid, { metaAccountId: null, googleCustomerId: null, tiktokAdvertiserIds: tiktok });
    }
  }
  return NextResponse.json({ ok: true });
}
