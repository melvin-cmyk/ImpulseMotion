/**
 * POST /api/creas/templates/[id]/copy → « Copier à la marque » (staff).
 *   { clientId, instructions?, n? (1–4), engine? ("agnes" | fal model with references), ratio?, textless?, assets?: dataURI[] (≤ 2 brand visuals), assetIds?: string[] (brand assets of the client) }
 *   → 201 { assets: AssetView[], failed, cost }
 * The template's picture is reference 1, the brand's visuals follow; the
 * generator keeps the composition and swaps the brand. Daily quotas apply
 * (lib/quotas.ts); the price is the engine's list price per image.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { IMAGE_RATIOS, dataUriOk, isFalModel, relayFalImage, relayFalModels, relayImage } from "@/lib/studio";
import { assetView } from "@/lib/studio-assets";
import { checkGeneration, readQuotas, spentToday } from "@/lib/quotas";
import { mediaFileDataUri } from "@/lib/creas/media";
import { parseAnalysis } from "@/lib/creas/model";
import { buildCopyPrompt, loadTemplate, resolveAlertClient } from "@/lib/creas/templates";

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const template = await loadTemplate(id);
  if (!template) return NextResponse.json({ error: "Template introuvable." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const client = typeof body.clientId === "string" ? await resolveAlertClient(body.clientId) : null;
  if (!client) return NextResponse.json({ error: "Choisissez le client pour lequel copier ce template." }, { status: 400 });

  const n = Math.min(4, Math.max(1, Math.round(Number(body.n) || 1)));
  const ratio = (IMAGE_RATIOS as readonly string[]).includes(String(body.ratio)) ? String(body.ratio) : "1:1";
  const textless = body.textless !== false;
  const instructions = typeof body.instructions === "string" ? body.instructions.trim().slice(0, 1500) : "";
  const engine = isFalModel(body.engine) ? body.engine : null;

  // References: the template, then the brand visuals (sent now or kept as brand assets of the client).
  const templateUri = template.file ? await mediaFileDataUri(template.file) : null;
  if (!templateUri) return NextResponse.json({ error: "Ce template n'a pas d'image exploitable : ajoutez-en une (ou copiez son brief dans le Studio)." }, { status: 400 });
  const sent = Array.isArray(body.assets) ? body.assets.filter(dataUriOk).slice(0, 2) : [];
  const kept: string[] = [];
  if (Array.isArray(body.assetIds)) {
    const rows = await prisma.creativeAsset.findMany({ where: { id: { in: body.assetIds.filter((x): x is string => typeof x === "string").slice(0, 4) }, deletedAt: null, status: "completed" }, select: { file: true } });
    for (const r of rows) { if (kept.length + sent.length >= 2) break; const uri = r.file ? await mediaFileDataUri(r.file) : null; if (uri) kept.push(uri); }
  }
  const refs = [templateUri, ...sent, ...kept].slice(0, 3);

  // Price and caps.
  let unitUsd = 0;
  if (engine) { try { unitUsd = (await relayFalModels()).models.find((m) => m.id === engine)?.usd ?? 0; } catch { unitUsd = 0; } }
  const gate = checkGeneration(await readQuotas(), await spentToday(guard.session.userId), unitUsd * n, n);
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 429 });

  const analysis = parseAnalysis(template.analysisJson);
  const prompt = buildCopyPrompt({ template, analysis, clientName: client.name, instructions, assets: refs.length - 1, textless });
  const author = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { name: true, email: true } });
  const base = { createdById: guard.session.userId, createdByName: (author?.name ?? "").trim() || author?.email || "Consultant", alertClientId: client.id, clientName: client.name, prompt: instructions || `Copie du template « ${template.name} »` };
  const group = `t_${Date.now().toString(36)}`;

  type Out = { url: string; file: string | null; model: string; usd: number };
  let results: Array<PromiseSettledResult<Out>>;
  let usedEngine = engine ?? "agnes";
  if (engine) {
    try {
      const out = await relayFalImage({ prompt, model: engine, ratio, images: refs, n });
      results = out.urls.map((url, i) => ({ status: "fulfilled" as const, value: { url, file: out.files[i] ?? null, model: out.model, usd: out.usd / Math.max(1, out.urls.length) } }));
    } catch (e) {
      // The fal key may not allow this model yet: Agnes (free, references accepted) takes over.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/n'autorise pas ce modèle|does not have access/i.test(msg)) return NextResponse.json({ error: `La copie n'a pas pu être générée : ${msg}` }, { status: 502 });
      usedEngine = "agnes";
      results = await Promise.allSettled(Array.from({ length: n }, () => relayImage({ prompt, ratio, size: "2K", images: refs }).then((o) => ({ url: o.url, file: o.file, model: o.model, usd: 0 }))));
    }
  } else {
    results = await Promise.allSettled(Array.from({ length: n }, () => relayImage({ prompt, ratio, size: "2K", images: refs }).then((o) => ({ url: o.url, file: o.file, model: o.model, usd: 0 }))));
  }
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!ok.length) {
    const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    return NextResponse.json({ error: `La copie n'a pas pu être générée : ${first?.reason instanceof Error ? first.reason.message : String(first?.reason ?? "")}` }, { status: 502 });
  }
  const paramsJson = JSON.stringify({ ratio, engine: usedEngine, references: refs.length, mode: "edit", textless, promptSent: prompt, group, variants: n, templateId: template.id, templateName: template.name });
  const created = [];
  for (const out of ok) {
    created.push(await prisma.creativeAsset.create({ data: { ...base, kind: "image", model: out.model, paramsJson, status: "completed", progress: 100, url: out.url, file: out.file, costUsd: out.usd, templateId: template.id, origin: "template" } }));
  }
  return NextResponse.json({ assets: created.map((a) => assetView(a, guard.session.userId)), failed: n - ok.length, cost: ok.reduce((s, o) => s + o.usd, 0), engine: usedEngine }, { status: 201 });
}
