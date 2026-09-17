/**
 * Payload shapes emitted by lib/dashboard-widgets (passed through intact by
 * /api/dashboards/[id]) and the pure decisions the renderers take from them.
 * Every resolver ships `currency` and its unavailability flags: dropping them
 * turns an outage into a zero on the client's screen.
 */

import { errorKindLabel, PACING_STATUS_LABEL } from "@/components/portfolio/format";

/** Flags any resolver may attach to its payload. */
export interface WidgetFlags {
  /** One source of a multi-source widget failed: the numbers are incomplete. */
  partial?: boolean;
  /** Raw resolver errors, "Meta: …" / "Google: …". */
  errors?: string[];
  currency?: string;
  fetchedAt?: string;
  /** revenue/roas: no tracked value and no AOV configured. */
  unavailable?: boolean;
  truncated?: boolean;
}

export interface KpiData extends WidgetFlags {
  metric: string;
  source: string;
  value: number;
  estimated: boolean;
  previous?: number | null;
  deltaPct?: number | null;
  compareKind?: string | null;
  compareSince?: string | null;
  compareUntil?: string | null;
  /** purchases/cpa/cr on Meta: which conversion action is counted. */
  conversionLabel?: string;
}

export interface MetaActionsData extends WidgetFlags {
  rows: Array<{
    actionType: string; label: string; count: number;
    costPer: number | null; value: number | null;
    previous: number | null; deltaPct: number | null;
  }>;
  spend: number;
  compareKind?: string | null;
}

export interface PlatformTableData extends WidgetFlags {
  rows: Array<Record<string, number | string | null>>;
  compareKind?: string | null;
}

export interface TimeseriesData extends WidgetFlags {
  metric: string;
  points: Array<{ date: string; value: number }>;
  estimated: boolean;
}

export interface TableData extends WidgetFlags {
  kind: string;
  rows: Array<Record<string, unknown>>;
}

export interface TopCreativesData extends WidgetFlags {
  creatives: Array<{
    adId: string; name: string; imageUrl: string | null;
    spend: number; ctr: number; hookRate: number; roas: number;
    estimated: boolean; unavailable?: boolean;
  }>;
}

export interface PacingData extends WidgetFlags {
  monthlyTarget: number;
  mtdSpend: number;
  projectedSpend: number;
  pacingPct: number;
  status: string;
  currency: string;
  daysRemaining?: number;
  /** Set when status is "unknown" (Meta error, no closed day yet). */
  reason?: string;
}

export interface FunnelData extends WidgetFlags {
  source: string;
  steps: Array<{ label: string; value: number }>;
  rates: Array<{ label: string; pct: number }>;
}

export interface DemographicsData extends WidgetFlags {
  metric: string;
  rows: Array<{ age: string; gender: string; value: number }>;
}

export interface GeoDeviceData extends WidgetFlags {
  dimension: string;
  source: string;
  rows: Array<{ key: string; spend: number; clicks: number; conversions: number }>;
}

export interface AlertsData extends WidgetFlags {
  events: Array<{
    id: string; metric: string; value: number; threshold: number;
    message: string; acknowledged: boolean; triggeredAt: string;
  }>;
}

const PLATFORM_PREFIX: Record<string, string> = { meta: "Meta", google: "Google" };

/** Platforms named in a resolver's `errors`, in the client's vocabulary. */
export function failedPlatforms(errors?: string[]): string[] {
  const out: string[] = [];
  for (const e of errors ?? []) {
    const label = PLATFORM_PREFIX[String(e).split(":")[0].trim().toLowerCase()];
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/** Text for an empty widget: an outage must not read like an absence of traffic. */
export function emptyMessage(flags: WidgetFlags, fallback = "Pas de données sur la période"): string {
  const failed = failedPlatforms(flags.errors);
  if (!flags.partial && failed.length === 0) return fallback;
  const who = failed.length > 0 ? failed.join(" et ") : "Source publicitaire";
  return `${who} : ${errorKindLabel("widget")}`;
}

/** Warning under a partial widget — what the numbers shown do NOT cover. */
export function partialNote(flags: WidgetFlags): string | null {
  const failed = failedPlatforms(flags.errors);
  if (!flags.partial && failed.length === 0) return null;
  const who = failed.length > 0 ? failed.join(" et ") : "Une source";
  return `${who} : ${errorKindLabel("widget")} — les totaux et les taux ci-dessous n'en tiennent pas compte.`;
}

/**
 * Semantic color for a KPI value: only ROAS carries an absolute judgement
 * (≥2 healthy, <1 losing money). An unavailable metric stays grey — a missing
 * number must never be read as a counter-performance.
 */
export function kpiValueClass(metric: string, value: number, flags: WidgetFlags = {}): string {
  if (flags.unavailable) return "text-gray-500";
  if (metric === "roas" && value > 0) {
    if (value >= 2) return "text-emerald-400";
    if (value < 1) return "text-red-400";
  }
  return "text-white";
}

export type PacingTone = "default" | "amber" | "red" | "emerald";

/** Badge and wording for a pacing payload; "unknown" is an outage, not a stopped campaign. */
export function pacingView(d: Pick<PacingData, "status" | "reason">): {
  unknown: boolean;
  label: string;
  tone: PacingTone;
  reason: string | null;
} {
  const unknown = d.status === "unknown";
  const tone: PacingTone =
    unknown ? "default"
    : d.status.startsWith("critical") ? "red"
    : d.status === "on_track" ? "emerald"
    : "amber";
  return {
    unknown,
    label: PACING_STATUS_LABEL[d.status] ?? d.status,
    tone,
    reason: unknown ? d.reason ?? errorKindLabel("widget") : null,
  };
}
