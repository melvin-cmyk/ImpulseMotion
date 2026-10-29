/**
 * A CSV as Google Sheets and Excel read it: UTF-8 with a BOM (so accents and
 * « € » survive Excel), comma separator, CRLF line ends, RFC 4180 quoting
 * (a cell with a comma, a quote, or a line break is quoted; a quote is doubled).
 * Pure, client-safe.
 */

export const CSV_BOM = "﻿";

export function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header row then the rows, each padded or cut to the number of columns. */
export function toCsv(columns: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const width = columns.length;
  const line = (cells: Array<string | number | null | undefined>) => Array.from({ length: width }, (_, i) => csvCell(cells[i])).join(",");
  return CSV_BOM + [line(columns), ...rows.map(line)].join("\r\n") + "\r\n";
}
