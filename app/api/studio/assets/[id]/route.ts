/**
 * GET    /api/studio/assets/[id] → the asset, a video in progress being asked again (polling of the page)
 * PATCH  /api/studio/assets/[id] { feedback?: "keep"|"cut"|null, feedbackNote?, clientId? } → the consultant's verdict on a
 *        generated visual; keep / cut and the note are journaled in the client's HQ project (what works, what to stop).
 * DELETE /api/studio/assets/[id] → hidden from the Studio (its author or an admin)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { assetView, refreshVideo } from "@/lib/studio-assets";
import { appendHqJournal } from "@/lib/hq-journal";
import { resolveAlertClient } from "@/lib/creas/templates";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await prisma.creativeAsset.findUnique({ where: { id } });
  if (!row || row.deletedAt) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  return NextResponse.json({ asset: assetView(await refreshVideo(row), guard.session.userId) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await prisma.creativeAsset.findUnique({ where: { id } });
  if (!row || row.deletedAt) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { feedback?: unknown; feedbackNote?: unknown; clientId?: unknown };
  const data: { feedback?: string | null; feedbackNote?: string | null; alertClientId?: string; clientName?: string } = {};
  if (body.feedback === null || body.feedback === "keep" || body.feedback === "cut") data.feedback = body.feedback;
  if (typeof body.feedbackNote === "string") data.feedbackNote = body.feedbackNote.trim().slice(0, 2000) || null;
  if (typeof body.clientId === "string" && body.clientId) {
    const client = await resolveAlertClient(body.clientId);
    if (!client) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
    data.alertClientId = client.id; data.clientName = client.name;
  }
  if (!Object.keys(data).length) return NextResponse.json({ error: "Rien à enregistrer." }, { status: 400 });
  const updated = await prisma.creativeAsset.update({ where: { id }, data });
  // The verdict feeds the client's memory (HQ): a short dated entry, best effort.
  let hq: { ok: boolean; error?: string } = { ok: false };
  if ((data.feedback !== undefined || data.feedbackNote !== undefined) && updated.alertClientId && (updated.feedback || updated.feedbackNote)) {
    const client = await resolveAlertClient(updated.alertClientId);
    if (client?.hqSlug) {
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(updated.paramsJson); } catch { params = {}; }
      const verdict = updated.feedback === "keep" ? "GARDÉE" : updated.feedback === "cut" ? "COUPÉE" : "commentée";
      const who = guard.session.user?.name ?? guard.session.user?.email ?? "consultant";
      const content = [
        `## Créa IA ${verdict} — ${new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })}`,
        `- Visuel : « ${updated.prompt.slice(0, 120)} » (${updated.model}${typeof params.templateName === "string" ? `, template « ${params.templateName} »` : ""}, ${updated.createdByName})`,
        `- Verdict de ${who} : ${verdict.toLowerCase()}${updated.feedbackNote ? ` — ${updated.feedbackNote}` : ""}`,
        `- Lien : /creas?client=${updated.alertClientId}&asset=${updated.id}`,
      ].join("\n");
      hq = await appendHqJournal({ project: client.hqSlug, slug: `crea-${updated.id.slice(-8)}`, content }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    } else hq = { ok: false, error: "Ce client n'a pas de dossier HQ rattaché : le retour reste dans ImpulseMotion." };
  }
  return NextResponse.json({ asset: assetView(updated, guard.session.userId), hq }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await prisma.creativeAsset.findUnique({ where: { id }, select: { createdById: true, deletedAt: true } });
  if (!row || row.deletedAt) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  if (row.createdById !== guard.session.userId && guard.session.baseRole !== "admin") return NextResponse.json({ error: "Seul son auteur peut le retirer." }, { status: 403 });
  await prisma.creativeAsset.update({ where: { id }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
