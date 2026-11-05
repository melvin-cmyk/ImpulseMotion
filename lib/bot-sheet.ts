/**
 * A table of a client bot's reply, sent to Google Sheets (POST
 * /api/bot/[botId]/sheet). The cells arrive as the text the chat shows
 * (« 1 982 970 », « 63,64 € », « −14 % »): amounts and counts become real
 * numbers so the client can sort and sum; percentages, dates and words stay
 * text, as written.
 */

import type { SheetCell } from "@/lib/sheet-values";

export const SHEET_MAX_ROWS = 2000;
export const SHEET_MAX_COLS = 30;
export const SHEET_MAX_CELL = 500;

/** « 1 982 970 » → 1982970, « 63,64 € » → 63.64, « −14 » → -14 ; anything else stays text. */
export function parseCell(raw: unknown): SheetCell {
  const s = String(raw ?? "").replace(/ | /g, " ").trim().slice(0, SHEET_MAX_CELL);
  if (!s || s === "—" || s === "-") return s === "" ? null : s;
  const m = /^([−-]?)\s*([0-9]{1,3}(?:[ ][0-9]{3})+|[0-9]+)(?:,([0-9]+))?\s*(?:€|EUR|\$)?$/.exec(s);
  if (!m) return s;
  const n = Number(`${m[1] ? "-" : ""}${m[2].replace(/ /g, "")}${m[3] ? `.${m[3]}` : ""}`);
  return Number.isFinite(n) ? n : s;
}

/** « Chiffres Meta – 05/11/2026 14:32 » : unique per export, so a new export never replaces an older sheet. */
export function sheetName(title: string, now = new Date()): string {
  const t = title.replace(/[\u0000-\u001f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Tableau";
  const d = now.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", "");
  return `${t} – ${d}`;
}

export interface SheetTable { columns: string[]; rows: SheetCell[][] }

/** Validates and converts the browser's table; null when it is not a usable table. */
export function toSheetTable(input: { columns?: unknown; rows?: unknown }): SheetTable | null {
  if (!Array.isArray(input.columns) || !Array.isArray(input.rows)) return null;
  const columns = input.columns.slice(0, SHEET_MAX_COLS).map((c, i) => String(c ?? "").trim().slice(0, 120) || `Colonne ${i + 1}`);
  if (!columns.length || !input.rows.length || input.rows.length > SHEET_MAX_ROWS) return null;
  const rows: SheetCell[][] = [];
  for (const r of input.rows) {
    if (!Array.isArray(r)) return null;
    rows.push(columns.map((_, i) => parseCell(r[i])));
  }
  return { columns, rows };
}
