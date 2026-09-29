import { describe, expect, it } from "vitest";

import { catchUpDecision, computeNextRunAt, isValidTimezone, zonedTimeToUtc } from "@/lib/routines/schedule";
import { hashDefinition, canonicalJson } from "@/lib/routines/hash";
import type { RoutineDefinition, Schedule } from "@/lib/routines/types";

const PARIS = "Europe/Paris";
const at = (iso: string) => new Date(iso);
const next = (s: Schedule, after: string, tz: string | null = PARIS) => computeNextRunAt(s, tz, at(after))?.toISOString() ?? null;

/** Every occurrence between two dates, as the cron would chain them. */
function chain(s: Schedule, from: string, count: number, tz = PARIS): string[] {
  const out: string[] = [];
  let cursor = at(from);
  for (let i = 0; i < count; i++) {
    const n = computeNextRunAt(s, tz, cursor);
    if (!n) break;
    out.push(n.toISOString());
    cursor = n;
  }
  return out;
}

describe("routines — schedule in Europe/Paris", () => {
  const daily9: Schedule = { kind: "daily", time: "09:00" };

  it("follows the clocks going forward (29 March 2026, 28 March 2027)", () => {
    expect(chain(daily9, "2026-03-27T12:00:00Z", 3)).toEqual(["2026-03-28T08:00:00.000Z", "2026-03-29T07:00:00.000Z", "2026-03-30T07:00:00.000Z"]);
    expect(chain(daily9, "2027-03-26T12:00:00Z", 3)).toEqual(["2027-03-27T08:00:00.000Z", "2027-03-28T07:00:00.000Z", "2027-03-29T07:00:00.000Z"]);
  });

  it("follows the clocks going back (25 October 2026, 31 October 2027)", () => {
    expect(chain(daily9, "2026-10-23T12:00:00Z", 3)).toEqual(["2026-10-24T07:00:00.000Z", "2026-10-25T08:00:00.000Z", "2026-10-26T08:00:00.000Z"]);
    expect(chain(daily9, "2027-10-29T12:00:00Z", 3)).toEqual(["2027-10-30T07:00:00.000Z", "2027-10-31T08:00:00.000Z", "2027-11-01T08:00:00.000Z"]);
  });

  it("runs an hour that does not exist right after the change, once", () => {
    const s: Schedule = { kind: "daily", time: "02:30" };
    // 02:30 does not exist on 29 March 2026: 03:30 local time, 01:30 UTC.
    expect(chain(s, "2026-03-27T12:00:00Z", 3)).toEqual(["2026-03-28T01:30:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-30T00:30:00.000Z"]);
    expect(chain(s, "2027-03-26T12:00:00Z", 3)).toEqual(["2027-03-27T01:30:00.000Z", "2027-03-28T01:30:00.000Z", "2027-03-29T00:30:00.000Z"]);
  });

  it("runs an hour that exists twice at its first occurrence, once", () => {
    const s: Schedule = { kind: "daily", time: "02:30" };
    expect(chain(s, "2026-10-23T12:00:00Z", 3)).toEqual(["2026-10-24T00:30:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
    expect(chain(s, "2027-10-29T12:00:00Z", 3)).toEqual(["2027-10-30T00:30:00.000Z", "2027-10-31T00:30:00.000Z", "2027-11-01T01:30:00.000Z"]);
    // Between the two 02:30 of the night: the second one is not a new run.
    expect(next(s, "2026-10-25T01:00:00Z")).toBe("2026-10-26T01:30:00.000Z");
  });

  it("keeps midnight and late evening on the right day across the changes", () => {
    expect(chain({ kind: "daily", time: "00:00" }, "2026-03-28T12:00:00Z", 2)).toEqual(["2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"]);
    expect(chain({ kind: "daily", time: "23:45" }, "2026-10-24T12:00:00Z", 2)).toEqual(["2026-10-24T21:45:00.000Z", "2026-10-25T22:45:00.000Z"]);
  });

  it("is strictly after the reference", () => {
    expect(next(daily9, "2026-06-10T06:59:59Z")).toBe("2026-06-10T07:00:00.000Z");
    expect(next(daily9, "2026-06-10T07:00:00Z")).toBe("2026-06-11T07:00:00.000Z");
  });

  it("schedules by weekday, 1 = Monday, 7 = Sunday", () => {
    // 27 March 2026 is a Friday; the Monday after is past the change of hour.
    expect(next({ kind: "weekly", time: "08:00", weekdays: [1] }, "2026-03-27T12:00:00Z")).toBe("2026-03-30T06:00:00.000Z");
    expect(next({ kind: "weekly", time: "08:00", weekdays: [7] }, "2026-03-27T12:00:00Z")).toBe("2026-03-29T06:00:00.000Z");
    expect(chain({ kind: "weekly", time: "18:30", weekdays: [2, 4] }, "2026-10-19T00:00:00Z", 4)).toEqual([
      "2026-10-20T16:30:00.000Z", "2026-10-22T16:30:00.000Z", "2026-10-27T17:30:00.000Z", "2026-10-29T17:30:00.000Z",
    ]);
    // Weekday of the local date, not of the UTC one: Monday 00:15 in Paris is still Sunday in UTC.
    expect(next({ kind: "weekly", time: "00:15", weekdays: [1] }, "2026-06-12T12:00:00Z")).toBe("2026-06-14T22:15:00.000Z");
  });

  it("schedules by day of the month", () => {
    expect(chain({ kind: "monthly", time: "08:15", dayOfMonth: 1 }, "2026-10-20T00:00:00Z", 2)).toEqual(["2026-11-01T07:15:00.000Z", "2026-12-01T07:15:00.000Z"]);
    expect(next({ kind: "monthly", time: "07:00", dayOfMonth: 28 }, "2026-02-28T07:00:00Z")).toBe("2026-03-28T06:00:00.000Z");
  });

  it("has no next run when manual or unreadable", () => {
    expect(next({ kind: "manual" }, "2026-06-10T00:00:00Z")).toBeNull();
    expect(next({ kind: "daily" }, "2026-06-10T00:00:00Z")).toBeNull();
    expect(next({ kind: "daily", time: "25:00" }, "2026-06-10T00:00:00Z")).toBeNull();
    expect(next({ kind: "weekly", time: "09:00", weekdays: [] }, "2026-06-10T00:00:00Z")).toBeNull();
    expect(next({ kind: "monthly", time: "09:00", dayOfMonth: 31 }, "2026-06-10T00:00:00Z")).toBeNull();
  });

  it("reads another timezone, and falls back on Paris for an unknown one", () => {
    expect(next(daily9, "2026-06-10T00:00:00Z", "America/New_York")).toBe("2026-06-10T13:00:00.000Z");
    expect(next(daily9, "2026-06-10T00:00:00Z", "UTC")).toBe("2026-06-10T09:00:00.000Z");
    expect(next(daily9, "2026-06-10T00:00:00Z", "Mars/Olympus")).toBe("2026-06-10T07:00:00.000Z");
    expect(next(daily9, "2026-06-10T00:00:00Z", null)).toBe("2026-06-10T07:00:00.000Z");
    expect(isValidTimezone("Europe/Paris")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(zonedTimeToUtc(2026, 7, 14, 12, 0, PARIS).toISOString()).toBe("2026-07-14T10:00:00.000Z");
  });
});

describe("routines — catching up", () => {
  const due = at("2026-06-10T07:00:00Z");
  it("waits before the hour, runs when late by less than 12 hours, gives up beyond", () => {
    expect(catchUpDecision(due, at("2026-06-10T06:59:00Z"))).toBe("wait");
    expect(catchUpDecision(due, at("2026-06-10T07:00:00Z"))).toBe("run");
    expect(catchUpDecision(due, at("2026-06-10T18:59:59Z"))).toBe("run");
    expect(catchUpDecision(due, at("2026-06-10T19:00:00Z"))).toBe("missed");
    expect(catchUpDecision(due, at("2026-06-13T07:00:00Z"))).toBe("missed");
    expect(catchUpDecision(null, at("2026-06-10T07:00:00Z"))).toBe("wait");
  });

  it("runs once after a long stop: the next run is counted from now", () => {
    // Three days without cron: one run now, then tomorrow — not three runs in a row.
    expect(next({ kind: "daily", time: "09:00" }, "2026-06-13T10:00:00Z")).toBe("2026-06-14T07:00:00.000Z");
  });
});

describe("routines — definition hash", () => {
  const definition = { version: 1, steps: [{ id: "a", type: "rows.limit", count: 3 }, { id: "b", type: "rows.sort", by: "x", dir: "asc" }] } as RoutineDefinition;
  const schedule: Schedule = { kind: "weekly", time: "09:00", weekdays: [1, 3] };
  const base = hashDefinition({ definition, schedule, maxItemsPerRun: 20 });

  it("does not depend on the order of the keys", () => {
    const shuffled = { steps: [{ count: 3, type: "rows.limit", id: "a" }, { dir: "asc", by: "x", id: "b", type: "rows.sort" }], version: 1 } as RoutineDefinition;
    expect(hashDefinition({ maxItemsPerRun: 20, schedule: { weekdays: [1, 3], time: "09:00", kind: "weekly" }, definition: shuffled })).toBe(base);
    expect(hashDefinition({ definition: JSON.parse(JSON.stringify(definition)), schedule, maxItemsPerRun: 20 })).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores absent values", () => {
    const withUndefined = { version: 1, steps: [{ id: "a", type: "rows.limit", count: 3, label: undefined }, definition.steps[1]] } as RoutineDefinition;
    expect(hashDefinition({ definition: withUndefined, schedule: { ...schedule, dayOfMonth: undefined }, maxItemsPerRun: 20 })).toBe(base);
  });

  it("changes with the definition, the order of the steps, the schedule and the ceiling", () => {
    const hashes = new Set([
      base,
      hashDefinition({ definition: { version: 1, steps: [...definition.steps].reverse() }, schedule, maxItemsPerRun: 20 }),
      hashDefinition({ definition: { version: 1, steps: [{ id: "a", type: "rows.limit", count: 4 }, definition.steps[1]] }, schedule, maxItemsPerRun: 20 }),
      hashDefinition({ definition, schedule: { ...schedule, time: "09:15" }, maxItemsPerRun: 20 }),
      hashDefinition({ definition, schedule: { ...schedule, weekdays: [3, 1] }, maxItemsPerRun: 20 }),
      hashDefinition({ definition, schedule, maxItemsPerRun: 21 }),
    ]);
    expect(hashes.size).toBe(6);
  });

  it("writes JSON with sorted keys", () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }], e: undefined })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
  });
});
