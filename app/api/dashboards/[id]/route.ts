/**
 * GET    /api/dashboards/[id]?since&until   → dashboard + widgets with resolved data
 * PATCH  /api/dashboards/[id]               → staff: rename / rebind accounts
 * DELETE /api/dashboards/[id]               → staff
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, requireStaff } from "@/lib/auth-helpers";
import { loadDashboardFor } from "@/lib/dashboard-auth";
import { resolveWidgets } from "@/lib/dashboard-widgets";

export const maxDuration = 60;

function offsetDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const loaded = await loadDashboardFor(guard.session, id);
  if (loaded.status !== 200) {
    return NextResponse.json({ error: loaded.status === 404 ? "not found" : "forbidden" }, { status: loaded.status });
  }
  const { dashboard } = loaded;

  const since = req.nextUrl.searchParams.get("since") ?? offsetDate(-30);
  const until = req.nextUrl.searchParams.get("until") ?? offsetDate(0);
  if (!DATE_RE.test(since) || !DATE_RE.test(until)) {
    return NextResponse.json({ error: "since/until must be YYYY-MM-DD" }, { status: 400 });
  }

  const widgets = await resolveWidgets(dashboard, dashboard.widgets, since, until);
  return NextResponse.json({
    dashboard: {
      id: dashboard.id,
      userId: dashboard.userId,
      name: dashboard.name,
      metaAccountId: dashboard.metaAccountId,
      googleCustomerId: dashboard.googleCustomerId,
    },
    since,
    until,
    widgets,
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const existing = await prisma.dashboard.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
  if (body.metaAccountId === null || typeof body.metaAccountId === "string") {
    data.metaAccountId = body.metaAccountId ? String(body.metaAccountId).replace(/^act_/, "") : null;
  }
  if (body.googleCustomerId === null || typeof body.googleCustomerId === "string") {
    data.googleCustomerId = body.googleCustomerId ? String(body.googleCustomerId).replace(/-/g, "") : null;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  const dashboard = await prisma.dashboard.update({ where: { id }, data });
  return NextResponse.json({ dashboard });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  await prisma.dashboard.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
