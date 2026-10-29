/**
 * Storage of the swipe file (CreativeTemplate) and the prompts of « Copier à
 * la marque » and of the editors. Server only.
 */

import type { CreativeTemplate } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publicMediaUrl } from "@/lib/studio";
import { analysisIsEmpty, parseAnalysis, parseTags, type TemplateAnalysis, type TemplateView } from "@/lib/creas/model";

export const TEMPLATE_ID_RE = /^[a-z0-9]{10,40}$/i;

/** An agency client by its registry id (AlertClient) or by one of its dashboards. */
export async function resolveAlertClient(id: string | null | undefined): Promise<{ id: string; name: string; hqSlug: string | null } | null> {
  if (!id || !/^[a-z0-9]{10,40}$/i.test(id)) return null;
  const byId = await prisma.alertClient.findUnique({ where: { id }, select: { id: true, name: true, hqSlug: true, gone: true } });
  if (byId && !byId.gone) return { id: byId.id, name: byId.name, hqSlug: byId.hqSlug };
  const dash = await prisma.dashboard.findUnique({ where: { id }, select: { id: true, name: true, hqSlug: true, metaAccountId: true, googleCustomerId: true } });
  if (!dash) return null;
  const byDash = await prisma.alertClient.findFirst({ where: { dashboardId: dash.id, gone: false }, select: { id: true, name: true, hqSlug: true } });
  if (byDash) return { ...byDash, hqSlug: byDash.hqSlug ?? dash.hqSlug };
  // A dashboard whose client row carries another dashboard: find the client through its accounts.
  const all = await prisma.alertClient.findMany({ where: { gone: false }, select: { id: true, name: true, hqSlug: true, accountsJson: true } });
  for (const c of all) {
    let accs: Array<{ platform: string; accountId: string }> = [];
    try { accs = JSON.parse(c.accountsJson); } catch { accs = []; }
    if (accs.some((a) => (a.platform === "meta" && dash.metaAccountId && a.accountId.replace(/^act_/, "") === dash.metaAccountId.replace(/^act_/, "")) || (a.platform === "google" && dash.googleCustomerId && a.accountId.replace(/-/g, "") === dash.googleCustomerId.replace(/-/g, "")))) {
      return { id: c.id, name: c.name, hqSlug: c.hqSlug ?? dash.hqSlug };
    }
  }
  return null;
}

/** The agency client owning an ad account (registry accountsJson), or null. */
export async function clientOfAccount(platform: string, accountId: string): Promise<{ id: string; name: string; hqSlug: string | null } | null> {
  const norm = (p: string, id: string) => (p === "meta" ? id.replace(/^act_/, "") : p === "google" ? id.replace(/-/g, "") : id);
  const wanted = norm(platform, accountId);
  const rows = await prisma.alertClient.findMany({ where: { gone: false }, select: { id: true, name: true, hqSlug: true, accountsJson: true } });
  for (const c of rows) {
    let accs: Array<{ platform: string; accountId: string }> = [];
    try { accs = JSON.parse(c.accountsJson); } catch { accs = []; }
    if (accs.some((a) => a.platform === platform && norm(a.platform, a.accountId) === wanted)) return { id: c.id, name: c.name, hqSlug: c.hqSlug };
  }
  return null;
}

export const OWN_AD_ID_RE = /^(meta|google|tiktok|linkedin):[\w-]+$/;

/**
 * One of the client's own ads kept as a template (source « own », Analyse Ads
 * and Mo « Garder »): picture, texts and name from the warehouse, the client
 * from the ad's account when none is given. Null when the ad is unknown.
 */
export async function ownAdTemplateSource(adId: string): Promise<{ sourceRef: string; imageUrl: string | null; title: string; body: string; name: string; client: { id: string; name: string; hqSlug: string | null } | null } | null> {
  if (!OWN_AD_ID_RE.test(adId)) return null;
  const ad = await prisma.adCatalog.findUnique({ where: { id: adId } });
  if (!ad) return null;
  return { sourceRef: ad.id, imageUrl: ad.imageUrl ?? ad.thumbnailUrl ?? null, title: ad.title ?? "", body: ad.body ?? "", name: ad.name.slice(0, 120), client: await clientOfAccount(ad.platform, ad.accountId) };
}

export function templateView(row: CreativeTemplate, viewerId: string, uses = 0, verdicts: { kept: number; cut: number } = { kept: 0, cut: 0 }): TemplateView {
  return {
    id: row.id, name: row.name, source: (row.source === "competitor" || row.source === "own" ? row.source : "upload"), brand: row.brand,
    clientId: row.alertClientId, clientName: row.clientName, sourceRef: row.sourceRef, sourceUrl: row.sourceUrl,
    image: row.file ? publicMediaUrl(row.file, 6 * 3600) ?? row.imageUrl : row.imageUrl,
    title: row.title, body: row.body, analysis: parseAnalysis(row.analysisJson), tags: parseTags(row.tags),
    createdByName: row.createdByName, createdAt: row.createdAt.toISOString(), mine: row.createdById === viewerId, uses,
    kept: verdicts.kept, cut: verdicts.cut, retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
  };
}

export async function loadTemplate(id: string) {
  if (!TEMPLATE_ID_RE.test(id)) return null;
  const row = await prisma.creativeTemplate.findUnique({ where: { id } });
  return row && !row.deletedAt ? row : null;
}

/** The brief of « Copier à la marque » for the generator: template first, then the brand's assets, then the consultant's wishes. */
export function buildCopyPrompt(opts: { template: Pick<CreativeTemplate, "name" | "brand" | "title" | "body">; analysis: TemplateAnalysis; clientName: string; instructions: string; assets: number; textless: boolean }): string {
  const a = opts.analysis;
  const parts = [
    `Image 1 = une publicité qui sert de TEMPLATE${opts.template.brand ? ` (marque d'origine : ${opts.template.brand})` : ""}. Recrée cette publicité pour la marque « ${opts.clientName} » : même composition, même hiérarchie visuelle, même ambiance, mais avec les produits, les couleurs et l'univers de « ${opts.clientName} ».`,
    opts.assets ? `Images 2 à ${1 + opts.assets} = les éléments de marque de « ${opts.clientName} » (logo, produits, photos) : utilise-les tels quels, sans les déformer ni réinventer le produit.` : `Aucun visuel de marque fourni : invente un produit crédible et neutre pour « ${opts.clientName} », en restant générique.`,
    !analysisIsEmpty(a) ? `Ce qu'on garde du template : ${[a.hook && `accroche « ${a.hook} »`, a.structure && `structure : ${a.structure}`, a.style && `style : ${a.style}`].filter(Boolean).join(" ; ")}.` : "",
    opts.textless
      ? "Ne dessine AUCUN texte, AUCUN logo, AUCUN bouton dans l'image : laisse des zones calmes là où le template place ses textes (ils seront posés ensuite)."
      : a.textZones.length ? `Zones de texte à prévoir, dans cet ordre : ${a.textZones.map((z) => `${z.role}${z.text ? ` (« ${z.text} » à adapter à la marque, en français)` : ""}`).join(", ")}. Le texte doit être lisible et sans faute.` : "Textes courts, en français, lisibles.",
    opts.instructions ? `Consignes du consultant : ${opts.instructions}` : "",
    "Une seule image, cadrage publicitaire propre, rendu réaliste et net, sans filigrane.",
  ];
  return parts.filter(Boolean).join("\n");
}

/** What the design copilot is asked when a template is opened in FigCraft / PhotoCraft. */
export function buildEditorAsk(opts: { editor: "figcraft" | "photocraft"; file: string; template: Pick<CreativeTemplate, "name" | "brand">; analysis: TemplateAnalysis; clientName: string | null }): string {
  const a = opts.analysis;
  const brand = opts.clientName ? `pour la marque « ${opts.clientName} »` : "pour l'agence";
  const keep = [a.structure && `structure : ${a.structure}`, a.textZones.length && `zones de texte : ${a.textZones.map((z) => z.role).join(", ")}`, a.palette.length && `palette : ${a.palette.join(", ")}`].filter(Boolean).join(" ; ");
  if (opts.editor === "figcraft") {
    return `Le fichier uploads/${opts.file} est une publicité qui sert de template (« ${opts.template.name} »${opts.template.brand ? `, marque d'origine ${opts.template.brand}` : ""}). Reconstruis-la ${brand} en calques modifiables dans ce design : place l'image du template en calque de référence verrouillé en arrière-plan, puis recrée au-dessus chaque zone (fond, visuel, textes, bouton) en calques séparés, avec des textes en français adaptés à la marque.${keep ? ` À garder : ${keep}.` : ""} Termine par un export out/template.png et dis ce qui reste à remplacer (produit, logo).`;
  }
  return `Le fichier uploads/${opts.file} est une publicité qui sert de template (« ${opts.template.name} »${opts.template.brand ? `, marque d'origine ${opts.template.brand}` : ""}). Prépare-en une version ${brand} : ouvre-la, nettoie ce qui appartient à la marque d'origine (logo, mentions, produit si possible), garde la composition${keep ? ` (${keep})` : ""}, et enregistre le résultat en out/template.png et en out/template.psd pour la retouche à la main. Dis ce qui reste à remplacer.`;
}

/** Keep / cut counts of the visuals made from each template (feedback of the consultants). */
export async function templateVerdicts(ids: string[]): Promise<Map<string, { kept: number; cut: number }>> {
  const out = new Map<string, { kept: number; cut: number }>();
  if (!ids.length) return out;
  const rows = await prisma.creativeAsset.groupBy({ by: ["templateId", "feedback"], where: { templateId: { in: ids }, deletedAt: null, feedback: { in: ["keep", "cut"] } }, _count: { _all: true } });
  for (const r of rows) {
    if (!r.templateId) continue;
    const v = out.get(r.templateId) ?? { kept: 0, cut: 0 };
    if (r.feedback === "keep") v.kept += r._count._all; else v.cut += r._count._all;
    out.set(r.templateId, v);
  }
  return out;
}
