/**
 * Alert rules below the account level (campaign / adset / ad) + rule input
 * validation shared by the admin and self-service routes.
 *
 * A rule with `level !== "account"` is evaluated once per entity of that
 * level on the account (after the name / min-spend filter) and raises one
 * event per matching entity — « la créa X dépense trop », not « le compte ».
 *
 * Data comes from the same Meta insight fetchers the dashboards use; adsets
 * are aggregated from ad-level rows (Meta serves both in one call), so a
 * scan costs at most two ad-level calls per account and window (current +
 * previous period), whatever the number of rules.
 */

import {
  getAdInsightsAll,
  getCampaignInsights,
  getMetaSystemToken,
  type MetaAccountInsight,
  type MetaCreativeInsight,
} from "@/lib/meta-api";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { prevRange, type DateRange } from "@/lib/date-ranges";
import { computeFromInsight, windowToRange, type ComputedMetrics } from "@/lib/alerts";

export type AlertLevel = "account" | "campaign" | "adset" | "ad" | "ad_group" | "keyword";
export type AlertMode = "rule" | "ai";
export type AlertPlatform = "meta" | "google";
export const ALERT_LEVELS: readonly AlertLevel[] = ["account", "campaign", "adset", "ad", "ad_group", "keyword"];
export const LEVEL_LABELS: Record<AlertLevel, string> = { account: "Compte", campaign: "Campagne", adset: "Ad set", ad: "Créa", ad_group: "Groupe d'annonces", keyword: "Mot-clé" };
export const LEVELS_BY_PLATFORM: Record<AlertPlatform, readonly AlertLevel[]> = {
  meta: ["account", "campaign", "adset", "ad"],
  google: ["account", "campaign", "ad_group", "keyword"],
};
export const METRICS_BY_PLATFORM: Record<AlertPlatform, readonly string[]> = {
  meta: ["roas", "spend", "cpa", "ctr", "frequency"],
  google: ["roas", "spend", "cpa", "ctr"],
};
export const AI_METRIC = "ai";

export interface AlertFilter {
  nameContains?: string;
  minSpend?: number;
}

export function parseFilter(json: string | null | undefined): AlertFilter {
  if (!json) return {};
  try {
    const v = validateFilter(JSON.parse(json));
    return v.ok ? v.value : {};
  } catch {
    return {};
  }
}

export function validateFilter(input: unknown): { ok: true; value: AlertFilter } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== "object") return { ok: false, error: "filter doit être un objet" };
  const o = input as Record<string, unknown>;
  const out: AlertFilter = {};
  if (typeof o.nameContains === "string" && o.nameContains.trim()) out.nameContains = o.nameContains.trim().slice(0, 80);
  if (o.minSpend !== undefined && o.minSpend !== null && o.minSpend !== "") {
    const n = Number(o.minSpend);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "minSpend doit être un nombre ≥ 0" };
    if (n > 0) out.minSpend = Math.round(n * 100) / 100;
  }
  return { ok: true, value: out };
}

export function isAlertLevel(v: unknown): v is AlertLevel {
  return typeof v === "string" && (ALERT_LEVELS as readonly string[]).includes(v);
}

/** Validates the rule fields shared by create and update; returns Prisma-ready data. */
export function validateRuleInput(body: Record<string, unknown>, opts: { partial?: boolean; platform?: string } = {}):
  | { ok: true; data: { level?: AlertLevel; filterJson?: string; mode?: AlertMode; prompt?: string | null; label?: string | null; metric?: string; condition?: string; threshold?: number; window?: string } }
  | { ok: false; error: string } {
  const data: { level?: AlertLevel; filterJson?: string; mode?: AlertMode; prompt?: string | null; label?: string | null; metric?: string; condition?: string; threshold?: number; window?: string } = {};
  const platform: AlertPlatform = (opts.platform ?? body.platform) === "google" ? "google" : "meta";
  if (body.level !== undefined) {
    if (!isAlertLevel(body.level)) return { ok: false, error: "level invalide" };
    if (!LEVELS_BY_PLATFORM[platform].includes(body.level)) return { ok: false, error: `niveau « ${LEVEL_LABELS[body.level]} » indisponible sur ${platform === "google" ? "Google Ads" : "Meta"}` };
    data.level = body.level;
  }
  if (body.filter !== undefined) {
    const f = validateFilter(body.filter);
    if (!f.ok) return f;
    data.filterJson = JSON.stringify(f.value);
  }
  if (body.mode !== undefined) {
    if (body.mode !== "rule" && body.mode !== "ai") return { ok: false, error: "mode invalide (rule ou ai)" };
    data.mode = body.mode;
  }
  if (body.prompt !== undefined) data.prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim().slice(0, 1500) : null;
  if (body.label !== undefined) data.label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : null;
  if (body.window !== undefined) {
    if (!["1d", "7d", "14d", "30d"].includes(String(body.window))) return { ok: false, error: "window invalide" };
    data.window = String(body.window);
  }
  const mode = data.mode ?? (opts.partial ? undefined : "rule");
  if (mode === "ai") {
    // The AI judges `prompt`: metric / condition / threshold are placeholders.
    if (!opts.partial && !data.prompt) return { ok: false, error: "prompt requis pour une alerte IA (la condition à évaluer)" };
    data.metric = AI_METRIC;
    data.condition = AI_METRIC;
    data.threshold = 0;
    if (!data.level && !opts.partial) data.level = platform === "google" ? "keyword" : "ad";
  } else {
    if (body.metric !== undefined) {
      if (!METRICS_BY_PLATFORM[platform].includes(String(body.metric))) return { ok: false, error: `métrique « ${String(body.metric)} » indisponible sur ${platform === "google" ? "Google Ads" : "Meta"}` };
      data.metric = String(body.metric);
    }
    if (body.condition !== undefined) {
      if (!["below", "above", "drop_pct"].includes(String(body.condition))) return { ok: false, error: "condition invalide" };
      data.condition = String(body.condition);
    }
    if (body.threshold !== undefined) {
      if (typeof body.threshold !== "number" || !Number.isFinite(body.threshold)) return { ok: false, error: "threshold doit être un nombre" };
      data.threshold = body.threshold;
    }
    if (!opts.partial && (!data.metric || !data.condition || data.threshold === undefined)) {
      return { ok: false, error: "metric, condition, threshold requis" };
    }
  }
  return { ok: true, data };
}

// ── Entity metrics ───────────────────────────────────────────────────────────

export interface EntityMetrics {
  id: string;
  name: string;
  level: Exclude<AlertLevel, "account">;
  current: ComputedMetrics;
  previous: ComputedMetrics;
}

type ActionList = Array<{ action_type: string; value: string }>;

function sumActions(rows: Array<ActionList | undefined>): ActionList {
  const acc = new Map<string, number>();
  for (const list of rows) for (const a of list ?? []) acc.set(a.action_type, (acc.get(a.action_type) ?? 0) + (parseFloat(a.value) || 0));
  return [...acc].map(([action_type, value]) => ({ action_type, value: String(value) }));
}

/** Folds ad-level rows into one pseudo account insight (for adset aggregation). */
export function aggregateInsights(rows: MetaCreativeInsight[]): MetaAccountInsight {
  const num = (k: keyof MetaCreativeInsight) => rows.reduce((s, r) => s + (parseFloat(String(r[k] ?? "0")) || 0), 0);
  const spend = num("spend");
  const impressions = num("impressions");
  const clicks = num("clicks");
  const reach = num("reach");
  return {
    account_id: "",
    spend: String(spend),
    impressions: String(impressions),
    clicks: String(clicks),
    ctr: String(impressions > 0 ? (clicks / impressions) * 100 : 0),
    cpm: String(impressions > 0 ? (spend / impressions) * 1000 : 0),
    reach: String(reach),
    frequency: String(reach > 0 ? impressions / reach : 0),
    actions: sumActions(rows.map((r) => r.actions)),
    action_values: sumActions(rows.map((r) => r.action_values)),
    date_start: rows[0]?.date_start ?? "",
    date_stop: rows[0]?.date_stop ?? "",
  };
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); if (!k) continue; (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
  return m;
}

/** Fetches current + previous window metrics for every entity of `level` on the account. */
export async function fetchEntityMetrics(
  accountId: string,
  level: Extract<AlertLevel, "campaign" | "adset" | "ad">,
  window: string,
): Promise<{ entities: EntityMetrics[]; range: DateRange; compare: DateRange }> {
  const token = getMetaSystemToken();
  const settings = await getAccountProfileSettings("meta", accountId);
  const range = windowToRange(window, { tz: settings.timezone });
  const compare = prevRange(range);
  const compute = (i: MetaAccountInsight | null) => computeFromInsight(i, settings);

  if (level === "campaign") {
    const [cur, prev] = await Promise.all([getCampaignInsights(token, accountId, range), getCampaignInsights(token, accountId, compare)]);
    const prevById = new Map(prev.map((r) => [r.campaign_id ?? "", r]));
    const entities = cur.filter((r) => r.campaign_id).map((r) => ({
      id: r.campaign_id!, name: r.campaign_name ?? r.campaign_id!, level: "campaign" as const,
      current: compute(r), previous: compute(prevById.get(r.campaign_id!) ?? null),
    }));
    return { entities, range, compare };
  }

  const [cur, prev] = await Promise.all([getAdInsightsAll(token, accountId, range), getAdInsightsAll(token, accountId, compare)]);
  if (level === "ad") {
    const prevById = new Map(prev.map((r) => [r.ad_id, r]));
    const entities = cur.map((r) => ({
      id: r.ad_id, name: r.ad_name, level: "ad" as const,
      current: compute(r as unknown as MetaAccountInsight), previous: compute((prevById.get(r.ad_id) as unknown as MetaAccountInsight) ?? null),
    }));
    return { entities, range, compare };
  }
  const curBy = groupBy(cur, (r) => r.adset_id);
  const prevBy = groupBy(prev, (r) => r.adset_id);
  const entities = [...curBy].map(([id, rows]) => ({
    id, name: rows[0].adset_name ?? id, level: "adset" as const,
    current: compute(aggregateInsights(rows)), previous: compute(prevBy.has(id) ? aggregateInsights(prevBy.get(id)!) : null),
  }));
  return { entities, range, compare };
}

/** Applies the rule filter (name, min spend) to the entities. */
export function filterEntities<T extends { name: string; current: { spend: number } }>(entities: T[], filter: AlertFilter): T[] {
  const needle = filter.nameContains?.toLowerCase();
  return entities.filter((e) => (!needle || e.name.toLowerCase().includes(needle)) && (!filter.minSpend || e.current.spend >= filter.minSpend));
}

/** One-line human summary of a filter, for lists and messages. */
export function describeFilter(filter: AlertFilter): string {
  const parts = [filter.nameContains ? `nom contient « ${filter.nameContains} »` : null, filter.minSpend ? `dépense ≥ ${filter.minSpend}` : null].filter(Boolean);
  return parts.join(" · ");
}
