/**
 * Agents IA of the Analyse Ads — Motion's AI agent workflows. A run reads the
 * client's warehouse (30 days vs the 30 before), the playbook, the glossary
 * and, for « Voix du client », the Meta comments; the AI (relay, Sonnet low)
 * answers in 3–6 sections stored on AdAgentRun. The team scores sections and
 * asks follow-up questions (the run's sections are the context).
 */

import { prisma } from "@/lib/prisma";
import { relayComplete, parseLooseJson } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import { metaCommentsOpen, readAdComments } from "@/lib/meta-comments";
import { queryAds, type AdsGroupRow, type AdsQuery, type AdsQueryResult, type MetricKey, type Metrics } from "./query";
import { METRIC_BY_KEY, fmtMetric } from "./metrics-ui";
import { playbookContext } from "./playbook";
import { GLOSSARY_LABELS, type GlossaryKey } from "./glossary-labels";
import { AGENT_BY_KEY, type AgentFollowup, type AgentRunView, type AgentSection, type AgentWorkflow } from "./agents-catalog";

export type AgentUser = { id: string; email: string | null; role: string; name: string };
type RunRow = { id: string; workflow: string; creativeKey: string | null; label: string; input: string; status: string; error: string; sectionsJson: string; scoresJson: string; followupsJson: string; createdByName: string; createdAt: Date };

const parse = <T,>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

export function toRun(r: RunRow): AgentRunView {
  return {
    id: r.id, workflow: r.workflow, creativeKey: r.creativeKey, label: r.label, input: r.input,
    status: (["running", "done", "error"].includes(r.status) ? r.status : "error") as AgentRunView["status"], error: r.error,
    sections: parse<AgentSection[]>(r.sectionsJson, []), scores: parse<Record<string, 1 | -1>>(r.scoresJson, {}),
    followups: parse<AgentFollowup[]>(r.followupsJson, []), createdByName: r.createdByName, createdAt: r.createdAt.toISOString(),
  };
}

/** Sections from the AI's JSON: 1–6, title ≤ 80, body ≤ 3000. */
export function cleanSections(v: unknown): AgentSection[] {
  const list = Array.isArray((v as { sections?: unknown })?.sections) ? (v as { sections: unknown[] }).sections : [];
  return list.map((s) => ({ title: str((s as AgentSection)?.title, 80), body: str((s as AgentSection)?.body, 3000) })).filter((s) => s.title && s.body).slice(0, 6);
}

/** The last 30 full days, and the 30 before. */
function periods() {
  const until = new Date(); until.setUTCDate(until.getUTCDate() - 1);
  const since = new Date(until); since.setUTCDate(since.getUTCDate() - 29);
  const pUntil = new Date(since); pUntil.setUTCDate(pUntil.getUTCDate() - 1);
  const pSince = new Date(pUntil); pSince.setUTCDate(pSince.getUTCDate() - 29);
  return { range: { since: iso(since), until: iso(until) }, compare: { since: iso(pSince), until: iso(pUntil) } };
}

const METRICS: MetricKey[] = ["spend", "ctr", "cpm", "frequency", "cpa", "roas", "hookRate", "holdRate", "hookScore", "convertScore"];

function metricsLine(res: AdsQueryResult, x: Metrics): string {
  return METRICS.filter((k) => !(k === "roas" && res.benchmark.roasUnavailable)).map((k) => `${METRIC_BY_KEY[k].short}=${fmtMetric(k, x[k], res.currency, x)}`).join(" · ");
}

function creativeLine(res: AdsQueryResult, r: AdsGroupRow, i: number, detail = false): string {
  const a = r.sample!;
  const tags = Object.entries(a.tags).filter(([k]) => k.startsWith("ai:")).map(([k, v]) => `${GLOSSARY_LABELS[k as GlossaryKey] ?? k}=${v}`).join(", ");
  const txt = [a.title, a.body].filter(Boolean).join(" — ").replace(/\s+/g, " ").slice(0, detail ? 1200 : 200);
  const trend = r.trend ? ` · dépense 7 j ${r.trend.state}${r.trend.wow !== null ? ` (${r.trend.wow > 0 ? "+" : ""}${Math.round(r.trend.wow)} %)` : ""}` : "";
  return [
    `${i}. ${r.label.slice(0, 90)} [${a.format}${a.dynamic ? ", dynamique" : ""}${r.launch ? `, lancée ${r.launch}` : ""}, ${r.adCount} annonce${r.adCount > 1 ? "s" : ""}]${tags ? ` {${tags}}` : ""}`,
    `   30 j : ${metricsLine(res, r.metrics)}${trend}`,
    r.previous && r.previous.spend > 0 ? `   30 j d'avant : ${metricsLine(res, r.previous)}` : "",
    txt ? `   texte : ${txt}` : "",
    detail && a.landingUrl ? `   page : ${a.landingUrl.split("?")[0]}` : "",
    detail && a.campaignName ? `   campagne : ${a.campaignName}${a.adsetName ? ` / ${a.adsetName}` : ""}` : "",
  ].filter(Boolean).join("\n");
}

const SYSTEM_BASE = `Tu es stratège créatif senior en acquisition payante dans une agence. Tu travailles sur UN annonceur avec ses vrais chiffres (30 derniers jours, comparés aux 30 d'avant) et son playbook (apprentissages déjà validés par l'équipe : appuie-toi dessus, ne les répète pas).
Règles : français, concret, chiffré, chaque affirmation appuyée sur les données fournies ; aucune généralité marketing ; cite les créas par leur nom court ; si une donnée manque, dis-le au lieu d'inventer.
Réponds UNIQUEMENT en JSON : {"sections":[{"title":"…","body":"…"}]} — 3 à 6 sections, titre court, corps en texte simple (listes avec « - » autorisées, pas de tableau).`;

const TASK: Record<string, string> = {
  creative_breakdown: `Décortique la créa étudiée : ce qui arrête le scroll (hook), le message et la promesse, le format, ce que disent ses chiffres face à la moyenne du compte (forces, faiblesses, où elle perd les gens), puis « À garder / À changer ». Sections suggérées : Verdict, Hook, Message, Chiffres, À garder / À changer.`,
  creative_iterations: `Propose exactement 5 itérations de la créa étudiée, prêtes à briefer à un designer ou un monteur. Une section par itération : titre = nom de l'itération ; corps = ce qui change (hook, visuel, angle ou format), ce qui reste, l'hypothèse testée et le chiffre qu'on espère bouger.`,
  creative_voice: `Lis les commentaires laissés sous la créa étudiée (ce sont les mots des clients). Sections : Ce qu'ils veulent, Leurs objections (et comment y répondre dans la créa), Mots exacts à reprendre (citations courtes), Idées de hooks tirées des commentaires, Signaux à remonter au client (SAV, prix, produit). Ne cite que des commentaires fournis.`,
  account_brief: `Rédige le brief de la prochaine vague de créas : trois concepts, une section chacun (titre = nom du concept ; corps = angle, persona, hook d'ouverture, format et durée, preuve ou offre, pourquoi maintenant d'après les chiffres et le playbook, gagnante dont il s'inspire). Termine par une section « Ce qu'on arrête ».`,
  account_fatigue: `Fais l'audit de fatigue : quelles créas s'essoufflent (dépense ou efficacité en baisse face aux 30 jours d'avant, fréquence qui monte, scores qui chutent), lesquelles remplacer en premier et par quoi, lesquelles tiennent encore. Sections suggérées : Diagnostic, À remplacer en priorité, Sous surveillance, Encore solides, Plan de renouvellement.`,
  account_gaps: `Lis la performance par catégorie du glossaire (types d'asset, formats visuels, personas, thèmes, hooks, offres, thèmes de message) : ce qui est sur-investi sans résultat, ce qui performe avec peu de budget (à pousser), les valeurs jamais ou presque jamais testées qui mériteraient un test. Termine par 3 tests concrets à lancer.`,
};

const GAP_KEYS: GlossaryKey[] = ["ai:type", "ai:format", "ai:audience", "ai:theme", "ai:hook", "ai:offer", "ai:msg"];

/** Builds the prompt of a run; throws a message for the team when the data is missing. */
async function buildPrompt(q: AdsQuery, accountKey: string, wf: AgentWorkflow, creativeKey: string | null): Promise<{ prompt: string; label: string }> {
  const { range, compare } = periods();
  const res = await queryAds({ ...q, groupBy: "creative", filters: {}, compare, range, sort: { key: "spend", dir: "desc" }, limit: wf.scope === "creative" ? 400 : 40 });
  const rows = res.rows.filter((r) => r.sample && r.metrics.spend > 0);
  const head = [
    `Période : ${range.since} → ${range.until} (comparée à ${compare.since} → ${compare.until}).`,
    `Moyenne du compte : ${metricsLine(res, res.benchmark)}`,
    res.benchmark.roasUnavailable ? "Pas de valeur de conversion suivie : raisonne en CPA." : "",
    `Playbook du client :\n${(await playbookContext(accountKey, 2500)) || "(vide)"}`,
  ];

  if (wf.scope === "creative") {
    const row = res.rows.find((r) => r.key === creativeKey);
    if (!row?.sample) throw new Error("Cette créa n'a pas de diffusion sur les 30 derniers jours.");
    const label = row.label.slice(0, 160);
    const top = rows.filter((r) => r.key !== row.key).slice(0, 8);
    const parts = [...head, `CRÉA ÉTUDIÉE :\n${creativeLine(res, row, 0, true)}`, top.length ? `Autres créas du compte (repères) :\n${top.map((r, i) => creativeLine(res, r, i + 1)).join("\n")}` : ""];
    if (wf.key === "creative_voice") {
      if (!metaCommentsOpen()) throw new Error("La lecture des commentaires Meta n'est pas activée.");
      const adIds = row.ads.filter((a) => a.platform === "meta").map((a) => a.adId);
      const { comments } = await readAdComments(adIds);
      if (comments.length < 3) throw new Error(comments.length ? "Trop peu de commentaires lisibles sous cette créa (moins de 3)." : "Aucun commentaire lisible sous cette créa (Page non attribuée, pub dynamique ou pas de commentaires).");
      parts.push(`Commentaires (${comments.length}, les plus aimés d'abord) :\n${comments.slice(0, 120).map((c) => `- (${c.likes} j'aime) ${c.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}`);
    }
    return { prompt: parts.filter(Boolean).join("\n\n"), label };
  }

  if (rows.length < 3) throw new Error("Pas assez de créas avec de la dépense sur 30 jours.");
  const label = `30 j au ${range.until}`;
  const parts = [...head];
  if (wf.key === "account_gaps") {
    for (const key of GAP_KEYS) {
      const g = await queryAds({ ...q, groupBy: `tag:${key}`, filters: {}, compare: null, range, sort: { key: "spend", dir: "desc" }, limit: 15 });
      const vals = g.rows.filter((r) => r.key !== "—");
      if (vals.length) parts.push(`${GLOSSARY_LABELS[key]} :\n${vals.map((r) => `- ${r.label.slice(0, 80)} (${r.adCount} annonces) : ${metricsLine(res, r.metrics)}`).join("\n")}`);
    }
    if (parts.length === head.length) throw new Error("Aucune créa taguée par l'IA pour ce client : le glossaire est vide.");
    parts.push(`Créas principales :\n${rows.slice(0, 12).map((r, i) => creativeLine(res, r, i + 1)).join("\n")}`);
  } else {
    parts.push(`Créas (30 derniers jours, par dépense) :\n${rows.slice(0, wf.key === "account_fatigue" ? 40 : 25).map((r, i) => creativeLine(res, r, i + 1)).join("\n")}`);
  }
  return { prompt: parts.filter(Boolean).join("\n\n"), label };
}

/** Starts and completes a run (synchronous, ~30–90 s). The row is « running » meanwhile. */
export async function runAgent(q: AdsQuery, accountKey: string, workflow: string, creativeKey: string | null, input: string, user: AgentUser): Promise<AgentRunView> {
  const wf = AGENT_BY_KEY[workflow];
  if (!wf) throw new Error("Agent inconnu.");
  if (wf.scope === "creative" && !creativeKey) throw new Error("Choisis une créa.");
  const run = await prisma.adAgentRun.create({ data: { accountKey, workflow, creativeKey: wf.scope === "creative" ? creativeKey : null, input, createdById: user.id, createdByName: user.name || user.email || "" } });
  try {
    const { prompt, label } = await buildPrompt(q, accountKey, wf, wf.scope === "creative" ? creativeKey : null);
    await prisma.adAgentRun.update({ where: { id: run.id }, data: { label } });
    const text = await relayComplete(
      { messages: [{ role: "user", content: `${prompt}\n\nTÂCHE : ${TASK[wf.key]}${input ? `\nConsigne du consultant : ${input}` : ""}` }], systemPrompt: SYSTEM_BASE, allowedServers: [], accountScope: {}, model: "sonnet", effort: "low", maxTurns: 1 },
      { maxMs: 150_000, onUsage: (usage) => void recordAiUsage(usage, { feature: "analyse_agents", clientName: accountKey, user }) },
    );
    const sections = cleanSections(parseLooseJson(text));
    if (!sections.length) throw new Error("Réponse de l'IA illisible, relance l'agent.");
    return toRun(await prisma.adAgentRun.update({ where: { id: run.id }, data: { status: "done", sectionsJson: JSON.stringify(sections) } }));
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 400) : "Échec de l'agent";
    return toRun(await prisma.adAgentRun.update({ where: { id: run.id }, data: { status: "error", error: msg } }));
  }
}

/** A follow-up question on a finished run: the AI answers from the run's sections (no new data read). */
export async function followUp(runId: string, accountKey: string, promptText: string, user: AgentUser): Promise<AgentRunView> {
  const run = await prisma.adAgentRun.findFirst({ where: { id: runId, accountKey } });
  if (!run) throw new Error("Analyse introuvable.");
  if (run.status !== "done") throw new Error("L'analyse n'est pas terminée.");
  const sections = parse<AgentSection[]>(run.sectionsJson, []);
  const prev = parse<AgentFollowup[]>(run.followupsJson, []);
  if (prev.length >= 10) throw new Error("10 questions maximum par analyse : relance l'agent.");
  const wf = AGENT_BY_KEY[run.workflow];
  const context = [
    `Analyse « ${wf?.title ?? run.workflow} » (${run.label}) que tu as rendue :`,
    sections.map((s) => `## ${s.title}\n${s.body}`).join("\n\n"),
    prev.length ? `Questions déjà posées :\n${prev.map((f) => `Q : ${f.prompt}\nR : ${f.answer}`).join("\n\n")}` : "",
    `Nouvelle question du consultant : ${promptText}`,
  ].filter(Boolean).join("\n\n");
  const answer = (await relayComplete(
    { messages: [{ role: "user", content: context }], systemPrompt: "Tu es le stratège créatif qui a rendu l'analyse ci-dessous. Réponds à la question en français, court et concret, en t'appuyant sur l'analyse ; si elle ne contient pas l'information, dis-le. Texte simple, pas de JSON.", allowedServers: [], accountScope: {}, model: "sonnet", effort: "low", maxTurns: 1 },
    { maxMs: 110_000, onUsage: (usage) => void recordAiUsage(usage, { feature: "analyse_agents", clientName: accountKey, user }) },
  )).trim().slice(0, 4000);
  if (!answer) throw new Error("Pas de réponse de l'IA, réessaie.");
  const followups = [...prev, { prompt: promptText, answer, at: new Date().toISOString(), by: user.name || user.email || "" }];
  return toRun(await prisma.adAgentRun.update({ where: { id: run.id }, data: { followupsJson: JSON.stringify(followups) } }));
}
