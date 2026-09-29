import { describe, expect, it } from "vitest";

import { cellNumber, compareCells, matches, rowsFilterHandler, rowsLimitHandler, rowsSelectHandler, rowsSortHandler } from "@/lib/routines/steps/rows";
import type { Row, RowSet, StepContext, StepHandler, RoutineStep } from "@/lib/routines/types";

const rows: Row[] = [
  { id: "c1", nom: "Promo été", statut: "À créer", budget: "100", ctr: 1.2 },
  { id: "c2", nom: "Soldes", statut: "créée", budget: "9", ctr: 3.4 },
  { id: "c3", nom: "Rentrée", statut: "à créer ", budget: "12,5", ctr: null },
  { id: "c4", nom: "Noël", statut: "", budget: "", ctr: 0.4 },
];
const input = (): RowSet => ({ columns: ["id", "nom", "statut", "budget", "ctr"], rows: rows.map((r) => ({ ...r })), truncated: false });

function ctx(data: RowSet | null): StepContext {
  return {
    mode: "dry_run", runId: "run1", now: new Date("2026-09-29T08:00:00Z"), deadlineAt: Date.now() + 60_000,
    routine: { id: "r1", name: "Test", metaAccountId: null, googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20 },
    input: data, outputs: {}, write: null,
    claimItem: async () => { throw new Error("a transformation never claims"); },
    settleItem: async () => { throw new Error("a transformation never settles"); },
  };
}

async function run<S extends RoutineStep>(handler: StepHandler<S>, raw: unknown, data: RowSet | null = input()) {
  const checked = handler.validate(raw);
  if (!checked.ok) throw new Error(`refused: ${checked.error}`);
  return handler.run(checked.step, ctx(data));
}
const ids = (out: { output: { rows?: RowSet } }) => out.output.rows?.rows.map((r) => r.id);
const refusal = <S extends RoutineStep>(handler: StepHandler<S>, raw: unknown) => {
  const checked = handler.validate(raw);
  return checked.ok ? null : checked.error;
};

describe("routines — comparisons", () => {
  it("reads numbers as a Sheet writes them, and nothing looser", () => {
    expect(cellNumber(12)).toBe(12);
    expect(cellNumber("12")).toBe(12);
    expect(cellNumber(" 12,5 ")).toBe(12.5);
    expect(cellNumber("-3.25")).toBe(-3.25);
    for (const no of ["", "12 €", "1 000", "1e3", "0x10", "12.5.1", "abc", null, true, NaN, Infinity]) expect(cellNumber(no as never)).toBeNull();
  });

  it("compares as numbers when both sides are numbers, as text otherwise", () => {
    expect(compareCells("9", "100")).toBeLessThan(0);
    expect(compareCells(9, "100")).toBeLessThan(0);
    expect(compareCells("12,5", 12.5)).toBe(0);
    // One side is not a number: text, where "9" comes after "100 €" would be wrong — numeric collation keeps digits in order.
    expect(compareCells("b", "a")).toBeGreaterThan(0);
    expect(compareCells("Été", "été")).toBe(0);
    expect(compareCells("2026-09-01", "2026-10-01")).toBeLessThan(0);
  });

  it("applies each operator", () => {
    expect(matches("100", "gt", 9)).toBe(true);
    expect(matches("9", "gt", "100")).toBe(false);
    expect(matches("10", "gte", 10)).toBe(true);
    expect(matches("10", "lt", 10)).toBe(false);
    expect(matches("10", "lte", 10)).toBe(true);
    expect(matches("À créer", "eq", "à créer")).toBe(true);
    expect(matches("1.0", "eq", 1)).toBe(true);
    expect(matches("1.0", "neq", 1)).toBe(false);
    expect(matches("Promo été", "contains", "ÉTÉ")).toBe(true);
    expect(matches(true, "eq", "TRUE")).toBe(true);
    expect(matches("", "empty", undefined)).toBe(true);
    expect(matches("  ", "empty", undefined)).toBe(true);
    expect(matches(null, "not_empty", undefined)).toBe(false);
    expect(matches(0, "not_empty", undefined)).toBe(true);
    // An empty cell is not smaller than anything, and contains nothing.
    expect(matches("", "lt", 5)).toBe(false);
    expect(matches(null, "lte", 5)).toBe(false);
    expect(matches(null, "contains", "a")).toBe(false);
    expect(matches(null, "eq", "")).toBe(true);
    expect(matches(null, "neq", "x")).toBe(true);
  });
});

describe("routines — rows.filter", () => {
  it("keeps the rows that satisfy every condition", async () => {
    const out = await run(rowsFilterHandler, { id: "f", type: "rows.filter", where: [{ column: "statut", op: "eq", value: "à créer" }] });
    expect(out.status).toBe("ok");
    expect(ids(out)).toEqual(["c1", "c3"]);
    expect(out).toMatchObject({ rowsIn: 4, rowsOut: 2, planned: [], written: [] });
    expect(out.output.rows?.columns).toEqual(["id", "nom", "statut", "budget", "ctr"]);

    const both = await run(rowsFilterHandler, { id: "f", type: "rows.filter", where: [{ column: "statut", op: "not_empty" }, { column: "budget", op: "gte", value: 12 }] });
    expect(ids(both)).toEqual(["c1", "c3"]);
  });

  it("compares budgets as numbers, not as text", async () => {
    const out = await run(rowsFilterHandler, { id: "f", type: "rows.filter", where: [{ column: "budget", op: "gt", value: 10 }] });
    expect(ids(out)).toEqual(["c1", "c3"]);
  });

  it("does not touch its input", async () => {
    const data = input();
    await run(rowsFilterHandler, { id: "f", type: "rows.filter", where: [{ column: "id", op: "eq", value: "c1" }] }, data);
    expect(data).toEqual(input());
  });

  it("fails on a column that does not exist, and names those that do", async () => {
    const out = await run(rowsFilterHandler, { id: "f", type: "rows.filter", where: [{ column: "Statut", op: "eq", value: "x" }] });
    expect(out.status).toBe("failed");
    expect(out.error).toMatchObject({ class: "functional" });
    expect(out.error?.message).toContain("« Statut »");
    expect(out.error?.message).toContain("« statut »");
    expect(out.output).toEqual({});
  });

  it("fails without input", async () => {
    const out = await run(rowsFilterHandler, { id: "f", type: "rows.filter", where: [{ column: "a", op: "empty" }] }, null);
    expect(out).toMatchObject({ status: "failed", rowsIn: 0, error: { class: "functional" } });
  });

  it("refuses operators and shapes outside the closed list", () => {
    const base = { id: "f", type: "rows.filter" };
    expect(refusal(rowsFilterHandler, { ...base, where: [{ column: "a", op: "eq", value: 1 }] })).toBeNull();
    for (const bad of [
      { ...base }, { ...base, where: [] }, { ...base, where: "a = 1" },
      { ...base, where: [{ column: "a", op: "regex", value: ".*" }] },
      { ...base, where: [{ column: "a", op: "eval", value: "process.exit()" }] },
      { ...base, where: [{ column: "a", op: "eq" }] },
      { ...base, where: [{ column: "a", op: "eq", value: { $gt: 1 } }] },
      { ...base, where: [{ column: "a", op: "gt", value: "" }] },
      { ...base, where: [{ column: "a", op: "empty", value: "x" }] },
      { ...base, where: [{ column: "", op: "empty" }] },
      { ...base, where: [{ column: "a", op: "eq", value: 1, fn: "x" }] },
      { ...base, where: Array.from({ length: 11 }, () => ({ column: "a", op: "empty" })) },
      { ...base, where: [{ column: "a", op: "empty" }], expression: "a > 1" },
      { ...base, id: "bad id", where: [{ column: "a", op: "empty" }] },
      { ...base, type: "rows.sort", where: [{ column: "a", op: "empty" }] },
      null, "rows.filter", [],
    ]) expect(refusal(rowsFilterHandler, bad), JSON.stringify(bad)).toBeTypeOf("string");
  });

  it("rebuilds the step: what it returns holds its own fields only", () => {
    const checked = rowsFilterHandler.validate({ id: "f", type: "rows.filter", label: " Garder ", input: "lire", where: [{ column: " a ", op: "empty", value: null }] });
    expect(checked).toEqual({ ok: true, step: { id: "f", type: "rows.filter", label: "Garder", input: "lire", where: [{ column: "a", op: "empty" }] } });
  });
});

describe("routines — rows.sort", () => {
  it("sorts numbers as numbers, empty cells last in both directions", async () => {
    expect(ids(await run(rowsSortHandler, { id: "s", type: "rows.sort", by: "budget", dir: "asc" }))).toEqual(["c2", "c3", "c1", "c4"]);
    expect(ids(await run(rowsSortHandler, { id: "s", type: "rows.sort", by: "budget", dir: "desc" }))).toEqual(["c1", "c3", "c2", "c4"]);
    expect(ids(await run(rowsSortHandler, { id: "s", type: "rows.sort", by: "ctr", dir: "desc" }))).toEqual(["c2", "c1", "c4", "c3"]);
  });

  it("sorts text in French order and keeps the order of equal rows", async () => {
    expect(ids(await run(rowsSortHandler, { id: "s", type: "rows.sort", by: "nom", dir: "asc" }))).toEqual(["c4", "c1", "c3", "c2"]);
    const equal: RowSet = { columns: ["id", "g"], rows: [{ id: "a", g: 1 }, { id: "b", g: 1 }, { id: "c", g: 0 }, { id: "d", g: 1 }], truncated: true };
    const out = await run(rowsSortHandler, { id: "s", type: "rows.sort", by: "g", dir: "asc" }, equal);
    expect(ids(out)).toEqual(["c", "a", "b", "d"]);
    expect(out.output.rows?.truncated).toBe(true);
  });

  it("fails on an unknown column and refuses a bad direction", async () => {
    expect((await run(rowsSortHandler, { id: "s", type: "rows.sort", by: "absente", dir: "asc" })).status).toBe("failed");
    expect(refusal(rowsSortHandler, { id: "s", type: "rows.sort", by: "a", dir: "random" })).toBeTypeOf("string");
    expect(refusal(rowsSortHandler, { id: "s", type: "rows.sort", dir: "asc" })).toBeTypeOf("string");
    expect(refusal(rowsSortHandler, { id: "s", type: "rows.sort", by: "a", dir: "asc", comparator: "(a,b)=>0" })).toBeTypeOf("string");
  });
});

describe("routines — rows.limit", () => {
  it("keeps the first rows", async () => {
    const out = await run(rowsLimitHandler, { id: "l", type: "rows.limit", count: 2 });
    expect(ids(out)).toEqual(["c1", "c2"]);
    expect(out).toMatchObject({ rowsIn: 4, rowsOut: 2 });
    expect(ids(await run(rowsLimitHandler, { id: "l", type: "rows.limit", count: 10 }))).toHaveLength(4);
  });

  it("refuses a count that is not a positive integer", () => {
    for (const count of [0, -1, 1.5, "3", null, undefined, NaN, Infinity, 5001]) {
      expect(refusal(rowsLimitHandler, { id: "l", type: "rows.limit", count }), String(count)).toBeTypeOf("string");
    }
  });
});

describe("routines — rows.select", () => {
  it("keeps and renames columns, in the order asked", async () => {
    const out = await run(rowsSelectHandler, { id: "c", type: "rows.select", columns: [{ from: "nom", as: "Créa" }, { from: "id" }] });
    expect(out.output.rows?.columns).toEqual(["Créa", "id"]);
    expect(out.output.rows?.rows[0]).toEqual({ "Créa": "Promo été", id: "c1" });
    expect(Object.keys(out.output.rows!.rows[1])).toEqual(["Créa", "id"]);
  });

  it("fails on an unknown column", async () => {
    const out = await run(rowsSelectHandler, { id: "c", type: "rows.select", columns: [{ from: "id" }, { from: "prix" }, { from: "stock" }] });
    expect(out.status).toBe("failed");
    expect(out.error?.message).toMatch(/« prix », « stock »/);
  });

  it("refuses two columns under the same name, and unknown fields", () => {
    const base = { id: "c", type: "rows.select" };
    expect(refusal(rowsSelectHandler, { ...base, columns: [{ from: "a" }, { from: "b", as: "a" }] })).toMatch(/deux fois/);
    expect(refusal(rowsSelectHandler, { ...base, columns: [{ from: "a" }, { from: "a" }] })).toMatch(/deux fois/);
    expect(refusal(rowsSelectHandler, { ...base, columns: [] })).toBeTypeOf("string");
    expect(refusal(rowsSelectHandler, { ...base, columns: [{ from: "a", compute: "a*2" }] })).toBeTypeOf("string");
    expect(refusal(rowsSelectHandler, { ...base, columns: Array.from({ length: 51 }, (_, i) => ({ from: `c${i}` })) })).toBeTypeOf("string");
  });
});

describe("routines — transformations never write", () => {
  it("declare nothing to check and nothing written", async () => {
    for (const handler of [rowsFilterHandler, rowsSortHandler, rowsLimitHandler, rowsSelectHandler] as StepHandler[]) {
      expect(handler.writes).toBe("none");
      expect(await handler.preflight({ id: "x", type: handler.type } as RoutineStep, ctx(null).routine)).toEqual([]);
    }
  });
});
