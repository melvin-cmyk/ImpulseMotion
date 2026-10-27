/**
 * Metric catalogue of Analyse Ads v2 — labels (French), formats, direction
 * ("higher is better" or not), video-only flags, presets and the colour rule
 * against the account benchmark (Motion: green above / red below the account
 * average, inverted for cost metrics). Pure functions, shared by cards, table
 * and drawer.
 */

import type { MetricKey, Metrics } from "./query";

export type MetricFormat = "money" | "int" | "pct" | "ratio" | "x";

export interface MetricDef {
  key: MetricKey;
  label: string;
  short: string;
  format: MetricFormat;
  /** true = a higher value is better (CTR, ROAS); false = lower is better (CPA, CPC). null = neutral (spend, impressions). */
  higherBetter: boolean | null;
  video?: boolean;
  hint: string;
}

export const METRICS: MetricDef[] = [
  { key: "spend", label: "Dépenses", short: "Dép.", format: "money", higherBetter: null, hint: "Montant dépensé sur la période" },
  { key: "impressions", label: "Impressions", short: "Impr.", format: "int", higherBetter: null, hint: "Nombre d'affichages" },
  { key: "reach", label: "Couverture", short: "Reach", format: "int", higherBetter: null, hint: "Personnes uniques touchées" },
  { key: "frequency", label: "Fréquence", short: "Fréq.", format: "ratio", higherBetter: false, hint: "Impressions ÷ couverture" },
  { key: "cpm", label: "CPM", short: "CPM", format: "money", higherBetter: false, hint: "Coût pour 1 000 impressions" },
  { key: "linkClicks", label: "Clics lien", short: "Clics", format: "int", higherBetter: null, hint: "Clics sortants vers le site" },
  { key: "ctr", label: "CTR (lien)", short: "CTR", format: "pct", higherBetter: true, hint: "Clics lien ÷ impressions" },
  { key: "ctrAll", label: "CTR (tous)", short: "CTR tous", format: "pct", higherBetter: true, hint: "Tous les clics ÷ impressions" },
  { key: "cpc", label: "CPC", short: "CPC", format: "money", higherBetter: false, hint: "Dépenses ÷ clics lien — l'indicateur de fatigue de Motion" },
  { key: "conversions", label: "Conversions", short: "Conv.", format: "int", higherBetter: null, hint: "Événement de conversion du compte (achats, leads…)" },
  { key: "cpa", label: "CPA", short: "CPA", format: "money", higherBetter: false, hint: "Dépenses ÷ conversions" },
  { key: "cvr", label: "Taux de conv.", short: "CVR", format: "pct", higherBetter: true, hint: "Conversions ÷ clics lien" },
  { key: "conversionValue", label: "Valeur", short: "Valeur", format: "money", higherBetter: null, hint: "Valeur des conversions (suivie ou estimée via panier moyen)" },
  { key: "roas", label: "ROAS", short: "ROAS", format: "x", higherBetter: true, hint: "Valeur ÷ dépenses" },
  { key: "aov", label: "Panier moyen", short: "AOV", format: "money", higherBetter: true, hint: "Valeur ÷ conversions" },
  { key: "purchases", label: "Achats", short: "Achats", format: "int", higherBetter: null, hint: "Achats (toujours la famille achat)" },
  { key: "leads", label: "Leads", short: "Leads", format: "int", higherBetter: null, hint: "Leads (formulaires, pixel lead)" },
  { key: "hookRate", label: "Hook rate", short: "Hook", format: "pct", higherBetter: true, video: true, hint: "Vues 3 s ÷ impressions (thumbstop) — la pub arrête-t-elle le scroll ?" },
  { key: "holdRate", label: "Hold rate", short: "Hold", format: "pct", higherBetter: true, video: true, hint: "ThruPlays (15 s) ÷ impressions — retient-elle l'attention ?" },
  { key: "p25Rate", label: "Vue 25 %", short: "25 %", format: "pct", higherBetter: true, video: true, hint: "Vues à 25 % ÷ impressions" },
  { key: "p50Rate", label: "Vue 50 %", short: "50 %", format: "pct", higherBetter: true, video: true, hint: "Vues à 50 % ÷ impressions" },
  { key: "p75Rate", label: "Vue 75 %", short: "75 %", format: "pct", higherBetter: true, video: true, hint: "Vues à 75 % ÷ impressions" },
  { key: "p100Rate", label: "Vue 100 %", short: "100 %", format: "pct", higherBetter: true, video: true, hint: "Vues complètes ÷ impressions" },
  { key: "videoPlays", label: "Lectures vidéo", short: "Lectures", format: "int", higherBetter: null, video: true, hint: "Démarrages de la vidéo" },
  { key: "thruPlays", label: "ThruPlays", short: "Thru", format: "int", higherBetter: null, video: true, hint: "Vues de 15 s ou complètes" },
];

export const METRIC_BY_KEY: Record<string, MetricDef> = Object.fromEntries(METRICS.map((m) => [m.key, m]));

export interface MetricPreset { id: string; label: string; keys: MetricKey[] }

export const PRESETS: MetricPreset[] = [
  { id: "essentiel", label: "Essentiel", keys: ["spend", "roas", "cpa", "ctr", "hookRate", "conversions"] },
  { id: "parcours", label: "Parcours (Hook → Convert)", keys: ["spend", "hookRate", "holdRate", "ctr", "cvr", "roas"] },
  { id: "fatigue", label: "Fatigue", keys: ["spend", "cpc", "cpm", "frequency", "ctr", "roas"] },
  { id: "video", label: "Vidéo", keys: ["spend", "hookRate", "p25Rate", "p50Rate", "p75Rate", "p100Rate"] },
  { id: "leadgen", label: "Lead gen", keys: ["spend", "leads", "cpa", "cvr", "ctr", "cpc"] },
];

export function fmtMetric(key: MetricKey, value: number, currency: string | null, m?: Metrics): string {
  const def = METRIC_BY_KEY[key];
  if (!def) return String(value);
  if ((key === "roas" || key === "conversionValue" || key === "aov") && m?.roasUnavailable) return "—";
  if (value === 0 && def.format !== "int" && def.higherBetter !== null) return "—";
  const est = (key === "roas" || key === "conversionValue" || key === "aov") && m?.estimated ? "*" : "";
  switch (def.format) {
    case "money": {
      try { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: currency ?? "EUR", maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value) + est; } catch { return `${value.toFixed(2)} ${currency ?? ""}` + est; }
    }
    case "int": return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value);
    case "pct": return `${value.toLocaleString("fr-FR", { maximumFractionDigits: value < 1 ? 2 : 1 })} %`;
    case "ratio": return value.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
    case "x": return `${value.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}×${est}`;
  }
}

export type Tone = "good" | "bad" | "neutral";

/** Colour of a cell against the benchmark (±10 % band), honouring the metric direction. */
export function toneVs(key: MetricKey, value: number, bench: number): Tone {
  const def = METRIC_BY_KEY[key];
  if (!def || def.higherBetter === null || value <= 0 || bench <= 0) return "neutral";
  const r = value / bench;
  if (r >= 1.1) return def.higherBetter ? "good" : "bad";
  if (r <= 0.9) return def.higherBetter ? "bad" : "good";
  return "neutral";
}

/** % change between two values (null when the previous value is 0). */
export function deltaPct(cur: number, prev: number | null | undefined): number | null {
  if (prev === null || prev === undefined || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

/** Tone of a delta: for cost metrics a drop is good. */
export function deltaTone(key: MetricKey, d: number | null): Tone {
  const def = METRIC_BY_KEY[key];
  if (d === null || !def || def.higherBetter === null || Math.abs(d) < 2) return "neutral";
  const up = d > 0;
  return up === def.higherBetter ? "good" : "bad";
}

export const TONE_CLASS: Record<Tone, string> = {
  good: "bg-emerald-500/15 text-emerald-300",
  bad: "bg-red-500/15 text-red-300",
  neutral: "bg-gray-800/60 text-gray-200",
};
