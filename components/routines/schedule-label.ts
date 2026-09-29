/**
 * Routines — a structured schedule said in French: « tous les lundis à 9 h ».
 *
 * Pure and client-safe. Reads what the API sends (an object, or the JSON kept
 * in Routine.scheduleJson) without trusting it: anything that is not a
 * schedule gives « planning non défini », never an exception.
 */

import { DEFAULT_TIMEZONE, type Schedule } from "@/lib/routines/types";

const DAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"] as const;
const plural = (day: string) => (day.endsWith("s") ? day : `${day}s`);

export const NO_SCHEDULE_LABEL = "planning non défini";
export const MANUAL_SCHEDULE_LABEL = "à la demande, sans planning";

/** A schedule from untrusted input (object or JSON text); null when it is not one. */
export function parseSchedule(input: unknown): Schedule | null {
  let raw = input;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (s.kind === "manual") return { kind: "manual" };
  if (s.kind !== "daily" && s.kind !== "weekly" && s.kind !== "monthly") return null;
  if (typeof s.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) return null;
  if (s.kind === "daily") return { kind: "daily", time: s.time };
  if (s.kind === "weekly") {
    if (!Array.isArray(s.weekdays)) return null;
    const days = [...new Set(s.weekdays.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
    return days.length && days.length === new Set(s.weekdays).size ? { kind: "weekly", time: s.time, weekdays: days } : null;
  }
  const day = s.dayOfMonth;
  if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 28) return null;
  return { kind: "monthly", time: s.time, dayOfMonth: day };
}

/** "09:00" → « 9 h », "09:30" → « 9 h 30 », "00:15" → « 0 h 15 ». */
export function hourLabel(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

function daysLabel(days: number[]): string {
  if (days.length === 7) return "tous les jours";
  const consecutive = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (consecutive && days.length >= 3) return `du ${DAYS[days[0] - 1]} au ${DAYS[days[days.length - 1] - 1]}`;
  return `tous les ${list(days.map((d) => plural(DAYS[d - 1])))}`;
}

/**
 * The schedule in one phrase, without capital nor final period so that it
 * fits in a sentence. The timezone is named only when it is not the agency's.
 */
export function scheduleLabel(input: unknown, timezone?: string | null): string {
  const schedule = parseSchedule(input);
  if (!schedule) return NO_SCHEDULE_LABEL;
  if (schedule.kind === "manual") return MANUAL_SCHEDULE_LABEL;
  const at = `à ${hourLabel(schedule.time!)}`;
  const zone = timezone && timezone !== DEFAULT_TIMEZONE ? ` (heure de ${timezone})` : "";
  switch (schedule.kind) {
    case "daily": return `tous les jours ${at}${zone}`;
    case "weekly": return `${daysLabel(schedule.weekdays!)} ${at}${zone}`;
    case "monthly": return `le ${schedule.dayOfMonth === 1 ? "1er" : schedule.dayOfMonth} de chaque mois ${at}${zone}`;
  }
}

/** Same phrase with a capital, for a line of its own. */
export function scheduleTitle(input: unknown, timezone?: string | null): string {
  const label = scheduleLabel(input, timezone);
  return label.charAt(0).toUpperCase() + label.slice(1);
}
