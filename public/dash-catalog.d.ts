/** Types of public/dash-catalog.js (shared by the app and the dashboard frames). */

export interface CatalogDimensionLike {
  field: string;
  kind: "field" | "regex" | "mapping";
  rule?: {
    pattern?: string;
    flags?: string;
    group?: number;
    values?: Array<{ match: string; value: string; regex?: boolean }>;
    fallback?: string;
  } | null;
}

export interface CatalogMetricLike {
  key: string;
  formula: string;
  format?: string;
  unit?: string | null;
}

export interface RollupRow {
  key: string;
  count: number;
  fields: Record<string, number>;
  metrics: Record<string, number>;
}

declare const DashCatalog: {
  validateFormula(formula: string): { ok: true; fields: string[] } | { ok: false; error: string };
  fieldsOf(formula: string): string[];
  evaluate(formula: string, row: unknown): number;
  resolve(row: unknown, path: string): unknown;
  derive(dimension: CatalogDimensionLike, row: unknown): string;
  validateDimension(dimension: unknown): { ok: true } | { ok: false; error: string };
  format(def: { format?: string; unit?: string | null } | null | undefined, value: unknown, currency?: string): string;
  rollup(rows: unknown[], dimension: CatalogDimensionLike | null, metrics: CatalogMetricLike[]): RollupRow[];
  num(v: unknown): number;
};

export default DashCatalog;
