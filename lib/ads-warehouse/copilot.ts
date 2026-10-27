/**
 * Analyse Ads copilot — the system prompt and the compact report context the
 * model receives: what the consultant is looking at (account, period, group
 * by, filters), the account benchmark and the top rows with their metrics,
 * names and naming-convention tags. No tool: the answer comes from the
 * report itself, in a few seconds, so the chat feels like a colleague
 * reading the screen with you.
 */

import type { AdsQuery, AdsQueryResult, MetricKey } from "./query";
import { METRIC_BY_KEY, fmtMetric } from "./metrics-ui";

export const COPILOT_SUGGESTIONS = [
  { id: "ask", label: "Demander à l'IA", prompt: "" },
  { id: "patterns", label: "Patterns des gagnantes", prompt: "Quels points communs ont les créas qui performent le mieux ici (format, accroche, message, persona d'après les tags de nommage) ? Donne 3 à 5 patterns avec les chiffres qui les justifient." },
  { id: "plan", label: "Plan de test", prompt: "Propose un plan de test créa pour les deux prochaines semaines à partir de ce rapport : 5 tests maximum, chacun avec l'hypothèse, la créa de référence, ce qu'on change, la métrique de succès." },
  { id: "cut", label: "Que couper, que scaler ?", prompt: "D'après ce rapport, quelles créas couper, lesquelles scaler, lesquelles itérer ? Réponds en trois listes courtes avec le chiffre qui motive chaque décision." },
];

const SUMMARY_METRICS: MetricKey[] = ["spend", "impressions", "ctr", "cpc", "conversions", "cpa", "roas", "hookRate", "holdRate", "p100Rate"];

export function buildAnalyseContext(q: AdsQuery, r: AdsQueryResult, extra: { clientName: string | null; groupLabel: string }): string {
  const cur = r.currency;
  const line = (label: string, m: AdsQueryResult["benchmark"]) => `${label}: ` + SUMMARY_METRICS.filter((k) => !(k === "roas" && m.roasUnavailable)).map((k) => `${METRIC_BY_KEY[k].short}=${fmtMetric(k, m[k], cur, m)}`).join(" · ");
  const rows = r.rows.slice(0, 40).map((row, i) => {
    const tags = row.sample ? Object.entries(row.sample.tags).filter(([k]) => !/^(s|t)\d+$/.test(k)).map(([k, v]) => `${k}=${v}`).join(", ") : "";
    const prev = row.previous ? ` | période précédente: ${line("", row.previous).slice(2)}` : "";
    return `${i + 1}. ${row.label.slice(0, 90)} [${row.sample?.format ?? "?"}${row.sample?.dynamic ? " dynamic" : ""}, ${row.adCount} annonce(s)${row.launch ? `, lancée ${row.launch}` : ""}${row.sample?.status ? `, ${row.sample.status}` : ""}]${tags ? ` {${tags}}` : ""}\n   ${line("", row.metrics).slice(2)}${prev}${row.sample?.title ? `\n   titre: ${row.sample.title.slice(0, 120)}` : ""}${row.sample?.body ? `\n   texte: ${row.sample.body.replace(/\s+/g, " ").slice(0, 160)}` : ""}`;
  });
  const filters = Object.entries(q.filters ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ");
  return [
    `Client : ${extra.clientName ?? "compte " + q.accountIds.join(",")} (Meta Ads)`,
    `Période : ${q.range.since} → ${q.range.until}${q.compare ? ` comparée à ${q.compare.since} → ${q.compare.until}` : ""}`,
    `Regroupement : ${extra.groupLabel} · ${r.total} groupes au total, les ${Math.min(40, r.rows.length)} premiers ci-dessous (tri ${q.sort?.key ?? "spend"} ${q.sort?.dir ?? "desc"})`,
    filters ? `Filtres : ${filters}` : "Filtres : aucun",
    line("Moyenne du compte sur la période", r.benchmark),
    r.benchmarkPrevious ? line("Moyenne période précédente", r.benchmarkPrevious) : "",
    r.benchmark.estimated ? "Note : la valeur et le ROAS sont estimés via le panier moyen configuré." : "",
    r.benchmark.roasUnavailable ? "Note : pas de valeur de conversion suivie, raisonne en CPA / taux de conversion." : "",
    "",
    "Lignes :",
    ...rows,
  ].filter(Boolean).join("\n");
}

export function buildAnalyseSystemPrompt(): string {
  return [
    "Tu es le copilote Analyse Ads d'ImpulseMotion, une agence média. Tu lis avec le consultant un rapport de performance créative (Meta Ads) issu de l'entrepôt de l'agence, dont le contenu t'est donné ci-dessous.",
    "Règles : réponds en français, concis, en t'appuyant uniquement sur les chiffres fournis ; cite les créas par leur nom (ou son début) et donne le chiffre qui justifie chaque affirmation ; compare toujours à la moyenne du compte ; quand une donnée manque, dis-le plutôt que d'inventer.",
    "Lis les tags de nommage (ex. s=Pulse, v=CAD, c=Parent, m=…, h=…, cta=…) comme des dimensions créatives : persona, verticale, message, accroche, CTA.",
    "Format : phrases courtes, listes à puces quand il y a plusieurs éléments, pas de titres markdown de niveau 1, pas de tableau de plus de 6 lignes. Termine par une suggestion d'action concrète quand c'est pertinent.",
  ].join("\n\n");
}
