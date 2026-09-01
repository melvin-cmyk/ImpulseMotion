import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { micros, costFrom, extractRows } from "@/lib/dashboard-widgets";

describe("micros()", () => {
  it("always divides by 1e6 — no magnitude heuristic", () => {
    expect(micros(1_500_000)).toBe(1.5);
    expect(micros("2500000")).toBe(2.5);
    expect(micros(5000)).toBe(0.005); // small spend used to be mistaken for units
    expect(micros(0)).toBe(0);
    expect(micros("abc")).toBe(0);
  });
});

describe("costFrom()", () => {
  it("uses cost_micros / costMicros explicitly, plain cost as-is", () => {
    expect(costFrom({ costMicros: "1230000" })).toBe(1.23);
    expect(costFrom({ cost_micros: 4000 })).toBe(0.004);
    expect(costFrom({ cost: "42.5" })).toBe(42.5);
    expect(costFrom({ cost: 12000 })).toBe(12000); // not micros → not divided
    expect(costFrom({})).toBe(0);
  });
});

describe("extractRows()", () => {
  it("concatenates ALL pages of {results} chunks", () => {
    const raw = [
      { results: [{ campaign: { name: "a" } }, { campaign: { name: "b" } }], fieldMask: "x" },
      { results: [{ campaign: { name: "c" } }] },
      { results: [] },
    ];
    expect(extractRows(raw).map((r) => (r.campaign as { name: string }).name)).toEqual(["a", "b", "c"]);
  });

  it("accepts a plain array of rows and a single {results|data|rows} object", () => {
    expect(extractRows([{ a: 1 }, { a: 2 }])).toHaveLength(2);
    expect(extractRows({ results: [{ a: 1 }] })).toHaveLength(1);
    expect(extractRows({ data: [{ a: 1 }] })).toHaveLength(1);
    expect(extractRows({ rows: [] })).toEqual([]);
    expect(extractRows([])).toEqual([]);
    expect(extractRows(JSON.stringify([{ results: [{ a: 1 }] }]))).toHaveLength(1);
  });

  it("throws a descriptive error for relay error objects instead of returning []", () => {
    expect(() => extractRows({ error: "Customer not found" })).toThrow(/Customer not found/);
    expect(() => extractRows({ error: { message: "PERMISSION_DENIED" } })).toThrow(/PERMISSION_DENIED/);
    expect(() => extractRows([{ results: [{ a: 1 }] }, { error: "quota" }])).toThrow(/quota/);
    expect(() => extractRows({ isError: true, message: "tool failed" })).toThrow(/tool failed/);
  });

  it("throws on null / non-conforming shapes", () => {
    expect(() => extractRows(null)).toThrow(/vide/);
    expect(() => extractRows(undefined)).toThrow(/vide/);
    expect(() => extractRows({ foo: 1 })).toThrow(/results\/data\/rows/);
    expect(() => extractRows("not json")).toThrow(/non-JSON/);
    expect(() => extractRows(42)).toThrow(/inattendu/);
    expect(() => extractRows([1, 2])).toThrow(/inattendue/);
    expect(() => extractRows([{ results: "nope" }])).toThrow(/results/);
  });
});
