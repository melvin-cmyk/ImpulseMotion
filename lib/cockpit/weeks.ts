/**
 * Global Cockpit — the calendar: W0 is the last FULL week (Monday → Sunday)
 * in the agency timezone, preceded by 8 weeks of history; the budget pace is
 * read on the month of the last closed day.
 */

import { addDays, todayIn } from "@/lib/date-ranges";
import { COCKPIT_CFG, EMPTY_WEEK, type WeekPoint } from "@/lib/cockpit/engine";

export const COCKPIT_TZ = "Europe/Paris";

export interface CockpitCalendar {
  today: string;
  /** Monday of each of the 9 weeks, oldest first */
  weekStarts: string[];
  /** W0: Monday and Sunday */
  w0: { since: string; until: string };
  /** month of the last closed day */
  month: { key: string; first: string; lastClosed: string; elapsed: number; days: number };
  /** one window covering the 9 weeks and the month to date */
  fetch: { since: string; until: string };
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
    fetch: { since: weekStarts[0] < first ? weekStarts[0] : first, until: lastClosed },
  };
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
