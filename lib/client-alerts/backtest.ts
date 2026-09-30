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
 * days only. Pure.
 */

import { addDays } from "@/lib/date-ranges";
import { definitionHash, evaluate, lastFullDay, PLATFORM_LABEL, sameAccount } from "@/lib/client-alerts/evaluate";
import {
  ALERT_DEFAULTS, BACKTEST_DAYS, CHECK_SLOTS_UTC, COOLDOWN_MIN_HOURS,
  type AlertDefinition, type Backtest, type BacktestTrigger, type ClientSeries, type Evaluation,
} from "@/lib/client-alerts/types";

export interface AlertState {
  /** false after a message, until a check finds the condition false again. */
  armed: boolean;
  lastMessageAt: Date | null;
}

export type MessageKind = "trigger" | "reminder";

/**
 * The cron never fires at the same second: a check 71 h 59 after a message
 * must count as three days later, not wait for the next slot.
 */
const COOLDOWN_SLACK_MS = 30 * 60_000;

/** Silence after a message, in ms. A definition read leniently never goes under the floor. */
function cooldownMs(def: Pick<AlertDefinition, "cooldownHours">): number {
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

const USES_SALES = new Set(["conversions", "cpa", "roas", "revenue"]);
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
  let daysTrue = 0;
  let skippedDays = 0;
  let unchecked = 0;

  for (let back = BACKTEST_DAYS - 1; back >= 0; back--) {
    const asOf = addDays(end, -back);
    // A full day is judged by the check of the next morning.
    const checkDay = addDays(asOf, 1);
    if (!checkedOn(def, checkDay)) { unchecked++; continue; }
    const ev = evaluate(def, series, { asOf, live: false });
    if (ev.status === "skipped") {
      skippedDays++;
      if (ev.reason) reasons.set(ev.reason, (reasons.get(ev.reason) ?? 0) + 1);
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
  if (judgedDays > 0 && skippedDays === judgedDays) {
    const main = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    notes.push(`Aucun jour n'a pu être jugé${main ? ` — ${main}` : ""}.`);
  }
  const platforms = new Set(def.accounts.map((a) => a.platform));
  if (def.aggregation !== "each" && platforms.size > 1 && USES_SALES.has(def.metric)) {
    notes.push("Meta et Google sont additionnés : la même vente peut être comptée par Meta et par Google, le total peut dépasser les ventes réelles.");
  }
  const foreign = mine.filter((a): a is NonNullable<typeof a> => !!a && !a.error && a.currency !== "EUR");
  for (const a of foreign) {
    notes.push(`Compte « ${a.account.name} » en ${a.currency} : montants convertis en euros au taux du jour (1 ${a.currency} = ${fr(a.eurRate, 4)} €), jours passés compris.`);
  }
  if (def.condition === "stopped" && def.metric === "spend" && def.windowDays === 1) {
    notes.push("Arrêt rejoué sur des jours complets seulement : en réel, une journée encore à zéro l'après-midi déclenche aussi, sans attendre le lendemain.");
  }
  if (unchecked > 0) notes.push(`Week-ends non vérifiés : ${judgedDays} jours rejoués sur ${BACKTEST_DAYS}.`);

  return {
    days: BACKTEST_DAYS,
    daysTrue,
    messages,
    skippedDays,
    current: evaluate(def, series, { asOf: end, live: false }).value,
    min: values.length ? values[0] : null,
    median: median(values),
    max: values.length ? values[values.length - 1] : null,
    notes,
    hash: definitionHash(def),
    ranAt: (opts.now ?? new Date()).toISOString(),
  };
}
