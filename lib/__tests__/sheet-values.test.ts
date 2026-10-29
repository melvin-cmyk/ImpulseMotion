/**
 * lib/sheet-values + lib/xlsx — Mo's « Mets ça dans un Google Sheet »: the
 * French display strings become numbers with the unit in the header, and the
 * file sent to Drive is an .xlsx whose cells carry their type.
 */

import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { headerWithUnit, isEmptyDisplay, parseDisplayNumber, typeKpiSheet, typeSheetColumns } from "@/lib/sheet-values";
import { columnName, crc32, safeSheetName, toXlsx, worksheetXml, xmlEscape, zipStored } from "@/lib/xlsx";
import { sheetValuesOf } from "@/lib/mo/act";
import type { MoCard } from "@/lib/mo/model";

describe("parseDisplayNumber", () => {
  it("reads the French formats with their unit", () => {
    expect(parseDisplayNumber("1 245,30 €")).toEqual({ value: 1245.3, unit: "€" });
    expect(parseDisplayNumber("1 245,30 €")).toEqual({ value: 1245.3, unit: "€" });
    expect(parseDisplayNumber("3,2 %")).toEqual({ value: 3.2, unit: "%" });
    expect(parseDisplayNumber("12,40 $")).toEqual({ value: 12.4, unit: "$" });
    expect(parseDisplayNumber("2,1 x")).toEqual({ value: 2.1, unit: "x" });
    expect(parseDisplayNumber("2,1×")).toEqual({ value: 2.1, unit: "x" });
    expect(parseDisplayNumber("-8 %")).toEqual({ value: -8, unit: "%" });
    expect(parseDisplayNumber("−8 %")).toEqual({ value: -8, unit: "%" });
    expect(parseDisplayNumber("+12 %")).toEqual({ value: 12, unit: "%" });
    expect(parseDisplayNumber("+3 pts")).toEqual({ value: 3, unit: "pts" });
    expect(parseDisplayNumber("140")).toEqual({ value: 140, unit: null });
    expect(parseDisplayNumber("1,2 k€")).toEqual({ value: 1200, unit: "€" });
    expect(parseDisplayNumber("3,4 M€")).toEqual({ value: 3400000, unit: "€" });
    expect(parseDisplayNumber("12 EUR")).toEqual({ value: 12, unit: "€" });
  });
  it("reads English and raw formats too", () => {
    expect(parseDisplayNumber("1,245.30")).toEqual({ value: 1245.3, unit: null });
    expect(parseDisplayNumber("1.245,30 €")).toEqual({ value: 1245.3, unit: "€" });
    expect(parseDisplayNumber("$12.40")).toEqual({ value: 12.4, unit: "$" });
    expect(parseDisplayNumber("1245.3")).toEqual({ value: 1245.3, unit: null });
    expect(parseDisplayNumber("1.245.300")).toEqual({ value: 1245300, unit: null });
  });
  it("refuses what is not a number", () => {
    for (const s of ["Prospection", "29/10/2026", "2026-10-29", "12:30", "0042", "120210000123456789012", "12 € 30", "3 m", "1,2,3", "12,", "€", "", "12 jours", "€12 €"]) {
      expect(parseDisplayNumber(s), s).toBeNull();
    }
  });
  it("knows an empty display", () => {
    for (const s of ["", " ", "—", "-", "–", "n/a", "NC", null, undefined]) expect(isEmptyDisplay(s), String(s)).toBe(true);
    expect(isEmptyDisplay("0")).toBe(false);
  });
});

describe("typeSheetColumns", () => {
  it("turns numeric columns into numbers and moves the unit into the header", () => {
    const out = typeSheetColumns(
      ["Campagne", "Dépense", "CTR", "ROAS", "Conversions", "CPA €"],
      [
        ["Prospection, large", "1 245,30 €", "3,2 %", "2,1 x", "140", "12 €"],
        ["Retargeting", "300 €", "—", "4 x", "0", ""],
        ["Marque", "0", "1,05 %", "—", "-", "9,50 €"],
      ],
    );
    expect(out.columns).toEqual(["Campagne", "Dépense (€)", "CTR (%)", "ROAS (x)", "Conversions", "CPA €"]);
    expect(out.rows).toEqual([
      ["Prospection, large", 1245.3, 3.2, 2.1, 140, 12],
      ["Retargeting", 300, null, 4, 0, null],
      ["Marque", 0, 1.05, null, null, 9.5],
    ]);
  });
  it("keeps mixed, multi-currency and identifier columns as text", () => {
    const out = typeSheetColumns(
      ["Valeur", "Coût", "Identifiant", "Ad ID"],
      [["12 €", "12 €", "120001", "120210000123"], ["élevé", "3 $", "120002", "120210000124"]],
    );
    expect(out.columns).toEqual(["Valeur", "Coût", "Identifiant", "Ad ID"]);
    expect(out.rows).toEqual([["12 €", "12 €", "120001", "120210000123"], ["élevé", "3 $", "120002", "120210000124"]]);
  });
  it("leaves an all-empty column empty and pads short rows", () => {
    expect(typeSheetColumns(["A", "B"], [["—"], ["x", ""]])).toEqual({ columns: ["A", "B"], rows: [[null, null], ["x", null]] });
  });
  it("does not repeat a unit the header already names", () => {
    expect(headerWithUnit("Dépense (€)", "€")).toBe("Dépense (€)");
    expect(headerWithUnit("Budget en euros", "€")).toBe("Budget en euros");
    expect(headerWithUnit("CTR", "%")).toBe("CTR (%)");
    expect(headerWithUnit("Clics", null)).toBe("Clics");
  });
});

describe("typeKpiSheet / sheetValuesOf", () => {
  it("puts each KPI's unit into its label and types the variation", () => {
    expect(typeKpiSheet([["CPA", "12 €", "-8 %"], ["Leads", "140", ""], ["Statut", "en pause", "—"]])).toEqual({
      columns: ["Indicateur", "Valeur", "Variation (%)"],
      rows: [["CPA (€)", 12, -8], ["Leads", 140, null], ["Statut", "en pause", null]],
    });
  });
  it("types the cards the way the export sends them", () => {
    const kpis = { id: "k1", type: "kpis", title: "KPI", x: 0, y: 0, w: 1, h: 1, items: [{ label: "Dépense", value: "1 245,30 €", delta: "+12 %" }] } as unknown as MoCard;
    expect(sheetValuesOf(kpis)).toEqual({ columns: ["Indicateur", "Valeur", "Variation (%)"], rows: [["Dépense (€)", 1245.3, 12]] });
    const creas = { id: "c1", type: "creatives", title: "Créas", x: 0, y: 0, w: 1, h: 1, items: [{ name: "UGC", adId: "120001", metrics: { Dépense: "120 €", ROAS: "2,1 x" } }, { name: "Static", adId: "120002", metrics: { Dépense: "80 €" } }] } as unknown as MoCard;
    expect(sheetValuesOf(creas)).toEqual({ columns: ["Visuel", "Identifiant", "Dépense (€)", "ROAS (x)"], rows: [["UGC", "120001", 120, 2.1], ["Static", "120002", 80, null]] });
  });
});

/** The entries of a ZIP, read from its central directory (stored or deflated). */
function unzip(buf: Buffer): Record<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    const data = method === 0 ? raw : inflateRawSync(raw);
    expect(crc32(data)).toBe(crc);
    out[name] = data.toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("xlsx", () => {
  it("names the columns and escapes the XML", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
    expect(xmlEscape('a < b & "c" \u0001')).toBe("a &lt; b &amp; &quot;c&quot; ");
    expect(safeSheetName("Chiffres [Naturalia] : ce mois-ci / 2026 — très long")).toBe("Chiffres Naturalia ce mois-ci 2");
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
  it("writes numbers as numbers and text as shared strings, never as a formula", () => {
    const { sheet, sharedStrings } = worksheetXml(["Campagne", "Dépense (€)"], [["=HYPERLINK(\"x\")", 1245.3], ["B & C", null], ["Prospection", -0.5]]);
    expect(sheet).toContain('<c r="A1" s="1" t="s"><v>0</v></c>');
    expect(sheet).toContain('<c r="B2"><v>1245.3</v></c>');
    expect(sheet).toContain('<c r="B4"><v>-0.5</v></c>');
    expect(sheet).toContain('<row r="3"><c r="A3" t="s"><v>3</v></c></row>');
    expect(sheet).not.toContain("<f>");
    expect(sharedStrings).toContain("<t xml:space=\"preserve\">=HYPERLINK(&quot;x&quot;)</t>");
    expect(sharedStrings).toContain("B &amp; C");
  });
  it("packs a valid ZIP with the Office parts", () => {
    const files = unzip(toXlsx(["A", "B"], [["x", 1]], "Tableau"));
    expect(Object.keys(files).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"].sort());
    expect(files["xl/workbook.xml"]).toContain('<sheet name="Tableau" sheetId="1" r:id="rId1"/>');
    expect(unzip(zipStored({ "é.txt": "héllo" }))).toEqual({ "é.txt": "héllo" });
  });
});
