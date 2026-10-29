/**
 * Playbook d'une marque — pure part (I/O in ./playbook.ts). The ads a brand
 * runs (Meta Ad Library), each read by the AI (hook, structure, text zones,
 * style), grouped into recurring FORMATS: how often each comes back, which
 * ads show it, and whether it is « polyvalent » (reusable for another brand:
 * a layout, not a product-specific trick) or « spécifique ».
 */

import type { TemplateAnalysis } from "@/lib/creas/model";

export interface PlaybookCandidate {
  libraryId: string;
  pageName: string;
  image: string | null;
  text: string;
  startedAt: string | null;
  video: boolean;
  snapshotUrl: string | null;
  analysis: TemplateAnalysis;
  /** Label of the format it belongs to (filled by groupFormats). */
  format: string;
}

export interface PlaybookFormat {
  label: string;
  count: number;
  /** Share of the analysed ads, in %. */
  share: number;
  libraryIds: string[];
  verdict: "polyvalent" | "spécifique";
  structure: string;
  style: string;
  why: string;
}

export interface Playbook {
  brand: string;
  country: string;
  at: string;
  /** Ads found in the library, ads analysed. */
  total: number;
  analysed: number;
  formats: PlaybookFormat[];
  candidates: PlaybookCandidate[];
  md: string;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Canonical formats, recognised in the AI's words (hook + structure + style); the first match wins. */
export const FORMAT_RULES: Array<{ label: string; re: RegExp }> = [
  { label: "Avant / après", re: /\bavant\b.*\bapres\b|before after|split screen|\bvs\b|versus|comparati/ },
  { label: "Témoignage / avis client", re: /temoign|avis client|\bavis\b|review|citation|verbatim|\bquote\b|etoiles|\bnote\b \d/ },
  { label: "UGC / face caméra", re: /\bugc\b|face camera|selfie|smartphone|tiktok|creat(eur|rice)|influen/ },
  { label: "Chiffre ou preuve chiffrée", re: /\bchiffre|\d+ ?%|statisti|\bpreuve\b|resultat chiffre|nombre de/ },
  { label: "Liste de bénéfices", re: /\bliste\b|benefices|checklist|puces|coches|\bpoints?\b cles|raisons/ },
  { label: "Offre encadrée / promo", re: /\bpromo|remise|reduction|\boffre\b|code promo|soldes|prix barre|\bgratuit|black friday/ },
  { label: "Question / problème", re: /\bquestion\b|\bprobleme\b|douleur|pain point|\bvous aussi\b|\btu en as marre/ },
  { label: "Produit héros", re: /packshot|produit (geant|central|centre|en gros|heros|seul|isole)|gros plan (sur le|du) produit|mise en avant du produit/ },
  { label: "Titre en gros / typographique", re: /typograph|titre en gros|gros titre|texte seul|texte (en|tres) gros|accroche en gros/ },
  { label: "Lifestyle / mise en situation", re: /lifestyle|mise en situation|scene de vie|en situation|ambiance|famille|personnage/ },
  { label: "Meme / humour", re: /\bmeme\b|humour|second degre|blague/ },
];

/** The format of one analysed ad. */
export function formatOf(a: Pick<TemplateAnalysis, "hook" | "structure" | "style">): string {
  const hook = fold(a.hook);
  for (const r of FORMAT_RULES) if (r.re.test(hook)) return r.label;
  const all = fold(`${a.hook} ${a.structure} ${a.style}`);
  for (const r of FORMAT_RULES) if (r.re.test(all)) return r.label;
  return a.hook.trim() ? "Autre" : "Non lu";
}

/** Product-specific when the brief or the structure names the brand/product as the trick itself. */
function specific(group: PlaybookCandidate[], brand: string): boolean {
  const b = fold(brand);
  const named = group.filter((c) => b && fold(`${c.analysis.structure} ${c.analysis.brief}`).includes(b)).length;
  return named > group.length / 2;
}

/** Groups the candidates into formats (≥ 2 ads, or the only one), most frequent first; sets each candidate's `format`. */
export function groupFormats(candidates: PlaybookCandidate[], brand: string): PlaybookFormat[] {
  const read = candidates.filter((c) => c.analysis.hook || c.analysis.structure);
  const by = new Map<string, PlaybookCandidate[]>();
  for (const c of read) { c.format = formatOf(c.analysis); by.set(c.format, [...(by.get(c.format) ?? []), c]); }
  for (const c of candidates) if (!c.format) c.format = "Non lu";
  const total = read.length || 1;
  return [...by].map(([label, group]) => {
    const first = group[0].analysis;
    return {
      label, count: group.length, share: Math.round((group.length / total) * 100), libraryIds: group.map((c) => c.libraryId),
      // A recurring layout (≥ 3 ads) that is not about the brand's own product is reusable elsewhere.
      verdict: group.length >= 3 && label !== "Autre" && !specific(group, brand) ? "polyvalent" as const : "spécifique" as const,
      structure: first.structure, style: first.style, why: first.whyItWorks,
    };
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** The playbook as a Markdown document (shown, and the base of the Mo note). */
export function renderPlaybook(p: Omit<Playbook, "md">): string {
  const lines = [`# Playbook ${p.brand} — bibliothèque Meta (${p.country})`, `${p.analysed} pubs lues par l'IA sur ${p.total} trouvées, le ${new Date(p.at).toLocaleDateString("fr-FR")}.`, ""];
  if (!p.formats.length) lines.push("Aucun format lisible (pubs sans image ou analyse impossible).");
  for (const f of p.formats) {
    lines.push(`## ${f.label} — ${f.count} pub${f.count > 1 ? "s" : ""} (${f.share} %) · ${f.verdict}`);
    if (f.structure) lines.push(`- Structure : ${f.structure}`);
    if (f.style) lines.push(`- Style : ${f.style}`);
    if (f.why) lines.push(`- Pourquoi ça marche : ${f.why}`);
    const ex = p.candidates.filter((c) => c.format === f.label).slice(0, 3).map((c) => c.analysis.hook || c.text.slice(0, 80)).filter(Boolean);
    if (ex.length) lines.push(`- Exemples : ${ex.map((e) => `« ${e} »`).join(" ; ")}`);
    lines.push("");
  }
  const poly = p.formats.filter((f) => f.verdict === "polyvalent").map((f) => f.label);
  lines.push(poly.length ? `À garder comme templates en priorité : ${poly.join(", ")}.` : "Aucun format nettement récurrent : choisir à l'œil les pubs les plus claires.");
  return lines.join("\n");
}

/** Cache key of a brand's study (AppSetting). */
export const playbookKey = (brand: string, country: string) => `playbook:${fold(brand).replace(/ /g, "-").slice(0, 60)}:${country.toUpperCase()}`;

/** The candidates a consultant ticks by number (« garde 1, 4 et 7 »): 1-based, in the order shown. */
export function pickByNumbers<T>(list: T[], numbers: number[]): T[] {
  return [...new Set(numbers)].filter((n) => Number.isInteger(n) && n >= 1 && n <= list.length).map((n) => list[n - 1]);
}
