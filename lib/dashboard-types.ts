import { parseConversionEvent } from "@/lib/meta-actions";

/**
 * Client-safe part of the dashboard widget system: types, catalogue and
 * config validation. No server imports — safe to use in "use client" files.
 * Server-side resolution lives in lib/dashboard-widgets.ts.
 */

export const WIDGET_TYPES = ["kpi", "platform_table", "timeseries", "table", "top_creatives", "pacing", "text", "funnel", "demographics", "geo_device", "alerts", "crm_funnel", "crm_attribution", "meta_actions"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const KPI_METRICS = ["spend", "revenue", "roas", "ctr", "cpa", "cpc", "cr", "purchases", "clicks", "impressions"] as const;
export const DEMOGRAPHICS_METRICS = ["spend", "purchases", "clicks"] as const;
export const GEO_DEVICE_DIMENSIONS = ["device", "country"] as const;
export const SERIES_METRICS = ["spend", "revenue", "roas", "clicks", "ctr", "cpc", "cr", "purchases"] as const;
export const TABLE_KINDS = ["campaigns", "keywords", "search_terms"] as const;
export const WIDGET_WIDTHS = ["third", "half", "full"] as const;
export const META_ACTIONS_MAX = 30;

/** Widgets whose Meta conversions follow `conversionEvent` (override of the account setting). */
export const CONVERSION_WIDGET_TYPES = ["kpi", "timeseries", "table", "top_creatives", "platform_table", "funnel", "demographics", "geo_device"] as const;
const CONVERSION_DOC = `; option conversionEvent?: purchase|lead|complete_registration|custom:<action_type Meta> (ex. custom:offsite_conversion.custom.123, custom:onsite_conversion.messaging_conversation_started_7d) — action de conversion Meta comptée par ce widget, à la place du réglage du compte ; sans effet côté Google`;

/** Human/AI-facing catalogue — also consumed by the copilot tool definitions. */
export const WIDGET_TYPE_INFO: Record<WidgetType, { label: string; configDoc: string }> = {
  kpi: {
    label: "KPI",
    configDoc: `{ metric: ${KPI_METRICS.join("|")}, source: "meta"|"google"|"combined" } — inclut automatiquement la comparaison vs période précédente` + CONVERSION_DOC,
  },
  platform_table: {
    label: "Vue par plateforme",
    configDoc: `{} — une ligne par plateforme liée (Meta, Google, Total) avec Cost, Impr., CTR, Clics, CPC, CR%, Conversions, CPA et leur %Δ vs la période de comparaison` + CONVERSION_DOC,
  },
  timeseries: {
    label: "Courbe temporelle",
    configDoc: `{ metric: ${SERIES_METRICS.join("|")}, source: "meta"|"google" } (quotidien)` + CONVERSION_DOC,
  },
  table: {
    label: "Table de performance",
    configDoc: `{ kind: ${TABLE_KINDS.join("|")}, source: "google"|"meta", limit?: 1-30 } — source meta uniquement pour kind=campaigns` + CONVERSION_DOC,
  },
  top_creatives: {
    label: "Top créas Meta",
    configDoc: `{ limit?: 1-10 }` + CONVERSION_DOC,
  },
  pacing: {
    label: "Pacing budget",
    configDoc: `{} (utilise le budget mensuel du compte Meta du dashboard)`,
  },
  text: {
    label: "Texte libre",
    configDoc: `{ markdown: string (≤ 5000 caractères) }`,
  },
  funnel: {
    label: "Entonnoir de conversion",
    configDoc: `{ source: "meta"|"google"|"combined" (défaut combined) } — étapes Impressions → Clics → Conversions avec taux de passage (CTR, taux de conversion) ; combined additionne les plateformes liées ; pas de comparaison de période` + CONVERSION_DOC,
  },
  demographics: {
    label: "Démographie Meta",
    configDoc: `{ metric: ${DEMOGRAPHICS_METRICS.join("|")} (défaut spend) } — répartition Meta par âge et genre, triée par valeur décroissante ; nécessite un compte Meta lié ; pas de comparaison de période` + CONVERSION_DOC,
  },
  geo_device: {
    label: "Répartition appareil / pays",
    configDoc: `{ source: "meta"|"google" (défaut meta), dimension: ${GEO_DEVICE_DIMENSIONS.join("|")} (défaut device) } — dépense, clics et conversions par appareil ou pays ; la source google ne supporte que dimension=device (la répartition pays n'est pas exposée simplement en GAQL) ; pas de comparaison de période` + CONVERSION_DOC,
  },
  alerts: {
    label: "Dernières alertes",
    configDoc: `{ limit?: 1-20 (défaut 5) } — dernières alertes déclenchées sur les comptes liés au dashboard, de la plus récente à la plus ancienne ; pas de comparaison de période`,
  },
  crm_funnel: {
    label: "Entonnoir CRM (HubSpot)",
    configDoc: `{} — dépense pub → leads → leads qualifiés → deals → deals gagnés sur la période, avec CPL, CPL qualifié, coût par deal, ROAS réel et taux de gain ; nécessite une source HubSpot connectée au dashboard ; largeur conseillée half ; pas de comparaison de période`,
  },
  meta_actions: {
    label: "Actions Meta",
    configDoc: `{ actions?: string[] (≤ ${META_ACTIONS_MAX} action_type Meta, ex. ["link_click","landing_page_view","omni_add_to_cart","omni_purchase"] ; vide = toutes les actions du compte, doublons retirés), limit?: 1-50 (défaut 15, ignoré si actions est fourni) } — volume, coût par action, valeur trackée et %Δ vs période de comparaison, par type d'action Meta ; nécessite un compte Meta lié`,
  },
  crm_attribution: {
    label: "Attribution CRM (HubSpot)",
    configDoc: `{ limit?: 1-50 (défaut 10) } — contacts / qualifiés / deals gagnés par source d'origine HubSpot (avec dépense et ROAS réel pour Paid Social = Meta et Paid Search = Google) et par campagne UTM rapprochée des campagnes Meta/Google, plus le diagnostic d'attribution (niveau 0/1/2, recommandations) ; nécessite une source HubSpot ; largeur conseillée full`,
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
  const out = validateTypedConfig(type as WidgetType, cfg);
  if ((CONVERSION_WIDGET_TYPES as readonly string[]).includes(type)) {
    let conversionEvent: string | null;
    try {
      conversionEvent = parseConversionEvent(cfg.conversionEvent);
    } catch (e) {
      throw widgetIssue((e as Error).message);
    }
    if (conversionEvent) out.conversionEvent = conversionEvent;
  }
  return out;
}

function validateTypedConfig(type: WidgetType, cfg: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
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
      const source = String(cfg.source ?? "meta");
      if (!["meta", "google"].includes(source)) {
        throw widgetIssue(`Source de courbe invalide: ${source} (meta ou google)`);
      }
      return { metric, source };
    }
    case "table": {
      const kind = String(cfg.kind ?? "campaigns");
      if (!TABLE_KINDS.includes(kind as (typeof TABLE_KINDS)[number])) {
        throw widgetIssue(`Table invalide: ${kind}. Valides: ${TABLE_KINDS.join(", ")}`);
      }
      const source = String(cfg.source ?? "google");
      if (!["google", "meta"].includes(source)) {
        throw widgetIssue(`Source de table invalide: ${source} (google ou meta)`);
      }
      if (source === "meta" && kind !== "campaigns") {
        throw widgetIssue(`La source meta ne supporte que kind=campaigns`);
      }
      const limit = Math.min(Math.max(Number(cfg.limit ?? 10) || 10, 1), 30);
      return { kind, source, limit };
    }
    case "top_creatives": {
      const limit = Math.min(Math.max(Number(cfg.limit ?? 6) || 6, 1), 10);
      return { limit };
    }
    case "platform_table":
    case "pacing":
      return {};
    case "text": {
      const markdown = String(cfg.markdown ?? "");
      if (markdown.length > 5000) throw widgetIssue("Texte trop long (5000 caractères max)");
      return { markdown };
    }
    case "funnel": {
      const source = String(cfg.source ?? "combined");
      if (!["meta", "google", "combined"].includes(source)) {
        throw widgetIssue(`Source d'entonnoir invalide: ${source} (meta, google ou combined)`);
      }
      return { source };
    }
    case "demographics": {
      const metric = String(cfg.metric ?? "spend");
      if (!DEMOGRAPHICS_METRICS.includes(metric as (typeof DEMOGRAPHICS_METRICS)[number])) {
        throw widgetIssue(`Métrique démographique invalide: ${metric}. Valides: ${DEMOGRAPHICS_METRICS.join(", ")}`);
      }
      return { metric };
    }
    case "geo_device": {
      const source = String(cfg.source ?? "meta");
      if (!["meta", "google"].includes(source)) {
        throw widgetIssue(`Source de répartition invalide: ${source} (meta ou google)`);
      }
      const dimension = String(cfg.dimension ?? "device");
      if (!GEO_DEVICE_DIMENSIONS.includes(dimension as (typeof GEO_DEVICE_DIMENSIONS)[number])) {
        throw widgetIssue(`Dimension invalide: ${dimension}. Valides: ${GEO_DEVICE_DIMENSIONS.join(", ")}`);
      }
      if (source === "google" && dimension === "country") {
        throw widgetIssue("La source google ne supporte que dimension=device (répartition pays indisponible)");
      }
      return { source, dimension };
    }
    case "alerts": {
      const limit = Math.min(Math.max(Number(cfg.limit ?? 5) || 5, 1), 20);
      return { limit };
    }
    case "crm_funnel":
      return {};
    case "crm_attribution": {
      const limit = Math.min(Math.max(Number(cfg.limit ?? 10) || 10, 1), 50);
      return { limit };
    }
    case "meta_actions": {
      const rawList = Array.isArray(cfg.actions) ? cfg.actions : [];
      const actions = [...new Set(rawList.map((a) => String(a).trim()).filter(Boolean))];
      if (actions.length > META_ACTIONS_MAX) throw widgetIssue(`${META_ACTIONS_MAX} actions max par widget`);
      const bad = actions.find((a) => !/^[A-Za-z0-9_.:-]{1,200}$/.test(a));
      if (bad) throw widgetIssue(`Type d'action Meta invalide: ${bad}`);
      const limit = Math.min(Math.max(Number(cfg.limit ?? 15) || 15, 1), 50);
      return { actions, limit };
    }
  }
}

export function validateWidgetWidth(raw: unknown): string {
  const w = String(raw ?? "half");
  return WIDGET_WIDTHS.includes(w as (typeof WIDGET_WIDTHS)[number]) ? w : "half";
}
