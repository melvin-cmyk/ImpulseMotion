/**
 * Google Sheets for the routines, through the relay's /api/sheets/* routes
 * (server/sheets-direct.mjs): no AI, shared identity data@impulse-analytics.com,
 * columns addressed by name (header on row 1).
 *
 * Values read: raw numbers (1234.5, not "1 234,50 €"), dates as the text shown
 * in the sheet, empty cell = null, empty rows skipped.
 * Values written: never interpreted by Sheets (RAW); a text starting with
 * = + - or @ gets an apostrophe in front, on the relay side.
 *
 * Every failure is a SheetsError carrying an ErrorClass:
 *   functional — the routine is wrong (document not shared, tab or column
 *                missing, bad id): counts towards the automatic stop;
 *   infra      — relay unreachable, Google token, quota, outage.
 *
 * The two writing functions take the WriteGuard of a live run and check it
 * before anything else.
 */

import { relayHeaders } from "@/lib/relay-headers";
import { RELAY_URLS } from "@/lib/relay-server";
import { assertWriteGuard } from "@/lib/routines/write-guard-check";
import type { Cell, ErrorClass, Row, RowSet, SheetRef, WriteGuard } from "@/lib/routines/types";

export const SHEETS_DEFAULT_MAX_ROWS = 1000;
export const SHEETS_MAX_ROWS_CAP = 5000;
export const SHEETS_MAX_APPEND_ROWS = 500;
export const SHEETS_MAX_UPDATES = 500;

const SPREADSHEET_ID_RE = /^[A-Za-z0-9_-]{20,100}$/;
const TAB_FORBIDDEN = /[\[\]*?:\/\\\u0000-\u001f\u007f]/;

export class SheetsError extends Error {
  readonly errorClass: ErrorClass;
  constructor(message: string, errorClass: ErrorClass) {
    super(message);
    this.name = "SheetsError";
    this.errorClass = errorClass;
  }
}

/** Class of any error thrown by this module's callers: unknown = infra. */
export function sheetsErrorClass(err: unknown): ErrorClass {
  return err instanceof SheetsError ? err.errorClass : "infra";
}

/** Rows of a tab, with the sheet row number of each (rowNumbers[i] ↔ rows[i]). */
export interface SheetData extends RowSet { rowNumbers: number[]; warnings: string[] }
export interface CellUpdate { row: number; column: string; value: Cell }

/** Same rules as the relay; null when the reference is usable, the reason otherwise. */
export function sheetRefError(ref: unknown): string | null {
  if (!ref || typeof ref !== "object") return "feuille manquante (spreadsheetId et tab)";
  const { spreadsheetId, tab } = ref as Record<string, unknown>;
  if (typeof spreadsheetId !== "string" || !SPREADSHEET_ID_RE.test(spreadsheetId)) {
    return "identifiant de document invalide : attendu l'identifiant du Google Sheet (entre /d/ et /edit dans son adresse), pas une adresse";
  }
  if (typeof tab !== "string" || !tab.trim() || tab.trim().length > 100 || TAB_FORBIDDEN.test(tab.trim()) || tab.trim().startsWith("'") || tab.trim().endsWith("'")) {
    return "nom d'onglet invalide";
  }
  return null;
}

/** Rebuilds a SheetRef from untrusted input; throws a functional SheetsError. */
export function cleanSheetRef(ref: unknown): SheetRef {
  const error = sheetRefError(ref);
  if (error) throw new SheetsError(error.charAt(0).toUpperCase() + error.slice(1), "functional");
  const { spreadsheetId, tab } = ref as SheetRef;
  return { spreadsheetId, tab: tab.trim() };
}

/** What the relay writes for a value (formula neutralised): used for the dry-run preview. */
export function writtenValue(value: Cell): Cell {
  if (typeof value !== "string" || value === "") return value;
  if (/^[\t\r\n]/.test(value) || /^[=+\-@]/.test(value.trimStart())) return `'${value}`;
  return value;
}

interface RelayAnswer { result?: unknown; error?: string; class?: string }

async function call<T>(action: "read" | "append" | "update", body: Record<string, unknown>, timeoutMs: number): Promise<T> {
  let lastInfra = "Relay injoignable";
  for (const url of RELAY_URLS) {
    let res: Response;
    try {
      res = await fetch(`${url}/api/sheets/${action}`, {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(url.includes("localhost") ? Math.min(timeoutMs, 5000) : timeoutMs),
      });
    } catch (e) {
      // A write whose answer never came may have been applied: never replayed on another URL.
      if (action !== "read" && !isConnectionRefused(e)) {
        throw new SheetsError(`Relay : réponse non reçue (${message(e)}), l'écriture a pu être appliquée`, "infra");
      }
      lastInfra = `Relay injoignable (${message(e)})`;
      continue;
    }
    const json = (await res.json().catch(() => null)) as RelayAnswer | null;
    if (res.ok && json && "result" in json) return json.result as T;
    if (json?.class === "functional" && typeof json.error === "string") throw new SheetsError(json.error, "functional");
    if (json?.class === "infra" && typeof json.error === "string") throw new SheetsError(json.error, "infra");
    // 404 without a class: a relay that does not know the route yet (not restarted).
    lastInfra = res.status === 404
      ? "Relay pas à jour : les routes Google Sheets n'y sont pas encore ouvertes"
      : `Relay ${res.status}${json?.error ? ` : ${String(json.error).slice(0, 200)}` : ""}`;
  }
  throw new SheetsError(lastInfra, "infra");
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);

/** True when nothing listened (the request never left): safe to try the next URL. */
function isConnectionRefused(e: unknown): boolean {
  const cause = e instanceof Error ? (e as Error & { cause?: { code?: string } }).cause : null;
  return cause?.code === "ECONNREFUSED" || cause?.code === "ENOTFOUND";
}

function asSheetData(raw: unknown): SheetData {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(r.columns) || !Array.isArray(r.rows)) throw new SheetsError("Relay : réponse Google Sheets de forme inattendue", "infra");
  return {
    columns: r.columns.map(String),
    rows: r.rows as Row[],
    rowNumbers: Array.isArray(r.rowNumbers) ? r.rowNumbers.map(Number) : [],
    truncated: r.truncated === true,
    warnings: Array.isArray(r.warnings) ? r.warnings.map(String) : [],
  };
}

/** Rows of a tab, header on row 1; `truncated` when the tab holds more than maxRows. */
export async function readSheet(ref: SheetRef, opts: { maxRows?: number } = {}): Promise<SheetData> {
  const clean = cleanSheetRef(ref);
  const maxRows = Math.min(SHEETS_MAX_ROWS_CAP, Math.max(1, Math.floor(opts.maxRows ?? SHEETS_DEFAULT_MAX_ROWS)));
  return asSheetData(await call("read", { ...clean, maxRows }, 30_000));
}

/** Column names of row 1, in order (empty header cells skipped). */
export async function readHeader(ref: SheetRef): Promise<string[]> {
  const clean = cleanSheetRef(ref);
  return asSheetData(await call("read", { ...clean, headerOnly: true }, 20_000)).columns;
}

/** Appends rows; rows[i][j] goes under columns[j]. An unknown column refuses the whole call. */
export async function appendRows(guard: WriteGuard, ref: SheetRef, columns: string[], rows: Cell[][]): Promise<{ appendedRows: number }> {
  assertWriteGuard(guard);
  const clean = cleanSheetRef(ref);
  if (!rows.length) return { appendedRows: 0 };
  if (rows.length > SHEETS_MAX_APPEND_ROWS) throw new SheetsError(`Trop de lignes à ajouter : ${SHEETS_MAX_APPEND_ROWS} au plus par appel`, "functional");
  const out = await call<{ appendedRows?: number }>("append", { ...clean, columns, rows }, 30_000);
  return { appendedRows: Number(out?.appendedRows ?? rows.length) };
}

/** Rewrites cells, each named by sheet row number and column name. */
export async function updateCells(guard: WriteGuard, ref: SheetRef, updates: CellUpdate[]): Promise<{ updatedCells: number }> {
  assertWriteGuard(guard);
  const clean = cleanSheetRef(ref);
  if (!updates.length) return { updatedCells: 0 };
  if (updates.length > SHEETS_MAX_UPDATES) throw new SheetsError(`Trop de cellules à mettre à jour : ${SHEETS_MAX_UPDATES} au plus par appel`, "functional");
  const out = await call<{ updatedCells?: number }>("update", { ...clean, updates }, 30_000);
  return { updatedCells: Number(out?.updatedCells ?? updates.length) };
}
