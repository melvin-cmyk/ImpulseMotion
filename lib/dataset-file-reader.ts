/**
 * Lecture d'un fichier de données (CSV / TSV / Excel / ODS) dans le navigateur,
 * pour l'import depuis le chat du bot client (POST /api/bot/[botId]/datasets).
 *
 * Première feuille, première ligne non vide = en-têtes. Les dates Excel
 * deviennent des dates ISO (le serveur normalise ensuite comme pour Drive).
 * SheetJS est chargé seulement à l'import (import dynamique).
 */

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const UPLOAD_ACCEPT = ".csv,.tsv,.txt,.xlsx,.xlsm,.xls,.ods";
const FILE_RE = /\.(csv|tsv|txt|xlsx|xlsm|xls|ods)$/i;

export interface ParsedDataFile {
  columns: string[];
  rows: Record<string, unknown>[];
  sheetName: string | null;
  /** Other sheets that were ignored (only the first one is imported). */
  ignoredSheets: string[];
}

function cellValue(v: unknown): unknown {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  return v === undefined ? null : v;
}

/** Header row + data rows (pure: used on the rows SheetJS gives back, and in tests). */
export function rowsFromMatrix(matrix: unknown[][]): { columns: string[]; rows: Record<string, unknown>[] } {
  const nonEmpty = (r: unknown[]) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== "");
  const headerAt = matrix.findIndex((r) => Array.isArray(r) && nonEmpty(r));
  if (headerAt < 0) return { columns: [], rows: [] };
  const header = matrix[headerAt];
  // Unique, non-empty column names (the server slugs them again).
  const seen = new Map<string, number>();
  const columns = header.map((h, i) => {
    let name = String(h ?? "").trim() || `colonne_${i + 1}`;
    const n = seen.get(name.toLowerCase()) ?? 0;
    seen.set(name.toLowerCase(), n + 1);
    if (n > 0) name = `${name}_${n + 1}`;
    return name;
  });
  // Trailing empty header cells with no data under them are dropped.
  let width = columns.length;
  while (width > 0 && !String(header[width - 1] ?? "").trim() && !matrix.slice(headerAt + 1).some((r) => r?.[width - 1] !== null && r?.[width - 1] !== undefined && String(r[width - 1]).trim() !== "")) width--;
  const cols = columns.slice(0, width);
  const rows: Record<string, unknown>[] = [];
  for (const r of matrix.slice(headerAt + 1)) {
    if (!Array.isArray(r) || !nonEmpty(r)) continue;
    const o: Record<string, unknown> = {};
    cols.forEach((c, i) => { o[c] = cellValue(r[i]); });
    rows.push(o);
  }
  return { columns: cols, rows };
}

/** UTF-8 when valid, else Windows-1252 (CSV saved by a French Excel). */
export function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

export async function readDataFile(file: File): Promise<ParsedDataFile> {
  if (!FILE_RE.test(file.name)) throw new Error("Format non pris en charge : CSV ou Excel (.csv, .xlsx, .xls, .ods).");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("Fichier trop lourd (20 Mo au maximum).");
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  // Text files stay raw text: SheetJS would read 01/02/2025 as January 2 and "98,1" as 981;
  // the server normalises French numbers and dates (lib/client-datasets.ts coerceCell).
  const isText = /\.(csv|tsv|txt)$/i.test(file.name);
  const wb = isText
    ? XLSX.read(decodeText(buf), { type: "string", dense: true, raw: true })
    : XLSX.read(buf, { type: "array", cellDates: true, dense: true });
  const sheetName = wb.SheetNames[0] ?? null;
  if (!sheetName) throw new Error("Le fichier ne contient aucune feuille.");
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: null, raw: true, blankrows: false });
  const { columns, rows } = rowsFromMatrix(matrix);
  if (!columns.length || !rows.length) throw new Error("Aucune donnée trouvée : la première ligne doit contenir les en-têtes, puis une ligne par enregistrement.");
  return { columns, rows, sheetName, ignoredSheets: wb.SheetNames.slice(1) };
}

/** Rows split for POST: ≤ maxRows per part and roughly ≤ maxBytes of JSON (Vercel body limit). */
export function splitParts<T>(rows: T[], maxRows = 2000, maxBytes = 3_000_000): T[][] {
  const parts: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const r of rows) {
    const s = JSON.stringify(r).length + 1;
    if (cur.length && (cur.length >= maxRows || size + s > maxBytes)) { parts.push(cur); cur = []; size = 0; }
    cur.push(r);
    size += s;
  }
  if (cur.length || !parts.length) parts.push(cur);
  return parts;
}
