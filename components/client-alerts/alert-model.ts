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
  BACKTEST_DAYS, readDefinition,
  type AlertAccountRef, type AlertDefinition, type AlertMetric, type AlertPlatform, type Backtest, type ClientAlertStatus,
} from "@/lib/client-alerts/types";

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
  /** `retry`: not judged (figures unreadable right now) — not the proposal's fault, to be checked again. */
  | { ok: false; errors: string[]; retry?: boolean };

export interface AlertEventView {
  id: string;
  triggeredAt: string;
  kind: string;
  value: number | null;
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

/** A stored alert as the API answers it. The conversation itself never leaves through here. */
export function toAlertView(row: AlertRow, viewerId: string): AlertView {
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
    mine,
    createdByEmail: mine ? null : row.createdByEmail,
    empty: !definition && (chat === "" || chat === "{}"),
    createdAt: iso(row.createdAt) ?? "",
    events: (row.events ?? []).map((e) => ({
      id: e.id, triggeredAt: iso(e.triggeredAt) ?? "", kind: e.kind, value: e.value, message: e.message,
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

const windowWords = (days: number) => (days === 1 ? "sur le dernier jour complet" : `sur les ${days} derniers jours`);

function compareWords(def: AlertDefinition): string {
  if (def.compare === "same_weekdays") return "par rapport aux mêmes jours de la semaine précédente";
  return def.windowDays === 1 ? "par rapport à la veille" : `par rapport aux ${def.windowDays} jours précédents`;
}

/** The rule as ONE sentence, built from the definition alone. */
export function ruleSentence(def: AlertDefinition): string {
  const who = `${SUBJECT[def.metric]} ${scopeWords(def)}`;
  const when = windowWords(def.windowDays);
  const pct = def.threshold === null ? "" : plain(nf(1).format(def.threshold));
  switch (def.condition) {
    case "above": return `Vous êtes prévenu quand ${who} dépasse ${formatValue(def.metric, def.threshold)} ${when}.`;
    case "below": return `Vous êtes prévenu quand ${who} passe sous ${formatValue(def.metric, def.threshold)} ${when}.`;
    case "drop_pct": return `Vous êtes prévenu quand ${who} baisse d'au moins ${pct} % ${when}, ${compareWords(def)}.`;
    case "rise_pct": return `Vous êtes prévenu quand ${who} augmente d'au moins ${pct} % ${when}, ${compareWords(def)}.`;
    case "stopped": return `Vous êtes prévenu quand ${who} tombe à zéro ${when}, alors qu'il y en avait les jours d'avant.`;
  }
}

const silenceWords = (hours: number) => {
  if (hours % 24 !== 0) return `${hours} heures`;
  const d = hours / 24;
  return d === 1 ? "1 jour" : `${d} jours`;
};

/**
 * The remarks of a card: what the validation warns about, then what the replay
 * noted. Both may speak of the same thing (a sale counted twice, an account
 * that could not be read, a currency converted): it is said once — the
 * replay's word on currencies is kept, it gives the rate.
 */
export function cardNotes(warnings: string[], replayNotes: string[]): string[] {
  const subject = (text: string): string | null => {
    if (/même vente/i.test(text)) return "double";
    if (/convertis? en euros/i.test(text)) return "fx";
    const account = /«\s*([^»]+?)\s*»/.exec(text)?.[1];
    if (account && /illisible|pas pu être lu/i.test(text)) return `unread:${account}`;
    return null;
  };
  const replaySubjects = new Set(replayNotes.map(subject));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [text, fromReplay] of [...warnings.map((w) => [w, false] as const), ...replayNotes.map((n) => [n, true] as const)]) {
    const s = subject(text);
    if (s === "fx" && !fromReplay && replaySubjects.has("fx")) continue;
    // Several accounts in a foreign currency each keep their line.
    const key = s === "fx" ? `fx:${text}` : s ?? text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
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
    def.weekdaysOnly ? "du lundi au vendredi" : "week-ends compris",
  ].join(" · ");
}

/** The volumes under which the alert is not judged, in words; null when there is none. */
export function guardsLine(def: AlertDefinition): string | null {
  const parts: string[] = [];
  if (def.guards.minConversions) parts.push(`${plain(nf(1).format(def.guards.minConversions))} conversion${def.guards.minConversions > 1 ? "s" : ""}`);
  if (def.guards.minSpend) parts.push(`${formatValue("spend", def.guards.minSpend)} de dépense`);
  return parts.length ? `Jugée seulement à partir de ${parts.join(" et ")} sur la période.` : null;
}

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

/** « Sur les 30 derniers jours : 3 messages — les 4, 12 et 21 sept. » */
export function replayLine(replay: { days: number; messages: number; dates: string[] }): string {
  if (replay.messages === 0) return `Ne se serait jamais déclenchée sur ${replay.days} jours`;
  const when = datesLabel(replay.dates);
  return `Sur les ${replay.days} derniers jours : ${replay.messages} message${replay.messages > 1 ? "s" : ""}${when ? ` — ${when}` : ""}`;
}

/** The replay of a proposal, reduced to what the card and the list both read. */
export function replayOf(backtest: Backtest): { days: number; messages: number; dates: string[] } {
  return { days: backtest.days, messages: backtest.messages.length, dates: backtest.messages.map((m) => m.date) };
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
