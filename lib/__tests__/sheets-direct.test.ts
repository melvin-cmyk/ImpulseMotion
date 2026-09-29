/**
 * server/sheets-direct.mjs — what the relay does for /api/sheets/*: validation,
 * values read and written, formula neutralisation, Google's errors in plain
 * words. Google is a stand-in (`fetch` injected), nothing leaves the machine.
 */

import { describe, expect, it } from "vitest";
import {
  buildAppendValues, buildUpdateData, cellToWrite, columnLetter, explainGoogleError, handleSheetsRequest,
  neutralizeFormula, parseHeader, quoteTab, toRowSet, validateSpreadsheetId, validateTab,
} from "../../server/sheets-direct.mjs";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEFG";

interface Call { method: string; url: string; body: unknown }
function google(answers: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : null });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
  };
  return { calls, deps: { getToken: async () => "jeton-de-test", fetch: fetchImpl as unknown as typeof fetch } };
}

describe("sheets-direct — validation", () => {
  it("accepts a document id and nothing that looks like an address or a path", () => {
    expect(validateSpreadsheetId(ID)).toBe(ID);
    for (const bad of [
      `https://docs.google.com/spreadsheets/d/${ID}/edit`, `${ID}/values/A1`, `../${ID}`, `${ID}?alt=media`, `${ID}#gid=0`,
      "court", "", null, undefined, 42, { id: ID }, `${ID} `, `${ID}%2F..`, "a".repeat(101),
    ]) expect(() => validateSpreadsheetId(bad), String(bad)).toThrow(/Identifiant de document invalide/);
  });

  it("accepts a tab name and refuses what Sheets refuses, or what would leave the tab", () => {
    expect(validateTab(" Suivi créas 2026 ")).toBe("Suivi créas 2026");
    expect(validateTab("L'onglet")).toBe("L'onglet");
    for (const bad of ["", "   ", "a/b", "a\\b", "Feuille!A1:B2".replace("!", ":"), "a[1]", "a*", "a?", "'a", "a'", "a\nb", "x".repeat(101), null, 3]) {
      expect(() => validateTab(bad), String(bad)).toThrow(/onglet invalide/);
    }
  });

  it("quotes a tab and names the columns", () => {
    expect(quoteTab("L'onglet")).toBe("'L''onglet'");
    expect([0, 25, 26, 27, 701].map(columnLetter)).toEqual(["A", "Z", "AA", "AB", "ZZ"]);
    expect(() => columnLetter(702)).toThrow();
    expect(() => columnLetter(-1)).toThrow();
  });
});

describe("sheets-direct — formula neutralisation", () => {
  it("puts an apostrophe before = + - @, leading spaces and control characters included", () => {
    expect(neutralizeFormula("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(neutralizeFormula("+33612345678")).toBe("'+33612345678");
    expect(neutralizeFormula("-1+cmd|' /C calc'!A0")).toBe("'-1+cmd|' /C calc'!A0");
    expect(neutralizeFormula("@IMPORTXML(\"http://x\")")).toBe("'@IMPORTXML(\"http://x\")");
    expect(neutralizeFormula("  =HYPERLINK(\"http://x\")")).toBe("'  =HYPERLINK(\"http://x\")");
    expect(neutralizeFormula("\t=1+1")).toBe("'\t=1+1");
    expect(neutralizeFormula("\r=1+1")).toBe("'\r=1+1");
  });

  it("leaves the rest alone, and is harmless twice", () => {
    for (const plain of ["Promo été", "a=b", "12,5 %", "", "'=déjà neutralisé"]) expect(neutralizeFormula(plain)).toBe(plain);
    expect(neutralizeFormula(neutralizeFormula("=1+1"))).toBe("'=1+1");
  });

  it("writes numbers and booleans as they are, null as an empty cell", () => {
    expect([cellToWrite(-12.5), cellToWrite(0), cellToWrite(true), cellToWrite(null), cellToWrite("=A1")]).toEqual([-12.5, 0, true, "", "'=A1"]);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, {}, ["=A1"], "x".repeat(50_001)]) expect(() => cellToWrite(bad)).toThrow();
  });
});

describe("sheets-direct — reading", () => {
  it("reads the header, skips empty header cells and keeps the first of a name present twice", () => {
    const h = parseHeader([" Nom ", "", "Budget", "Nom", null, "Statut"]);
    expect(h.columns).toEqual(["Nom", "Budget", "Statut"]);
    expect(h.indexOf.get("Budget")).toBe(2);
    expect(h.duplicates).toEqual(["Nom"]);
  });

  it("returns rows by column name with their sheet row number, empty rows skipped", () => {
    const out = toRowSet([["Nom", "Budget", "Début"], ["A", 1234.5, "29/09/2026"], [], ["", "", ""], ["B", "", true]], 10);
    expect(out.columns).toEqual(["Nom", "Budget", "Début"]);
    expect(out.rows).toEqual([{ Nom: "A", Budget: 1234.5, "Début": "29/09/2026" }, { Nom: "B", Budget: null, "Début": true }]);
    expect(out.rowNumbers).toEqual([2, 5]);
    expect(out.truncated).toBe(false);
  });

  it("caps the rows and says so", () => {
    const out = toRowSet([["n"], [1], [2], [3]], 2);
    expect(out.rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect(out.truncated).toBe(true);
  });

  it("refuses a tab without header", () => {
    expect(() => toRowSet([], 10)).toThrow(/En-tête introuvable/);
    expect(() => toRowSet([["", ""]], 10)).toThrow(/En-tête introuvable/);
  });

  it("asks Google for raw numbers and displayed dates, one row more than the cap", async () => {
    const g = google([{ json: { values: [["Nom"], ["A"], ["B"], ["C"]] } }]);
    const out = await handleSheetsRequest("read", { spreadsheetId: ID, tab: "Créas", maxRows: 2 }, g.deps);
    expect(out.status).toBe(200);
    expect(out.json.result).toMatchObject({ columns: ["Nom"], rows: [{ Nom: "A" }, { Nom: "B" }], truncated: true });
    expect(g.calls).toHaveLength(1);
    const url = new URL(g.calls[0].url);
    expect(url.origin + url.pathname).toBe(`https://sheets.googleapis.com/v4/spreadsheets/${ID}/values/${encodeURIComponent("'Créas'!A1:ZZ4")}`);
    expect(url.searchParams.get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
    expect(url.searchParams.get("dateTimeRenderOption")).toBe("FORMATTED_STRING");
    expect(g.calls[0].method).toBe("GET");
  });

  it("never calls Google for an invalid document or tab", async () => {
    const g = google([{ json: {} }]);
    for (const body of [{ spreadsheetId: "https://evil.example/x", tab: "A" }, { spreadsheetId: `${ID}/../x`, tab: "A" }, { spreadsheetId: ID, tab: "a/b" }, { spreadsheetId: ID }, null, []]) {
      const out = await handleSheetsRequest("read", body, g.deps);
      expect(out.status).toBe(400);
      expect(out.json.class).toBe("functional");
    }
    expect((await handleSheetsRequest("clear", { spreadsheetId: ID, tab: "A" }, g.deps)).status).toBe(404);
    expect((await handleSheetsRequest("constructor", { spreadsheetId: ID, tab: "A" }, g.deps)).status).toBe(404);
    expect(g.calls).toHaveLength(0);
  });
});

describe("sheets-direct — writing", () => {
  const header = ["Nom", "Statut", "", "ID pub"];

  it("lays the appended rows on the header, neutralised", () => {
    expect(buildAppendValues(header, ["ID pub", "Nom"], [["123", "=HYPERLINK(1)"], [null, "B"]])).toEqual([
      ["'=HYPERLINK(1)", "", "", "123"],
      ["B", "", "", ""],
    ]);
  });

  it("refuses an unknown or ambiguous column, and a row of the wrong width", () => {
    expect(() => buildAppendValues(header, ["Nom", "Inconnue"], [["a", "b"]])).toThrow(/Colonne inconnue : « Inconnue »/);
    expect(() => buildAppendValues(["Nom", "Nom"], ["Nom"], [["a"]])).toThrow(/Colonne ambiguë/);
    expect(() => buildAppendValues(header, ["Nom"], [["a", "b"]])).toThrow(/une valeur par colonne/);
    expect(() => buildAppendValues(header, ["Nom", "Nom"], [["a", "b"]])).toThrow(/deux fois/);
    expect(() => buildAppendValues(header, ["Nom"], [])).toThrow();
    expect(() => buildAppendValues(header, ["__proto__"], [["a"]])).toThrow(/Colonne inconnue/);
  });

  it("names each updated cell, never the header row", () => {
    expect(buildUpdateData(header, "L'onglet", [{ row: 5, column: "Statut", value: "+créée" }, { row: 12, column: "ID pub", value: 42 }])).toEqual([
      { range: "'L''onglet'!B5", values: [["'+créée"]] },
      { range: "'L''onglet'!D12", values: [[42]] },
    ]);
    for (const row of [1, 0, -3, 2.5, "x", null]) expect(() => buildUpdateData(header, "A", [{ row, column: "Nom", value: "a" }])).toThrow(/Numéro de ligne invalide/);
    expect(() => buildUpdateData(header, "A", [{ row: 2, column: "Absente", value: "a" }])).toThrow(/Colonne inconnue/);
    expect(() => buildUpdateData(header, "A", [{ row: 2, column: "Nom", value: "a" }, { row: 2, column: "Nom", value: "b" }])).toThrow(/deux fois/);
  });

  it("appends with RAW after reading the header", async () => {
    const g = google([{ json: { values: [header] } }, { json: { updates: { updatedRows: 1, updatedRange: "'Créas'!A9:D9" } } }]);
    const out = await handleSheetsRequest("append", { spreadsheetId: ID, tab: "Créas", columns: ["Nom"], rows: [["@mention"]] }, g.deps);
    expect(out).toEqual({ status: 200, json: { result: { appendedRows: 1, updatedRange: "'Créas'!A9:D9" } } });
    expect(g.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(g.calls[1].url).toContain(":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS");
    expect(g.calls[1].url).not.toContain("USER_ENTERED");
    expect(g.calls[1].body).toEqual({ majorDimension: "ROWS", values: [["'@mention"]] });
  });

  it("updates with RAW, and writes nothing when one column is unknown", async () => {
    const g = google([{ json: { values: [header] } }, { json: { totalUpdatedCells: 1 } }]);
    const out = await handleSheetsRequest("update", { spreadsheetId: ID, tab: "Créas", updates: [{ row: 3, column: "Statut", value: "=1+1" }] }, g.deps);
    expect(out.json.result).toEqual({ updatedCells: 1 });
    expect(g.calls[1].url).toBe(`https://sheets.googleapis.com/v4/spreadsheets/${ID}/values:batchUpdate`);
    expect(g.calls[1].body).toMatchObject({ valueInputOption: "RAW", data: [{ range: "'Créas'!B3", values: [["'=1+1"]] }] });

    const h = google([{ json: { values: [header] } }]);
    const refused = await handleSheetsRequest("update", { spreadsheetId: ID, tab: "Créas", updates: [{ row: 3, column: "Statut", value: "ok" }, { row: 3, column: "Inconnue", value: "x" }] }, h.deps);
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({ class: "functional" });
    expect(h.calls.map((c) => c.method)).toEqual(["GET"]);
  });
});

describe("sheets-direct — Google's errors in plain words", () => {
  const err = (status: number, message = "", extra: Record<string, unknown> = {}) => explainGoogleError(status, { error: { message, ...extra } }, { tab: "Créas" });

  it("tells a document that is not shared from a missing tab", () => {
    expect(err(403, "The caller does not have permission").message).toMatch(/non partagé avec data@impulse-analytics\.com/);
    expect(err(403).errorClass).toBe("functional");
    expect(explainGoogleError(403, { error: { message: "The caller does not have permission" } }, { tab: "Créas", write: true }).message).toMatch(/partagé en éditeur avec data@impulse-analytics\.com/);
    expect(err(404, "Requested entity was not found.").message).toMatch(/Document introuvable/);
    expect(err(400, "Unable to parse range: 'Créas'!A1:ZZ1002").message).toBe("Onglet introuvable : « Créas » n'existe pas dans ce document (vérifier le nom exact, accents et espaces compris).");
    expect(err(400, "This operation is not supported for this document").message).toMatch(/n'est pas un Google Sheet/);
  });

  it("classes token, scope, quota and outages as infrastructure", () => {
    expect(err(401).errorClass).toBe("infra");
    expect(err(403, "Request had insufficient authentication scopes.", { details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] })).toMatchObject({ errorClass: "infra" });
    expect(err(429).errorClass).toBe("infra");
    expect(err(503).errorClass).toBe("infra");
  });

  it("answers through the route with the class, and with infra when the token cannot be had", async () => {
    const g = google([{ status: 403, json: { error: { message: "The caller does not have permission", status: "PERMISSION_DENIED" } } }]);
    const out = await handleSheetsRequest("read", { spreadsheetId: ID, tab: "Créas" }, g.deps);
    expect(out.status).toBe(422);
    expect(out.json).toMatchObject({ class: "functional", error: expect.stringContaining("data@impulse-analytics.com") });

    const down = await handleSheetsRequest("read", { spreadsheetId: ID, tab: "Créas" }, { getToken: async () => { throw new Error("OAuth Google refusé (HTTP 400)"); }, fetch: g.deps.fetch });
    expect(down.status).toBe(502);
    expect(down.json).toMatchObject({ class: "infra", error: expect.stringContaining("OAuth Google refusé") });
  });
});
