/** Client-safe types of the team's catalogue (no server imports) — see ./catalog.ts. */

export const CATALOG_PLATFORMS = ["any", "meta", "google", "tiktok", "ga4", "sheet"] as const;
export type CatalogPlatform = (typeof CATALOG_PLATFORMS)[number];
export const METRIC_FORMATS = ["number", "integer", "currency", "percent", "ratio"] as const;
export type MetricFormat = (typeof METRIC_FORMATS)[number];
export const DIMENSION_KINDS = ["field", "regex", "mapping"] as const;
export type DimensionKind = (typeof DIMENSION_KINDS)[number];

export interface DimensionRule {
  pattern?: string;
  flags?: string;
  group?: number;
  values?: Array<{ match: string; value: string; regex?: boolean }>;
  fallback?: string;
}

export interface FrameMetric { key: string; label: string; description: string; platform: CatalogPlatform; formula: string; format: MetricFormat; unit: string | null }
export interface FrameDimension { key: string; label: string; description: string; platform: CatalogPlatform; field: string; kind: DimensionKind; rule: DimensionRule }

/** What the frame needs (no owners, no dates). */
export interface FrameCatalog { metrics: FrameMetric[]; dimensions: FrameDimension[] }

export interface StaffMetricDef extends FrameMetric { id: string; fields: string[]; ownerId: string; ownerEmail?: string | null; createdAt: string; updatedAt: string }
export interface StaffDimensionDef extends FrameDimension { id: string; ownerId: string; ownerEmail?: string | null; createdAt: string; updatedAt: string }
export interface StaffCatalog { metrics: StaffMetricDef[]; dimensions: StaffDimensionDef[] }

export const CATALOG_PLATFORM_LABELS: Record<CatalogPlatform, string> = {
  any: "Toutes", meta: "Meta Ads", google: "Google Ads", tiktok: "TikTok Ads", ga4: "GA4", sheet: "Google Sheets",
};
export const METRIC_FORMAT_LABELS: Record<MetricFormat, string> = {
  number: "Nombre", integer: "Entier", currency: "Montant (devise)", percent: "Pourcentage", ratio: "Ratio (x)",
};
export const DIMENSION_KIND_LABELS: Record<DimensionKind, string> = {
  field: "Valeur du champ", regex: "Extrait par expression régulière", mapping: "Classé par motifs",
};
