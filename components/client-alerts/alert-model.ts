/**
 * Client alerts — what the page and the routes share about an alert, as data:
 * who may touch it, the shape the API answers, and the French a consultant
 * reads (the rule as one sentence, the settings in words, the replay).
 *
 * Pure: no React, no network, no database. The sentences are built here from
 * the validated definition, never from the AI's prose: what the card says is
 * what the engine checks.
 */

import {
  BACKTEST_DAYS, compareShiftDays, conversionLagDays, cpaSpendFloor, readDefinition, STOP_LOOKBACK_DAYS,
  BACK_TO_NORMAL, COOLDOWN_MIN_HOURS,
  type AlertAccountRef, type AlertDefinition, type AlertMetric, type AlertPlatform, type Backtest, type ClientAlertStatus, type SlackIdentity,
} from "@/lib/client-alerts/types";
import { slackToPlain } from "@/lib/client-alerts/message";

// ── Who may touch an alert ───────────────────────────────────────────────

export type AlertAccess = "owner" | "admin";

/**
 * An alert belongs to the person who created it. A real admin (not a
 * consultant raised to admin) may read every alert, pause it and delete it —
 * never rewrite it, never read its conversation.
 */
export function alertAccess(
  session: { userId: string; baseRole?: string | null },
  alert: { createdById: string },
): AlertAccess | null {
  if (alert.createdById === session.userId) return "owner";
  return session.baseRole === "admin" ? "admin" : null;
}

export const OWNER_ONLY = "Seule la personne qui a créé cette alerte peut la modifier.";
export const ALERT_NOT_FOUND = "Alerte introuvable.";

// ── What the API answers ─────────────────────────────────────────────────

/** Validation of one proposal of the conversation, as the assistant route answers it. */
export type ProposalCheck =
  | { ok: true; proposal: AlertDefinition; warnings: string[]; backtest: Backtest; noisy: boolean }
  /**
   * `errors`: what the consultant reads on the card. `hints`: the fields and values to write, for the
   * AI's next turn only — never shown. `retry`: not judged (figures unreadable right now) — not the
   * proposal's fault, to be checked again.
   */
  | { ok: false; errors: string[]; hints?: string[]; retry?: boolean };

export interface AlertEventView {
  id: string;
  triggeredAt: string;
  kind: string;
  value: number | null;
  /** Plain text: the stored message is Slack mrkdwn, the page is not Slack. */
  message: string;
  dryRun: boolean;
  notifiedAt: string | null;
  notifyError: string | null;
}

export interface BacktestSummary {
  days: number;
  /** Messages the consultant would have received, and their days (YYYY-MM-DD). */
  messages: number;
  dates: string[];
  daysTrue: number;
  skippedDays: number;
  /** Days that were really judged (checked and not skipped). */
  judgedDays: number;
  current: number | null;
  min: number | null;
  median: number | null;
  max: number | null;
  notes: string[];
  ranAt: string | null;
}

export interface AlertView {
  id: string;
  clientName: string;
  alertClientId: string | null;
  label: string;
  status: ClientAlertStatus;
  accounts: AlertAccountRef[];
  definition: AlertDefinition | null;
  definitionHash: string;
  backtest: BacktestSummary | null;
  armed: boolean;
  lastCheckedAt: string | null;
  lastTriggeredAt: string | null;
  lastValue: number | null;
  lastNote: string | null;
  /**
   * The client the alert was made from no longer exists (or has no readable account left):
   * nothing can be checked nor proposed any more, only deleting is offered.
   */
  clientGone: boolean;
  /** Whether the viewer created it; the creator's e-mail is given for the alerts of others. */
  mine: boolean;
  createdByEmail: string | null;
  /** A draft nobody wrote in yet. */
  empty: boolean;
  createdAt: string;
  events: AlertEventView[];
}

export interface ClientOption {
  id: string;
  name: string;
  accounts: AlertAccountRef[];
  dormant: boolean;
}

type DateLike = Date | string | null | undefined;
const iso = (d: DateLike): string | null => (d ? new Date(d).toISOString() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const STATUSES: readonly ClientAlertStatus[] = ["draft", "active", "paused", "review", "error"];

/** Lenient read of ClientAlert.accountsJson. */
export function readAccounts(json: string | null | undefined): AlertAccountRef[] {
  try {
    const list = JSON.parse(json || "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter((a) => a && (a.platform === "meta" || a.platform === "google") && typeof a.accountId === "string" && a.accountId)
      .map((a) => ({ platform: a.platform, accountId: a.accountId, name: String(a.name ?? a.accountId), currency: typeof a.currency === "string" ? a.currency : null }));
  } catch {
    return [];
  }
}

/** Lenient read of ClientAlert.backtestJson: null for "{}" or anything that is not a replay. */
export function summarizeBacktest(json: string | null | undefined): BacktestSummary | null {
  try {
    const b = JSON.parse(json || "{}") as Partial<Backtest> | null;
    if (!b || typeof b !== "object" || !Array.isArray(b.messages)) return null;
    return {
      days: num(b.days) ?? BACKTEST_DAYS,
      messages: b.messages.length,
      dates: b.messages.map((m) => (m && typeof m.date === "string" ? m.date : "")).filter(Boolean),
      daysTrue: num(b.daysTrue) ?? 0,
      skippedDays: num(b.skippedDays) ?? 0,
      judgedDays: Math.max(0, (num(b.checkedDays) ?? num(b.days) ?? BACKTEST_DAYS) - (num(b.skippedDays) ?? 0)),
      current: num(b.current), min: num(b.min), median: num(b.median), max: num(b.max),
      notes: Array.isArray(b.notes) ? b.notes.filter((n): n is string => typeof n === "string") : [],
      ranAt: typeof b.ranAt === "string" ? b.ranAt : null,
    };
  } catch {
    return null;
  }
}

export interface AlertRow {
  id: string;
  createdById: string;
  createdByEmail: string | null;
  alertClientId: string | null;
  clientName: string;
  label: string;
  accountsJson: string;
  definitionJson: string;
  definitionHash: string;
  status: string;
  backtestJson: string;
  chatJson?: string | null;
  armed: boolean;
  lastCheckedAt: DateLike;
  lastTriggeredAt: DateLike;
  lastValue: number | null;
  lastNote: string | null;
  createdAt: DateLike;
  events?: Array<{
    id: string; kind: string; triggeredAt: DateLike; value: number | null; message: string;
    dryRun: boolean; notifiedAt: DateLike; notifyError: string | null;
  }>;
}

/**
 * A stored alert as the API answers it. The conversation itself never leaves through here.
 * `clientGone` is what the route found of the alert's client today (goneClients of lib/client-alerts/accounts.ts).
 */
export function toAlertView(row: AlertRow, viewerId: string, opts: { clientGone?: boolean } = {}): AlertView {
  const mine = row.createdById === viewerId;
  const definition = readDefinition(row.definitionJson);
  const chat = (row.chatJson ?? "").trim();
  return {
    id: row.id,
    clientName: row.clientName,
    alertClientId: row.alertClientId,
    label: row.label,
    status: STATUSES.includes(row.status as ClientAlertStatus) ? (row.status as ClientAlertStatus) : "review",
    accounts: readAccounts(row.accountsJson),
    definition,
    definitionHash: row.definitionHash,
    backtest: summarizeBacktest(row.backtestJson),
    armed: row.armed,
    lastCheckedAt: iso(row.lastCheckedAt),
    lastTriggeredAt: iso(row.lastTriggeredAt),
    lastValue: row.lastValue,
    lastNote: row.lastNote,
    clientGone: opts.clientGone === true,
    mine,
    createdByEmail: mine ? null : row.createdByEmail,
    empty: !definition && (chat === "" || chat === "{}"),
    createdAt: iso(row.createdAt) ?? "",
    events: (row.events ?? []).map((e) => ({
      id: e.id, triggeredAt: iso(e.triggeredAt) ?? "", kind: e.kind, value: e.value, message: slackToPlain(e.message),
      dryRun: e.dryRun, notifiedAt: iso(e.notifiedAt), notifyError: e.notifyError,
    })),
  };
}

// ── Words ────────────────────────────────────────────────────────────────

export type Tone = "default" | "violet" | "emerald" | "amber" | "red" | "blue";

export const ALERT_STATUS: Record<ClientAlertStatus, { label: string; tone: Tone; help: string }> = {
  active: { label: "En service", tone: "emerald", help: "L'alerte est vérifiée plusieurs fois par jour." },
  paused: { label: "En pause", tone: "default", help: "L'alerte n'est plus vérifiée tant que vous ne la reprenez pas." },
  draft: { label: "Brouillon", tone: "blue", help: "Rien n'est encore validé : ouvrez la conversation pour terminer." },
  review: { label: "À revoir", tone: "amber", help: "L'alerte n'est plus vérifiée : ouvrez la conversation et validez-la de nouveau." },
  error: { label: "En erreur", tone: "red", help: "Les messages n'ont pas pu être envoyés plusieurs fois de suite." },
};

export const PLATFORM_LABEL: Record<AlertPlatform, string> = { meta: "Meta", google: "Google Ads" };

export function platformCounts(accounts: Array<{ platform: string }>): Record<AlertPlatform, number> {
  return {
    meta: accounts.filter((a) => a.platform === "meta").length,
    google: accounts.filter((a) => a.platform === "google").length,
  };
}

const nf = (max: number, min = 0) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: max, minimumFractionDigits: min });
// Intl writes narrow and non-breaking spaces; plain ones copy and compare better.
const plain = (s: string) => s.replace(/[  ]/g, " ");

/** A value of the metric, as a consultant writes it: « 60 € », « 12,50 € », « 2,4 », « 1,2 % ». */
export function formatValue(metric: AlertMetric, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  switch (metric) {
    case "spend":
    case "cpa":
    case "revenue": {
      const whole = Math.abs(value) >= 100 || Number.isInteger(value);
      return `${plain(nf(whole ? 0 : 2, whole ? 0 : 2).format(value))} €`;
    }
    case "conversions": return plain(nf(1).format(value));
    case "roas": return plain(nf(2).format(value));
    case "ctr": return `${plain(nf(2).format(value))} %`;
  }
}

const SUBJECT: Record<AlertMetric, string> = {
  spend: "la dépense",
  conversions: "le nombre de conversions",
  cpa: "le coût par conversion (CPA)",
  roas: "le ROAS",
  revenue: "le revenu",
  ctr: "le taux de clic (CTR)",
};

function scopeWords(def: AlertDefinition): string {
  const n = platformCounts(def.accounts);
  if (n.meta && n.google) return def.aggregation === "each" ? "de Meta ou de Google Ads, chaque plateforme jugée seule," : "de Meta et Google Ads réunis";
  return n.google ? "de Google Ads" : "de Meta";
}

/** « sur les 3 derniers jours », « sur les 3 derniers jours ouvrés » when Saturdays and Sundays do not count. */
const windowWords = (def: Pick<AlertDefinition, "windowDays" | "weekdaysOnly">) => {
  const worked = def.weekdaysOnly === true;
  return def.windowDays === 1 ? `sur le dernier jour${worked ? " ouvré" : ""} complet` : `sur les ${def.windowDays} derniers jours${worked ? " ouvrés" : ""}`;
};
const beforeWords = (def: Pick<AlertDefinition, "weekdaysOnly">) => `les ${STOP_LOOKBACK_DAYS} jours${def.weekdaysOnly === true ? " ouvrés" : ""} d'avant`;

function compareWords(def: AlertDefinition): string {
  if (def.compare === "same_weekdays") {
    // The engine goes back by whole weeks, enough to clear the window: two for 14 days, five for 30.
    const weeks = compareShiftDays(def) / 7;
    return weeks > 1 ? `par rapport aux mêmes jours de la semaine, ${weeks} semaines plus tôt` : "par rapport aux mêmes jours de la semaine précédente";
  }
  const worked = def.weekdaysOnly === true;
  if (def.windowDays === 1) return worked ? "par rapport au jour ouvré précédent" : "par rapport à la veille";
  return `par rapport aux ${def.windowDays} jours${worked ? " ouvrés" : ""} précédents`;
}

/** The rule as ONE sentence, built from the definition alone. */
export function ruleSentence(def: AlertDefinition): string {
  const who = `${SUBJECT[def.metric]} ${scopeWords(def)}`;
  const when = windowWords(def);
  const pct = def.threshold === null ? "" : plain(nf(1).format(def.threshold));
  switch (def.condition) {
    case "above": return `Vous êtes prévenu quand ${who} dépasse ${formatValue(def.metric, def.threshold)} ${when}.`;
    case "below": return `Vous êtes prévenu quand ${who} passe sous ${formatValue(def.metric, def.threshold)} ${when}.`;
    case "drop_pct": return `Vous êtes prévenu quand ${who} baisse d'au moins ${pct} % ${when}, ${compareWords(def)}.`;
    case "rise_pct": return `Vous êtes prévenu quand ${who} augmente d'au moins ${pct} % ${when}, ${compareWords(def)}.`;
    // No conversion while nothing is spent is the other alert (the spend that stops): the card says which one this is.
    case "stopped": return def.metric === "conversions"
      ? `Vous êtes prévenu quand ${who} tombe à zéro ${when} alors que la dépense continue, et qu'il y en avait sur ${beforeWords(def)}.`
      : `Vous êtes prévenu quand ${who} tombe à zéro ${when}, alors qu'il y en avait sur ${beforeWords(def)}.`;
  }
}

const silenceWords = (hours: number) => {
  if (hours % 24 !== 0) return `${hours} heures`;
  const d = hours / 24;
  return d === 1 ? "1 jour" : `${d} jours`;
};

/**
 * The remarks of a card, each with one owner: the validation speaks of the
 * definition (the default CPA guard, a drop that can never trigger…), the
 * replay of the data (a sale counted by both platforms, an account that could
 * not be read, amounts converted to euros). Neither repeats the other, so
 * nothing is filtered here.
 */
export function cardNotes(warnings: string[], replayNotes: string[]): string[] {
  return [...warnings, ...replayNotes];
}

/** On screen, a figure and its unit stay on the same line. */
export const unbreakable = (text: string) => text.replace(/(\d) (€|%)/g, "$1\u00a0$2");

/** « 2 vérifications par jour · silence de 3 jours après un message · pas de rappel ». */
export function settingsLine(def: AlertDefinition): string {
  const checks = parseInt(def.checks, 10) || 1;
  return [
    `${checks} vérification${checks > 1 ? "s" : ""} par jour`,
    `silence de ${silenceWords(def.cooldownHours)} après un message`,
    def.remind ? "rappel tant que la situation dure" : "pas de rappel",
    def.weekdaysOnly ? "jours ouvrés seulement : les samedis et dimanches ne comptent pas" : "week-ends compris",
  ].join(" · ");
}

/**
 * What depends on conversions is judged with one day of hindsight (conversionLagDays): said on the
 * card, or the consultant looks for yesterday in the figures. null for the spend and the click rate.
 */
export function hindsightLine(def: Pick<AlertDefinition, "metric">): string | null {
  return conversionLagDays(def.metric) > 0 ? "Jugée avec un jour de recul, le temps que les conversions remontent : la journée d'hier n'est pas encore comptée." : null;
}

/**
 * The volumes under which the alert is not judged, in words; null when there is none.
 * The period is the one the engine reads them on: the window for a threshold, the comparison
 * period for a variation, the 7 days before for a stop.
 */
export function guardsLine(def: AlertDefinition): string | null {
  const parts: string[] = [];
  if (def.guards.minConversions) parts.push(`${plain(nf(1).format(def.guards.minConversions))} conversion${def.guards.minConversions > 1 ? "s" : ""}`);
  if (def.guards.minSpend) parts.push(`${formatValue("spend", def.guards.minSpend)} de dépense`);
  // A CPA « above » also triggers on the spend alone (cpaSpendFloor): without it, the guard would read as a blind spot.
  const floor = cpaSpendFloor(def);
  const spent = floor === null ? null : formatValue("spend", floor);
  if (!parts.length) return spent ? `Sans aucune conversion, se déclenche dès ${spent} dépensés sur la période.` : null;
  const few = def.guards.minConversions && spent ? ` Avec moins de conversions, elle se déclenche quand même dès ${spent} dépensés.` : "";
  const where = def.condition === "stopped" ? `sur ${beforeWords(def)}`
    : def.condition === "drop_pct" || def.condition === "rise_pct" ? "sur la période de comparaison"
    : "sur la période";
  return `Jugée seulement à partir de ${parts.join(" et ")} ${where}.${few}`;
}

/** A value that does not exist, in words: a CPA without any conversion is not « — ». */
const noValue = (metric: AlertMetric) => (metric === "cpa" ? "aucune conversion" : "non calculable");

/**
 * The spread of the replay, as the card says it. The days without a value (a
 * CPA with no conversion, a ROAS with no spend) are left out of the minimum,
 * the median and the maximum; when no day has one, the line says so instead
 * of four dashes.
 */
export function statsLine(metric: AlertMetric, replay: Pick<Backtest, "current" | "min" | "median" | "max">): string {
  const has = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
  const current = has(replay.current) ? formatValue(metric, replay.current) : noValue(metric);
  if (!has(replay.min) || !has(replay.median) || !has(replay.max)) {
    return has(replay.current) ? `Valeur actuelle : ${current}.` : `Valeur actuelle : ${current} — aucun jour des 30 derniers n'a de valeur à comparer.`;
  }
  return `Valeur actuelle : ${current} · minimum ${formatValue(metric, replay.min)} · médiane ${formatValue(metric, replay.median)} · maximum ${formatValue(metric, replay.max)}`;
}

/** « 48,50 € · le 29 sept. » — what the last check found, in the list. */
export function lastValueLine(alert: Pick<AlertView, "definition" | "lastCheckedAt" | "lastValue" | "lastNote">): string {
  if (!alert.lastCheckedAt) return "Pas encore vérifiée";
  const metric = alert.definition?.metric ?? "spend";
  // Without a value: a check that could not judge says why in its note; a CPA alert that was judged spent without converting.
  const value = alert.lastValue === null ? (alert.lastNote ? "non calculable" : noValue(metric)) : formatValue(metric, alert.lastValue);
  return `${value} · le ${dayLabel(alert.lastCheckedAt)}`;
}

/** Whose alert it is, for a real admin reading everyone's: said on every line, the admin's own included. */
export function ownerLine(alert: Pick<AlertView, "mine" | "createdByEmail">, everyone: boolean): string | null {
  if (alert.mine) return everyone ? "Créée par vous" : null;
  return `Créée par ${alert.createdByEmail?.trim() || "un autre membre de l'équipe"}`;
}

/** The toggle of the client picker for the clients that spend nothing: the same words whatever their number. */
export const SHOW_DORMANT = "Afficher les clients sans dépense";

/** What the list and the conversation say of an alert whose client is gone. */
export const CLIENT_GONE = "Ce client n'existe plus dans l'application : l'alerte ne peut plus être vérifiée ni modifiée. Vous pouvez seulement la supprimer.";

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MAX_DATES = 10;

/** « 4 sept. » from YYYY-MM-DD or an ISO instant (read in Europe/Paris). */
export function dayLabel(date: string | null | undefined): string {
  if (!date) return "—";
  let ymd = date;
  if (date.length > 10) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return "—";
    ymd = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return "—";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ""}`.trim();
}

/** « les 4, 12 et 21 sept. », « les 28 août, 4 et 12 sept. », « le 4 sept. ». */
export function datesLabel(dates: string[]): string {
  const parsed = dates
    .map((d) => /^(\d{4})-(\d{2})-(\d{2})/.exec(d))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ day: Number(m[3]), month: Number(m[2]) }));
  if (!parsed.length) return "";
  const shown = parsed.slice(0, MAX_DATES);
  // The month is written once, after the last day of its run.
  const words = shown.map((d, i) => (i === shown.length - 1 || shown[i + 1].month !== d.month ? `${d.day} ${MONTHS[d.month - 1] ?? ""}`.trim() : String(d.day)));
  const more = parsed.length - shown.length;
  if (more > 0) return `les ${words.join(", ")} et ${more} autre${more > 1 ? "s" : ""} jour${more > 1 ? "s" : ""}`;
  if (words.length === 1) return `le ${words[0]}`;
  return `les ${words.slice(0, -1).join(", ")} et ${words[words.length - 1]}`;
}

/**
 * « Sur les 30 derniers jours : 3 messages — les 4, 12 et 21 sept. » — the days the messages would
 * have been received. A replay that judged no day never reads « ne se serait jamais déclenchée »:
 * nobody measured anything.
 */
export function replayLine(replay: { days: number; messages: number; dates: string[]; judgedDays?: number | null }): string {
  if (replay.messages === 0) {
    return replay.judgedDays === 0 ? `Aucun jour n'a pu être jugé sur ${replay.days} jours` : `Ne se serait jamais déclenchée sur ${replay.days} jours`;
  }
  const when = datesLabel(replay.dates);
  return `Sur les ${replay.days} derniers jours : ${replay.messages} message${replay.messages > 1 ? "s" : ""}${when ? ` — ${when}` : ""}`;
}

/** The replay of a proposal, reduced to what the card and the list both read. */
export function replayOf(backtest: Backtest): { days: number; messages: number; dates: string[]; judgedDays: number } {
  return {
    days: backtest.days, messages: backtest.messages.length, dates: backtest.messages.map((m) => m.date),
    judgedDays: Math.max(0, (backtest.checkedDays ?? backtest.days) - backtest.skippedDays),
  };
}

// ── The cards of a conversation ──────────────────────────────────────────

/**
 * checking    the server is validating and replaying the proposal
 * unverified  it could not be judged (server unreachable, figures unreadable): to be checked again
 * invalid     refused by the validation: the reasons, no button
 * pending     valid, waiting for the click
 * confirming  valid but noisy: the click asks for a confirmation first
 * applying    being put in service
 * failed      valid, but the server refused to put it in service
 * inService   it is the alert in service
 * paused      it is the alert, which is paused
 * replaced    it was validated, then another proposal took its place
 * superseded  valid, never validated, and a more recent valid proposal exists: only the latest can be validated
 * closed      nothing can be validated any more (the client is gone): the reason, no button
 */
export type CardState =
  | "checking" | "unverified" | "invalid" | "pending" | "confirming" | "applying" | "failed" | "inService" | "paused" | "replaced" | "superseded" | "closed";

/** The key (« m7 ») of the most recent proposal the server found valid; null when there is none. */
export function latestValidKey(checks: Record<string, ProposalCheck>): string | null {
  let best = -1;
  for (const [key, check] of Object.entries(checks)) {
    const m = /^m(\d+)$/.exec(key);
    if (m && check.ok && Number(m[1]) > best) best = Number(m[1]);
  }
  return best === -1 ? null : `m${best}`;
}

/**
 * What one card of the conversation shows. Only the LATEST valid proposal can
 * be validated: an older one the consultant scrolls back to must not replace,
 * by one click, what was asked for since.
 */
export function cardStateOf(input: {
  key: string;
  /** The block could not even be read (extraction). */
  malformed: boolean;
  check: ProposalCheck | undefined;
  verifying: boolean;
  outcome: { applying?: boolean; errors?: string[]; confirm?: number };
  /** Status kept with the conversation (« applied » once validated). */
  stored: string | undefined;
  alert: Pick<AlertView, "definitionHash" | "status">;
  latestValid: string | null;
  blocked: boolean;
}): CardState {
  const { check, outcome, alert } = input;
  if (input.blocked) return "closed";
  if (input.malformed) return "invalid";
  if (!check) return input.verifying ? "checking" : "unverified";
  if (!check.ok) return check.retry ? (input.verifying ? "checking" : "unverified") : "invalid";
  if (outcome.applying) return "applying";
  // The server's word on which proposal is the alert: the hash of what was replayed.
  const isTheAlert = !!alert.definitionHash && check.backtest.hash === alert.definitionHash;
  if (isTheAlert && alert.status === "active") return "inService";
  if (isTheAlert && alert.status === "paused") return "paused";
  if (input.key !== input.latestValid) return input.stored === "applied" ? "replaced" : "superseded";
  if (outcome.confirm !== undefined) return "confirming";
  if (outcome.errors) return "failed";
  if (!isTheAlert && input.stored === "applied") return "replaced";
  return "pending";
}

/** « Compte Slack trouvé : Prénom N. » — with the name Slack answered, so that the person sees it is theirs. */
export function slackFoundLine(identity: Pick<SlackIdentity, "name" | "email">): string {
  const who = identity.name?.trim() || identity.email?.trim();
  // « Prénom N. » already ends the sentence.
  return who ? `Compte Slack trouvé : ${who}${who.endsWith(".") ? "" : "."}` : "Compte Slack trouvé.";
}

/**
 * Where a trigger stands, as the list says it. An undelivered event is still
 * to be sent while it is younger than the silence of its alert (the next pass
 * tries again if the condition is true); once the situation is back to normal,
 * or the silence is over, it is simply not sent.
 */
export function eventStateOf(
  e: Pick<AlertEventView, "triggeredAt" | "dryRun" | "notifiedAt" | "notifyError">, cooldownHours: number | null | undefined, now: Date = new Date(),
): { label: string; tone: Tone } {
  if (e.notifiedAt) return { label: "envoyé dans Slack", tone: "emerald" };
  if (e.dryRun) return { label: "mode d'essai", tone: "amber" };
  if (e.notifyError === BACK_TO_NORMAL) return { label: "non envoyé", tone: "default" };
  const hours = Math.max(typeof cooldownHours === "number" && Number.isFinite(cooldownHours) ? cooldownHours : 72, COOLDOWN_MIN_HOURS);
  const age = now.getTime() - new Date(e.triggeredAt).getTime();
  return Number.isFinite(age) && age < hours * 3_600_000 ? { label: "envoi en attente", tone: "amber" } : { label: "non envoyé", tone: "red" };
}

/** Enter in the search of the client picker: the first client shown — and nothing while nothing is typed. */
export function pickOnEnter<T>(query: string, shown: T[]): T | null {
  return query.trim() && shown.length ? shown[0] : null;
}

/** Example requests of the empty conversation, in words the engine can honour, for the platforms the client has. */
export function exampleRequests(accounts: Array<{ platform: string }>): string[] {
  const n = platformCounts(accounts);
  const both = n.meta > 0 && n.google > 0;
  return [
    "Préviens-moi si la dépense chute de moitié par rapport à la semaine précédente",
    "Alerte si le CPA devient trop élevé sur 3 jours — propose-moi un seuil d'après les chiffres",
    both
      ? "Préviens-moi si Meta ou Google Ads ne dépense plus rien depuis hier"
      : "Préviens-moi s'il n'y a plus aucune conversion sur 3 jours",
  ];
}
