/**
 * Routines — when a routine runs next.
 *
 * The schedule is structured (daily, weekly, monthly, manual) and read in the
 * routine's timezone, Europe/Paris unless said otherwise. nextRunAt is stored
 * in UTC; the cron fires every 15 minutes and takes what is due.
 *
 * Daylight saving time:
 *   - an hour that does not exist (02:30 on the night clocks go forward) runs
 *     at the same distance after the change, so 03:30 local time;
 *   - an hour that exists twice (02:30 on the night clocks go back) runs once,
 *     at its first occurrence.
 *
 * Catching up: a run that is late by less than 12 hours starts once; beyond
 * that it is recorded as missed. Either way the next date is computed from
 * now, so occurrences that were skipped are never replayed one by one.
 */

import { CATCH_UP_MAX_HOURS, DEFAULT_TIMEZONE, type Schedule } from "@/lib/routines/types";

const DAY_MS = 86_400_000;
/** Days scanned to find the next occurrence: a monthly schedule is always found within two months. */
const SEARCH_DAYS = 70;

export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || !timezone || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Wall clock of an instant in a timezone. */
export function localParts(at: Date | number, timezone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(at))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute };
}

/** Offset of the timezone at an instant, in ms (local = UTC + offset). */
function offsetAt(utcMs: number, timezone: string): number {
  const p = localParts(utcMs, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(utcMs / 60_000) * 60_000;
}

/** UTC instant of a wall clock time in a timezone (see the header for the two DST cases). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(wall - DAY_MS, timezone);
  const after = offsetAt(wall + DAY_MS, timezone);
  const candidates = before === after ? [wall - before] : [wall - before, wall - after];
  const exact = candidates.filter((c) => {
    const p = localParts(c, timezone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  });
  if (exact.length) return new Date(Math.min(...exact));
  // Hour skipped by the change: the offset in force before it gives the same distance after it.
  return new Date(wall - before);
}

/** 1 = Monday … 7 = Sunday, for a calendar date. */
function weekdayOf(year: number, month: number, day: number): number {
  const d = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return d === 0 ? 7 : d;
}

function parseTime(time: string | undefined): { hour: number; minute: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? "");
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/**
 * First occurrence strictly after `after`, in UTC. Null for a manual schedule
 * or a schedule that cannot be read (validateSchedule refuses those earlier).
 */
export function computeNextRunAt(schedule: Schedule, timezone: string | null | undefined, after: Date): Date | null {
  if (!schedule || schedule.kind === "manual") return null;
  const time = parseTime(schedule.time);
  if (!time) return null;
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const weekdays = new Set(schedule.weekdays ?? []);
  if (schedule.kind === "weekly" && !weekdays.size) return null;
  if (schedule.kind === "monthly" && !(Number.isInteger(schedule.dayOfMonth) && schedule.dayOfMonth! >= 1 && schedule.dayOfMonth! <= 28)) return null;

  // Calendar walk from the local day before `after`: dates only, so no DST effect here.
  const start = localParts(after, tz);
  const base = Date.UTC(start.year, start.month - 1, start.day) - DAY_MS;
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const d = new Date(base + i * DAY_MS);
    const year = d.getUTCFullYear(), month = d.getUTCMonth() + 1, day = d.getUTCDate();
    if (schedule.kind === "weekly" && !weekdays.has(weekdayOf(year, month, day))) continue;
    if (schedule.kind === "monthly" && day !== schedule.dayOfMonth) continue;
    const at = zonedTimeToUtc(year, month, day, time.hour, time.minute, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

/**
 * Last occurrence of the schedule at or before `now`: the occurrence a run
 * started at `now` belongs to. Null for a manual schedule, or when none fell
 * in the last 70 days.
 */
export function lastOccurrenceAt(schedule: Schedule, timezone: string | null | undefined, now: Date): Date | null {
  let at = computeNextRunAt(schedule, timezone, new Date(now.getTime() - SEARCH_DAYS * DAY_MS));
  let last: Date | null = null;
  for (let i = 0; at && at.getTime() <= now.getTime() && i < 2 * SEARCH_DAYS; i++) {
    last = at;
    at = computeNextRunAt(schedule, timezone, at);
  }
  return last;
}

export type CatchUp = "wait" | "run" | "missed";

/** What to do with a routine whose nextRunAt is `dueAt`, at `now`. */
export function catchUpDecision(dueAt: Date | null | undefined, now: Date): CatchUp {
  if (!dueAt) return "wait";
  const late = now.getTime() - dueAt.getTime();
  if (late < 0) return "wait";
  return late < CATCH_UP_MAX_HOURS * 3_600_000 ? "run" : "missed";
}
