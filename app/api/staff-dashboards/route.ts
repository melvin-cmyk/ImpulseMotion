/**
 * « Mes dashboards » (staff).
 *   GET  → { dashboards: [{ id, title, description, shared, mine, ownerEmail, datasetCount, updatedAt }], templates }
 *   POST → crée un dashboard : { title?, description?, datasets?, params?, html?, shared?, sources? }
 *          ou depuis un modèle livré : { template: "cours-legendre", title? }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { MAX_HTML_CHARS, MAX_TITLE_CHARS, TEMPLATES, loadTemplate, parseDatasets, parseParams } from "@/lib/staff-dashboards/model";
import { parseSources } from "@/lib/staff-dashboards/sources";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const rows = await prisma.staffDashboard.findMany({
    where: { OR: [{ ownerId: guard.session.userId }, { shared: true }] },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, description: true, shared: true, ownerId: true, datasetsJson: true, updatedAt: true, owner: { select: { email: true, name: true } } },
  });
  return NextResponse.json({
    dashboards: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      shared: r.shared,
      mine: r.ownerId === guard.session.userId,
      ownerEmail: r.owner.email,
      ownerName: r.owner.name,
      datasetCount: Object.keys(parseDatasets(r.datasetsJson).datasets).length,
      updatedAt: r.updatedAt,
    })),
    templates: TEMPLATES,
  }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "corps de requête invalide" }, { status: 400 });

  let title = typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE_CHARS) : "";
  let description = typeof body.description === "string" ? body.description.trim().slice(0, 2000) : "";
  let datasetsJson = "{}";
  let paramsJson = "{}";
  let html = "";

  if (typeof body.template === "string") {
    const t = loadTemplate(body.template);
    if (!t) return NextResponse.json({ error: "modèle inconnu" }, { status: 400 });
    title = title || t.title;
    description = description || t.description;
    datasetsJson = JSON.stringify(t.datasets);
    paramsJson = JSON.stringify(t.params);
    html = t.html;
  } else {
    if (body.datasets !== undefined) {
      const { datasets, errors } = parseDatasets(body.datasets);
      if (errors.length) return NextResponse.json({ error: errors[0], errors }, { status: 400 });
      datasetsJson = JSON.stringify(datasets);
    }
    if (body.params !== undefined) paramsJson = JSON.stringify(parseParams(body.params));
    if (typeof body.html === "string") html = body.html;
  }
  if (!title) return NextResponse.json({ error: "titre requis" }, { status: 400 });
  if (html.length > MAX_HTML_CHARS) return NextResponse.json({ error: `page trop grande (max ${MAX_HTML_CHARS} caractères)` }, { status: 413 });

  const row = await prisma.staffDashboard.create({
    data: {
      ownerId: guard.session.userId, title, description: description || null, datasetsJson, paramsJson, html, shared: body.shared === true,
      sourcesJson: JSON.stringify(parseSources(body.sources)),
    },
    select: { id: true },
  });
  return NextResponse.json({ id: row.id }, { status: 201 });
}
