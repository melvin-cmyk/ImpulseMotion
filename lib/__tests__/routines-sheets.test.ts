/**
 * Routines — Google Sheets from the application: lib/relay-sheets.ts and the
 * steps sheet.read and sheet.write.
 *
 * `fetch` is a stand-in for the relay, which runs the real code of
 * server/sheets-direct.mjs against a Sheet kept in memory: the whole chain is
 * exercised, and nothing leaves the machine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSheetsRequest } from "../../server/sheets-direct.mjs";
import { SheetsError, appendRows, readHeader, readSheet, sheetRefError, updateCells, writtenValue } from "@/lib/relay-sheets";
import { sheetReadHandler } from "@/lib/routines/steps/sheet-read";
import { planUpsert, sheetWriteHandler, toCell } from "@/lib/routines/steps/sheet-write";
import { mintWriteGuard } from "@/lib/routines/write-guard";
import type { Cell, RowSet, SheetReadStep, SheetWriteStep, StepContext, WriteGuard } from "@/lib/routines/types";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEFG";
const REF = { spreadsheetId: ID, tab: "Créas" };

// ── A Sheet in memory, behind a stand-in relay ───────────────────────────

let grid: Cell[][] = [];
let googleWrites: Array<{ url: string; body: unknown }> = [];
let relayCalls: string[] = [];
let relayDown: "no" | "refused" | "timeout" | "old" = "no";
let googleStatus: { status: number; json: unknown } | null = null;

const cellAt = (a1: string) => {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  const col = [...m[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  return { col, row: Number(m[2]) - 1 };
};

async function fakeGoogle(url: string, init: RequestInit): Promise<Response> {
  const answer = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status });
  if (googleStatus) return answer(googleStatus.json, googleStatus.status);
  const u = new URL(url);
  const tail = decodeURIComponent(u.pathname.split(`/${ID}/`)[1]);
  if (init.method === "GET") {
    const range = tail.replace(/^values\//, "");
    if (!range.startsWith("'Créas'!")) return answer({ error: { code: 400, message: `Unable to parse range: ${range}`, status: "INVALID_ARGUMENT" } }, 400);
    return answer({ values: range.endsWith("!1:1") ? grid.slice(0, 1) : grid });
  }
  const body = JSON.parse(String(init.body));
  googleWrites.push({ url, body });
  if (tail.endsWith(":append")) {
    grid.push(...(body.values as Cell[][]));
    return answer({ updates: { updatedRows: body.values.length, updatedRange: "x" } });
  }
  for (const d of body.data as Array<{ range: string; values: Cell[][] }>) {
    const { col, row } = cellAt(d.range.split("!")[1]);
    while (grid.length <= row) grid.push([]);
    grid[row][col] = d.values[0][0];
  }
  return answer({ totalUpdatedCells: body.data.length });
}

async function fakeRelay(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  relayCalls.push(url);
  if (relayDown === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  if (relayDown === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  if (relayDown === "old") return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  const action = /\/api\/sheets\/(\w+)$/.exec(url)?.[1] ?? "";
  const out = await handleSheetsRequest(action, JSON.parse(String(init?.body)), { getToken: async () => "jeton", fetch: fakeGoogle as unknown as typeof fetch });
  return new Response(JSON.stringify(out.json), { status: out.status });
}

const routine: StepContext["routine"] = { id: "r1", name: "Test", metaAccountId: null, googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20 };
function context(input: RowSet | null, write: WriteGuard | null, outputs: StepContext["outputs"] = {}): StepContext {
  return {
    mode: write ? "live" : "dry_run", routine, runId: "run1", now: new Date("2026-09-29T08:00:00Z"), deadlineAt: Date.now() + 60_000,
    input, outputs, write,
    claimItem: async () => { throw new Error("une étape Sheet ne réserve pas d'élément"); },
    settleItem: async () => { throw new Error("une étape Sheet ne solde pas d'élément"); },
  };
}
const rowset = (rows: RowSet["rows"]): RowSet => ({ columns: Object.keys(rows[0] ?? {}), rows, truncated: false });
const live = () => mintWriteGuard("live", "run1");

beforeEach(() => {
  grid = [
    ["ID", "Nom", "Statut", "Budget"],
    ["c1", "Promo été", "à faire", 1200.5],
    ["c2", "Rentrée", "à faire", 300],
  ];
  googleWrites = [];
  relayCalls = [];
  relayDown = "no";
  googleStatus = null;
  vi.stubGlobal("fetch", vi.fn(fakeRelay));
});
afterEach(() => { vi.unstubAllGlobals(); });

// ── lib/relay-sheets.ts ──────────────────────────────────────────────────

describe("relay-sheets — reading", () => {
  it("reads the rows by column name, with their row numbers", async () => {
    const data = await readSheet(REF, { maxRows: 10 });
    expect(data.columns).toEqual(["ID", "Nom", "Statut", "Budget"]);
    expect(data.rows[0]).toEqual({ ID: "c1", Nom: "Promo été", Statut: "à faire", Budget: 1200.5 });
    expect(data.rowNumbers).toEqual([2, 3]);
    expect(data.truncated).toBe(false);
    expect(await readHeader(REF)).toEqual(["ID", "Nom", "Statut", "Budget"]);
  });

  it("refuses an invalid document id or tab without calling the relay", async () => {
    for (const ref of [
      { spreadsheetId: `https://docs.google.com/spreadsheets/d/${ID}/edit`, tab: "Créas" },
      { spreadsheetId: `${ID}/../x`, tab: "Créas" }, { spreadsheetId: "court", tab: "Créas" },
      { spreadsheetId: ID, tab: "a/b" }, { spreadsheetId: ID, tab: "" },
    ]) {
      expect(sheetRefError(ref)).toBeTruthy();
      await expect(readSheet(ref)).rejects.toMatchObject({ errorClass: "functional" });
      await expect(appendRows(live(), ref, ["Nom"], [["a"]])).rejects.toMatchObject({ errorClass: "functional" });
    }
    expect(relayCalls).toEqual([]);
  });

  it("tells a functional error from an infrastructure failure", async () => {
    await expect(readSheet({ spreadsheetId: ID, tab: "Absent" })).rejects.toMatchObject({ errorClass: "functional", message: expect.stringContaining("Onglet introuvable : « Absent »") });

    googleStatus = { status: 403, json: { error: { message: "The caller does not have permission", status: "PERMISSION_DENIED" } } };
    await expect(readSheet(REF)).rejects.toMatchObject({ errorClass: "functional", message: expect.stringContaining("data@impulse-analytics.com") });
    googleStatus = { status: 503, json: { error: { message: "backend error" } } };
    await expect(readSheet(REF)).rejects.toMatchObject({ errorClass: "infra" });
    googleStatus = null;

    relayDown = "refused";
    await expect(readSheet(REF)).rejects.toMatchObject({ errorClass: "infra", message: expect.stringContaining("Relay injoignable") });
    relayDown = "old";
    const old = await readSheet(REF).catch((e: unknown) => e);
    expect(old).toBeInstanceOf(SheetsError);
    expect(old).toMatchObject({ errorClass: "infra", message: expect.stringContaining("Relay pas à jour") });
  });
});

describe("relay-sheets — writing", () => {
  it("refuses to write without a guard minted by the engine, before any call", async () => {
    const fakes = [null, undefined, {}, { runId: "run1" }, { ...live() }, "run1"] as unknown as WriteGuard[];
    for (const fake of fakes) {
      await expect(appendRows(fake, REF, ["Nom"], [["a"]])).rejects.toThrow(/Écriture refusée/);
      await expect(updateCells(fake, REF, [{ row: 2, column: "Nom", value: "a" }])).rejects.toThrow(/Écriture refusée/);
    }
    expect(relayCalls).toEqual([]);
    expect(googleWrites).toEqual([]);
  });

  it("appends and updates by column name, formulas neutralised on the way", async () => {
    await appendRows(live(), REF, ["Nom", "ID"], [["=IMPORTDATA(\"http://x\")", "c3"]]);
    expect(grid[3]).toEqual(["c3", "'=IMPORTDATA(\"http://x\")"]);
    await updateCells(live(), REF, [{ row: 2, column: "Statut", value: "@tous" }, { row: 3, column: "Budget", value: -5 }]);
    expect(grid[1][2]).toBe("'@tous");
    expect(grid[2][3]).toBe(-5);
    expect(googleWrites.every((w) => /valueInputOption=RAW/.test(w.url) || (w.body as { valueInputOption?: string }).valueInputOption === "RAW")).toBe(true);
    expect(writtenValue("=1+1")).toBe("'=1+1");
    expect(writtenValue(-5)).toBe(-5);
  });

  it("refuses an unknown column and writes nothing", async () => {
    await expect(appendRows(live(), REF, ["Nom", "Inconnue"], [["a", "b"]])).rejects.toMatchObject({ errorClass: "functional", message: expect.stringContaining("Colonne inconnue : « Inconnue »") });
    await expect(updateCells(live(), REF, [{ row: 2, column: "Inconnue", value: "x" }])).rejects.toMatchObject({ errorClass: "functional" });
    expect(googleWrites).toEqual([]);
  });

  it("does not replay on another relay a write whose answer was lost", async () => {
    relayDown = "timeout";
    await expect(appendRows(live(), REF, ["Nom"], [["a"]])).rejects.toMatchObject({ errorClass: "infra", message: expect.stringContaining("a pu être appliquée") });
    expect(relayCalls).toHaveLength(1);
  });
});

// ── sheet.read ───────────────────────────────────────────────────────────

describe("sheet.read", () => {
  const step: SheetReadStep = { id: "lire", type: "sheet.read", sheet: REF, requiredColumns: ["ID", "Nom"] };

  it("validates the shape and rebuilds the step", () => {
    expect(sheetReadHandler.validate({ ...step, maxRows: 50 })).toEqual({ ok: true, step: { ...step, maxRows: 50 } });
    for (const bad of [
      { ...step, sheet: { spreadsheetId: "https://docs.google.com/spreadsheets/d/x", tab: "A" } },
      { ...step, sheet: { ...REF, range: "A1:B2" } },
      { ...step, requiredColumns: "ID" }, { ...step, requiredColumns: [""] }, { ...step, requiredColumns: [3] },
      { ...step, maxRows: 0 }, { ...step, maxRows: 5001 }, { ...step, maxRows: "10" },
      { ...step, url: "https://x" }, { ...step, id: "1 mauvais" }, { ...step, type: "sheet.write" }, null, "x",
    ]) expect(sheetReadHandler.validate(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("checks the required columns against the real header at preflight", async () => {
    expect(await sheetReadHandler.preflight(step, routine)).toEqual([]);
    const issues = await sheetReadHandler.preflight({ ...step, requiredColumns: ["ID", "Lien média", "Texte"] }, routine);
    expect(issues).toEqual([{ stepId: "lire", severity: "error", message: "colonnes absentes de l'onglet « Créas » : « Lien média », « Texte »" }]);
    expect((await sheetReadHandler.preflight({ ...step, sheet: { spreadsheetId: ID, tab: "Absent" } }, routine))[0]).toMatchObject({ severity: "error", message: expect.stringContaining("Onglet introuvable") });
    relayDown = "refused";
    expect((await sheetReadHandler.preflight(step, routine))[0]).toMatchObject({ severity: "error", message: expect.stringContaining("vérification impossible") });
  });

  it("returns the rows", async () => {
    const out = await sheetReadHandler.run(step, context(null, null));
    expect(out).toMatchObject({ status: "ok", rowsIn: 0, rowsOut: 2, planned: [], written: [] });
    expect(out.output.rows).toEqual({ columns: ["ID", "Nom", "Statut", "Budget"], truncated: false, rows: [
      { ID: "c1", Nom: "Promo été", Statut: "à faire", Budget: 1200.5 }, { ID: "c2", Nom: "Rentrée", Statut: "à faire", Budget: 300 },
    ] });
  });

  it("fails functionally when a required column has gone, at run time too", async () => {
    grid[0][1] = "Nom de la créa";
    const out = await sheetReadHandler.run(step, context(null, live()));
    expect(out).toMatchObject({ status: "failed", rowsOut: 0, output: {}, written: [], error: { class: "functional", message: "colonne absente de l'onglet « Créas » : « Nom »" } });
    expect(googleWrites).toEqual([]);
  });

  it("says when the tab holds more than what was read, and classes a relay failure as infra", async () => {
    const out = await sheetReadHandler.run({ ...step, maxRows: 1 }, context(null, null));
    expect(out.output.rows?.truncated).toBe(true);
    expect(out.rowsOut).toBe(1);
    expect(out.warnings.join(" ")).toContain("plus de 1 lignes");
    relayDown = "refused";
    expect(await sheetReadHandler.run(step, context(null, null))).toMatchObject({ status: "failed", error: { class: "infra" } });
  });
});

// ── sheet.write ──────────────────────────────────────────────────────────

describe("sheet.write", () => {
  const append: SheetWriteStep = {
    id: "ecrire", type: "sheet.write", sheet: REF, mode: "append",
    columns: [{ column: "ID", value: "{{row.id}}" }, { column: "Nom", value: "{{row.nom}}" }, { column: "Budget", value: "{{row.budget}}" }],
  };
  const upsert: SheetWriteStep = {
    id: "maj", type: "sheet.write", sheet: REF, mode: "upsert", keyColumn: "ID",
    columns: [{ column: "ID", value: "{{row.id}}" }, { column: "Statut", value: "{{row.statut}} le {{run.date}}" }],
  };

  it("validates the shape", () => {
    expect(sheetWriteHandler.validate(append)).toEqual({ ok: true, step: append });
    expect(sheetWriteHandler.validate(upsert)).toEqual({ ok: true, step: upsert });
    for (const bad of [
      { ...append, mode: "replace" }, { ...append, mode: "clear" }, { ...append, columns: [] },
      { ...append, columns: [{ column: "ID", value: "{{row.id | upper}}" }] },
      { ...append, columns: [{ column: "ID", value: "{{env.SECRET}}" }] },
      { ...append, columns: [{ column: "ID", value: "a" }, { column: "ID", value: "b" }] },
      { ...append, columns: [{ column: "ID", value: "a", formula: true }] },
      { ...append, keyColumn: "ID" },
      { ...upsert, keyColumn: undefined }, { ...upsert, keyColumn: "Nom" },
      { ...append, sheet: { spreadsheetId: "x", tab: "A" } }, { ...append, valueInputOption: "USER_ENTERED" },
    ]) expect(sheetWriteHandler.validate(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("checks the written columns against the real header at preflight", async () => {
    expect(await sheetWriteHandler.preflight(append, routine)).toEqual([]);
    const issues = await sheetWriteHandler.preflight({ ...append, columns: [...append.columns, { column: "ID pub", value: "x" }] }, routine);
    expect(issues).toEqual([{ stepId: "ecrire", severity: "error", message: "colonne inconnue dans l'onglet « Créas » : « ID pub »" }]);
  });

  it("writes plain numbers as numbers and the rest as text", () => {
    expect([toCell("12.5"), toCell("-3"), toCell("0"), toCell(" 42 ")]).toEqual([12.5, -3, 0, 42]);
    for (const text of ["0123", "+33612345678", "1e5", "12,5", "120210000000000000", "=1+1", "1 200", "0x10"]) expect(toCell(text)).toBe(text);
    expect(toCell("  ")).toBeNull();
  });

  it("dry run: writes nothing and lists every write with the values as they would land", async () => {
    const input = rowset([{ id: "c3", nom: "=HYPERLINK(\"http://x\")", budget: -12.5 }, { id: "c4", nom: "Noël", budget: null }]);
    const before = JSON.stringify(grid);
    const out = await sheetWriteHandler.run(append, context(input, null));
    expect(out).toMatchObject({ status: "ok", rowsIn: 2, rowsOut: 0, written: [] });
    expect(out.planned).toEqual([
      { target: "sheet", summary: "Ajout d'une ligne dans « Créas »", preview: { ID: "c3", Nom: "'=HYPERLINK(\"http://x\")", Budget: -12.5 } },
      { target: "sheet", summary: "Ajout d'une ligne dans « Créas »", preview: { ID: "c4", Nom: "Noël", Budget: null } },
    ]);
    expect(googleWrites).toEqual([]);
    expect(JSON.stringify(grid)).toBe(before);
    expect(relayCalls.every((u) => u.endsWith("/api/sheets/read"))).toBe(true);
  });

  it("live: appends one row per input row, in one call", async () => {
    const out = await sheetWriteHandler.run(append, context(rowset([{ id: "c3", nom: "+promo", budget: 10 }, { id: "c4", nom: "Noël", budget: 20 }]), live()));
    expect(out).toMatchObject({ status: "ok", rowsIn: 2, rowsOut: 2 });
    expect(out.written).toHaveLength(2);
    // What would be written is the business of a dry run; a live run says what it did, counted the same way.
    expect(out.planned).toEqual([]);
    expect(out.counts).toEqual({ sheetRows: 2 });
    expect(googleWrites).toHaveLength(1);
    expect(grid.slice(3)).toEqual([["c3", "'+promo", "", 10], ["c4", "Noël", "", 20]]);
  });

  it("upsert: rewrites the row that holds the key, adds the row whose key is absent", async () => {
    const input = rowset([{ id: "c2", statut: "créée" }, { id: "c9", statut: "créée" }]);
    const dry = await sheetWriteHandler.run(upsert, context(input, null));
    expect(dry.planned).toEqual([
      { target: "sheet", summary: "Mise à jour de la ligne 3 de « Créas »", itemKey: "c2", preview: { ID: "c2", Statut: "créée le 2026-09-29" } },
      { target: "sheet", summary: "Ajout d'une ligne dans « Créas »", itemKey: "c9", preview: { ID: "c9", Statut: "créée le 2026-09-29" } },
    ]);
    expect(googleWrites).toEqual([]);

    const out = await sheetWriteHandler.run(upsert, context(input, live()));
    expect(out).toMatchObject({ status: "ok", rowsOut: 2 });
    expect(out.written.map((w) => w.itemKey)).toEqual(["c2", "c9"]);
    expect(grid[2]).toEqual(["c2", "Rentrée", "créée le 2026-09-29", 300]);
    expect(grid[1]).toEqual(["c1", "Promo été", "à faire", 1200.5]);
    expect(grid[3]).toEqual(["c9", "", "créée le 2026-09-29"]);
    // The key cell of an existing row is not rewritten.
    const updated = googleWrites.flatMap((w) => ((w.body as { data?: Array<{ range: string }> }).data ?? []).map((d) => d.range));
    expect(updated).toEqual(["'Créas'!C3"]);
  });

  it("upsert: a key present twice in the Sheet stops the step before any write", async () => {
    grid.push(["c2", "Doublon", "à faire", 1]);
    const out = await sheetWriteHandler.run(upsert, context(rowset([{ id: "c1", statut: "ok" }, { id: "c2", statut: "ok" }]), live()));
    expect(out).toMatchObject({ status: "failed", written: [], error: { class: "functional", message: expect.stringContaining("clé en double dans le Sheet : « c2 » aux lignes 3, 4") } });
    expect(googleWrites).toEqual([]);
  });

  it("upsert: an empty key, or a key carried by two input rows, stops the step too", async () => {
    const twice = await sheetWriteHandler.run(upsert, context(rowset([{ id: "c1", statut: "a" }, { id: "c1", statut: "b" }]), live()));
    expect(twice.error).toMatchObject({ class: "functional", message: expect.stringContaining("clé en double dans les lignes à écrire") });
    const empty = await sheetWriteHandler.run(upsert, context(rowset([{ id: null, statut: "a" }]), live()));
    expect(empty.error).toMatchObject({ class: "functional", message: expect.stringContaining("clé vide") });
    expect(googleWrites).toEqual([]);
    expect(planUpsert([{ key: "12", values: [] }], [{ key: "12", row: 2 }, { key: "", row: 3 }, { key: "", row: 4 }])).toEqual({ appends: [], updates: [{ row: 2, prepared: { key: "12", values: [] } }] });
  });

  it("fails without writing when a column is missing, in the rows or in the tab", async () => {
    const noColumn = await sheetWriteHandler.run(append, context(rowset([{ id: "c3", nom: "x" }]), live()));
    expect(noColumn.error).toMatchObject({ class: "functional", message: expect.stringContaining("« budget » absente des lignes reçues") });
    grid[0][3] = "Montant";
    const renamed = await sheetWriteHandler.run(append, context(rowset([{ id: "c3", nom: "x", budget: 1 }]), live()));
    expect(renamed.error).toMatchObject({ class: "functional", message: expect.stringContaining("colonne inconnue dans l'onglet « Créas » : « Budget »") });
    expect(googleWrites).toEqual([]);
  });

  it("writes one row when it is given no input, nothing when the input is empty, and refuses too many rows", async () => {
    const log: SheetWriteStep = { ...append, columns: [{ column: "ID", value: "{{run.date}}" }, { column: "Nom", value: "{{steps.resume.text}}" }] };
    const one = await sheetWriteHandler.run(log, context(null, live(), { resume: { text: "Tout va bien" } }));
    expect(one).toMatchObject({ status: "ok", rowsOut: 1 });
    expect(grid[3]).toEqual(["2026-09-29", "Tout va bien"]);

    const none = await sheetWriteHandler.run(append, context({ columns: ["id"], rows: [], truncated: false }, live()));
    expect(none).toMatchObject({ status: "ok", rowsOut: 0, planned: [], written: [] });

    const many = rowset(Array.from({ length: 501 }, (_, i) => ({ id: `k${i}`, nom: "n", budget: 1 })));
    expect((await sheetWriteHandler.run(append, context(many, live()))).error).toMatchObject({ class: "functional" });
    expect(googleWrites).toHaveLength(1);
  });

  it("a cell that looks like a template is written as it is", async () => {
    await sheetWriteHandler.run(append, context(rowset([{ id: "c3", nom: "{{steps.x.text}} {{row.id}}", budget: 1 }]), live()));
    expect(grid[3][1]).toBe("{{steps.x.text}} {{row.id}}");
  });

  it("classes a relay failure as infra", async () => {
    relayDown = "refused";
    expect(await sheetWriteHandler.run(append, context(rowset([{ id: "c3", nom: "x", budget: 1 }]), live()))).toMatchObject({ status: "failed", error: { class: "infra" }, written: [] });
  });
});
