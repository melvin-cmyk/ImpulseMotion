/**
 * Display strings back to numbers for a spreadsheet export. Mo's cards carry
 * French-formatted strings (« 1 245,30 € », « 3,2 % », « +12 % », « 2,1 x »);
 * a sheet wants the number in the cell and the unit in the column header
 * (« Dépense (€) », « CTR (%) »). Pure, client-safe.
 */

export type SheetCell = string | number | null;

export interface ParsedNumber { value: number; unit: string | null }

/** Empty, a dash, or a « not available » marker: an empty cell. */
const EMPTY_RE = /^(?:|[-–—]|n\/?a|nc|n\.c\.|—\s*—)$/i;

/** Units recognised after (or before, for currencies) the number, mapped to how the header shows them. */
const UNITS: Record<string, string> = {
  "€": "€", eur: "€", euro: "€", euros: "€",
  $: "$", usd: "$",
  "£": "£", gbp: "£",
  chf: "CHF",
  "%": "%",
  x: "x", "×": "x",
  pt: "pts", pts: "pts", points: "pts",
};
const MULTIPLIERS: Record<string, number> = { k: 1e3, m: 1e6, md: 1e9, mds: 1e9 };

/** Spaces of every kind (normal, no-break, narrow no-break, thin) used as thousand separators by fr-FR. */
const SPACES_RE = /[\s    ]/g;

/**
 * « 1 245,30 € » → { value: 1245.3, unit: "€" }; « −8 % » → { -8, "%" };
 * « 1,2 k€ » → { 1200, "€" }; « 1,245.30 » → 1245.3. Null when it is not
 * a number with at most one known unit (a date, an id with leading zeros or
 * too many digits to stay exact, free text).
 */
export function parseDisplayNumber(raw: string): ParsedNumber | null {
  let s = raw.replace(SPACES_RE, "").replace(/[−–]/g, "-").toLowerCase();
  if (!s) return null;
  // A currency written first (« $12.40 », « €3 »).
  let unit: string | null = null;
  const lead = s.match(/^([+-]?)(€|\$|£)(.*)$/);
  if (lead) { unit = UNITS[lead[2]]; s = lead[1] + lead[3]; }
  const m = s.match(/^([+-]?)(\d[\d.,]*)(mds|md|k|m)?([^\d.,]*)$/);
  if (!m) return null;
  const [, sign, digits, mult, tail] = m;
  if (tail) {
    if (unit || !(tail in UNITS)) return null;
    unit = UNITS[tail];
  }
  // « 3 m » would read as a million where it may be minutes / metres: a multiplier only before a currency.
  if (mult && !(unit && ["€", "$", "£", "CHF"].includes(unit))) return null;
  const value = parseDigits(digits);
  if (value === null) return null;
  const n = (sign === "-" ? -1 : 1) * value * (mult ? MULTIPLIERS[mult] : 1);
  return Number.isFinite(n) ? { value: Math.round(n * 1e9) / 1e9, unit } : null;
}

/** « 1245,30 », « 1.245,30 », « 1,245.30 », « 1245.3 » → 1245.3; null when ambiguous or not a number. */
function parseDigits(d: string): number | null {
  if (/[.,]$/.test(d)) return null;
  const commas = (d.match(/,/g) ?? []).length;
  const dots = (d.match(/\./g) ?? []).length;
  let norm: string;
  if (commas && dots) {
    // The last separator is the decimal one, the other groups thousands.
    const dec = d.lastIndexOf(",") > d.lastIndexOf(".") ? "," : ".";
    const thou = dec === "," ? "." : ",";
    if (d.split(dec).length !== 2) return null;
    const [int, frac] = d.split(dec);
    if (!new RegExp(`^\\d{1,3}(\\${thou}\\d{3})*$`).test(int)) return null;
    norm = int.split(thou).join("") + "." + frac;
  } else if (commas > 1 || dots > 1) {
    // Only thousand separators (« 1.245.300 », « 1,245,300 »).
    const sep = commas > 1 ? "," : ".";
    if (!new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(d)) return null;
    norm = d.split(sep).join("");
  } else {
    // One separator at most: the decimal one (fr « 3,2 », en « 3.2 »).
    norm = d.replace(",", ".");
  }
  const intPart = norm.split(".")[0];
  // Codes and ids: a leading zero (« 0042 ») or more digits than a double keeps exact.
  if ((intPart.length > 1 && intPart.startsWith("0")) || intPart.length > 15) return null;
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

export const isEmptyDisplay = (s: string | null | undefined): boolean => s === null || s === undefined || EMPTY_RE.test(s.replace(SPACES_RE, ""));

/** Columns whose values are identifiers, never numbers, whatever they look like. */
const ID_HEADER_RE = /(^|[\s_(])(id|ids|identifiant|identifiants|code|n°|numéro|siret|siren|tél|téléphone|phone)([\s_)]|$)/i;

/** « Dépense » + « € » → « Dépense (€) »; a header that already names the unit is left as is. */
export function headerWithUnit(header: string, unit: string | null): string {
  if (!unit) return header;
  const h = header.toLowerCase();
  if (h.includes(unit.toLowerCase()) || (unit === "€" && /\beur(o|os)?\b/.test(h)) || (unit === "%" && /\bpourcentage\b|\btaux\b.*%/.test(h))) return header;
  return `${header} (${unit})`;
}

/**
 * A column becomes numbers when every non-empty cell is a number and at most
 * one unit appears in it (bare numbers alongside « € » cells count as €); the
 * unit then moves to the header. Otherwise the column stays text, as shown.
 * Empty cells and dashes become empty cells either way.
 */
export function typeSheetColumns(columns: string[], rows: string[][]): { columns: string[]; rows: SheetCell[][] } {
  const outCols = [...columns];
  const out: SheetCell[][] = rows.map((r) => columns.map((_, j) => (isEmptyDisplay(r[j]) ? null : r[j])));
  columns.forEach((header, j) => {
    if (ID_HEADER_RE.test(header)) return;
    const parsed: Array<ParsedNumber | null> = [];
    const units = new Set<string>();
    let any = false;
    for (const row of out) {
      const cell = row[j];
      if (cell === null) { parsed.push(null); continue; }
      const p = parseDisplayNumber(String(cell));
      if (!p) return; // text in the column: it stays text
      any = true;
      if (p.unit) units.add(p.unit);
      parsed.push(p);
    }
    if (!any || units.size > 1) return;
    const unit = units.size ? [...units][0] : null;
    out.forEach((row, i) => { row[j] = parsed[i]?.value ?? null; });
    outCols[j] = headerWithUnit(header, unit);
  });
  return { columns: outCols, rows: out };
}

/**
 * The KPI layout (indicateur, valeur, variation): each row is its own metric,
 * so the value's unit goes into the row's label (« CPA (€) ») and the value
 * is a number; the variation column is typed like any column.
 */
export function typeKpiSheet(rows: string[][]): { columns: string[]; rows: SheetCell[][] } {
  const labelled = rows.map((r) => {
    const [label = "", value = "", delta = ""] = r;
    if (isEmptyDisplay(value)) return { label, value: null as SheetCell, delta };
    const p = parseDisplayNumber(value);
    return p ? { label: headerWithUnit(label, p.unit), value: p.value as SheetCell, delta } : { label, value: value as SheetCell, delta };
  });
  const deltas = typeSheetColumns(["Variation"], labelled.map((l) => [l.delta]));
  return {
    columns: ["Indicateur", "Valeur", deltas.columns[0]],
    rows: labelled.map((l, i) => [l.label, l.value, deltas.rows[i][0]]),
  };
}
