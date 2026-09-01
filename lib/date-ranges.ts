/**
 * Single source of truth for reporting windows.
 *
 * Rules (shared by every surface — cockpit, portfolio, dashboards, Analyse Ads,
 * WoW, changes, alerts, reports):
 *   - A preset of N days = the N FULL days ending YESTERDAY (never today's
 *     partial day). "7 jours" is 7 rows of daily data, not 8.
 *   - "Today" is computed in the ad account's timezone when known (Meta and
 *     Google both interpret since/until in the account timezone), UTC otherwise.
 *   - The comparison window is the same length, ending the day before `since`.
 *   - A range that includes today is allowed (explicit custom pick) but is
 *     flagged `partialDay` so the UI can say so.
 *
 * Client-safe: no server imports, no Date.now() side effects outside `now`.
 */

export interface DateRange {
  since: string; // YYYY-MM-DD inclusive
  until: string; // YYYY-MM-DD inclusive
}

export type RangePreset =
  | "yesterday"
  | "last_7"
  | "last_14"
  | "last_30"
  | "last_90"
  | "mtd"
  | "last_month";

export const PRESET_DAYS: Record<Exclude<RangePreset, "mtd" | "last_month" | "yesterday">, number> = {
  last_7: 7,
  last_14: 14,
  last_30: 30,
  last_90: 90,
};

export const PRESET_LABELS: Record<RangePreset, string> = {
  yesterday: "Hier",
  last_7: "7 derniers jours",
  last_14: "14 derniers jours",
  last_30: "30 derniers jours",
  last_90: "90 derniers jours",
  mtd: "Mois en cours",
  last_month: "Mois dernier",
};

const DAY_MS = 86_400_000;
export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Maximum span accepted from user input (Meta insights cap is ~37 months; we stay well below). */
export const MAX_RANGE_DAYS = 400;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Calendar date (YYYY-MM-DD) of `now` in the given IANA timezone; UTC when tz is missing/invalid. */
export function todayIn(tz?: string | null, now: Date = new Date()): string {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      const y = get("year");
      const m = get("month");
      const d = get("day");
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch {
      // invalid tz → fall through to UTC
    }
  }
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

/** Add `n` calendar days to a YYYY-MM-DD string (n may be negative). */
export function addDays(ymd: string, n: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(t + n * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive number of days in a range (≥ 1 for a valid range). */
export function rangeDays(range: DateRange): number {
  const s = Date.parse(`${range.since}T00:00:00Z`);
  const u = Date.parse(`${range.until}T00:00:00Z`);
  return Math.round((u - s) / DAY_MS) + 1;
}

export interface RangeOptions {
  /** IANA timezone of the ad account (e.g. "Africa/Johannesburg"). */
  tz?: string | null;
  /** Injectable clock for tests. */
  now?: Date;
}

/** Yesterday in the account timezone. */
export function yesterdayIn(opts: RangeOptions = {}): string {
  return addDays(todayIn(opts.tz, opts.now), -1);
}

/** The `days` full days ending yesterday. `lastFullDays(7)` → 7 daily rows. */
export function lastFullDays(days: number, opts: RangeOptions = {}): DateRange {
  const n = Math.max(1, Math.floor(days));
  const until = yesterdayIn(opts);
  return { since: addDays(until, -(n - 1)), until };
}

/** Month-to-date: 1st of the current month → yesterday (or the 1st itself on the 1st). */
export function monthToDate(opts: RangeOptions = {}): DateRange {
  const today = todayIn(opts.tz, opts.now);
  const first = `${today.slice(0, 7)}-01`;
  const until = addDays(today, -1);
  return until < first ? { since: first, until: first } : { since: first, until };
}

/** Previous full calendar month. */
export function lastCalendarMonth(opts: RangeOptions = {}): DateRange {
  const today = todayIn(opts.tz, opts.now);
  const firstOfThisMonth = `${today.slice(0, 7)}-01`;
  const until = addDays(firstOfThisMonth, -1);
  return { since: `${until.slice(0, 7)}-01`, until };
}

export function presetRange(preset: RangePreset, opts: RangeOptions = {}): DateRange {
  switch (preset) {
    case "yesterday": {
      const y = yesterdayIn(opts);
      return { since: y, until: y };
    }
    case "mtd":
      return monthToDate(opts);
    case "last_month":
      return lastCalendarMonth(opts);
    default:
      return lastFullDays(PRESET_DAYS[preset], opts);
  }
}

/** Numeric preset (7/14/30/90) → RangePreset key; used by legacy pickers. */
export function presetFromDays(days: number): RangePreset {
  if (days <= 1) return "yesterday";
  if (days <= 7) return "last_7";
  if (days <= 14) return "last_14";
  if (days <= 30) return "last_30";
  return "last_90";
}

/** Previous window of the same length, ending the day before `since`. */
export function prevRange(range: DateRange): DateRange {
  const days = Math.max(1, rangeDays(range));
  const until = addDays(range.since, -1);
  return { since: addDays(until, -(days - 1)), until };
}

/** Same window one year earlier (calendar-aligned). */
export function yearAgoRange(range: DateRange): DateRange {
  const shift = (ymd: string) => `${Number(ymd.slice(0, 4)) - 1}${ymd.slice(4)}`;
  return { since: shift(range.since), until: shift(range.until) };
}

/** True when the range includes today (in the account timezone) → last day is partial. */
export function includesToday(range: DateRange, opts: RangeOptions = {}): boolean {
  return range.until >= todayIn(opts.tz, opts.now);
}

/** True when every day of the range is closed (can be cached for a long time). */
export function isClosedRange(range: DateRange, opts: RangeOptions = {}): boolean {
  return !includesToday(range, opts);
}

export type RangeValidation = { ok: true; range: DateRange; days: number } | { ok: false; error: string };

/** Validates user-provided since/until (format, order, span). */
export function validateRange(
  since: unknown,
  until: unknown,
  maxDays: number = MAX_RANGE_DAYS,
): RangeValidation {
  if (typeof since !== "string" || typeof until !== "string" || !YMD_RE.test(since) || !YMD_RE.test(until)) {
    return { ok: false, error: "since/until doivent être au format YYYY-MM-DD" };
  }
  if (Number.isNaN(Date.parse(`${since}T00:00:00Z`)) || Number.isNaN(Date.parse(`${until}T00:00:00Z`))) {
    return { ok: false, error: "Date invalide" };
  }
  if (since > until) return { ok: false, error: "La date de début doit précéder la date de fin" };
  const days = rangeDays({ since, until });
  if (days > maxDays) return { ok: false, error: `Période trop longue (max ${maxDays} jours)` };
  return { ok: true, range: { since, until }, days };
}

/** Parse `?since&until` (or a preset) from URL params with a safe default. */
export function rangeFromParams(
  params: { get(name: string): string | null },
  fallback: RangePreset = "last_30",
  opts: RangeOptions = {},
): RangeValidation {
  const preset = params.get("preset");
  if (preset && preset in PRESET_LABELS) {
    const range = presetRange(preset as RangePreset, opts);
    return { ok: true, range, days: rangeDays(range) };
  }
  const since = params.get("since");
  const until = params.get("until");
  if (!since && !until) {
    const range = presetRange(fallback, opts);
    return { ok: true, range, days: rangeDays(range) };
  }
  return validateRange(since, until);
}

/** Human label, e.g. "1 – 30 août 2026 · 30 j" (+ " · aujourd'hui partiel" when relevant). */
export function describeRange(range: DateRange, opts: RangeOptions = {}): { days: number; partialDay: boolean; label: string } {
  const days = rangeDays(range);
  const partialDay = includesToday(range, opts);
  const f = (d: string, withYear: boolean) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("fr-FR", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  const sameYear = range.since.slice(0, 4) === range.until.slice(0, 4);
  const label = `${f(range.since, !sameYear)} – ${f(range.until, true)} · ${days} j${partialDay ? " · aujourd'hui partiel" : ""}`;
  return { days, partialDay, label };
}
