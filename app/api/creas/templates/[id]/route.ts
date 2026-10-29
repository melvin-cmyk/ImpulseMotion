/**
 * One template of the swipe file (staff).
 *   GET    → { template, assets } (the visuals made from it)
 *   PATCH  { name?, tags?, brand?, clientId? (null = shared), reanalyse?: true, retired?: boolean } → { template }
 *   DELETE → { ok } (its author or an admin; the visuals made from it stay)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { assetView } from "@/lib/studio-assets";
import { loadTemplate, resolveAlertClient, templateVerdicts, templateView } from "@/lib/creas/templates";
import { analyseTemplate } from "@/lib/creas/analysis";
import { dataUriToRelayImage, mediaFileDataUri } from "@/lib/creas/media";

type Params = { params: Promise<{ id: string }> };
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET(_req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await loadTemplate(id);
  if (!row) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const assets = await prisma.creativeAsset.findMany({ where: { templateId: row.id, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 60 });
  const verdicts = (await templateVerdicts([row.id])).get(row.id);
  return NextResponse.json({ template: templateView(row, guard.session.userId, assets.length, verdicts), assets: assets.map((a) => assetView(a, guard.session.userId)) }, NO_STORE);
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await loadTemplate(id);
  if (!row) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim().slice(0, 120);
  if (typeof body.brand === "string") data.brand = body.brand.trim().slice(0, 120);
  // « Écarter » after too many cuts (suggested, never automatic) / « Remettre ».
  if (body.retired === true) data.retiredAt = new Date();
  else if (body.retired === false) data.retiredAt = null;
  if (Array.isArray(body.tags)) data.tags = body.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean).slice(0, 12).join(", ");
  else if (typeof body.tags === "string") data.tags = body.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 12).join(", ");
  if (body.clientId === null) { data.alertClientId = null; data.clientName = ""; }
  else if (typeof body.clientId === "string" && body.clientId) {
    const client = await resolveAlertClient(body.clientId);
    if (!client) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
    data.alertClientId = client.id; data.clientName = client.name;
  }
  if (body.reanalyse === true) {
    const dataUri = row.file ? await mediaFileDataUri(row.file) : null;
    const analysis = await analyseTemplate({ image: dataUri ? dataUriToRelayImage(dataUri, "template") : null, title: row.title, body: row.body, brand: row.brand || null, user: { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "" } });
    data.analysisJson = JSON.stringify(analysis);
  }
  const updated = Object.keys(data).length ? await prisma.creativeTemplate.update({ where: { id: row.id }, data }) : row;
  const uses = await prisma.creativeAsset.count({ where: { templateId: row.id, deletedAt: null } });
  return NextResponse.json({ template: templateView(updated, guard.session.userId, uses, (await templateVerdicts([updated.id])).get(updated.id)) }, NO_STORE);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await loadTemplate(id);
  if (!row) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  if (row.createdById !== guard.session.userId && guard.session.baseRole !== "admin") return NextResponse.json({ error: "Seul son auteur peut le retirer." }, { status: 403 });
  await prisma.creativeTemplate.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
