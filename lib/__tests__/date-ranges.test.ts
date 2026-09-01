import { describe, expect, it } from "vitest";
import {
  addDays,
  describeRange,
  includesToday,
  lastCalendarMonth,
  lastFullDays,
  monthToDate,
  presetRange,
  prevRange,
  rangeDays,
  rangeFromParams,
  todayIn,
  validateRange,
  yearAgoRange,
} from "@/lib/date-ranges";

// 2026-08-31 23:30 UTC — already 1 Sept in Johannesburg (UTC+2), still 31 Aug in Denver (UTC−6).
const NOW = new Date("2026-08-31T23:30:00Z");

describe("todayIn", () => {
  it("uses UTC by default", () => {
    expect(todayIn(undefined, NOW)).toBe("2026-08-31");
  });
  it("respects the account timezone (ahead of UTC)", () => {
    expect(todayIn("Africa/Johannesburg", NOW)).toBe("2026-09-01");
  });
  it("respects the account timezone (behind UTC)", () => {
    expect(todayIn("America/Denver", NOW)).toBe("2026-08-31");
  });
  it("falls back to UTC on an invalid timezone", () => {
    expect(todayIn("Not/AZone", NOW)).toBe("2026-08-31");
  });
});

describe("lastFullDays", () => {
  it("returns exactly N days ending yesterday", () => {
    const r = lastFullDays(7, { now: NOW });
    expect(r).toEqual({ since: "2026-08-24", until: "2026-08-30" });
    expect(rangeDays(r)).toBe(7);
  });
  it("30 days ending yesterday is 30 rows, not 31", () => {
    const r = lastFullDays(30, { now: NOW });
    expect(rangeDays(r)).toBe(30);
    expect(r.until).toBe("2026-08-30");
  });
  it("shifts with the account timezone", () => {
    const r = lastFullDays(7, { now: NOW, tz: "Africa/Johannesburg" });
    expect(r).toEqual({ since: "2026-08-25", until: "2026-08-31" });
  });
});

describe("prevRange", () => {
  it("is the same length and ends the day before since", () => {
    const cur = { since: "2026-08-24", until: "2026-08-30" };
    expect(prevRange(cur)).toEqual({ since: "2026-08-17", until: "2026-08-23" });
    expect(rangeDays(prevRange(cur))).toBe(rangeDays(cur));
  });
  it("handles a single day", () => {
    expect(prevRange({ since: "2026-08-30", until: "2026-08-30" })).toEqual({ since: "2026-08-29", until: "2026-08-29" });
  });
});

describe("calendar presets", () => {
  it("month-to-date ends yesterday", () => {
    expect(monthToDate({ now: NOW })).toEqual({ since: "2026-08-01", until: "2026-08-30" });
  });
  it("month-to-date on the 1st is the 1st itself", () => {
    expect(monthToDate({ now: new Date("2026-09-01T10:00:00Z") })).toEqual({ since: "2026-09-01", until: "2026-09-01" });
  });
  it("last calendar month", () => {
    expect(lastCalendarMonth({ now: NOW })).toEqual({ since: "2026-07-01", until: "2026-07-31" });
    expect(lastCalendarMonth({ now: new Date("2026-03-15T00:00:00Z") })).toEqual({ since: "2026-02-01", until: "2026-02-28" });
  });
  it("presetRange dispatches", () => {
    expect(presetRange("yesterday", { now: NOW })).toEqual({ since: "2026-08-30", until: "2026-08-30" });
    expect(presetRange("last_90", { now: NOW }).since).toBe(addDays("2026-08-30", -89));
  });
  it("year-ago shifts the year only", () => {
    expect(yearAgoRange({ since: "2026-08-01", until: "2026-08-30" })).toEqual({ since: "2025-08-01", until: "2025-08-30" });
  });
});

describe("partial day", () => {
  it("flags ranges that include today", () => {
    expect(includesToday({ since: "2026-08-01", until: "2026-08-31" }, { now: NOW })).toBe(true);
    expect(includesToday({ since: "2026-08-01", until: "2026-08-30" }, { now: NOW })).toBe(false);
    expect(includesToday({ since: "2026-08-01", until: "2026-08-31" }, { now: NOW, tz: "Africa/Johannesburg" })).toBe(false);
  });
  it("describeRange labels the partial day", () => {
    const d = describeRange({ since: "2026-08-01", until: "2026-08-31" }, { now: NOW });
    expect(d.days).toBe(31);
    expect(d.partialDay).toBe(true);
    expect(d.label).toContain("31 j");
    expect(d.label).toContain("partiel");
  });
});

describe("validation", () => {
  it("rejects bad formats, inverted and too-long ranges", () => {
    expect(validateRange("2026-8-1", "2026-08-30").ok).toBe(false);
    expect(validateRange("2026-08-30", "2026-08-01").ok).toBe(false);
    expect(validateRange("2024-01-01", "2026-08-30").ok).toBe(false);
    expect(validateRange("2026-02-30", "2026-03-01").ok).toBe(true); // JS Date normalises; format-valid
  });
  it("rangeFromParams falls back to the preset and reads explicit dates", () => {
    const p = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    const dflt = rangeFromParams(p({}), "last_30", { now: NOW });
    expect(dflt.ok && dflt.range).toEqual({ since: "2026-08-01", until: "2026-08-30" });
    const explicit = rangeFromParams(p({ since: "2026-07-01", until: "2026-07-31" }), "last_30", { now: NOW });
    expect(explicit.ok && explicit.days).toBe(31);
    const preset = rangeFromParams(p({ preset: "last_7" }), "last_30", { now: NOW });
    expect(preset.ok && preset.range).toEqual({ since: "2026-08-24", until: "2026-08-30" });
    expect(rangeFromParams(p({ since: "x" }), "last_30").ok).toBe(false);
  });
});
