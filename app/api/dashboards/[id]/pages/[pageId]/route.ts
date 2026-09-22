/**
 * One page of a dashboard — staff only.
 *   PATCH  { name?, position? }
 *   DELETE → the page's widgets move to the first page (pageId = null), nothing is lost.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { cleanPageName } from "@/lib/dashboard-pages";

async function guardPage(id: string, pageId: string) {
  const guard = await requireStaff();
  if ("error" in guard) return { error: guard.error };
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return { error: denied };
  const page = await prisma.dashboardPage.findFirst({ where: { id: pageId, dashboardId: id } });
  if (!page) return { error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  return { page };
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; pageId: string }> }) {
  const { id, pageId } = await params;
  const g = await guardPage(id, pageId);
  if ("error" in g) return g.error;
  const body = await req.json().catch(() => ({}));
  const data: { name?: string; position?: number } = {};
  if (typeof body.name === "string" && body.name.trim()) data.name = cleanPageName(body.name);
  if (Number.isInteger(body.position) && body.position >= 0) data.position = Number(body.position);
  const page = await prisma.dashboardPage.update({ where: { id: pageId }, data, select: { id: true, name: true, position: true, intent: true } });
  return NextResponse.json({ page });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; pageId: string }> }) {
  const { id, pageId } = await params;
  const g = await guardPage(id, pageId);
  if ("error" in g) return g.error;
  const mode = _req.nextUrl.searchParams.get("widgets") === "delete" ? "delete" : "keep";
  await prisma.$transaction([
    mode === "delete"
      ? prisma.dashboardWidget.deleteMany({ where: { dashboardId: id, pageId } })
      : prisma.dashboardWidget.updateMany({ where: { dashboardId: id, pageId }, data: { pageId: null } }),
    prisma.dashboardPage.delete({ where: { id: pageId } }),
  ]);
  return NextResponse.json({ ok: true });
}
