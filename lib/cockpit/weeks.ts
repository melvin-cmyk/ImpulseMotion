/**
 * Global Cockpit — the calendar: W0 is the last FULL week (Monday → Sunday)
 * in the agency timezone, preceded by 8 weeks of history; the budget pace is
 * read on the month of the last closed day.
 */

import { addDays, todayIn } from "@/lib/date-ranges";
import { COCKPIT_CFG, EMPTY_WEEK, PERIOD_LIMITS, type PeriodKind, type WeekPoint } from "@/lib/cockpit/engine";

export const COCKPIT_TZ = "Europe/Paris";

export interface CockpitCalendar {
  today: string;
  /** Monday of each of the 9 weeks, oldest first */
  weekStarts: string[];
  /** W0: Monday and Sunday */
  w0: { since: string; until: string };
  /** month of the last closed day */
  month: { key: string; first: string; lastClosed: string; elapsed: number; days: number };
  /** one window covering the 9 weeks, the month to date and the months it is compared to */
  fetch: { since: string; until: string };
}

/** Months the month to date is compared to. */
export const MONTHS_BASE = PERIOD_LIMITS.month.points - 1;

const daysIn = (year: number, month1: number): number => new Date(Date.UTC(year, month1, 0)).getUTCDate();
const pad = (n: number): string => String(n).padStart(2, "0");

/** First day of the month `back` months before the month `key` (YYYY-MM). */
export function monthBefore(key: string, back: number): { key: string; first: string; days: number } {
  const total = Number(key.slice(0, 4)) * 12 + (Number(key.slice(5, 7)) - 1) - back;
  const year = Math.floor(total / 12), month1 = (total % 12) + 1;
  return { key: `${year}-${pad(month1)}`, first: `${year}-${pad(month1)}-01`, days: daysIn(year, month1) };
}

const dow = (ymd: string): number => new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 = Sunday

export function cockpitCalendar(now: Date = new Date()): CockpitCalendar {
  const today = todayIn(COCKPIT_TZ, now);
  const lastClosed = addDays(today, -1);
  // Last Sunday that is closed (yesterday when today is a Monday).
  const back = dow(lastClosed);
  const sunday = addDays(lastClosed, -back);
  const monday = addDays(sunday, -6);
  const weekStarts = Array.from({ length: COCKPIT_CFG.histWeeks + 1 }, (_, i) => addDays(monday, -7 * (COCKPIT_CFG.histWeeks - i)));

  const key = lastClosed.slice(0, 7);
  const first = `${key}-01`;
  const days = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
  const elapsed = Number(lastClosed.slice(8, 10));

  return {
    today,
    weekStarts,
    w0: { since: monday, until: sunday },
    month: { key, first, lastClosed, elapsed, days },
    fetch: { since: [weekStarts[0], monthBefore(key, MONTHS_BASE).first].sort()[0], until: lastClosed },
  };
}

export interface PeriodRange { since: string; until: string }

export interface CockpitPeriods {
  kind: PeriodKind;
  /** oldest first; the last one is the period read */
  ranges: PeriodRange[];
  /** the period read, as shown in the header */
  label: string;
  /** one short label per range, for the charts */
  starts: string[];
}

/**
 * The periods of a reading:
 *   day   — yesterday, against the 8 days before;
 *   week  — the last full week, against the 8 weeks before;
 *   month — the month to date, against the SAME days of the 3 months before
 *           (the 1st to the 27th of each), so that a month that is not over
 *           is never compared to full ones.
 */
export function cockpitPeriods(kind: PeriodKind, cal: CockpitCalendar): CockpitPeriods {
  if (kind === "day") {
    const last = cal.month.lastClosed;
    const days = Array.from({ length: PERIOD_LIMITS.day.points }, (_, i) => addDays(last, i - (PERIOD_LIMITS.day.points - 1)));
    return { kind, ranges: days.map((d) => ({ since: d, until: d })), label: shortDay(last), starts: days.map(shortDay) };
  }
  if (kind === "month") {
    const months = Array.from({ length: MONTHS_BASE + 1 }, (_, i) => monthBefore(cal.month.key, MONTHS_BASE - i));
    const ranges = months.map((m) => ({ since: m.first, until: `${m.key}-${pad(Math.min(cal.month.elapsed, m.days))}` }));
    const p0 = ranges[ranges.length - 1];
    return { kind, ranges, label: `${shortDay(p0.since)} → ${shortDay(p0.until)}`, starts: months.map((m) => `${m.key.slice(5, 7)}/${m.key.slice(2, 4)}`) };
  }
  return {
    kind,
    ranges: cal.weekStarts.map((s) => ({ since: s, until: addDays(s, 6) })),
    label: `${shortDay(cal.w0.since)} → ${shortDay(cal.w0.until)}`,
    starts: cal.weekStarts.map(shortDay),
  };
}

/** Daily rows → one point per range. */
export function bucketRanges(days: DailyPoint[], ranges: PeriodRange[]): WeekPoint[] {
  const points: WeekPoint[] = ranges.map(() => ({ ...EMPTY_WEEK }));
  for (const d of days) {
    const i = ranges.findIndex((r) => d.date >= r.since && d.date <= r.until);
    if (i < 0) continue;
    const w = points[i];
    w.spend += d.spend; w.conv += d.conv; w.value += d.value; w.impressions += d.impressions; w.clicks += d.clicks;
  }
  return points;
}

export interface DailyPoint extends WeekPoint { date: string }

/** Daily rows → 9 weekly points + month-to-date spend. */
export function bucket(days: DailyPoint[], cal: CockpitCalendar): { weeks: WeekPoint[]; mtd: number } {
  const weeks: WeekPoint[] = cal.weekStarts.map(() => ({ ...EMPTY_WEEK }));
  let mtd = 0;
  for (const d of days) {
    if (d.date >= cal.month.first && d.date <= cal.month.lastClosed) mtd += d.spend;
    if (d.date < cal.weekStarts[0] || d.date > cal.w0.until) continue;
    const i = Math.floor((Date.parse(`${d.date}T00:00:00Z`) - Date.parse(`${cal.weekStarts[0]}T00:00:00Z`)) / (7 * 86_400_000));
    const w = weeks[i];
    if (!w) continue;
    w.spend += d.spend; w.conv += d.conv; w.value += d.value; w.impressions += d.impressions; w.clicks += d.clicks;
  }
  return { weeks, mtd };
}

/** "21/09" */
export const shortDay = (ymd: string): string => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
