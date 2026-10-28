/**
 * POST /api/creas/variations → « Plus comme ça » (staff): new visuals from one
 * of the client's generated visuals, kept as reference.
 *   { assetId, n? (1–4), instructions?, engine? } → 201 { assets, failed, cost, engine }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { isFalModel, relayFalImage, relayFalModels, relayImage } from "@/lib/studio";
import { assetView } from "@/lib/studio-assets";
import { checkGeneration, readQuotas, spentToday } from "@/lib/quotas";
import { mediaFileDataUri } from "@/lib/creas/media";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const src = typeof body.assetId === "string" ? await prisma.creativeAsset.findUnique({ where: { id: body.assetId } }) : null;
  if (!src || src.deletedAt || src.kind !== "image" || src.status !== "completed") return NextResponse.json({ error: "Visuel de départ introuvable." }, { status: 404 });
  const ref = src.file ? await mediaFileDataUri(src.file) : null;
  if (!ref) return NextResponse.json({ error: "Ce visuel n'a plus de copie exploitable." }, { status: 400 });

  const n = Math.min(4, Math.max(1, Math.round(Number(body.n) || 2)));
  const instructions = typeof body.instructions === "string" ? body.instructions.trim().slice(0, 1500) : "";
  const engine = isFalModel(body.engine) ? body.engine : null;
  let params: Record<string, unknown> = {};
  try { params = JSON.parse(src.paramsJson); } catch { params = {}; }
  const ratio = typeof params.ratio === "string" ? params.ratio : "1:1";

  let unitUsd = 0;
  if (engine) { try { unitUsd = (await relayFalModels()).models.find((m) => m.id === engine)?.usd ?? 0; } catch { unitUsd = 0; } }
  const gate = checkGeneration(await readQuotas(), await spentToday(guard.session.userId), unitUsd * n, n);
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 429 });

  const prompt = [
    `Image 1 = une publicité validée${src.clientName ? ` pour la marque « ${src.clientName} »` : ""}. Produis une NOUVELLE variante dans le même esprit : même marque, même produit, même niveau de qualité, mais une composition, un angle ou un décor différents — pas une copie.`,
    typeof params.promptSent === "string" && params.promptSent ? `Consigne d'origine, pour mémoire : ${String(params.promptSent).slice(0, 800)}` : "",
    instructions ? `Ce que le consultant veut changer : ${instructions}` : "",
    params.textless === false ? "Textes courts en français, lisibles, sans faute." : "Ne dessine aucun texte ni logo (ils sont posés ensuite).",
    "Une seule image, cadrage publicitaire propre, rendu net, sans filigrane.",
  ].filter(Boolean).join("\n");

  type Out = { url: string; file: string | null; model: string; usd: number };
  let results: Array<PromiseSettledResult<Out>>;
  let usedEngine = engine ?? "agnes";
  const viaAgnes = () => Promise.allSettled(Array.from({ length: n }, () => relayImage({ prompt, ratio, size: "2K", images: [ref] }).then((o) => ({ url: o.url, file: o.file, model: o.model, usd: 0 }))));
  if (engine) {
    try {
      const out = await relayFalImage({ prompt, model: engine, ratio, images: [ref], n });
      results = out.urls.map((url, i) => ({ status: "fulfilled" as const, value: { url, file: out.files[i] ?? null, model: out.model, usd: out.usd / Math.max(1, out.urls.length) } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/n'autorise pas ce modèle|does not have access/i.test(msg)) return NextResponse.json({ error: `La variante n'a pas pu être générée : ${msg}` }, { status: 502 });
      usedEngine = "agnes"; results = await viaAgnes();
    }
  } else results = await viaAgnes();
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!ok.length) {
    const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    return NextResponse.json({ error: `La variante n'a pas pu être générée : ${first?.reason instanceof Error ? first.reason.message : String(first?.reason ?? "")}` }, { status: 502 });
  }
  const author = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { name: true, email: true } });
  const paramsJson = JSON.stringify({ ...params, engine: usedEngine, references: 1, mode: "edit", promptSent: prompt, group: `v_${Date.now().toString(36)}`, variants: n, variationOf: src.id });
  const created = [];
  for (const out of ok) {
    created.push(await prisma.creativeAsset.create({ data: {
      createdById: guard.session.userId, createdByName: (author?.name ?? "").trim() || author?.email || "Consultant", alertClientId: src.alertClientId, clientName: src.clientName,
      prompt: instructions || `Variante de « ${src.prompt.slice(0, 80)} »`, kind: "image", model: out.model, paramsJson, status: "completed", progress: 100, url: out.url, file: out.file, costUsd: out.usd,
      sourceId: src.id, templateId: src.templateId, origin: "variation",
    } }));
  }
  return NextResponse.json({ assets: created.map((a) => assetView(a, guard.session.userId)), failed: n - ok.length, cost: ok.reduce((s, o) => s + o.usd, 0), engine: usedEngine }, { status: 201 });
}
