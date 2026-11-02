/**
 * Motion's Opportunities ("Suggested creative iterations"): on a creative that
 * got budget, ONE weak stage of the funnel while the others hold — a small
 * change can unlock it. Types and labels are Motion's (ImproveFirstFrame,
 * IterateOnHook, IterateOnBody, ImproveCTA); the stages are read on the
 * creative scores (lib/ads-warehouse/trends.ts). Pure and client-safe; the
 * store lives in opportunities-store.ts.
 */

import type { AdsGroupRow, Metrics } from "./query";

export type OpportunityType = "ImproveFirstFrame" | "IterateOnHook" | "IterateOnBody" | "ImproveCTA";
export type OpportunityStatus = "active" | "completed" | "archived";

export const OPPORTUNITY_LABEL: Record<OpportunityType, string> = {
  ImproveFirstFrame: "Améliorer la première image",
  IterateOnHook: "Itérer sur le hook",
  IterateOnBody: "Itérer sur le corps",
  ImproveCTA: "Faire cliquer",
};

/** Opportunities expire after 30 days (Motion). */
export const OPPORTUNITY_TTL_DAYS = 30;

const WEAK = 40;
const VERY_WEAK = 25;
const STRONG = 55;

export interface DetectedOpportunity {
  type: OpportunityType;
  description: string;
  strengths: string[];
  weaknesses: string[];
}

const s = (n: number) => Math.round(n);

/**
 * The opportunity of a creative, if any (at most one, the earliest weak stage
 * of the funnel). `scaled` = the creative spent at least the threshold.
 */
export function detectOpportunity(m: Metrics, opts: { video: boolean; scaled: boolean }): DetectedOpportunity | null {
  if (!opts.scaled) return null;
  const { hookScore: hook, watchScore: watch, clickScore: click, convertScore: convert } = m;
  const strengths: string[] = [];
  if (hook >= STRONG) strengths.push(`Hook score ${s(hook)} : la vidéo arrête le scroll`);
  if (watch >= STRONG) strengths.push(`Watch score ${s(watch)} : elle retient l'attention`);
  if (click >= STRONG) strengths.push(`Click score ${s(click)} : elle fait cliquer`);
  if (convert >= STRONG) strengths.push(`Convert score ${s(convert)} : elle atteint l'objectif`);
  if (!strengths.length) return null; // nothing to keep: a new concept, not an iteration

  if (opts.video && hook > 0 && hook < VERY_WEAK && (watch >= STRONG || convert >= STRONG)) {
    return {
      type: "ImproveFirstFrame",
      description: "Ceux qui regardent restent et convertissent, mais presque personne ne s'arrête : la première image ne capte pas. Changer la vignette / le premier plan (texte, visage, contraste) peut débloquer la diffusion.",
      strengths,
      weaknesses: [`Hook score ${s(hook)} : très peu de vues 3 s par impression (${m.hookRate.toLocaleString("fr-FR")} %)`],
    };
  }
  if (opts.video && hook > 0 && hook < WEAK && (watch >= STRONG || convert >= STRONG)) {
    return {
      type: "IterateOnHook",
      description: "Le reste de la vidéo fonctionne mais les 3 premières secondes perdent trop de monde. Tester de nouvelles accroches sur le même corps de vidéo.",
      strengths,
      weaknesses: [`Hook score ${s(hook)} : hook rate ${m.hookRate.toLocaleString("fr-FR")} %, sous la plupart des vidéos du compte`],
    };
  }
  if (opts.video && hook >= STRONG && watch > 0 && watch < WEAK) {
    return {
      type: "IterateOnBody",
      description: "L'accroche arrête le scroll mais l'audience décroche ensuite. Garder le hook et retravailler le corps de la vidéo (rythme, preuve, démonstration plus tôt).",
      strengths,
      weaknesses: [`Watch score ${s(watch)} : hold rate ${m.holdRate.toLocaleString("fr-FR")} %, les gens partent après l'accroche`],
    };
  }
  if (click > 0 && click < WEAK && (convert >= 50 || hook >= STRONG || watch >= STRONG)) {
    return {
      type: "ImproveCTA",
      description: "La créa capte l'attention et ceux qui cliquent convertissent, mais trop peu cliquent. Rendre l'appel à l'action plus clair (offre, bouton, bénéfice explicite en fin de vidéo ou sur le visuel).",
      strengths,
      weaknesses: [`Click score ${s(click)} : CTR ${m.ctr.toLocaleString("fr-FR")} %, sous la plupart des créas du compte`],
    };
  }
  return null;
}

/** Opportunities of a result page (rows grouped by creative). */
export function opportunitiesOf(rows: AdsGroupRow[], threshold: number): Map<string, DetectedOpportunity> {
  const out = new Map<string, DetectedOpportunity>();
  for (const r of rows) {
    const video = r.sample?.format === "Video" || r.metrics.video3s > 0;
    const o = detectOpportunity(r.metrics, { video, scaled: r.metrics.spend >= threshold });
    if (o) out.set(r.key, o);
  }
  return out;
}

/** Snapshot stored with an opportunity: Motion's "performance when opportunity was identified". */
export function metricsAtAssignment(m: Metrics) {
  return { spend: m.spend, cpa: m.cpa, roas: m.roas, ctr: m.ctr, hookRate: m.hookRate, holdRate: m.holdRate, hookScore: m.hookScore, watchScore: m.watchScore, clickScore: m.clickScore, convertScore: m.convertScore };
}
export type MetricsAtAssignment = ReturnType<typeof metricsAtAssignment>;
