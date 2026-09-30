/**
 * Client alerts — the private Slack message, built from the evaluation, without AI.
 *
 * One alert is three short lines a consultant reads without opening anything:
 *
 *   *LPEV* — CPA au-dessus de 60 € sur 3 jours
 *   CPA : *72,40 €* (seuil 60 €) · Meta 81,20 € · Google 54,10 €
 *   Dépense 4 320 € · 60 conversions · du 27 au 29 sept.
 *
 * A value that does not exist is never written as a figure: a CPA alert that
 * triggers on the spend alone reads « Aucune conversion pour 900 € dépensés
 * (seuil : CPA de 60 €) ».
 *
 * No header, no emoji: a private message from the application is already the signal.
 */

import { compareShiftDays, conversionLagDays, STOP_LOOKBACK_DAYS, type AlertDefinition, type AlertMetric, type AlertPlatform, type Evaluation, type EvaluationPart } from "@/lib/client-alerts/types";

// ── Numbers, the French way (same conventions as lib/auto-alerts/detect.ts) ──

const num = (n: number, min: number, max: number) =>
  (n + 0).toLocaleString("fr-FR", { minimumFractionDigits: min, maximumFractionDigits: max }).replace(/^-/, "−");

/** 72,40 € · 60 € · 4 320 €: cents only where they matter. */
function euros(n: number): string {
  const whole = Math.abs(n) >= 1000 || Math.abs(n - Math.round(n)) < 0.005;
  return `${whole ? num(Math.round(n), 0, 0) : num(n, 2, 2)} €`;
}
const count = (n: number) => num(n, 0, 1);
const ratio = (n: number) => `×${num(n, 0, 2)}`;
const percent = (n: number) => `${num(n, 2, 2)} %`;
const change = (pct: number) => (Math.round(pct) === 0 ? "stable" : `${pct < 0 ? "−" : "+"}${num(Math.abs(pct), 0, 0)} %`);
const conversionsWords = (n: number) => `${count(n)} conversion${n >= 2 ? "s" : ""}`;

const METRIC: Record<AlertMetric, { label: string; format: (n: number) => string }> = {
  spend: { label: "Dépense", format: euros },
  conversions: { label: "Conversions", format: count },
  cpa: { label: "CPA", format: euros },
  roas: { label: "ROAS", format: ratio },
  revenue: { label: "Revenu", format: euros },
  ctr: { label: "CTR", format: percent },
};
const PLATFORM: Record<AlertPlatform, string> = { meta: "Meta", google: "Google" };

// ── Dates ────────────────────────────────────────────────────────────────────

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

function parseDay(date: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? null : new Date(t);
}
const dayOf = (d: Date) => (d.getUTCDate() === 1 ? "1er" : String(d.getUTCDate()));
const dayMonth = (d: Date) => `${dayOf(d)} ${MONTHS[d.getUTCMonth()]}`;
/** « 3 jours », « 3 jours ouvrés » for an alert that leaves Saturdays and Sundays out. */
const days = (n: number, def?: Pick<AlertDefinition, "weekdaysOnly">) => `${n} jour${n > 1 ? "s" : ""}${def?.weekdaysOnly === true ? ` ouvré${n > 1 ? "s" : ""}` : ""}`;

/**
 * The window that was judged: its real first and last day, as the evaluation
 * reports them (one day of hindsight for the conversions, working days only…).
 * An evaluation without `from` is read as `n` days in a row ending `asOf`;
 * null when `asOf` is not a date.
 */
function windowOf(evaluation: Pick<Evaluation, "asOf" | "from">, n: number): { from: Date; to: Date } | null {
  const to = parseDay(evaluation.asOf);
  if (!to) return null;
  const from = evaluation.from ? parseDay(evaluation.from) : null;
  return { from: from && from <= to ? from : new Date(to.getTime() - (n - 1) * 86_400_000), to };
}

function periodWords(def: AlertDefinition, evaluation: Evaluation): string {
  const n = def.windowDays;
  const w = windowOf(evaluation, n);
  if (!w) return `sur ${days(n, def)}`;
  if (w.from.getTime() === w.to.getTime()) return `le ${dayMonth(w.to)}`;
  const sameMonth = w.from.getUTCMonth() === w.to.getUTCMonth() && w.from.getUTCFullYear() === w.to.getUTCFullYear();
  return `du ${sameMonth ? dayOf(w.from) : dayMonth(w.from)} au ${dayMonth(w.to)}`;
}

function sinceWords(def: AlertDefinition, evaluation: Evaluation): string {
  const n = def.windowDays;
  const w = windowOf(evaluation, n);
  if (!w) return `depuis ${days(n, def)}`;
  return `depuis le ${dayMonth(w.from)}${n > 1 ? ` (${days(n, def)})` : ""}`;
}

/** Why the period stops before yesterday, for what depends on conversions — said with the period, in a few words. */
const hindsight = (def: AlertDefinition) => (conversionLagDays(def.metric) > 0 ? " (un jour de recul, le temps que les conversions remontent)" : "");

function compareWords(def: AlertDefinition): string {
  const one = def.windowDays <= 1;
  if (def.compare === "same_weekdays") {
    // Whole weeks back, enough to clear the window (compareShiftDays): two for 14 days, five for 30.
    const weeks = compareShiftDays(def) / 7;
    if (weeks > 1) return `par rapport aux mêmes jours de la semaine, ${weeks} semaines plus tôt`;
    return one ? "par rapport au même jour de la semaine précédente" : "par rapport aux mêmes jours de la semaine précédente";
  }
  const worked = def.weekdaysOnly === true;
  return one ? `par rapport au jour${worked ? " ouvré" : ""} précédent` : `par rapport aux ${def.windowDays} jours${worked ? " ouvrés" : ""} précédents`;
}

// ── Slack mrkdwn ─────────────────────────────────────────────────────────────

/** Names come from accounts and from a conversation: one line, and nothing Slack reads as a link or a mention. */
export function escapeSlack(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A stored message (Slack mrkdwn, as buildAlertLine writes it) as plain text
 * for the page: bold markers removed, entities decoded, link lines dropped.
 */
export function slackToPlain(text: string): string {
  return String(text ?? "")
    .split("\n")
    // A line that is only a Slack link (« Voir et régler mes alertes ») says nothing on the page it points to.
    .filter((line) => !/^\s*<[^<>\s|]+(\|[^<>]*)?>\s*$/.test(line))
    // A link inside a line keeps its words.
    .map((line) => line.replace(/<[^<>\s|]+\|([^<>]*)>/g, "$1").replace(/<([^<>\s|]+)>/g, "$1"))
    // Bold: a pair of stars around words, as Slack reads it — never a lone star.
    .map((line) => line.replace(/\*([^*\n]+)\*/g, "$1"))
    .map((line) => line.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"))
    .join("\n")
    .trim();
}

// ── One alert ────────────────────────────────────────────────────────────────

/** The part that decides: `combined`, or the first platform that triggered when each is judged on its own. */
function decidingPart(def: AlertDefinition, evaluation: Evaluation): EvaluationPart | null {
  const platforms = evaluation.parts.filter((p) => p.scope !== "combined");
  if (def.aggregation === "each") return platforms.find((p) => p.triggered) ?? platforms[0] ?? null;
  return evaluation.parts.find((p) => p.scope === "combined") ?? null;
}

/** Computed from the two values when they are there, so that the sign never depends on a convention. */
function changeOf(p: Pick<EvaluationPart, "value" | "baseline" | "changePct">): number | null {
  if (p.value !== null && p.baseline !== null && p.baseline > 0) return ((p.value - p.baseline) / p.baseline) * 100;
  return p.changePct;
}

const platformName = (p: EvaluationPart) => (p.scope === "combined" ? "" : PLATFORM[p.scope]);

function metricLine(def: AlertDefinition, evaluation: Evaluation, main: EvaluationPart | null): string {
  const metric = METRIC[def.metric];
  const each = def.aggregation === "each";
  const moving = def.condition === "drop_pct" || def.condition === "rise_pct";
  const on = main && each ? platformName(main) : "";
  const head = main ?? { value: evaluation.value, baseline: evaluation.baseline, changePct: evaluation.changePct };
  const bits: string[] = [];

  if (def.condition === "stopped") {
    const since = sinceWords(def, evaluation);
    const before = `sur les ${days(STOP_LOOKBACK_DAYS, def)} précédents`;
    if (def.metric === "conversions") {
      const spending = main !== null && main.spend > 0 ? " alors que la dépense continue" : "";
      bits.push(`*Plus aucune conversion${on ? ` sur ${on}` : ""}* ${since}${spending}`);
      if (head.baseline !== null && head.baseline > 0) bits.push(`${conversionsWords(head.baseline)} ${before}`);
    } else {
      bits.push(`*${metric.label}${on ? ` ${on}` : ""} à l'arrêt* ${since}`);
      if (head.baseline !== null && head.baseline > 0) bits.push(`${metric.format(head.baseline)} ${before}`);
    }
  } else if (head.value === null && def.metric === "cpa" && !moving) {
    // A CPA « above » triggers on the spend alone when nothing converted: there is no CPA to write.
    const spent = main ? ` pour ${euros(main.spend)} dépensés` : "";
    bits.push(`*Aucune conversion${on ? ` sur ${on}` : ""}${spent}*${def.threshold !== null ? ` (seuil : CPA de ${metric.format(def.threshold)})` : ""}`);
  } else {
    const value = head.value === null ? "non calculable" : metric.format(head.value);
    const subject = `${metric.label}${on ? ` sur ${on}` : ""} : *${value}*`;
    if (moving) {
      bits.push(subject);
      const pct = changeOf(head);
      if (pct !== null) bits.push(`${change(pct)} ${compareWords(def)}${head.baseline !== null ? ` (${metric.format(head.baseline)})` : ""}`);
    } else {
      bits.push(`${subject}${def.threshold !== null ? ` (seuil ${metric.format(def.threshold)})` : ""}`);
    }
  }

  // Per-platform detail: the other platform when each is judged on its own, both under a combined figure.
  const platforms = evaluation.parts.filter((p) => p.scope !== "combined");
  const detail = each ? platforms.filter((p) => p !== main) : platforms.length > 1 && def.condition !== "stopped" ? platforms : [];
  for (const p of detail) {
    if (p.value === null) {
      // A platform that spent without converting has no CPA, and is the one to look at.
      // Under « aucune conversion pour 900 € dépensés », only its share of the spend is left to say.
      if (def.metric === "cpa" && !moving && p.spend > 0) {
        bits.push(head.value === null ? `${platformName(p)} ${euros(p.spend)}` : `${platformName(p)} : aucune conversion pour ${euros(p.spend)}`);
      }
      continue;
    }
    const pct = moving ? changeOf(p) : null;
    const also = each && p.triggered ? " aussi :" : "";
    const value = def.metric === "conversions" ? conversionsWords(p.value) : metric.format(p.value);
    bits.push(`${platformName(p)}${also} ${value}${pct !== null ? ` (${change(pct)})` : ""}`);
  }
  return bits.join(" · ");
}

/** Spend, conversions and the period — without repeating what the line above already says. */
function contextLine(def: AlertDefinition, evaluation: Evaluation, main: EvaluationPart | null): string {
  const stoppedSpend = def.condition === "stopped" && def.metric !== "conversions";
  if (stoppedSpend) return "";
  const bits: string[] = [];
  // « Aucune conversion pour 900 € dépensés » has said both already.
  const said = def.metric === "cpa" && main !== null && main.value === null && def.condition !== "drop_pct" && def.condition !== "rise_pct";
  if (main && !said) {
    if (def.metric !== "spend") bits.push(`Dépense ${euros(main.spend)}`);
    if (def.metric !== "conversions") bits.push(conversionsWords(main.conversions));
  }
  bits.push(`${periodWords(def, evaluation)}${hindsight(def)}`);
  const line = bits.join(" · ");
  const on = main && def.aggregation === "each" && !said ? platformName(main) : "";
  if (on) return `${on} : ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
  // Alone on its line, the period starts it: « Du 27 au 29 sept. ».
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

/** One alert, as it reads in the private message (Slack mrkdwn, a few lines, per-platform detail). Pure. */
export function buildAlertLine(input: { clientName: string; def: AlertDefinition; evaluation: Evaluation; kind: "trigger" | "reminder" }): string {
  const { def, evaluation } = input;
  const main = decidingPart(def, evaluation);
  const name = escapeSlack(input.clientName).replace(/\*/g, "") || "Client";
  const label = escapeSlack(def.label) || METRIC[def.metric].label;
  const title = `${input.kind === "reminder" ? "Rappel — " : ""}*${name}* — ${label}`;
  return [title, metricLine(def, evaluation, main), contextLine(def, evaluation, main)].filter(Boolean).join("\n");
}

/** A page of the application, written as a Slack link; null when the address could break the syntax. */
function linkLine(pageUrl: string | null): string | null {
  const url = (pageUrl ?? "").trim();
  return /^https?:\/\/[^\s<>|]+$/.test(url) ? `<${url}|Voir et régler mes alertes>` : null;
}

/** The private message of one consultant for one pass: its alerts, then « N autres alertes » when capped. Pure. */
export function buildDmText(lines: string[], extra: number, pageUrl: string | null): string {
  const blocks = lines.map((l) => l.trim()).filter(Boolean);
  const more = Number.isFinite(extra) && extra >= 1 ? Math.floor(extra) : 0;
  const many = more > 1 ? "s" : "";
  const foot: string[] = [];
  if (more) foot.push(`${blocks.length ? "+ " : ""}${more} ${blocks.length ? `autre${many} ` : ""}alerte${many} déclenchée${many}, à voir dans l'application`);
  const link = linkLine(pageUrl);
  if (link) foot.push(link);
  if (!foot.length) return blocks.join("\n\n");
  // One alert keeps its link right under it; several are set apart from the closing lines.
  const glue = blocks.length === 1 && !more ? "\n" : "\n\n";
  return [blocks.join("\n\n"), foot.join("\n")].filter(Boolean).join(glue);
}
