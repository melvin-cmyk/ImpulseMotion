/**
 * Un dashboard du staff.
 *   GET    → { dashboard: { id, title, description, datasets, params, html, shared, mine, ownerEmail, updatedAt } }
 *            (propriétaire, ou tout le staff s'il est partagé)
 *   PUT    → { title?, description?, datasets?, params?, html?, shared?, origin?: "copilot"|"manual", label? } (propriétaire ou admin)
 *            → { ok, versionId? } : l'état précédent est gardé en version quand le contenu change
 *   DELETE → supprime (propriétaire ou admin)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { forgetDashboardCache } from "@/lib/staff-dashboards/data";
import { describeChange, snapshotVersion } from "@/lib/staff-dashboards/versions";
import { MAX_HTML_CHARS, MAX_TITLE_CHARS, parseDatasets, parseParams } from "@/lib/staff-dashboards/model";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };

async function load(id: string) {
  return prisma.staffDashboard.findUnique({
    where: { id },
    select: { id: true, ownerId: true, title: true, description: true, datasetsJson: true, paramsJson: true, html: true, shared: true, updatedAt: true, owner: { select: { email: true, name: true } } },
  });
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await load(id);
  const mine = row?.ownerId === guard.session.userId;
  if (!row || (!mine && !row.shared && guard.session.role !== "admin")) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  return NextResponse.json({
    dashboard: {
      id: row.id,
      title: row.title,
      description: row.description,
      datasets: parseDatasets(row.datasetsJson).datasets,
      params: parseParams(row.paramsJson),
      html: row.html,
      shared: row.shared,
      mine,
      canEdit: mine || guard.session.role === "admin",
      ownerEmail: row.owner.email,
      ownerName: row.owner.name,
      updatedAt: row.updatedAt,
    },
  }, { headers: NO_STORE });
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await prisma.staffDashboard.findUnique({ where: { id }, select: { ownerId: true, title: true, description: true, datasetsJson: true, paramsJson: true, html: true } });
  if (!row) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  if (row.ownerId !== guard.session.userId && guard.session.role !== "admin") return NextResponse.json({ error: "réservé au propriétaire" }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "corps de requête invalide" }, { status: 400 });

  const data: { title?: string; description?: string | null; datasetsJson?: string; paramsJson?: string; html?: string; shared?: boolean } = {};
  if (typeof body.title === "string") {
    const t = body.title.trim().slice(0, MAX_TITLE_CHARS);
    if (!t) return NextResponse.json({ error: "titre requis" }, { status: 400 });
    data.title = t;
  }
  if (typeof body.description === "string") data.description = body.description.trim().slice(0, 2000) || null;
  if (body.datasets !== undefined) {
    const { datasets, errors } = parseDatasets(body.datasets);
    if (errors.length) return NextResponse.json({ error: errors[0], errors }, { status: 400 });
    data.datasetsJson = JSON.stringify(datasets);
  }
  if (body.params !== undefined) data.paramsJson = JSON.stringify(parseParams(body.params));
  if (typeof body.html === "string") {
    if (body.html.length > MAX_HTML_CHARS) return NextResponse.json({ error: `page trop grande (max ${MAX_HTML_CHARS} caractères)` }, { status: 413 });
    data.html = body.html;
  }
  if (typeof body.shared === "boolean") data.shared = body.shared;

  // L'état précédent devient une version dès que le contenu change (pas pour le partage seul).
  const changed = describeChange(row, data);
  let versionId: string | undefined;
  if (changed) {
    const origin = body.origin === "copilot" ? "copilot" : "manual";
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : `Modification : ${changed}`;
    versionId = await snapshotVersion(id, row, { userId: guard.session.userId, origin, label });
  }
  await prisma.staffDashboard.update({ where: { id }, data });
  if (data.datasetsJson !== undefined || data.paramsJson !== undefined) forgetDashboardCache(id);
  return NextResponse.json({ ok: true, ...(versionId ? { versionId } : {}) });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await prisma.staffDashboard.findUnique({ where: { id }, select: { ownerId: true } });
  if (!row) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  if (row.ownerId !== guard.session.userId && guard.session.role !== "admin") return NextResponse.json({ error: "réservé au propriétaire" }, { status: 403 });
  await prisma.staffDashboard.delete({ where: { id } });
  forgetDashboardCache(id);
  return NextResponse.json({ ok: true });
}
