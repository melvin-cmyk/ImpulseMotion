/**
 * Client-safe part of the dashboard widget system: types, catalogue and
 * config validation. No server imports — safe to use in "use client" files.
 * Server-side resolution lives in lib/dashboard-widgets.ts.
 */

export const WIDGET_TYPES = ["kpi", "timeseries", "table", "top_creatives", "pacing", "text"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const KPI_METRICS = ["spend", "revenue", "roas", "ctr", "cpa", "purchases", "clicks", "impressions"] as const;
export const SERIES_METRICS = ["spend", "revenue", "roas", "clicks", "ctr", "purchases"] as const;
export const TABLE_KINDS = ["campaigns", "keywords", "search_terms"] as const;
export const WIDGET_WIDTHS = ["third", "half", "full"] as const;

/** Human/AI-facing catalogue — also consumed by the copilot tool definitions. */
export const WIDGET_TYPE_INFO: Record<WidgetType, { label: string; configDoc: string }> = {
  kpi: {
    label: "KPI",
    configDoc: `{ metric: ${KPI_METRICS.join("|")}, source: "meta"|"google"|"combined" }`,
  },
  timeseries: {
    label: "Courbe temporelle",
    configDoc: `{ metric: ${SERIES_METRICS.join("|")} } (source Meta, quotidien)`,
  },
  table: {
    label: "Table Google Ads",
    configDoc: `{ kind: ${TABLE_KINDS.join("|")}, limit?: 1-30 }`,
  },
  top_creatives: {
    label: "Top créas Meta",
    configDoc: `{ limit?: 1-10 }`,
  },
  pacing: {
    label: "Pacing budget",
    configDoc: `{} (utilise le budget mensuel du compte Meta du dashboard)`,
  },
  text: {
    label: "Texte libre",
    configDoc: `{ markdown: string (≤ 5000 caractères) }`,
  },
};

export interface ResolvedWidget {
  id: string;
  type: string;
  title: string | null;
  width: string;
  position: number;
  config: Record<string, unknown>;
  data?: unknown;
  error?: string;
}

export interface WidgetConfigError extends Error {
  widgetIssue: true;
}

export function widgetIssue(message: string): WidgetConfigError {
  const e = new Error(message) as WidgetConfigError;
  e.widgetIssue = true;
  return e;
}

/** Validates and normalizes a widget config. Throws a WidgetConfigError with a
 *  readable French message on invalid input (surfaced to the UI/copilot). */
export function validateWidgetConfig(type: string, raw: unknown): Record<string, unknown> {
  if (!WIDGET_TYPES.includes(type as WidgetType)) {
    throw widgetIssue(`Type de widget inconnu: ${type}. Types valides: ${WIDGET_TYPES.join(", ")}`);
  }
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  switch (type as WidgetType) {
    case "kpi": {
      const metric = String(cfg.metric ?? "spend");
      if (!KPI_METRICS.includes(metric as (typeof KPI_METRICS)[number])) {
        throw widgetIssue(`Métrique KPI invalide: ${metric}. Valides: ${KPI_METRICS.join(", ")}`);
      }
      const source = String(cfg.source ?? "meta");
      if (!["meta", "google", "combined"].includes(source)) {
        throw widgetIssue(`Source invalide: ${source} (meta, google ou combined)`);
      }
      return { metric, source };
    }
    case "timeseries": {
      const metric = String(cfg.metric ?? "spend");
      if (!SERIES_METRICS.includes(metric as (typeof SERIES_METRICS)[number])) {
        throw widgetIssue(`Métrique de courbe invalide: ${metric}. Valides: ${SERIES_METRICS.join(", ")}`);
      }
      return { metric };
    }
    case "table": {
      const kind = String(cfg.kind ?? "campaigns");
      if (!TABLE_KINDS.includes(kind as (typeof TABLE_KINDS)[number])) {
        throw widgetIssue(`Table invalide: ${kind}. Valides: ${TABLE_KINDS.join(", ")}`);
      }
      const limit = Math.min(Math.max(Number(cfg.limit ?? 10) || 10, 1), 30);
      return { kind, limit };
    }
    case "top_creatives": {
      const limit = Math.min(Math.max(Number(cfg.limit ?? 6) || 6, 1), 10);
      return { limit };
    }
    case "pacing":
      return {};
    case "text": {
      const markdown = String(cfg.markdown ?? "");
      if (markdown.length > 5000) throw widgetIssue("Texte trop long (5000 caractères max)");
      return { markdown };
    }
  }
}

export function validateWidgetWidth(raw: unknown): string {
  const w = String(raw ?? "half");
  return WIDGET_WIDTHS.includes(w as (typeof WIDGET_WIDTHS)[number]) ? w : "half";
}
