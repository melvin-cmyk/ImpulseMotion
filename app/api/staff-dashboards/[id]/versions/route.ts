/**
 * Versions d'un dashboard du staff (propriétaire ou admin).
 *   GET  → { versions: [{ id, origin, label, createdAt, title, htmlChars, datasetCount }] } (la plus récente d'abord)
 *   POST { versionId } → revient à cette version : l'état courant est d'abord gardé en version « restore »,
 *        puis le dashboard reprend titre, description, jeux, paramètres et page de la version.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { forgetDashboardCache } from "@/lib/staff-dashboards/data";
import { snapshotVersion } from "@/lib/staff-dashboards/versions";

type Ctx = { params: Promise<{ id: string }> };

async function guardEditable(id: string) {
  const guard = await requireStaff();
  if ("error" in guard) return { error: guard.error };
  const row = await prisma.staffDashboard.findUnique({ where: { id }, select: { ownerId: true, title: true, description: true, datasetsJson: true, paramsJson: true, html: true } });
  if (!row) return { error: NextResponse.json({ error: "introuvable" }, { status: 404 }) };
  if (row.ownerId !== guard.session.userId && guard.session.role !== "admin") return { error: NextResponse.json({ error: "réservé au propriétaire" }, { status: 403 }) };
  return { guard, row };
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const g = await guardEditable(id);
  if ("error" in g) return g.error;
  const rows = await prisma.staffDashboardVersion.findMany({
    where: { dashboardId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true, origin: true, label: true, createdAt: true, title: true, html: true, datasetsJson: true },
  });
  const versions = rows.map((v) => {
    let datasetCount = 0;
    try { datasetCount = Object.keys(JSON.parse(v.datasetsJson) ?? {}).length; } catch { /* ignoré */ }
    return { id: v.id, origin: v.origin, label: v.label, createdAt: v.createdAt, title: v.title, htmlChars: v.html.length, datasetCount };
  });
  return NextResponse.json({ versions }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const g = await guardEditable(id);
  if ("error" in g) return g.error;
  const body = await req.json().catch(() => ({}));
  const versionId = typeof body.versionId === "string" ? body.versionId : "";
  if (!versionId) return NextResponse.json({ error: "versionId requis" }, { status: 400 });
  const v = await prisma.staffDashboardVersion.findFirst({ where: { id: versionId, dashboardId: id } });
  if (!v) return NextResponse.json({ error: "version introuvable" }, { status: 404 });
  const when = v.createdAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" });
  await snapshotVersion(id, g.row, { userId: g.guard.session.userId, origin: "restore", label: `Avant retour à la version du ${when}` });
  await prisma.staffDashboard.update({
    where: { id },
    data: { title: v.title, description: v.description, datasetsJson: v.datasetsJson, paramsJson: v.paramsJson, html: v.html },
  });
  forgetDashboardCache(id);
  return NextResponse.json({ ok: true });
}
