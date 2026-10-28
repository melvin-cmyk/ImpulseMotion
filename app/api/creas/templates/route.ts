/**
 * Swipe file (staff).
 *   GET  ?client=<AlertClient id | dashboard id>  → { templates } : the client's templates + the agency's shared ones (newest first)
 *   POST → 201 { template } : keep an ad as a template
 *        { name?, clientId?, source: "competitor"|"own"|"upload", brand?, tags?,
 *          image?: dataURI | imageUrl?: https | adId?: "meta:<id>" (own: picture and texts from the warehouse),
 *          title?, body?, sourceUrl?, sourceRef?, analyse?: boolean (default true) }
 *        The picture is copied on the relay (never hot-linked for long) and read by the AI (hook, structure, brief).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { dataUriOk, relayUpload } from "@/lib/studio";
import { TEMPLATE_SOURCES, type TemplateSource } from "@/lib/creas/model";
import { dataUriToRelayImage, fetchImageBytes, toDataUri } from "@/lib/creas/media";
import { analyseTemplate } from "@/lib/creas/analysis";
import { OWN_AD_ID_RE, ownAdTemplateSource, resolveAlertClient, templateView } from "@/lib/creas/templates";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const MAX_LIST = 200;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const clientParam = req.nextUrl.searchParams.get("client");
  const client = clientParam ? await resolveAlertClient(clientParam) : null;
  const rows = await prisma.creativeTemplate.findMany({
    where: { deletedAt: null, ...(client ? { OR: [{ alertClientId: client.id }, { alertClientId: null }] } : clientParam ? { alertClientId: null } : {}) },
    orderBy: { createdAt: "desc" }, take: MAX_LIST,
  });
  const uses = await prisma.creativeAsset.groupBy({ by: ["templateId"], where: { templateId: { in: rows.map((r) => r.id) }, deletedAt: null }, _count: { _all: true } });
  const count = new Map(uses.map((u) => [u.templateId, u._count._all]));
  return NextResponse.json({ templates: rows.map((r) => templateView(r, guard.session.userId, count.get(r.id) ?? 0)), client: client ? { id: client.id, name: client.name } : null }, NO_STORE);
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Demande illisible." }, { status: 400 });
  const source: TemplateSource = (TEMPLATE_SOURCES as readonly string[]).includes(String(body.source)) ? (body.source as TemplateSource) : "upload";
  let client = typeof body.clientId === "string" && body.clientId ? await resolveAlertClient(body.clientId) : null;
  if (body.clientId && !client) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });

  let brand = typeof body.brand === "string" ? body.brand.trim().slice(0, 120) : "";
  let title = typeof body.title === "string" ? body.title.trim().slice(0, 500) : "";
  let text = typeof body.body === "string" ? body.body.trim().slice(0, 4000) : "";
  let imageUrl = typeof body.imageUrl === "string" && /^https:\/\/\S+$/.test(body.imageUrl) ? body.imageUrl.slice(0, 2000) : null;
  let sourceRef = typeof body.sourceRef === "string" ? body.sourceRef.slice(0, 120) : null;
  const sourceUrl = typeof body.sourceUrl === "string" && /^https?:\/\/\S+$/.test(body.sourceUrl) ? body.sourceUrl.slice(0, 2000) : null;
  let dataUri: string | null = dataUriOk(body.image) ? body.image : null;
  let name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";

  // One of the client's own ads (Analyse Ads « Garder comme template »): picture and texts from the warehouse.
  if (typeof body.adId === "string" && OWN_AD_ID_RE.test(body.adId)) {
    const ad = await ownAdTemplateSource(body.adId);
    if (!ad) return NextResponse.json({ error: "Annonce introuvable dans l'entrepôt." }, { status: 404 });
    sourceRef = ad.sourceRef;
    imageUrl = imageUrl ?? ad.imageUrl;
    title = title || ad.title;
    text = text || ad.body;
    name = name || ad.name;
    // No client given: the ad's account tells which client it belongs to.
    if (!client) client = ad.client;
    brand = brand || client?.name || "";
  }
  if (!dataUri && imageUrl) {
    const got = await fetchImageBytes(imageUrl);
    if (got) dataUri = toDataUri(got.buf, got.mediaType);
  }
  if (!dataUri && !title && !text) return NextResponse.json({ error: "Donnez une image (fichier, capture ou lien https) ou au moins le texte de la publicité." }, { status: 400 });

  let file: string | null = null;
  if (dataUri) {
    try { file = (await relayUpload(dataUri)).file; } catch (e) { return NextResponse.json({ error: `L'image n'a pas pu être enregistrée : ${e instanceof Error ? e.message : String(e)}` }, { status: 502 }); }
  }
  const author = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { name: true, email: true } });
  const user = { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "" };
  const analysis = body.analyse === false ? null : await analyseTemplate({ image: dataUri ? dataUriToRelayImage(dataUri, "template") : null, title, body: text, brand: brand || null, user });
  if (!name) name = analysis?.hook || title.slice(0, 80) || (brand ? `Pub ${brand}` : "Template");

  const row = await prisma.creativeTemplate.create({
    data: {
      alertClientId: client?.id ?? null, clientName: client?.name ?? "", name, source, brand, sourceRef, sourceUrl, imageUrl, file,
      title: title || null, body: text || null, analysisJson: JSON.stringify(analysis ?? {}),
      tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean).slice(0, 12).join(", ") : typeof body.tags === "string" ? body.tags.slice(0, 300) : "",
      createdById: guard.session.userId, createdByName: (author?.name ?? "").trim() || author?.email || "Consultant",
    },
  });
  return NextResponse.json({ template: templateView(row, guard.session.userId, 0) }, { status: 201, ...NO_STORE });
}
