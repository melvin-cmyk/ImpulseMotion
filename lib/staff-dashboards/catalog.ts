/**
 * Catalogue « Métriques & dimensions » des dashboards du staff.
 *
 * Les consultants y définissent, pour toute l'équipe, des MÉTRIQUES (une
 * formule sur les champs d'une ligne, un format) et des DIMENSIONS (un champ
 * lu tel quel, un groupe d'expression régulière, ou un classement par motifs).
 * Les pages les utilisent par le runtime (dash.metric, dash.dimension,
 * dash.rollup, dash.format) et le copilote les connaît (texte du prompt).
 *
 * L'évaluation elle-même vit dans public/dash-catalog.js, chargé ici ET dans
 * le cadre des pages : la même formule donne le même nombre des deux côtés.
 * Le catalogue de référence (champs des plateformes) est statique, pour les
 * consultants et pour l'IA.
 */

import DashCatalog from "@/public/dash-catalog.js";
import { prisma } from "@/lib/prisma";

export const CATALOG_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
export {
  CATALOG_PLATFORMS, CATALOG_PLATFORM_LABELS, METRIC_FORMATS, METRIC_FORMAT_LABELS, DIMENSION_KINDS, DIMENSION_KIND_LABELS,
  type CatalogPlatform, type MetricFormat, type DimensionKind, type DimensionRule, type StaffMetricDef, type StaffDimensionDef, type StaffCatalog, type FrameCatalog,
} from "./catalog-types";
import {
  CATALOG_PLATFORMS, CATALOG_PLATFORM_LABELS, METRIC_FORMATS, DIMENSION_KINDS,
  type CatalogPlatform, type MetricFormat, type DimensionKind, type DimensionRule, type StaffMetricDef, type StaffDimensionDef, type StaffCatalog, type FrameCatalog,
} from "./catalog-types";

const MAX_LABEL = 80;
const MAX_DESCRIPTION = 600;
const MAX_FORMULA = 600;
const MAX_FIELD = 200;
const MAX_MAPPING = 100;

// ── Validation ──────────────────────────────────────────────────────────────

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export type MetricInput = Pick<StaffMetricDef, "key" | "label" | "description" | "platform" | "formula" | "format" | "unit">;
export type DimensionInput = Pick<StaffDimensionDef, "key" | "label" | "description" | "platform" | "field" | "kind" | "rule">;

export function validateMetricInput(raw: unknown): { ok: true; value: MetricInput; fields: string[] } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const key = str(r.key, 40).toLowerCase();
  if (!CATALOG_KEY_RE.test(key)) return { ok: false, error: "clé invalide : lettres minuscules, chiffres et _ (2 à 40 caractères, commence par une lettre)" };
  const label = str(r.label, MAX_LABEL);
  if (!label) return { ok: false, error: "libellé requis" };
  const platform = str(r.platform, 10) as CatalogPlatform;
  if (!CATALOG_PLATFORMS.includes(platform)) return { ok: false, error: "plateforme invalide" };
  const formula = str(r.formula, MAX_FORMULA);
  if (!formula) return { ok: false, error: "formule requise" };
  const parsed = DashCatalog.validateFormula(formula);
  if (!parsed.ok) return { ok: false, error: `formule : ${parsed.error}` };
  if (!parsed.fields.length) return { ok: false, error: "la formule ne lit aucun champ" };
  const format = (str(r.format, 10) || "number") as MetricFormat;
  if (!METRIC_FORMATS.includes(format)) return { ok: false, error: "format invalide" };
  const unit = str(r.unit, 8).toUpperCase() || null;
  if (unit && !/^[A-Z]{3}$/.test(unit)) return { ok: false, error: "unité : un code devise à trois lettres (EUR, USD…) ou vide" };
  return { ok: true, value: { key, label, description: str(r.description, MAX_DESCRIPTION), platform, formula, format, unit }, fields: parsed.fields };
}

export function validateDimensionInput(raw: unknown): { ok: true; value: DimensionInput } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const key = str(r.key, 40).toLowerCase();
  if (!CATALOG_KEY_RE.test(key)) return { ok: false, error: "clé invalide : lettres minuscules, chiffres et _ (2 à 40 caractères, commence par une lettre)" };
  const label = str(r.label, MAX_LABEL);
  if (!label) return { ok: false, error: "libellé requis" };
  const platform = str(r.platform, 10) as CatalogPlatform;
  if (!CATALOG_PLATFORMS.includes(platform)) return { ok: false, error: "plateforme invalide" };
  const field = str(r.field, MAX_FIELD);
  if (!field) return { ok: false, error: "champ source requis" };
  const kind = (str(r.kind, 10) || "field") as DimensionKind;
  if (!DIMENSION_KINDS.includes(kind)) return { ok: false, error: "type invalide" };
  const rr = (r.rule && typeof r.rule === "object" ? r.rule : {}) as Record<string, unknown>;
  const rule: DimensionRule = {};
  if (typeof rr.fallback === "string" && rr.fallback.trim()) rule.fallback = rr.fallback.trim().slice(0, MAX_LABEL);
  if (kind === "regex") {
    rule.pattern = str(rr.pattern, MAX_FIELD);
    if (typeof rr.flags === "string" && /^[gimsuy]{0,6}$/.test(rr.flags)) rule.flags = rr.flags;
    if (typeof rr.group === "number" && Number.isInteger(rr.group) && rr.group >= 0 && rr.group <= 9) rule.group = rr.group;
  }
  if (kind === "mapping") {
    const values = Array.isArray(rr.values) ? rr.values : [];
    rule.values = values
      .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
      .slice(0, MAX_MAPPING)
      .map((v) => ({ match: str(v.match, MAX_FIELD), value: str(v.value, MAX_LABEL), ...(v.regex === true ? { regex: true } : {}) }))
      .filter((v) => v.match || v.value);
  }
  const check = DashCatalog.validateDimension({ field, kind, rule });
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, value: { key, label, description: str(r.description, MAX_DESCRIPTION), platform, field, kind, rule } };
}

// ── Base ────────────────────────────────────────────────────────────────────

type MetricRow = { id: string; key: string; label: string; description: string; platform: string; formula: string; format: string; unit: string | null; ownerId: string; createdAt: Date; updatedAt: Date; owner?: { email: string | null } | null };
type DimensionRow = { id: string; key: string; label: string; description: string; platform: string; field: string; kind: string; ruleJson: string; ownerId: string; createdAt: Date; updatedAt: Date; owner?: { email: string | null } | null };

function parseRule(json: string): DimensionRule {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as DimensionRule) : {};
  } catch { return {}; }
}

export function metricFromRow(r: MetricRow): StaffMetricDef {
  return {
    id: r.id, key: r.key, label: r.label, description: r.description, platform: r.platform as CatalogPlatform,
    formula: r.formula, format: r.format as MetricFormat, unit: r.unit, fields: DashCatalog.fieldsOf(r.formula),
    ownerId: r.ownerId, ownerEmail: r.owner?.email ?? null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

export function dimensionFromRow(r: DimensionRow): StaffDimensionDef {
  return {
    id: r.id, key: r.key, label: r.label, description: r.description, platform: r.platform as CatalogPlatform,
    field: r.field, kind: r.kind as DimensionKind, rule: parseRule(r.ruleJson),
    ownerId: r.ownerId, ownerEmail: r.owner?.email ?? null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

/** The team's catalogue (shared by every staff member). */
export async function loadStaffCatalog(): Promise<StaffCatalog> {
  const [metrics, dimensions] = await Promise.all([
    prisma.staffMetric.findMany({ orderBy: [{ platform: "asc" }, { key: "asc" }], include: { owner: { select: { email: true } } } }),
    prisma.staffDimension.findMany({ orderBy: [{ platform: "asc" }, { key: "asc" }], include: { owner: { select: { email: true } } } }),
  ]);
  return { metrics: metrics.map(metricFromRow), dimensions: dimensions.map(dimensionFromRow) };
}

export function toFrameCatalog(c: StaffCatalog): FrameCatalog {
  return {
    metrics: c.metrics.map(({ key, label, description, platform, formula, format, unit }) => ({ key, label, description, platform, formula, format, unit })),
    dimensions: c.dimensions.map(({ key, label, description, platform, field, kind, rule }) => ({ key, label, description, platform, field, kind, rule })),
  };
}

// ── Référence des champs (statique) ─────────────────────────────────────────

export interface ReferenceField { name: string; label: string; kind: "metric" | "dimension"; note?: string }
export interface ReferencePlatform { platform: Exclude<CatalogPlatform, "any" | "sheet">; title: string; tool: string; fields: ReferenceField[] }

/** The fields the connectors return, as the loaders see them (names to use in formulas). */
export const FIELD_REFERENCE: ReferencePlatform[] = [
  {
    platform: "meta",
    title: "Meta Ads (insights)",
    tool: "Campaign_Performance1 / Get_Insights — champs `fields` de l'API Insights",
    fields: [
      { name: "date_start", label: "Jour", kind: "dimension" },
      { name: "campaign_name", label: "Campagne", kind: "dimension" },
      { name: "adset_name", label: "Ensemble de publicités", kind: "dimension" },
      { name: "ad_name", label: "Publicité", kind: "dimension" },
      { name: "spend", label: "Dépense", kind: "metric" },
      { name: "impressions", label: "Impressions", kind: "metric" },
      { name: "reach", label: "Couverture", kind: "metric" },
      { name: "clicks", label: "Clics", kind: "metric" },
      { name: "inline_link_clicks", label: "Clics sur le lien", kind: "metric" },
      { name: "actions.purchase", label: "Achats", kind: "metric", note: "liste actions, type purchase ; lead, add_to_cart, initiate_checkout, complete_registration…" },
      { name: "action_values.purchase", label: "Valeur des achats", kind: "metric" },
      { name: "actions.video_view", label: "Vues vidéo 3 s", kind: "metric" },
      { name: "video_thruplay_watched_actions.video_view", label: "ThruPlay", kind: "metric" },
      { name: "video_p25_watched_actions.video_view", label: "Vidéo vue à 25 %", kind: "metric", note: "p50, p75, p100 de même" },
    ],
  },
  {
    platform: "google",
    title: "Google Ads (GAQL)",
    tool: "Custom_GAQL_Query — SELECT … FROM campaign / ad_group / customer",
    fields: [
      { name: "segments.date", label: "Jour", kind: "dimension" },
      { name: "campaign.name", label: "Campagne", kind: "dimension" },
      { name: "campaign.advertising_channel_type", label: "Type de campagne", kind: "dimension" },
      { name: "ad_group.name", label: "Groupe d'annonces", kind: "dimension" },
      { name: "segments.device", label: "Appareil", kind: "dimension" },
      { name: "metrics.cost_micros", label: "Coût (micros)", kind: "metric", note: "÷ 1000000 pour la devise" },
      { name: "metrics.impressions", label: "Impressions", kind: "metric" },
      { name: "metrics.clicks", label: "Clics", kind: "metric" },
      { name: "metrics.conversions", label: "Conversions", kind: "metric" },
      { name: "metrics.conversions_value", label: "Valeur des conversions", kind: "metric" },
      { name: "metrics.video_trueview_views", label: "Vues TrueView", kind: "metric" },
      { name: "metrics.video_quartile_p25_rate", label: "Taux vu à 25 %", kind: "metric", note: "taux 0–1 ; × impressions pour un nombre ; p50, p75, p100 de même" },
    ],
  },
  {
    platform: "tiktok",
    title: "TikTok Ads (rapports)",
    tool: "get_campaign_performance / get_report_integrated — objet `metrics` des lignes",
    fields: [
      { name: "stat_time_day", label: "Jour", kind: "dimension" },
      { name: "campaign_name", label: "Campagne", kind: "dimension" },
      { name: "adgroup_name", label: "Groupe d'annonces", kind: "dimension" },
      { name: "objective_type", label: "Objectif", kind: "dimension" },
      { name: "spend", label: "Dépense", kind: "metric" },
      { name: "impressions", label: "Impressions", kind: "metric" },
      { name: "clicks", label: "Clics", kind: "metric" },
      { name: "conversion", label: "Conversions (événement d'optimisation)", kind: "metric" },
      { name: "total_purchase", label: "Achats", kind: "metric" },
      { name: "total_purchase_value", label: "Valeur des achats", kind: "metric" },
      { name: "video_play_actions", label: "Lectures vidéo", kind: "metric" },
      { name: "video_watched_2s", label: "Vues vidéo 2 s", kind: "metric" },
      { name: "video_views_p25", label: "Vidéo vue à 25 %", kind: "metric", note: "p50, p75, p100 de même" },
    ],
  },
  {
    platform: "ga4",
    title: "Google Analytics 4",
    tool: "run_report — dimensions et métriques GA4",
    fields: [
      { name: "date", label: "Jour", kind: "dimension" },
      { name: "sessionDefaultChannelGroup", label: "Canal", kind: "dimension" },
      { name: "sessionSourceMedium", label: "Source / support", kind: "dimension" },
      { name: "sessions", label: "Sessions", kind: "metric" },
      { name: "totalUsers", label: "Utilisateurs", kind: "metric" },
      { name: "conversions", label: "Conversions", kind: "metric" },
      { name: "purchaseRevenue", label: "Revenu d'achat", kind: "metric" },
    ],
  },
];

// ── Texte pour le copilote ──────────────────────────────────────────────────

/** The team's catalogue as the copilot reads it (empty catalogue → a short note). */
export function catalogPromptText(c: StaffCatalog): string {
  const lines: string[] = [];
  lines.push("CATALOGUE MÉTRIQUES & DIMENSIONS DE L'ÉQUIPE (page /dashboards/catalogue ; disponible dans les pages via le runtime)");
  lines.push("- dash.catalog() → { metrics, dimensions } ; dash.metric(key, ligneOuTotal) → nombre ; dash.dimension(key, ligne) → libellé ; dash.format(key, valeur, devise?) → texte ; dash.rollup(lignes, dimensionKey|null, [metricKeys]) → [{ key, count, fields, metrics }] (somme des champs des formules par groupe, puis métriques sur les totaux).");
  lines.push("- Une métrique est une formule sur les champs d'une ligne (chemins avec points, camelCase ou snake_case indifférent, `metrics.` implicite pour GAQL, listes Meta lues par type : actions.purchase) ; division par zéro = 0. Une dimension lit un champ, en extrait un groupe (regex) ou le classe par motifs.");
  lines.push("- Quand une demande du consultant correspond à une entrée du catalogue (même nom, même notion), utilise-la (dash.metric / dash.dimension) au lieu de réécrire la formule : c'est la définition partagée de l'équipe. Une métrique ou dimension manquante se crée sur la page du catalogue (dis-le au consultant), pas dans la page.");
  if (!c.metrics.length && !c.dimensions.length) {
    lines.push("- Catalogue vide pour l'instant.");
    return lines.join("\n");
  }
  if (c.metrics.length) {
    lines.push(`Métriques (${c.metrics.length}) :`);
    for (const m of c.metrics) lines.push(`- ${m.key} « ${m.label} » [${CATALOG_PLATFORM_LABELS[m.platform]}, ${m.format}${m.unit ? ` ${m.unit}` : ""}] = ${m.formula}${m.description ? ` — ${m.description}` : ""}`);
  }
  if (c.dimensions.length) {
    lines.push(`Dimensions (${c.dimensions.length}) :`);
    for (const d of c.dimensions) {
      const how = d.kind === "field" ? `valeur de ${d.field}`
        : d.kind === "regex" ? `groupe ${d.rule.group ?? 1} de /${d.rule.pattern}/${d.rule.flags ?? "i"} sur ${d.field}`
        : `${d.field} classé par motifs : ${(d.rule.values ?? []).map((v) => `${v.regex ? "/" : "« "}${v.match}${v.regex ? "/" : " »"} → ${v.value}`).join(", ")}`;
      lines.push(`- ${d.key} « ${d.label} » [${CATALOG_PLATFORM_LABELS[d.platform]}] : ${how}${d.rule.fallback ? `, sinon « ${d.rule.fallback} »` : ""}${d.description ? ` — ${d.description}` : ""}`);
    }
  }
  return lines.join("\n");
}

export { DashCatalog };
