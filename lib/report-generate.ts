/**
 * AI report generation: snapshot → prompt → relay → parsed Markdown + next
 * steps, persisted on the ClientReport row.
 *
 * The AI never calls tools here: every number it needs is in the snapshot
 * (fast, cheap, reproducible). The output contract is Markdown with fixed
 * section headings plus one ```nextsteps JSON fence, parsed leniently.
 */

import { prisma } from "@/lib/prisma";
import { relayComplete, extractFence, parseLooseJson } from "@/lib/relay-chat";
import { collectReportData, periodLabel, type ReportData, type ReportNextStep } from "@/lib/report-data";
import { prevRange, type CompareRange } from "@/lib/dashboard-widgets";

/** Same day one year earlier (Feb 29 → Feb 28). */
export function shiftYear(d: string): string {
  const shifted = `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
  // JS Date rolls Feb 29 over to Mar 1 instead of failing: check the round-trip.
  const parsed = new Date(shifted + "T00:00:00Z");
  return Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(shifted) ? `${Number(d.slice(0, 4)) - 1}-02-28` : shifted;
}

/** Resolves a comparison mode into a concrete range (null = disabled). */
export function resolveCompare(
  since: string,
  until: string,
  mode: string | undefined,
  custom?: { since?: string | null; until?: string | null },
): { since: string; until: string } | null {
  if (mode === "none") return null;
  if (mode === "year") return { since: shiftYear(since), until: shiftYear(until) };
  if (mode === "custom" && custom?.since && custom?.until) return { since: custom.since, until: custom.until };
  return prevRange(since, until);
}

export const REPORT_SECTIONS = [
  "Synthèse",
  "Performance globale",
  "Campagnes",
  "Créas",
  "Audience & diffusion",
  "Budget & alertes",
  "Suivi des actions précédentes",
] as const;

const fmtEur = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} €`;
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${n > 0 ? "+" : ""}${n.toFixed(1)} %`);

/** Compact, human-readable rendering of the snapshot for the prompt. */
export function renderDataForPrompt(d: ReportData): string {
  const lines: string[] = [];
  lines.push(`CLIENT : ${d.client.name} (${d.client.platforms.map((p) => (p === "meta" ? "Meta Ads" : "Google Ads")).join(" + ")})`);
  lines.push(`PÉRIODE : ${periodLabel(d.period.since, d.period.until)} (${d.period.since} → ${d.period.until})`);
  if (d.compare) lines.push(`COMPARAISON : ${d.compare.since} → ${d.compare.until} (${d.compare.kind === "year" ? "N-1" : d.compare.kind === "prev" ? "période précédente" : "personnalisée"})`);

  lines.push("\nKPIS (valeur | précédent | delta) :");
  for (const k of d.kpis) {
    const unit = ["spend", "revenue", "cpa", "cpc"].includes(k.metric) ? " €" : ["ctr", "cr"].includes(k.metric) ? " %" : k.metric === "roas" ? "x" : "";
    lines.push(`- ${k.label}${k.source !== "combined" ? ` (${k.source})` : ""} : ${k.value}${unit} | ${k.previous ?? "n/a"}${k.previous !== null ? unit : ""} | ${pct(k.deltaPct)}${k.estimated ? " (revenu estimé via AOV)" : ""}`);
  }

  if (d.platforms?.rows?.length) {
    lines.push("\nPAR PLATEFORME (coût, impressions, CTR %, clics, CPC, CR %, conversions, CPA — delta % entre parenthèses) :");
    for (const r of d.platforms.rows) {
      const cell = (k: string) => `${r[k] ?? "n/a"}${r[`${k}DeltaPct`] !== null && r[`${k}DeltaPct`] !== undefined ? ` (${pct(r[`${k}DeltaPct`] as number)})` : ""}`;
      lines.push(`- ${r.platform} : coût ${cell("cost")} · impr ${cell("impressions")} · CTR ${cell("ctr")} · clics ${cell("clicks")} · CPC ${cell("cpc")} · CR ${cell("cr")} · conv ${cell("conversions")} · CPA ${cell("cpa")}`);
    }
  }

  if (d.funnel) {
    lines.push(`\nENTONNOIR : ${d.funnel.steps.map((s) => `${s.label} ${s.value.toLocaleString("fr-FR")}`).join(" → ")} ; ${d.funnel.rates.map((r) => `${r.label} ${r.pct} %`).join(", ")}`);
  }

  const seriesLine = (label: string, pts?: Array<{ date: string; value: number }>) => {
    if (!pts?.length) return;
    const vals = pts.map((p) => p.value);
    const max = pts.reduce((a, b) => (b.value > a.value ? b : a));
    const min = pts.reduce((a, b) => (b.value < a.value ? b : a));
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const half = Math.floor(pts.length / 2);
    const first = vals.slice(0, half).reduce((a, b) => a + b, 0) / Math.max(1, half);
    const second = vals.slice(half).reduce((a, b) => a + b, 0) / Math.max(1, vals.length - half);
    lines.push(`- ${label} : ${pts.length} jours, moyenne ${avg.toFixed(2)}, max ${max.value} le ${max.date}, min ${min.value} le ${min.date}, 2e moitié vs 1re moitié ${pct(first > 0 ? ((second - first) / first) * 100 : null)}`);
  };
  lines.push("\nTENDANCES QUOTIDIENNES :");
  seriesLine("Dépenses Meta", d.daily.metaSpend);
  seriesLine("ROAS Meta", d.daily.metaRoas);
  seriesLine("Dépenses Google", d.daily.googleSpend);
  seriesLine("Conversions Google", d.daily.googleConversions);

  const camp = (label: string, rows: ReportData["campaigns"]["meta"]) => {
    if (!rows.length) return;
    lines.push(`\nCAMPAGNES ${label} (dépense, clics, conversions, ROAS) :`);
    for (const r of rows) lines.push(`- ${r.name} : ${fmtEur(r.spend)}, ${r.clicks} clics, ${r.conversions} conv, ROAS ${r.roas}`);
  };
  camp("META", d.campaigns.meta);
  camp("GOOGLE", d.campaigns.google);

  if (d.keywords.length) {
    lines.push("\nTOP MOTS-CLÉS GOOGLE :");
    for (const k of d.keywords.slice(0, 10)) lines.push(`- ${k.name}${k.matchType ? ` [${k.matchType}]` : ""} : ${fmtEur(k.spend)}, ${k.clicks} clics, ${k.conversions} conv${k.ctr !== undefined ? `, CTR ${k.ctr} %` : ""}`);
  }
  if (d.searchTerms.length) {
    lines.push("\nTOP TERMES DE RECHERCHE :");
    for (const k of d.searchTerms.slice(0, 10)) lines.push(`- ${k.name} : ${fmtEur(k.spend)}, ${k.clicks} clics, ${k.conversions} conv`);
  }

  if (d.creatives.length) {
    lines.push("\nCRÉAS META (top dépense) :");
    for (const c of d.creatives) {
      const video = c.format === "video"
        ? ` hook ${c.hookRate ?? "n/a"} % · hold ${c.holdRate ?? "n/a"} %${c.dropoff ? ` · p25/p50/p75 ${c.dropoff.p25}/${c.dropoff.p50}/${c.dropoff.p75} %` : ""}`
        : "";
      lines.push(`- ${c.name} [${c.format}] : ${fmtEur(c.spend)}, ${c.impressions.toLocaleString("fr-FR")} impr, CTR ${c.ctr} %, ROAS ${c.roas}${c.estimated ? " (est.)" : ""}, CPA ${c.cpa} €, ${c.purchases} conv${video}`);
    }
  }

  if (d.demographics.length) {
    lines.push("\nDÉMOGRAPHIE META (dépense par âge × genre) :");
    lines.push(d.demographics.map((r) => `${r.age} ${r.gender} ${fmtEur(r.value)}`).join(" · "));
  }
  if (d.devices.length) lines.push(`\nAPPAREILS : ${d.devices.map((r) => `${r.key} ${fmtEur(r.spend)} / ${r.conversions} conv`).join(" · ")}`);
  if (d.countries.length) lines.push(`PAYS : ${d.countries.map((r) => `${r.key} ${fmtEur(r.spend)} / ${r.conversions} conv`).join(" · ")}`);

  if (d.pacing) {
    lines.push(`\nPACING BUDGET (mois en cours) : objectif ${fmtEur(d.pacing.monthlyTarget)}, dépensé ${fmtEur(d.pacing.mtdSpend)} après ${d.pacing.daysElapsed}/${d.pacing.daysInMonth} jours, projection ${fmtEur(d.pacing.projectedSpend)} (${d.pacing.pacingPct} %, statut ${d.pacing.status})`);
  } else {
    lines.push("\nPACING BUDGET : aucun budget mensuel configuré.");
  }

  if (d.alerts.length) {
    lines.push("\nALERTES RÉCENTES :");
    for (const a of d.alerts) lines.push(`- ${a.triggeredAt.slice(0, 10)} ${a.metric} ${a.value} (seuil ${a.threshold})${a.acknowledged ? " [acquittée]" : ""} — ${a.message}`);
  }

  if (d.previousReport) {
    lines.push(`\nNEXT STEPS DU RAPPORT PRÉCÉDENT (${d.previousReport.periodSince} → ${d.previousReport.periodUntil}) :`);
    for (const s of d.previousReport.nextSteps) lines.push(`- [${s.done ? "fait" : "à faire"}] ${s.title} — ${s.detail}`);
  }

  if (d.warnings.length) lines.push(`\nDONNÉES INDISPONIBLES : ${d.warnings.join(" ; ")}`);
  return lines.join("\n");
}

export const REPORT_SYSTEM_PROMPT = `Tu es un consultant média senior chez Impulse Analytics. Tu rédiges le rapport de performance d'un client à partir du snapshot de données fourni dans le message utilisateur. Tu n'appelles aucun outil : toutes les données sont dans le message.

RÈGLES DE FOND
- Chaque affirmation chiffrée doit provenir du snapshot. N'invente jamais un chiffre, une campagne, une créa ou une cause non observable. Si une donnée manque, dis-le en une phrase.
- Le revenu marqué « estimé » est calculé via un panier moyen : signale-le si tu t'appuies dessus.
- Priorise : ce qui a changé, ce qui coûte, ce qui marche. Une lecture de consultant, pas une liste de chiffres.
- Français, vouvoiement implicite (pas de « tu »), phrases courtes, pas d'emoji, pas de titre de niveau 1.
- Sois concret : nomme les campagnes et les créas en cause, donne les ordres de grandeur (%, €).

FORMAT DE SORTIE (Markdown strict, dans cet ordre, titres de niveau 2 exactement comme ci-dessous)
## Synthèse
3 à 5 puces : la lecture globale en une phrase chacune (résultat, principal levier, principal risque, tendance).
## Performance globale
KPIs clés vs période de comparaison, par plateforme si plusieurs. Un tableau Markdown (métrique | valeur | précédent | delta) puis 2-4 phrases d'analyse.
## Campagnes
Ce qui porte les résultats, ce qui sous-performe, mouvements notables. Tableau des 5-8 campagnes les plus significatives si pertinent.
## Créas
Gagnantes et perdantes avec pourquoi (hook, hold, CTR, CPA). Signaux de fatigue. Ce qu'il faut produire ensuite.
## Audience & diffusion
Démographie, appareils, pays, mots-clés / termes de recherche si Google : où le budget va et si c'est efficace.
## Budget & alertes
Pacing du mois en cours, alertes récentes, risques de dérive.
## Suivi des actions précédentes
Si des next steps précédents existent : pour chacun, fait / non fait / impact observable. Sinon : « Premier rapport, pas d'actions précédentes à suivre. »

Termine OBLIGATOIREMENT par un bloc :
\`\`\`nextsteps
[
  { "title": "Action courte à l'impératif", "detail": "Pourquoi et comment, 1-2 phrases avec les chiffres qui la justifient", "priority": "high|medium|low", "platform": "meta|google|global" }
]
\`\`\`
4 à 7 actions, ordonnées par priorité, chacune actionnable cette semaine.`;

export function buildReportUserPrompt(data: ReportData): string {
  return `Rédige le rapport de performance à partir de ce snapshot.\n\n${renderDataForPrompt(data)}`;
}

export interface ParsedReport {
  contentMd: string;
  summary: string;
  nextSteps: ReportNextStep[];
}

export function parseReportOutput(raw: string): ParsedReport {
  let text = raw.trim();
  let steps: ReportNextStep[] = [];

  const fence = extractFence(text, "nextsteps");
  const candidate = fence ?? (() => {
    // Fallback: last json fence in the document.
    const all = [...text.matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/gi)];
    const last = all[all.length - 1];
    if (!last) return null;
    return { inner: last[1], rest: (text.slice(0, last.index) + text.slice((last.index ?? 0) + last[0].length)).trim() };
  })();
  if (candidate) {
    const parsed = parseLooseJson<unknown[]>(candidate.inner);
    if (Array.isArray(parsed)) {
      steps = parsed
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as Record<string, unknown>).title === "string")
        .map((s, i) => ({
          id: `ns-${i + 1}`,
          title: String(s.title).trim(),
          detail: typeof s.detail === "string" ? s.detail.trim() : "",
          priority: (["high", "medium", "low"].includes(String(s.priority)) ? String(s.priority) : "medium") as ReportNextStep["priority"],
          platform: (["meta", "google", "global"].includes(String(s.platform)) ? String(s.platform) : "global") as ReportNextStep["platform"],
          done: false,
        }));
      text = candidate.rest;
    }
  }

  // Strip an accidental H1 and leading "Voici…" chatter.
  text = text.replace(/^#\s[^\n]*\n+/, "").replace(/^(voici|ci-dessous)[^\n]*\n+/i, "").trim();

  const synth = text.match(/## Synthèse\s*\n([\s\S]*?)(?=\n## |$)/);
  const summary = (synth?.[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 600);

  return { contentMd: text, summary, nextSteps: steps };
}

/** Runs the whole pipeline for an existing ClientReport row (status → ready|failed). */
export async function generateClientReport(reportId: string): Promise<void> {
  const report = await prisma.clientReport.findUnique({ where: { id: reportId }, include: { dashboard: true } });
  if (!report) throw new Error("report not found");

  await prisma.clientReport.update({ where: { id: reportId }, data: { status: "generating", error: null } });

  try {
    // compareSince/Until are always filled at creation (prev/year/custom) or
    // both null when the comparison was disabled.
    let compare: CompareRange | null = null;
    if (report.compareSince && report.compareUntil) {
      const prev = prevRange(report.periodSince, report.periodUntil);
      const isPrev = prev.since === report.compareSince && prev.until === report.compareUntil;
      const isYear = report.compareSince === shiftYear(report.periodSince) && report.compareUntil === shiftYear(report.periodUntil);
      compare = { since: report.compareSince, until: report.compareUntil, kind: isPrev ? "prev" : isYear ? "year" : "custom" };
    }
    const data = await collectReportData(report.dashboard, report.periodSince, report.periodUntil, compare);

    const raw = await relayComplete(
      {
        messages: [{ role: "user", content: buildReportUserPrompt(data) }],
        systemPrompt: REPORT_SYSTEM_PROMPT,
        allowedServers: [],
        accountScope: {},
      },
      { maxMs: 200_000 },
    );
    const parsed = parseReportOutput(raw);
    if (!parsed.contentMd || parsed.contentMd.length < 200) throw new Error("Rapport trop court ou vide renvoyé par l'IA");

    await prisma.clientReport.update({
      where: { id: reportId },
      data: {
        status: "ready",
        dataJson: JSON.stringify(data),
        contentMd: parsed.contentMd,
        summary: parsed.summary,
        nextStepsJson: JSON.stringify(parsed.nextSteps),
        compareSince: data.compare?.since ?? null,
        compareUntil: data.compare?.until ?? null,
        error: null,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.clientReport.update({ where: { id: reportId }, data: { status: "failed", error: msg } });
    throw e;
  }
}

/** Builds a default title. */
export function defaultReportTitle(clientName: string, since: string, until: string): string {
  return `${clientName} — ${periodLabel(since, until)}`;
}
