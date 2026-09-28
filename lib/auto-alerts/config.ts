/**
 * Automatic alerting — what a client is watched for, and how often.
 * Stored per client in AlertClient.autoAlertConfig; an empty object means
 * "everything, twice a day", so a new client is covered without any setup.
 */

import type { FindingKind } from "@/lib/auto-alerts/detect";

export type TopicId = "billing" | "delivery" | "creatives" | "tracking" | "performance" | "budget";
export type Frequency = "1x" | "2x" | "4x";

export const TOPICS: Array<{ id: TopicId; label: string; hint: string; kinds: FindingKind[] }> = [
  { id: "billing", label: "Compte et paiement", hint: "Compte désactivé, paiement refusé, plafond de dépense atteint, accès au compte perdu", kinds: ["account_blocked", "spend_cap", "access_lost"] },
  { id: "delivery", label: "Diffusion", hint: "Dépense qui s'arrête ou qui s'emballe", kinds: ["spend_stopped", "spend_spike"] },
  { id: "creatives", label: "Créas", hint: "Créa refusée, en erreur, ou active qui ne dépense plus", kinds: ["ad_blocked", "ad_stopped"] },
  { id: "tracking", label: "Conversions", hint: "Plus aucune conversion alors que le compte dépense", kinds: ["conversions_zero"] },
  { id: "performance", label: "Performance", hint: "CPA ou ROAS qui décroche sur 3 jours", kinds: ["perf_drift"] },
  { id: "budget", label: "Budget", hint: "Rythme de dépense très au-dessus ou en dessous du budget mensuel", kinds: ["pacing"] },
];

export const FREQUENCIES: Array<{ id: Frequency; label: string }> = [
  { id: "1x", label: "1 fois par jour (matin)" },
  { id: "2x", label: "2 fois par jour (matin, après-midi)" },
  { id: "4x", label: "4 fois par jour" },
];

/** UTC hours of the cron in vercel.json, in order. */
export const SLOTS_UTC = [6, 9, 12, 15] as const;
const SLOTS_OF: Record<Frequency, number[]> = { "1x": [0], "2x": [0, 2], "4x": [0, 1, 2, 3] };

export interface AutoAlertConfig {
  topics: Record<TopicId, boolean>;
  frequency: Frequency;
  weekdaysOnly: boolean;
}

export const DEFAULT_CONFIG: AutoAlertConfig = {
  topics: { billing: true, delivery: true, creatives: true, tracking: true, performance: true, budget: true },
  frequency: "2x",
  weekdaysOnly: false,
};

const isFrequency = (v: unknown): v is Frequency => v === "1x" || v === "2x" || v === "4x";

/** Lenient: anything unknown falls back to the default. */
export function normalizeConfig(input: unknown): AutoAlertConfig {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const t = o.topics && typeof o.topics === "object" ? (o.topics as Record<string, unknown>) : {};
  const topics = { ...DEFAULT_CONFIG.topics };
  for (const topic of TOPICS) if (typeof t[topic.id] === "boolean") topics[topic.id] = t[topic.id] as boolean;
  return { topics, frequency: isFrequency(o.frequency) ? o.frequency : DEFAULT_CONFIG.frequency, weekdaysOnly: o.weekdaysOnly === true };
}

export function parseConfig(json: string | null | undefined): AutoAlertConfig {
  if (!json) return normalizeConfig({});
  try { return normalizeConfig(JSON.parse(json)); } catch { return normalizeConfig({}); }
}

export function enabledKinds(config: AutoAlertConfig): Set<FindingKind> {
  return new Set(TOPICS.filter((t) => config.topics[t.id]).flatMap((t) => t.kinds));
}

/** Slot of a cron firing (it may start a little late); null outside any slot. */
export function slotOf(now: Date): number | null {
  const h = now.getUTCHours();
  const i = SLOTS_UTC.findIndex((s) => h >= s && h < s + 2);
  return i === -1 ? null : i;
}

/** Is this client due at this cron firing? Weekend = Saturday and Sunday in Paris. */
export function isDue(config: AutoAlertConfig, now: Date): boolean {
  const slot = slotOf(now);
  if (slot === null || !SLOTS_OF[config.frequency].includes(slot)) return false;
  if (config.weekdaysOnly) {
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", weekday: "short" }).format(now);
    if (day === "Sat" || day === "Sun") return false;
  }
  return true;
}
