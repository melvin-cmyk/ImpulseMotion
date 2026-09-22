/**
 * AI-assisted alerts — two small one-shot calls through the relay, no tools.
 *
 * 1. composeAlertProposal(text): the consultant writes the alert in French;
 *    the model maps it onto the rule grammar (level / metric / condition /
 *    threshold / window / filter). What does not fit becomes an "ai" rule.
 * 2. evaluateAiRule(rule, snapshot): every morning, an "ai" rule is judged on
 *    a compact snapshot of the account (KPIs + campaigns + ads with spend,
 *    CPA, CTR, frequency, both windows). Strict JSON out, no invented data.
 */

import { relayComplete, parseLooseJson } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import { METRIC_LABELS, type AlertMetric, type ComputedMetrics } from "@/lib/alerts";
import { LEVEL_LABELS, validateFilter, isAlertLevel, type AlertFilter, type AlertLevel, type EntityMetrics } from "@/lib/alert-entities";

export type AlertProposal =
  | { mode: "rule"; label: string; level: AlertLevel; metric: AlertMetric; condition: "below" | "above" | "drop_pct"; threshold: number; window: string; filter: AlertFilter; explanation: string }
  | { mode: "ai"; label: string; prompt: string; level: AlertLevel; window: string; filter: AlertFilter; explanation: string };

const WINDOWS = ["1d", "7d", "14d", "30d"];

export const COMPOSE_SYSTEM_PROMPT = `Tu transformes la demande d'un consultant média (en français) en règle d'alerte pour ImpulseMotion, un outil de pilotage Meta Ads.

GRAMMAIRE D'UNE RÈGLE CLASSIQUE (préférée : gratuite et déterministe)
- level : account (compte entier) | campaign | adset | ad (créa)
- metric : roas | spend (dépenses) | cpa | ctr | frequency
- condition : below | above | drop_pct (chute en % vs période précédente)
- threshold : nombre (montant, ratio, % pour drop_pct)
- window : 1d | 7d | 14d | 30d (jours complets finissant hier)
- filter : { "nameContains"?: "…" (sous-chaîne du nom de campagne/adset/créa), "minSpend"?: nombre (ignorer les éléments sous ce montant) }
Une règle classique évalue UNE métrique contre UN seuil, par élément du niveau choisi. « Une créa qui dépense plus de 200 € en 7 jours » → level ad, metric spend, condition above, threshold 200, window 7d. « … avec un CPA au-dessus de 30 € » en plus → deux métriques : la règle classique ne le permet pas, sauf en mettant la première dans filter.minSpend (dépense minimum) et la seconde en métrique : level ad, metric cpa, above 30, filter { minSpend: 200 }.

ALERTE IA (seulement si la demande ne rentre pas dans la grammaire : comparaison entre éléments, part de budget, tendance, combinaison de plusieurs métriques non réductible)
- mode "ai", prompt = la condition reformulée précisément en une phrase, level = le niveau d'éléments à regarder, window.

RÉPONDS UNIQUEMENT par un bloc \`\`\`json :
{"mode":"rule","label":"Nom court","level":"ad","metric":"cpa","condition":"above","threshold":30,"window":"7d","filter":{"minSpend":200},"explanation":"1 phrase : comment tu as lu la demande"}
ou
{"mode":"ai","label":"Nom court","prompt":"Condition précise","level":"ad","window":"7d","filter":{},"explanation":"1 phrase : pourquoi une règle classique ne suffit pas"}
Le label fait moins de 60 caractères. Ne pose pas de question : choisis l'interprétation la plus utile et dis-la dans explanation.`;

export function parseProposal(raw: string): AlertProposal {
  const p = parseLooseJson<Record<string, unknown>>(raw);
  if (!p || typeof p !== "object") throw new Error("Réponse IA illisible");
  const level = isAlertLevel(p.level) ? p.level : "account";
  const window = WINDOWS.includes(String(p.window)) ? String(p.window) : "7d";
  const f = validateFilter(p.filter);
  const filter = f.ok ? f.value : {};
  const label = String(p.label ?? "").trim().slice(0, 60) || "Alerte";
  const explanation = String(p.explanation ?? "").trim().slice(0, 300);
  if (p.mode === "ai") {
    const prompt = String(p.prompt ?? "").trim().slice(0, 1500);
    if (!prompt) throw new Error("L'IA n'a pas formulé de condition");
    return { mode: "ai", label, prompt, level: level === "account" ? "ad" : level, window, filter, explanation };
  }
  const metric = String(p.metric);
  const condition = String(p.condition);
  const threshold = Number(p.threshold);
  if (!["roas", "spend", "cpa", "ctr", "frequency"].includes(metric)) throw new Error(`métrique inconnue : ${metric}`);
  if (!["below", "above", "drop_pct"].includes(condition)) throw new Error(`condition inconnue : ${condition}`);
  if (!Number.isFinite(threshold)) throw new Error("seuil manquant");
  return { mode: "rule", label, level, metric: metric as AlertMetric, condition: condition as "below" | "above" | "drop_pct", threshold, window, filter, explanation };
}

export async function composeAlertProposal(text: string, user?: { id: string; email?: string | null; role: string }): Promise<AlertProposal> {
  const raw = await relayComplete(
    { messages: [{ role: "user", content: `DEMANDE DU CONSULTANT :\n${text.trim().slice(0, 1000)}` }], systemPrompt: COMPOSE_SYSTEM_PROMPT, allowedServers: [], accountScope: {} },
    { maxMs: 40_000, onUsage: (usage) => void recordAiUsage(usage, { feature: "alert_compose", clientName: "—", user }) },
  );
  return parseProposal(raw);
}

// ── Daily evaluation of an "ai" rule ─────────────────────────────────────────

export interface AiSnapshot {
  accountLabel: string;
  window: string;
  range: { since: string; until: string };
  compare: { since: string; until: string };
  account: { current: ComputedMetrics; previous: ComputedMetrics } | null;
  campaigns: EntityMetrics[];
  ads: EntityMetrics[];
}

const m = (c: ComputedMetrics) => `dép ${c.spend} · conv ${c.conversions} · CPA ${c.cpa || "n/a"} · ROAS ${c.roasAvailable ? c.roas : "n/a"} · CTR ${c.ctr} · fréq ${c.frequency}`;

export function renderSnapshot(s: AiSnapshot): string {
  const lines: string[] = [];
  lines.push(`COMPTE : ${s.accountLabel} — fenêtre ${s.window} : ${s.range.since} → ${s.range.until} (précédente ${s.compare.since} → ${s.compare.until}). Montants dans la devise du compte.`);
  if (s.account) lines.push(`TOTAL COMPTE : ${m(s.account.current)} | précédent : ${m(s.account.previous)}`);
  const top = <T extends EntityMetrics>(arr: T[], n: number) => [...arr].sort((a, b) => b.current.spend - a.current.spend).slice(0, n);
  if (s.campaigns.length) {
    lines.push(`\nCAMPAGNES (${s.campaigns.length}, top ${Math.min(15, s.campaigns.length)} par dépense) :`);
    for (const c of top(s.campaigns, 15)) lines.push(`- ${c.name} : ${m(c.current)} | précédent : ${m(c.previous)}`);
  }
  if (s.ads.length) {
    lines.push(`\nCRÉAS (${s.ads.length}, top ${Math.min(25, s.ads.length)} par dépense) :`);
    for (const a of top(s.ads, 25)) lines.push(`- ${a.name} : ${m(a.current)} | précédent : ${m(a.previous)}`);
  }
  return lines.join("\n");
}

export const EVALUATE_SYSTEM_PROMPT = `Tu es le moniteur d'alertes d'ImpulseMotion. On te donne une CONDITION écrite par un consultant et un SNAPSHOT chiffré du compte Meta Ads. Tu décides si la condition est remplie AUJOURD'HUI, uniquement à partir des chiffres du snapshot.

RÈGLES
- N'invente aucun chiffre ; si le snapshot ne permet pas de juger, réponds triggered=false et explique-le dans "message".
- Ignore le bruit : un élément sous 20 de dépense ou avec moins de 3 conversions ne justifie pas une alerte, sauf si la condition porte explicitement dessus.
- Le message est une phrase de consultant, en français, avec les chiffres qui justifient l'alerte (élément, valeur, seuil ou comparaison). Pas d'emoji.
- Liste dans "entities" les éléments en cause (nom exact du snapshot, niveau campaign|ad, valeur clé).

RÉPONDS UNIQUEMENT par un bloc \`\`\`json :
{"triggered": true|false, "message": "…", "entities": [{"name": "…", "level": "ad", "value": 42.5}]}`;

export interface AiVerdict {
  triggered: boolean;
  message: string;
  entities: Array<{ name: string; level: string; value: number | null }>;
}

export function parseVerdict(raw: string): AiVerdict {
  const p = parseLooseJson<Record<string, unknown>>(raw);
  if (!p || typeof p !== "object" || typeof p.triggered !== "boolean") throw new Error("Verdict IA illisible");
  const entities = Array.isArray(p.entities)
    ? p.entities.filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && typeof (e as Record<string, unknown>).name === "string")
      .slice(0, 10)
      .map((e) => ({ name: String(e.name).slice(0, 160), level: String(e.level ?? "ad"), value: typeof e.value === "number" && Number.isFinite(e.value) ? e.value : null }))
    : [];
  return { triggered: p.triggered, message: String(p.message ?? "").trim().slice(0, 600) || (p.triggered ? "Condition remplie" : ""), entities };
}

export async function evaluateAiRule(
  rule: { id: string; prompt: string; level: string; label: string | null },
  snapshot: AiSnapshot,
  usage: { dashboardId?: string | null; clientName: string },
): Promise<AiVerdict> {
  const levelHint = rule.level === "campaign" ? "campagnes" : rule.level === "ad" ? "créas" : rule.level === "adset" ? "ad sets (regarde les créas qui les composent)" : "compte entier";
  const raw = await relayComplete(
    {
      messages: [{ role: "user", content: `CONDITION (${rule.label ?? "alerte IA"}, niveau : ${levelHint}) :\n${rule.prompt}\n\nSNAPSHOT :\n${renderSnapshot(snapshot)}` }],
      systemPrompt: EVALUATE_SYSTEM_PROMPT,
      allowedServers: [],
      accountScope: {},
    },
    { maxMs: 60_000, onUsage: (u) => void recordAiUsage(u, { feature: "alert_ai", ...usage }) },
  );
  return parseVerdict(raw);
}

export const levelLabel = (level: string): string => (isAlertLevel(level) ? LEVEL_LABELS[level] : level);
export const metricLabel = (metric: string): string => (metric in METRIC_LABELS ? METRIC_LABELS[metric as AlertMetric] : metric);
