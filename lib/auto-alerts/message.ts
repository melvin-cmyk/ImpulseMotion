/**
 * Automatic alerting — the Slack message, and the only AI call of the feature.
 *
 * The message is built from the findings, without AI. One short AI reading is
 * added only when something NEW has no known cause (`needsAi`): the model gets
 * the few lines of the digest and ten daily figures, never the account — a few
 * hundred tokens, and none at all on a quiet day or for a payment failure.
 */

import { relayComplete } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import type { DayPoint, Finding } from "@/lib/auto-alerts/detect";
import type { Plan, Reason } from "@/lib/auto-alerts/incidents";

const DOT: Record<string, string> = { critical: ":red_circle:", warning: ":large_orange_circle:" };
const TAG: Record<Reason, string> = { new: "", escalated: " _(s'aggrave)_", reminder: " _(rappel, toujours en cours)_" };

export interface DigestInput {
  clientName: string;
  plan: Plan;
  reading?: string | null;
  link: string;
  /** Problems already announced and still open, for context. */
  stillOpen: number;
}

export function hasNews(plan: Plan): boolean {
  return plan.announce.length > 0 || plan.resolve.some((r) => r.say);
}

export function buildDigest(d: DigestInput): string {
  const lines: string[] = [];
  const n = d.plan.announce.length;
  const critical = d.plan.announce.some((a) => a.finding.severity === "critical");
  if (n) lines.push(`${critical ? ":rotating_light:" : ":warning:"} *${d.clientName}* — ${n} point${n > 1 ? "s" : ""} à regarder`);
  else lines.push(`:white_check_mark: *${d.clientName}* — retour à la normale`);
  for (const a of d.plan.announce) {
    lines.push(`${DOT[a.finding.severity] ?? DOT.warning} *${a.finding.title}*${TAG[a.reason]}\n${a.finding.detail}`);
  }
  if (d.reading) lines.push(`:mag: _Lecture_ : ${d.reading}`);
  for (const r of d.plan.resolve) {
    if (r.say) lines.push(`:white_check_mark: Résolu : ${r.incident.title}`);
  }
  const tail = d.stillOpen > 0 ? ` · ${d.stillOpen} autre${d.stillOpen > 1 ? "s" : ""} point${d.stillOpen > 1 ? "s" : ""} toujours en cours` : "";
  lines.push(`<${d.link}|Ouvrir dans ImpulseMotion>${tail}`);
  return lines.join("\n");
}

export const READING_SYSTEM_PROMPT = `Tu es consultant média senior chez Impulse Analytics. On te donne des anomalies DÉJÀ détectées sur le compte publicitaire d'un client et la dépense des derniers jours. Écris pour l'équipe, dans Slack, la lecture la plus probable et la première chose à vérifier.

RÈGLES
- 2 phrases maximum, 45 mots maximum, en français, sans emoji, sans liste, sans titre.
- Tu ne répètes pas les chiffres déjà donnés et tu n'en inventes aucun.
- Tu relies les anomalies entre elles quand elles ont sans doute la même cause.
- Tu nommes des causes concrètes et vérifiables (moyen de paiement, plafond de dépense, budget ou calendrier d'ad set, refus de créa, audience épuisée, pixel ou balise, site ou tunnel de commande, enchère trop basse).
- Si rien ne permet de trancher, dis quoi vérifier en premier, sans spéculer.
Réponds uniquement par le texte.`;

const short = (n: number) => String(Math.round(n));

export function readingPrompt(clientName: string, findings: Finding[], series: Record<string, DayPoint[]>): string {
  const lines = [`CLIENT : ${clientName}`, "ANOMALIES :"];
  for (const f of findings) lines.push(`- [${f.severity}] ${f.title} : ${f.detail}`);
  for (const [platform, days] of Object.entries(series)) {
    if (!days.length) continue;
    lines.push(`DÉPENSE / CONVERSIONS PAR JOUR (${platform}, du ${days[0].date} au ${days[days.length - 1].date}) : ${days.map((d) => `${short(d.spend)}/${short(d.conversions)}`).join(" ")}`);
  }
  return lines.join("\n");
}

/** Returns null on any failure: the digest goes out without the reading. */
export async function writeReading(
  client: { dashboardId: string | null; name: string },
  findings: Finding[],
  series: Record<string, DayPoint[]>,
): Promise<string | null> {
  try {
    const raw = await relayComplete(
      {
        messages: [{ role: "user", content: readingPrompt(client.name, findings, series) }],
        systemPrompt: READING_SYSTEM_PROMPT,
        allowedServers: [],
        accountScope: {},
        model: "sonnet",
        effort: "low",
        maxTurns: 1,
      },
      { maxMs: 45_000, onUsage: (u) => void recordAiUsage(u, { feature: "auto_alert", dashboardId: client.dashboardId, clientName: client.name }) },
    );
    const text = raw.replace(/\s+/g, " ").replace(/^["«\s]+|["»\s]+$/g, "").trim();
    return text ? text.slice(0, 400) : null;
  } catch {
    return null;
  }
}
