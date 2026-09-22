/**
 * Pages (tabs) of a dashboard — staff only.
 *   GET  → { pages }
 *   POST → { name, intent?, widgets?: [...] } creates an empty page or a page with widgets
 *          { ai: true, brief, name? } lets the AI compose the page from the brief
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { findHubspotSourceDashboard } from "@/lib/dashboard-widgets";
import { cleanPageName, createPageWithWidgets, generatePageSpec, validatePageWidgets } from "@/lib/dashboard-pages";

export const maxDuration = 120;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;
  const pages = await prisma.dashboardPage.findMany({ where: { dashboardId: id }, orderBy: { position: "asc" }, select: { id: true, name: true, position: true, intent: true } });
  return NextResponse.json({ pages });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;
  const dashboard = await prisma.dashboard.findUnique({ where: { id }, select: { id: true, name: true, metaAccountId: true, googleCustomerId: true } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  try {
    if (body.ai === true) {
      const brief = typeof body.brief === "string" ? body.brief.trim() : "";
      if (brief.length < 8) return NextResponse.json({ error: "décrivez la page en une phrase au moins" }, { status: 400 });
      const hasHubspot = !!(await findHubspotSourceDashboard([id]));
      const { spec, note } = await generatePageSpec(
        { ...dashboard, hasHubspot },
        brief,
        { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role },
      );
      const page = await createPageWithWidgets(id, {
        name: typeof body.name === "string" && body.name.trim() ? body.name : spec.name,
        intent: brief,
        widgets: spec.widgets,
      });
      return NextResponse.json({ page: { id: page.id, name: page.name, position: page.position, intent: page.intent, widgetCount: page._count.widgets }, note });
    }
    const widgets = body.widgets === undefined ? [] : validatePageWidgets(body.widgets);
    const page = await createPageWithWidgets(id, { name: cleanPageName(body.name, "Nouvelle page"), intent: typeof body.intent === "string" ? body.intent : null, widgets });
    return NextResponse.json({ page: { id: page.id, name: page.name, position: page.position, intent: page.intent, widgetCount: page._count.widgets } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /max par|liste|type inconnu|widget \d+|illisible|aucun widget/i.test(message) ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
