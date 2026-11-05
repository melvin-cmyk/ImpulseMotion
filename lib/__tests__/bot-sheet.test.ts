import { describe, it, expect } from "vitest";
import { parseCell, sheetName, toSheetTable, SHEET_MAX_ROWS } from "@/lib/bot-sheet";

describe("parseCell — chiffres du chat → nombres Sheets", () => {
  it("montants et volumes au format français", () => {
    expect(parseCell("1 982 970")).toBe(1982970);
    expect(parseCell("10 373 €")).toBe(10373);
    expect(parseCell("63,64 €")).toBe(63.64);
    expect(parseCell("−14")).toBe(-14);
    expect(parseCell("5,22")).toBe(5.22);
  });
  it("le reste reste du texte", () => {
    expect(parseCell("1,2 %")).toBe("1,2 %");
    expect(parseCell("+98 %")).toBe("+98 %");
    expect(parseCell("Impressions")).toBe("Impressions");
    expect(parseCell("29/10")).toBe("29/10");
    expect(parseCell("—")).toBe("—");
    expect(parseCell("")).toBeNull();
  });
});

describe("toSheetTable", () => {
  it("convertit un tableau propre", () => {
    const t = toSheetTable({ columns: ["Indicateur", "7 jours"], rows: [["Impressions", "1 982 970"], ["ROAS", "5,22"]] });
    expect(t).toEqual({ columns: ["Indicateur", "7 jours"], rows: [["Impressions", 1982970], ["ROAS", 5.22]] });
  });
  it("refuse un tableau vide ou trop long", () => {
    expect(toSheetTable({ columns: [], rows: [] })).toBeNull();
    expect(toSheetTable({ columns: ["a"], rows: Array.from({ length: SHEET_MAX_ROWS + 1 }, () => ["x"]) })).toBeNull();
    expect(toSheetTable({ columns: "a", rows: [] })).toBeNull();
  });
});

describe("sheetName", () => {
  it("unique par export, date de Paris", () => {
    expect(sheetName("Chiffres Meta 7 jours", new Date("2026-11-05T13:32:00Z"))).toBe("Chiffres Meta 7 jours – 05/11/2026 14:32");
  });
});
