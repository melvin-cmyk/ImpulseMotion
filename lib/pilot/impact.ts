/**
 * Pilotage — what a change did to the results, 7 and 14 days after.
 *
 * For each action sent, at J+7 and J+14: every object it changed (campaign,
 * ad set / ad group, ad) and the whole account, the N full days BEFORE the day
 * of the change against the N full days AFTER it (the day itself is left out:
 * it is half before, half after). The analysis waits one more day so that late
 * conversions are counted.
 *
 * No AI at all: figures, then one paragraph written by code (the same in the
 * page and in HQ). The verdict follows the goal of the action when it has
 * one (CPA, ROAS, spend, conversions…), else the cost of a result.
 *
 * Pure: no network, no database.
 */

import { GOAL_METRIC_FR, PLATFORM_FR, goalText, objectLabel, type PilotGoal } from "@/lib/pilot/ops";

export const IMPACT_HORIZONS = [7, 14] as const;
export type ImpactHorizon = (typeof IMPACT_HORIZONS)[number];
/** Days waited after the last day of the window: conversions come in late. */
export const IMPACT_SETTLE_DAYS = 1;
/** Below this many conversions on both sides, cost per result is not judged. */
export const IMPACT_MIN_CONVERSIONS = 5;
/** A move smaller than this (in %) is « stable ». */
export const IMPACT_FLAT_PCT = 5;

export interface Range { since: string; until: string }

export interface Metrics {
  spend: number;
  conversions: number;
  revenue: number | null;
  clicks: number;
  impressions: number;
}

export interface ObjectImpact {
  objectId: string;
  objectType: string;
  name: string;
  /** What was changed on it, as the journal says it. */
  changes: string[];
  before: Metrics | null;
  after: Metrics | null;
  error?: string | null;
  /** Its campaign (or ad set) was changed by the same action: shown, not added to the total. */
  insideChanged?: boolean;
}

export interface ImpactResult {
  horizon: number;
  before: Range;
  after: Range;
  currency: string;
  objects: ObjectImpact[];
  account: { before: Metrics | null; after: Metrics | null; error?: string | null };
}

export type Verdict = "improved" | "worse" | "mixed" | "flat" | "low_volume" | "skipped";

export const VERDICT_FR: Record<Verdict, string> = {
  improved: "en progrès",
  worse: "en recul",
  mixed: "contrasté",
  flat: "stable",
  low_volume: "volume trop faible",
  skipped: "non analysé",
};

// ── Dates ────────────────────────────────────────────────────────────────

/** YYYY-MM-DD of an instant in Paris. */
export function parisDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function addDays(day: string, n: number): string {
  const t = new Date(`${day}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** N full days before the day of the change, and N full days after it. */
export function impactWindows(executedAt: Date, horizon: number): { before: Range; after: Range } {
  const day = parisDay(executedAt);
  return {
    before: { since: addDays(day, -horizon), until: addDays(day, -1) },
    after: { since: addDays(day, 1), until: addDays(day, horizon) },
  };
}

/** True when the window after the change is complete and settled. */
export function impactDue(executedAt: Date, horizon: number, now: Date): boolean {
  const { after } = impactWindows(executedAt, horizon);
  return parisDay(now) > addDays(after.until, IMPACT_SETTLE_DAYS);
}

// ── Figures ──────────────────────────────────────────────────────────────

export const cpaOf = (m: Metrics | null) => (m && m.conversions > 0 ? m.spend / m.conversions : null);
export const roasOf = (m: Metrics | null) => (m && m.revenue !== null && m.spend > 0 ? m.revenue / m.spend : null);
export const ctrOf = (m: Metrics | null) => (m && m.impressions > 0 ? (m.clicks / m.impressions) * 100 : null);
const cpcOf = (m: Metrics | null) => (m && m.clicks > 0 ? m.spend / m.clicks : null);
const cpmOf = (m: Metrics | null) => (m && m.impressions > 0 ? (m.spend / m.impressions) * 1000 : null);

export function pct(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before === 0) return null;
  return ((after - before) / Math.abs(before)) * 100;
}

export function sumMetrics(list: Array<Metrics | null>): Metrics | null {
  const ok = list.filter((m): m is Metrics => !!m);
  if (!ok.length) return null;
  const revenue = ok.some((m) => m.revenue !== null) ? ok.reduce((n, m) => n + (m.revenue ?? 0), 0) : null;
  return {
    spend: ok.reduce((n, m) => n + m.spend, 0),
    conversions: ok.reduce((n, m) => n + m.conversions, 0),
    revenue,
    clicks: ok.reduce((n, m) => n + m.clicks, 0),
    impressions: ok.reduce((n, m) => n + m.impressions, 0),
  };
}

/**
 * The objects changed, summed: what the action was about. An object inside
 * another changed one (an ad set of a changed campaign) is left out, so that
 * nothing is counted twice.
 */
export function changedTotal(r: ImpactResult): { before: Metrics | null; after: Metrics | null } | null {
  const objects = r.objects.filter((o) => !o.error && !o.insideChanged);
  const before = sumMetrics(objects.map((o) => o.before));
  const after = sumMetrics(objects.map((o) => o.after));
  return before || after ? { before, after } : null;
}

// ── Verdict ──────────────────────────────────────────────────────────────

/** Lower is better for these. */
const LOWER_BETTER = new Set(["cpa", "cpm", "cpc"]);

function metricValue(metric: string, m: Metrics | null): number | null {
  switch (metric) {
    case "cpa": return cpaOf(m);
    case "roas": return roasOf(m);
    case "spend": return m ? m.spend : null;
    case "conversions": return m ? m.conversions : null;
    case "ctr": return ctrOf(m);
    case "cpc": return cpcOf(m);
    case "cpm": return cpmOf(m);
    default: return null;
  }
}

/**
 * The verdict on the changed objects: the goal's metric when the action has
 * one, else cost per result, else (no conversion on either side) « low volume ».
 */
export function verdictOf(result: ImpactResult, goal: PilotGoal): { verdict: Verdict; metric: string | null; before: number | null; after: number | null; change: number | null } {
  const total = changedTotal(result);
  const before = total ? total.before : null;
  const after = total ? total.after : null;
  if (!before && !after) return { verdict: "low_volume", metric: null, before: null, after: null, change: null };

  let metric = goal.metric && goal.metric !== "other" ? goal.metric : "cpa";
  const conversionMetric = metric === "cpa" || metric === "roas";
  const lowVolume = (before?.conversions ?? 0) < IMPACT_MIN_CONVERSIONS && (after?.conversions ?? 0) < IMPACT_MIN_CONVERSIONS;
  if (conversionMetric && lowVolume) {
    // Too few conversions to judge their cost: the spend tells what moved, no verdict on efficiency.
    if (goal.metric === "cpa" || goal.metric === "roas") return { verdict: "low_volume", metric, before: metricValue(metric, before), after: metricValue(metric, after), change: null };
    metric = "spend";
    const b = metricValue("spend", before), a = metricValue("spend", after);
    return { verdict: "low_volume", metric, before: b, after: a, change: pct(b, a) };
  }
  const b = metricValue(metric, before), a = metricValue(metric, after);
  const change = pct(b, a);
  if (change === null) return { verdict: a === null && b === null ? "low_volume" : "mixed", metric, before: b, after: a, change };
  if (Math.abs(change) < IMPACT_FLAT_PCT) return { verdict: "flat", metric, before: b, after: a, change };
  // Spend has no « better » of its own: it follows the goal's target when there is one, else it is only described.
  if (metric === "spend" || metric === "conversions") {
    const target = goal.target;
    if (metric === "spend" && target === null) return { verdict: "mixed", metric, before: b, after: a, change };
    const better = metric === "conversions" ? change > 0 : target !== null && b !== null && a !== null ? Math.abs(a - target) < Math.abs(b - target) : change > 0;
    return { verdict: better ? "improved" : "worse", metric, before: b, after: a, change };
  }
  const better = LOWER_BETTER.has(metric) ? change < 0 : change > 0;
  return { verdict: better ? "improved" : "worse", metric, before: b, after: a, change };
}

// ── Text ─────────────────────────────────────────────────────────────────

const METRIC_FR: Record<string, string> = { ...GOAL_METRIC_FR, cpc: "CPC", cpm: "CPM" };

function fmtMoney(v: number | null, currency: string): string {
  if (v === null) return "—";
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}
const fmtNum = (v: number | null, digits = 1) => (v === null ? "—" : new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits }).format(v));
export const fmtPct = (v: number | null) => (v === null ? "" : `${v > 0 ? "+" : ""}${fmtNum(v, 0)} %`);

export function metricText(metric: string, v: number | null, currency: string): string {
  if (v === null) return "—";
  if (metric === "roas") return fmtNum(v, 2);
  if (metric === "ctr") return `${fmtNum(v, 2)} %`;
  if (metric === "conversions") return fmtNum(v, 1);
  return fmtMoney(v, currency);
}

/** One line of figures: spend, conversions, CPA, ROAS — before → after. */
export function figuresLine(before: Metrics | null, after: Metrics | null, currency: string): string {
  const parts = [
    `dépense ${fmtMoney(before?.spend ?? null, currency)} → ${fmtMoney(after?.spend ?? null, currency)} ${fmtPct(pct(before?.spend ?? null, after?.spend ?? null))}`.trim(),
    `conversions ${fmtNum(before?.conversions ?? null)} → ${fmtNum(after?.conversions ?? null)} ${fmtPct(pct(before?.conversions ?? null, after?.conversions ?? null))}`.trim(),
  ];
  const cb = cpaOf(before), ca = cpaOf(after);
  if (cb !== null || ca !== null) parts.push(`CPA ${fmtMoney(cb, currency)} → ${fmtMoney(ca, currency)} ${fmtPct(pct(cb, ca))}`.trim());
  const rb = roasOf(before), ra = roasOf(after);
  if (rb !== null || ra !== null) parts.push(`ROAS ${fmtNum(rb, 2)} → ${fmtNum(ra, 2)} ${fmtPct(pct(rb, ra))}`.trim());
  return parts.join(" · ");
}

const dayFr = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** The paragraph shown in the page and written in HQ. */
export function impactSummary(result: ImpactResult, goal: PilotGoal, platform: string): { verdict: Verdict; summary: string } {
  const v = verdictOf(result, goal);
  const total = changedTotal(result);
  const head = `Bilan à J+${result.horizon} — ${VERDICT_FR[v.verdict]}.`;
  const period = `${result.horizon} jours avant (${dayFr(result.before.since)}–${dayFr(result.before.until)}) contre ${result.horizon} jours après (${dayFr(result.after.since)}–${dayFr(result.after.until)}).`;
  const lines: string[] = [head, period];
  if (v.metric && (v.before !== null || v.after !== null)) {
    const target = goal.metric === v.metric && goal.target !== null ? ` (objectif ${metricText(v.metric, goal.target, result.currency)})` : "";
    lines.push(`${METRIC_FR[v.metric] ?? v.metric} des objets modifiés : ${metricText(v.metric, v.before, result.currency)} → ${metricText(v.metric, v.after, result.currency)} ${fmtPct(v.change)}${target}.`.replace(/ \./, "."));
  }
  if (v.verdict === "low_volume") lines.push(`Moins de ${IMPACT_MIN_CONVERSIONS} conversions de part et d'autre : le coût par résultat n'est pas jugé.`);
  if (total) lines.push(`Objets modifiés : ${figuresLine(total.before, total.after, result.currency)}.`);
  if (result.account.before || result.account.after) lines.push(`Compte ${PLATFORM_FR[platform] ?? platform} entier : ${figuresLine(result.account.before, result.account.after, result.currency)}.`);
  const unread = result.objects.filter((o) => o.error).length;
  if (unread) lines.push(`${unread} objet(s) illisible(s) sur la plateforme : non comptés.`);
  return { verdict: v.verdict, summary: lines.join(" ") };
}

/** The HQ entry of an impact (journal of the client). */
export function impactHqEntry(input: {
  actionId: string; clientName: string; platform: string; accountName: string; accountId: string;
  authorName: string; executedAt: Date; why: string; goal: PilotGoal; changes: string[];
  result: ImpactResult; summary: string;
  /** A change read on the platform (not sent from Pilotage). */
  external?: boolean;
}): string {
  const platform = PLATFORM_FR[input.platform] ?? input.platform;
  const when = input.executedAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const goal = goalText(input.goal);
  const objects = input.result.objects.map((o) =>
    `- ${objectLabel(input.platform, o.objectType)} « ${o.name} » : ${o.error ? `illisible (${o.error})` : figuresLine(o.before, o.after, input.result.currency)}`);
  return [
    `## Bilan à J+${input.result.horizon} d'une modification ${platform}${input.external ? " hors ImpulseMotion" : ""} — ${input.clientName}`,
    "",
    `Modification faite par ${input.authorName} le ${when} sur le compte ${platform} « ${input.accountName || input.accountId} » (${input.accountId})${input.external ? ", lue dans le journal de la plateforme" : ""}.`,
    `**Ce qui avait été fait** :`,
    ...input.changes.map((c) => `- ${c}`),
    `**Pourquoi** : ${input.why || "non précisé"}${goal ? ` — **Objectif** : ${goal}` : ""}`,
    "",
    "### Résultat",
    input.summary,
    "",
    "### Par objet",
    ...objects,
    "",
    "---",
    `_Calculé automatiquement par ImpulseMotion (sans IA), ${input.external ? "modification" : "action"} ${input.actionId}._`,
  ].join("\n");
}

export function impactHqSlug(actionId: string, horizon: number, executedAt: Date): string {
  return `pilotage-bilan-j${horizon}-${parisDay(executedAt)}-${actionId.slice(-8)}`;
}
