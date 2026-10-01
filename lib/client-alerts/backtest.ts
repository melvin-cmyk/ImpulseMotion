/**
 * Client alerts — what decides a message, and the replay of the last 30 days.
 *
 * `advance` is the whole rule of delivery: silence after a message, re-arming
 * once the situation is back to normal, reminders only when asked for. The
 * cron (run.ts) and the replay below both call it, and nothing else decides a
 * message: the figure shown before activation cannot drift from what the
 * consultant then receives.
 *
 * The replay is one check a day, the morning after each full day, over full
 * days only — as the cron, which never judges the day in progress. Pure.
 *
 * A replay that judged (almost) nothing vouches for nothing: `replayVerdict`
 * says whether it may be shown as a measure, must wait (an account could not
 * be read), or means the rule itself cannot be judged on this client.
 */

import { addDays } from "@/lib/date-ranges";
import { definitionHash, evaluate, lastFullDay, PLATFORM_LABEL, sameAccount } from "@/lib/client-alerts/evaluate";
import {
  ALERT_DEFAULTS, BACKTEST_DAYS, CHECK_SLOTS_UTC, CONVERSION_METRICS, COOLDOWN_MIN_HOURS,
  type AlertDefinition, type Backtest, type BacktestTrigger, type ClientSeries, type Evaluation, type SkipKind,
} from "@/lib/client-alerts/types";

export interface AlertState {
  /** false after a message, until a check finds the condition false again. */
  armed: boolean;
  lastMessageAt: Date | null;
}

export type MessageKind = "trigger" | "reminder";

/**
 * The platform fires a cron anywhere within its hour: a check 71 h 10 after a
 * message (yesterday's at :55, today's at :05) must count as three days later,
 * not wait for the next slot.
 */
export const COOLDOWN_SLACK_MS = 90 * 60_000;

/** Silence after a message, in ms. A definition read leniently never goes under the floor. */
export function cooldownMs(def: Pick<AlertDefinition, "cooldownHours">): number {
  const hours = typeof def.cooldownHours === "number" && Number.isFinite(def.cooldownHours) ? def.cooldownHours : ALERT_DEFAULTS.cooldownHours;
  return Math.max(hours, COOLDOWN_MIN_HOURS) * 3_600_000 - COOLDOWN_SLACK_MS;
}

/**
 * One check at `at` with the status of its evaluation: the state after it, and
 * the message it is worth, if any.
 *   ok         re-arms;
 *   skipped    changes nothing (not judged is neither true nor false);
 *   triggered  a message when armed and out of the silence; a reminder when
 *              not armed, asked for (`remind`) and out of the silence.
 */
export function advance(
  state: AlertState, status: Evaluation["status"], at: Date, def: Pick<AlertDefinition, "cooldownHours" | "remind">,
): { state: AlertState; message: MessageKind | null } {
  if (status === "ok") return { state: { ...state, armed: true }, message: null };
  if (status !== "triggered") return { state, message: null };
  const quiet = state.lastMessageAt !== null && at.getTime() - state.lastMessageAt.getTime() < cooldownMs(def);
  if (quiet) return { state, message: null };
  if (state.armed) return { state: { armed: false, lastMessageAt: at }, message: "trigger" };
  if (def.remind === true) return { state: { armed: false, lastMessageAt: at }, message: "reminder" };
  return { state, message: null };
}

/** Is an alert checked on this calendar day (YYYY-MM-DD, Paris)? `weekdaysOnly` leaves Saturday and Sunday out. */
export function checkedOn(def: Pick<AlertDefinition, "weekdaysOnly">, date: string): boolean {
  if (def.weekdaysOnly !== true) return true;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

const fr = (n: number, digits = 2) => n.toLocaleString("fr-FR", { maximumFractionDigits: digits });

function median(sorted: number[]): number | null {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Replays the definition over the last BACKTEST_DAYS days with evaluate(), silence and re-arming applied. Pure. */
export function backtest(def: AlertDefinition, series: ClientSeries, opts: { now?: Date } = {}): Backtest {
  const end = lastFullDay(def, series);
  const hour = String(CHECK_SLOTS_UTC[0]).padStart(2, "0");
  let state: AlertState = { armed: true, lastMessageAt: null };
  const messages: BacktestTrigger[] = [];
  const values: number[] = [];
  const reasons = new Map<string, number>();
  const kinds = new Map<SkipKind, number>();
  let daysTrue = 0;
  let skippedDays = 0;
  let unchecked = 0;

  for (let back = BACKTEST_DAYS - 1; back >= 0; back--) {
    const asOf = addDays(end, -back);
    // A full day is judged by the check of the next morning.
    const checkDay = addDays(asOf, 1);
    if (!checkedOn(def, checkDay)) { unchecked++; continue; }
    const ev = evaluate(def, series, { asOf });
    if (ev.status === "skipped") {
      skippedDays++;
      if (ev.reason) reasons.set(ev.reason, (reasons.get(ev.reason) ?? 0) + 1);
      if (ev.skip) kinds.set(ev.skip, (kinds.get(ev.skip) ?? 0) + 1);
    } else if (ev.value !== null) {
      // A day judged without a value (a CPA that triggers on the spend alone, nothing converted) has no place in the spread.
      values.push(ev.value);
    }
    if (ev.status === "triggered") daysTrue++;
    const step = advance(state, ev.status, new Date(`${checkDay}T${hour}:00:00Z`), def);
    state = step.state;
    // Dated as the consultant would have lived it: the morning of the check, not the last day of the figures
    // (an alert checked on weekdays only never shows a message on a Sunday).
    if (step.message) messages.push({ date: checkDay, value: ev.value, changePct: ev.changePct });
  }

  values.sort((a, b) => a - b);
  const notes: string[] = [];
  const mine = def.accounts.map((ref) => series.accounts.find((a) => sameAccount(a.account, ref)) ?? null);

  def.accounts.forEach((ref, i) => {
    const read = mine[i];
    if (!read || read.error) notes.push(`Compte ${PLATFORM_LABEL[ref.platform]} « ${ref.name} » illisible${read?.error ? ` (${read.error})` : ""} : ce qui en dépend n'a pas pu être rejoué.`);
  });
  const judgedDays = BACKTEST_DAYS - unchecked;
  const mainReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (judgedDays > 0 && skippedDays === judgedDays) {
    notes.push(`Aucun jour n'a pu être jugé${mainReason ? ` — ${mainReason}` : ""}.`);
  }
  const platforms = new Set(def.accounts.map((a) => a.platform));
  if (def.aggregation !== "each" && platforms.size > 1 && CONVERSION_METRICS.includes(def.metric)) {
    if (!platforms.has("tiktok")) {
      notes.push("Meta et Google sont additionnés : la même vente peut être comptée par Meta et par Google, le total peut dépasser les ventes réelles.");
    } else {
      const names = (["meta", "google", "tiktok"] as const).filter((p) => platforms.has(p)).map((p) => PLATFORM_LABEL[p]);
      notes.push(`${names.slice(0, -1).join(", ")} et ${names[names.length - 1]} sont additionnés : la même vente peut être comptée par plusieurs plateformes, le total peut dépasser les ventes réelles.`);
    }
  }
  const foreign = mine.filter((a): a is NonNullable<typeof a> => !!a && !a.error && a.currency !== "EUR");
  for (const a of foreign) {
    notes.push(`Compte « ${a.account.name} » en ${a.currency} : montants convertis en euros au taux du jour (1 ${a.currency} = ${fr(a.eurRate, 4)} €), jours passés compris.`);
  }
  if (unchecked > 0) notes.push(`Jours ouvrés seulement : ${judgedDays} jours rejoués sur ${BACKTEST_DAYS}, les samedis et dimanches ne comptent pas.`);

  return {
    days: BACKTEST_DAYS,
    daysTrue,
    messages,
    skippedDays,
    checkedDays: judgedDays,
    skipKind: [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    current: evaluate(def, series, { asOf: end }).value,
    min: values.length ? values[0] : null,
    median: median(values),
    max: values.length ? values[values.length - 1] : null,
    notes,
    hash: definitionHash(def),
    ranAt: (opts.now ?? new Date()).toISOString(),
  };
}

export type ReplayVerdict =
  /** Enough days were judged: the replay is a measure. */
  | { kind: "ok" }
  /** Too few days judged because an account could not be read: not the rule's fault, to be replayed later. */
  | { kind: "wait"; unread: AlertDefinition["accounts"] }
  /** Too few days judged whatever is read: this rule cannot be judged on this client. `error` for the consultant, `hint` for the AI. */
  | { kind: "refused"; error: string; hint: string };

/** Why a rule cannot be judged, for the consultant — and what the AI may write instead. */
const STRUCTURAL: Record<Exclude<SkipKind, "unreadable">, { why: string; hint: string }> = {
  guard_spend: {
    why: "la dépense minimum demandée n'est presque jamais atteinte",
    hint: `"guards.minSpend" plus bas, ou une période "windowDays" plus longue`,
  },
  guard_conversions: {
    why: "le nombre minimum de conversions n'est presque jamais atteint",
    hint: `"guards.minConversions" plus bas, ou une période "windowDays" plus longue`,
  },
  no_value: {
    why: "la mesure n'a presque jamais de valeur sur la période (pas de conversion, pas de dépense, ou un compte qui dépense sans remonter de valeur de conversion)",
    hint: `une période "windowDays" plus longue, une autre "metric", ou "accounts" limité aux comptes qui ont des chiffres`,
  },
  no_history: {
    why: "les comptes n'ont pas assez d'historique pour cette période",
    hint: `une période "windowDays" plus courte`,
  },
  no_reference: {
    why: "la période de comparaison n'a presque jamais de valeur",
    hint: `"condition" : "above" | "below" | "stopped" plutôt qu'une variation, ou une période "windowDays" plus longue`,
  },
  definition: {
    why: "la règle est incomplète",
    hint: "une proposition complète, avec les champs et les valeurs du prompt",
  },
};

/**
 * What a replay is worth. More than half of its days not judged, and its
 * « never triggered » would vouch for an alert nobody measured: the proposal
 * waits when an account of the rule could not be read, and is refused when
 * the cause is the rule itself (guards never met, a ROAS on an account that
 * spends without tracking a value, not enough history). Pure.
 */
export function replayVerdict(def: AlertDefinition, series: ClientSeries, replay: Pick<Backtest, "skippedDays" | "checkedDays" | "skipKind" | "days">): ReplayVerdict {
  const checked = replay.checkedDays ?? replay.days;
  if (checked <= 0 || replay.skippedDays * 2 <= checked) return { kind: "ok" };
  const unread = def.accounts.filter((ref) => {
    const read = series.accounts.find((a) => sameAccount(a.account, ref));
    return !read || !!read.error || read.days.length === 0;
  });
  if (unread.length) return { kind: "wait", unread };
  const cause = STRUCTURAL[replay.skipKind && replay.skipKind !== "unreadable" ? replay.skipKind : "no_value"];
  const days = replay.skippedDays === checked ? `aucun des ${checked} jours` : `${replay.skippedDays} jours sur ${checked}`;
  return {
    kind: "refused",
    error: `Cette règle n'aurait pas pu être jugée sur ${days} rejoués : ${cause.why}. Telle quelle, elle ne vous préviendrait presque jamais : demandez une règle qui peut être jugée sur ce client.`,
    hint: cause.hint,
  };
}
