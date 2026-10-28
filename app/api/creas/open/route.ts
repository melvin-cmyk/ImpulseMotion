/**
 * POST /api/creas/open → open a template or a generated visual in an editor (staff).
 *   { editor: "figcraft" | "photocraft", templateId? | assetId?, clientId? (registry or dashboard id), name? }
 *   → 201 { designId, ask }
 * Creates the design for the client (FigCraft: a 1080 × 1350 frame;
 * PhotoCraft: a workspace), drops the picture in its uploads/, and hands
 * back the first message for the design copilot — the design page sends it
 * on arrival (/design/<id>?ask=…).
 */

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { DESIGN_SELECT, toDesignListItem } from "@/lib/design/access";
import { designSessionKey, parseDesignKind } from "@/lib/design/model";
import { createDesignFile } from "@/lib/design/relay";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { workspaceIdFor } from "@/lib/relay-workspace";
import { mediaFileDataUri } from "@/lib/creas/media";
import { parseAnalysis } from "@/lib/creas/model";
import { buildEditorAsk, loadTemplate, resolveAlertClient } from "@/lib/creas/templates";

async function dropInWorkspace(sessionKey: string, name: string, data: string): Promise<boolean> {
  const ws = workspaceIdFor(sessionKey);
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/files/${ws}`, { method: "POST", headers: relayHeaders(), body: JSON.stringify({ name, data }), signal: AbortSignal.timeout(30000) });
      if (res.ok) return true;
    } catch { /* next relay */ }
  }
  return false;
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as { editor?: unknown; clientId?: unknown; name?: unknown; templateId?: unknown; assetId?: unknown };
  const kind = parseDesignKind(body.editor);
  // Source: a template of the swipe file, or a visual generated for the client (opened as a one-off template).
  let template: { id: string; name: string; brand: string; file: string | null; analysisJson: string } | null = null;
  let sourceAssetId: string | null = null;
  if (typeof body.templateId === "string") template = await loadTemplate(body.templateId);
  else if (typeof body.assetId === "string" && /^[a-z0-9]{10,40}$/i.test(body.assetId)) {
    const asset = await prisma.creativeAsset.findUnique({ where: { id: body.assetId } });
    if (asset && !asset.deletedAt && asset.kind === "image") { sourceAssetId = asset.id; template = { id: asset.id, name: asset.prompt.slice(0, 80) || "Visuel", brand: asset.clientName, file: asset.file, analysisJson: "{}" }; }
  }
  if (!template) return NextResponse.json({ error: "Template ou visuel introuvable." }, { status: 404 });
  const client = typeof body.clientId === "string" && body.clientId ? await resolveAlertClient(body.clientId) : null;
  // The design is attached to a dashboard of the client when it has one (its name and HQ brief feed the copilot):
  // the id given when it is a dashboard, else the client's registered dashboard.
  const given = typeof body.clientId === "string" && /^[a-z0-9]{10,40}$/i.test(body.clientId) ? await prisma.dashboard.findUnique({ where: { id: body.clientId }, select: { id: true } }) : null;
  const registered = !given && client ? await prisma.alertClient.findUnique({ where: { id: client.id }, select: { dashboardId: true } }) : null;
  const clientDashboardId = given?.id ?? registered?.dashboardId ?? null;

  const dataUri = template.file ? await mediaFileDataUri(template.file) : null;
  if (!dataUri) return NextResponse.json({ error: "Ce template n'a pas d'image à ouvrir." }, { status: 400 });
  const m = dataUri.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!m) return NextResponse.json({ error: "Image du template illisible." }, { status: 400 });
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  const fileName = `template-${template.id.slice(-6)}.${ext}`;
  const name = (typeof body.name === "string" && body.name.trim() ? body.name.trim() : `${client ? `${client.name} — ` : ""}${template.name}`).slice(0, 120);

  let created: { fileId: string; editLink: string; viewLink: string };
  if (kind === "photocraft") created = { fileId: `pc_${randomBytes(12).toString("hex")}`, editLink: "", viewLink: "" };
  else {
    try { created = await createDesignFile({ name, width: 1080, height: 1350, frameName: name }); }
    catch (e) { return NextResponse.json({ error: `Le design n'a pas pu être créé (${e instanceof Error ? e.message : String(e)}).` }, { status: 502 }); }
  }
  const row = await prisma.designFile.create({
    data: { ownerId: guard.session.userId, name, kind, clientDashboardId, fileId: created.fileId, editLink: created.editLink, viewLink: created.viewLink },
    select: DESIGN_SELECT,
  });
  const dropped = await dropInWorkspace(designSessionKey(row.id), fileName, m[2]);
  const ask = sourceAssetId
    ? (kind === "figcraft"
      ? `Le fichier uploads/${fileName} est un visuel généré par l'IA${client ? ` pour « ${client.name} »` : ""}. Place-le dans ce design en calque de fond et prépare au-dessus des calques de texte (titre, sous-titre, bouton) modifiables, en français, adaptés à la marque. Termine par un export out/visuel.png.`
      : `Le fichier uploads/${fileName} est un visuel généré par l'IA${client ? ` pour « ${client.name} »` : ""}. Ouvre-le pour retouche : corrige les défauts visibles, garde la composition, et enregistre out/visuel.png et out/visuel.psd.`)
    : buildEditorAsk({ editor: kind, file: fileName, template, analysis: parseAnalysis(template.analysisJson), clientName: client?.name ?? null });
  return NextResponse.json({ design: toDesignListItem(row, guard.session), designId: row.id, ask: dropped ? ask : null, dropped }, { status: 201 });
}
