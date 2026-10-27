/**
 * Saved reports of Analyse Ads v2 (Motion's "reports"): a report is a named
 * configuration — period, comparison, group by, filters, metrics, view, sort.
 * Built-in TEMPLATES mirror the reports Motion creates in every workspace
 * (Top créas, Actives, Lancements, Hooks, Clics, Textes, Landing, Vidéo,
 * Statiques, Semaine vs semaine…); the consultant's own reports are stored in
 * AnalyseView, per client account.
 */

import type { AdsFilters, GroupBy, MetricKey } from "./query";

export type ViewMode = "cards" | "table" | "bar" | "chart";

export interface ViewConfig {
  /** Rolling period in days (ignored when since/until are set). */
  days: number;
  since?: string;
  until?: string;
  compare: boolean;
  groupBy: GroupBy;
  filters: AdsFilters;
  /** "Launched in the last N days" shortcut (resolved client-side into filters.launchedAfter). */
  launchDays?: number;
  metrics: MetricKey[];
  view: ViewMode;
  sort: { key: MetricKey | "name" | "adCount" | "launch"; dir: "asc" | "desc" };
}

export interface ViewTemplate {
  id: string;
  name: string;
  emoji: string;
  description: string;
  config: ViewConfig;
}

const base: ViewConfig = { days: 30, compare: false, groupBy: "creative", filters: {}, metrics: ["spend", "roas", "cpa", "ctr", "hookRate", "conversions"], view: "cards", sort: { key: "spend", dir: "desc" } };

export const VIEW_TEMPLATES: ViewTemplate[] = [
  { id: "top", name: "Top créas", emoji: "🏆", description: "Les créas qui dépensent le plus et ce qu'elles rapportent.", config: { ...base } },
  { id: "active", name: "Créas actives", emoji: "🟢", description: "Tout ce qui est en diffusion aujourd'hui.", config: { ...base, days: 7, filters: { status: "active" }, view: "table" } },
  { id: "launches", name: "Lancements", emoji: "🚀", description: "Les annonces lancées ces 14 derniers jours, par semaine de lancement.", config: { ...base, days: 14, launchDays: 14, groupBy: "ad", metrics: ["spend", "ctr", "cpa", "hookRate", "holdRate", "conversions"], view: "table", sort: { key: "launch", dir: "desc" } } },
  { id: "hooks", name: "Top hooks", emoji: "🪝", description: "Les vidéos qui arrêtent le scroll (hook rate), avec leur coût.", config: { ...base, days: 14, filters: { formats: ["Video"], minSpend: 50 }, metrics: ["spend", "hookRate", "holdRate", "ctr", "cpa", "roas"], sort: { key: "hookRate", dir: "desc" } } },
  { id: "clicks", name: "Top clics", emoji: "👆", description: "Les créas qui font cliquer (CTR), avec leur coût par clic.", config: { ...base, days: 14, filters: { minSpend: 50 }, metrics: ["spend", "ctr", "cpc", "cvr", "cpa", "roas"], sort: { key: "ctr", dir: "desc" } } },
  { id: "copy", name: "Top textes", emoji: "🖋️", description: "Performance par texte principal de l'annonce.", config: { ...base, groupBy: "copy", view: "table", metrics: ["spend", "ctr", "cvr", "cpa", "roas", "conversions"] } },
  { id: "landing", name: "Landing pages", emoji: "🛬", description: "Performance par page de destination.", config: { ...base, groupBy: "landing", view: "table", metrics: ["spend", "ctr", "cvr", "cpa", "roas", "conversions"] } },
  { id: "format", name: "Vidéo vs image", emoji: "📊", description: "Comparaison par type de créa.", config: { ...base, groupBy: "format", view: "bar", metrics: ["spend", "ctr", "cpa", "roas", "hookRate", "conversions"] } },
  { id: "video", name: "Vidéos", emoji: "📽️", description: "Rétention des vidéos : hook, hold, 25 / 50 / 75 / 100 %.", config: { ...base, filters: { formats: ["Video"] }, metrics: ["spend", "hookRate", "p25Rate", "p50Rate", "p75Rate", "p100Rate"] } },
  { id: "static", name: "Statiques", emoji: "📸", description: "Les images et carrousels seulement.", config: { ...base, filters: { formats: ["Image", "Carousel"] }, metrics: ["spend", "ctr", "cpc", "cvr", "cpa", "roas"] } },
  { id: "wow", name: "Semaine vs semaine", emoji: "📅", description: "7 derniers jours comparés aux 7 précédents.", config: { ...base, days: 7, compare: true, view: "table", metrics: ["spend", "ctr", "cpc", "cpa", "roas", "conversions"] } },
  { id: "converters", name: "Top convertisseuses", emoji: "💰", description: "Les créas qui convertissent le plus, et à quel coût.", config: { ...base, days: 30, filters: { minSpend: 50 }, metrics: ["conversions", "cpa", "cvr", "roas", "spend", "ctr"], sort: { key: "conversions", dir: "desc" } } },
  { id: "scalers", name: "À scaler", emoji: "📈", description: "Petites dépenses mais CTR et conversion au-dessus de la moyenne : prêtes à monter.", config: { ...base, days: 14, filters: { minSpend: 20 }, metrics: ["spend", "ctr", "cvr", "cpa", "roas", "hookRate"], sort: { key: "cvr", dir: "desc" } } },
  { id: "heavies", name: "Les lourdes", emoji: "🐘", description: "Grosses dépenses qui ne tirent pas leur poids (CPA, ROAS sous la moyenne).", config: { ...base, days: 30, filters: { minSpend: 300 }, view: "table", metrics: ["spend", "cpa", "roas", "ctr", "cpc", "conversions"], sort: { key: "cpa", dir: "desc" } } },
  { id: "cpm", name: "CPM élevés", emoji: "📉", description: "Les créas chères à diffuser qui mangent le budget.", config: { ...base, days: 14, filters: { minSpend: 50 }, view: "table", metrics: ["spend", "cpm", "frequency", "ctr", "cpc", "roas"], sort: { key: "cpm", dir: "desc" } } },
  { id: "fatigue", name: "Fatigue", emoji: "🥱", description: "CPC et fréquence qui montent sur les grosses dépenses.", config: { ...base, days: 30, filters: { minSpend: 200 }, view: "chart", metrics: ["spend", "cpc", "cpm", "frequency", "ctr", "roas"], sort: { key: "cpc", dir: "desc" } } },
];

export function isViewConfig(v: unknown): v is ViewConfig {
  if (!v || typeof v !== "object") return false;
  const c = v as Partial<ViewConfig>;
  return typeof c.days === "number" && typeof c.groupBy === "string" && Array.isArray(c.metrics) && typeof c.view === "string" && !!c.sort;
}
