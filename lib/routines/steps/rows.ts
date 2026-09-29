/**
 * Routines — row transformations: filter, sort, limit, select.
 *
 * Closed operators only, no expression and no code. The four steps read the
 * rows of their input and return new rows; they never write and never call
 * anything, so they behave the same in a dry run and in a live run.
 *
 * Comparisons are numeric when both sides are numbers ("12,5" and "12.5" read
 * as numbers, as a Sheet exports them), textual otherwise (case and
 * surrounding spaces ignored). An empty cell never satisfies gt, gte, lt, lte
 * or contains, and goes last in a sort, whatever the direction.
 *
 * A column that does not exist is an error, never an empty result: it is
 * reported when the definition is validated if the columns are known by then
 * (lib/routines/validate.ts), and here at run time otherwise.
 */

import { STEP_ID_RE } from "@/lib/routines/template";
import type {
  Cell, PreflightIssue, Row, RowSet, RowsFilterStep, RowsLimitStep, RowsSelectStep, RowsSortStep,
  StepContext, StepHandler, StepRunOutcome,
} from "@/lib/routines/types";

export const FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "empty", "not_empty"] as const;
type FilterOp = (typeof FILTER_OPS)[number];
const OPS_WITHOUT_VALUE: ReadonlySet<string> = new Set(["empty", "not_empty"]);

export const MAX_FILTER_CONDITIONS = 10;
export const MAX_SELECT_COLUMNS = 50;
export const MAX_LIMIT_COUNT = 5000;
const MAX_COLUMN_CHARS = 120;
const MAX_VALUE_CHARS = 500;

// ── Shared pieces ────────────────────────────────────────────────────────

type Checked<S> = { ok: true; step: S } | { ok: false; error: string };
const refuse = (error: string) => ({ ok: false as const, error });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refuses any key that the step does not define: nothing is carried along silently. */
function unknownKey(raw: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(raw).find((k) => !allowed.includes(k));
  return extra === undefined ? null : `champ « ${extra} » inconnu`;
}

interface Base { id: string; label?: string; input?: string }

function readBase(raw: unknown, type: string, fields: readonly string[]): { ok: true; raw: Record<string, unknown>; base: Base } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return refuse("l'étape doit être un objet");
  if (raw.type !== type) return refuse(`type attendu : ${type}`);
  const extra = unknownKey(raw, ["id", "type", "label", "input", ...fields]);
  if (extra) return refuse(extra);
  if (typeof raw.id !== "string" || !STEP_ID_RE.test(raw.id)) return refuse("identifiant d'étape invalide (lettres, chiffres, tiret et souligné, 40 caractères au plus)");
  const base: Base = { id: raw.id };
  if (raw.label !== undefined) {
    if (typeof raw.label !== "string" || raw.label.length > 120) return refuse("libellé invalide (texte de 120 caractères au plus)");
    if (raw.label.trim()) base.label = raw.label.trim();
  }
  if (raw.input !== undefined) {
    if (typeof raw.input !== "string" || !STEP_ID_RE.test(raw.input)) return refuse("« input » doit désigner une étape par son identifiant");
    base.input = raw.input;
  }
  return { ok: true, raw, base };
}

function readColumn(value: unknown, what: string): string | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: `${what} : nom de colonne manquant` };
  if (value.length > MAX_COLUMN_CHARS) return { error: `${what} : nom de colonne trop long` };
  return value.trim();
}

function isCell(value: unknown): value is Cell {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

export function isEmptyCell(value: Cell | undefined): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/** Number carried by a cell, or null: 12, "12", "12.5", "12,5", "-3". Nothing looser. */
export function cellNumber(value: Cell | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(text)) return null;
  const n = Number(text.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const cellText = (value: Cell | undefined) => (value === null || value === undefined ? "" : String(value)).trim().toLowerCase();

/** Negative, zero or positive; numeric when both sides are numbers. */
export function compareCells(a: Cell | undefined, b: Cell | undefined): number {
  const na = cellNumber(a), nb = cellNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return cellText(a).localeCompare(cellText(b), "fr", { numeric: true });
}

export function matches(cell: Cell | undefined, op: FilterOp, value: Cell | undefined): boolean {
  if (op === "empty") return isEmptyCell(cell);
  if (op === "not_empty") return !isEmptyCell(cell);
  if (op === "eq") return isEmptyCell(cell) || isEmptyCell(value) ? isEmptyCell(cell) && isEmptyCell(value) : compareCells(cell, value) === 0;
  if (op === "neq") return !matches(cell, "eq", value);
  if (isEmptyCell(cell)) return false;
  if (op === "contains") return cellText(cell).includes(cellText(value));
  const order = compareCells(cell, value);
  if (op === "gt") return order > 0;
  if (op === "gte") return order >= 0;
  if (op === "lt") return order < 0;
  return order <= 0;
}

const hasColumn = (input: RowSet, column: string) => input.columns.includes(column);

function failed(rowsIn: number, message: string): StepRunOutcome {
  return { status: "failed", rowsIn, rowsOut: 0, output: {}, planned: [], written: [], warnings: [], error: { class: "functional", message } };
}

function done(input: RowSet, rows: RowSet): StepRunOutcome {
  return { status: "ok", rowsIn: input.rows.length, rowsOut: rows.rows.length, output: { rows }, planned: [], written: [], warnings: [] };
}

function missingColumns(input: RowSet, columns: string[]): string | null {
  const missing = [...new Set(columns)].filter((c) => !hasColumn(input, c));
  if (!missing.length) return null;
  const known = input.columns.length ? input.columns.map((c) => `« ${c} »`).join(", ") : "aucune";
  return missing.length === 1
    ? `Colonne « ${missing[0]} » absente des lignes reçues. Colonnes disponibles : ${known}.`
    : `Colonnes ${missing.map((c) => `« ${c} »`).join(", ")} absentes des lignes reçues. Colonnes disponibles : ${known}.`;
}

function inputOf(ctx: StepContext): RowSet | null {
  return ctx.input && Array.isArray(ctx.input.rows) && Array.isArray(ctx.input.columns) ? ctx.input : null;
}

const NO_INPUT = "Aucune ligne en entrée : cette étape doit suivre une étape qui produit des lignes.";
const noIssue = async (): Promise<PreflightIssue[]> => [];

// ── rows.filter ──────────────────────────────────────────────────────────

export const rowsFilterHandler: StepHandler<RowsFilterStep> = {
  type: "rows.filter",
  writes: "none",
  validate(raw): Checked<RowsFilterStep> {
    const head = readBase(raw, "rows.filter", ["where"]);
    if (!head.ok) return head;
    const list = head.raw.where;
    if (!Array.isArray(list) || !list.length) return refuse("« where » doit contenir au moins une condition");
    if (list.length > MAX_FILTER_CONDITIONS) return refuse(`${MAX_FILTER_CONDITIONS} conditions au plus`);
    const where: RowsFilterStep["where"] = [];
    for (const [i, item] of list.entries()) {
      const at = `condition ${i + 1}`;
      if (!isPlainObject(item)) return refuse(`${at} : objet attendu`);
      const extra = unknownKey(item, ["column", "op", "value"]);
      if (extra) return refuse(`${at} : ${extra}`);
      const column = readColumn(item.column, at);
      if (typeof column !== "string") return refuse(column.error);
      const op = FILTER_OPS.find((o) => o === item.op);
      if (!op) return refuse(`${at} : opérateur inconnu (acceptés : ${FILTER_OPS.join(", ")})`);
      if (OPS_WITHOUT_VALUE.has(op)) {
        if (item.value !== undefined && item.value !== null) return refuse(`${at} : l'opérateur ${op} ne prend pas de valeur`);
        where.push({ column, op });
        continue;
      }
      if (item.value === undefined || !isCell(item.value)) return refuse(`${at} : valeur attendue (texte, nombre, booléen ou null)`);
      if (typeof item.value === "string" && item.value.length > MAX_VALUE_CHARS) return refuse(`${at} : valeur trop longue`);
      if (op !== "eq" && op !== "neq" && isEmptyCell(item.value)) return refuse(`${at} : l'opérateur ${op} demande une valeur non vide`);
      where.push({ column, op, value: item.value });
    }
    return { ok: true, step: { ...head.base, type: "rows.filter", where } };
  },
  preflight: noIssue,
  async run(step, ctx) {
    const input = inputOf(ctx);
    if (!input) return failed(0, NO_INPUT);
    const missing = missingColumns(input, step.where.map((w) => w.column));
    if (missing) return failed(input.rows.length, missing);
    const rows = input.rows.filter((row) => step.where.every((w) => matches(row[w.column], w.op, w.value)));
    return done(input, { columns: [...input.columns], rows, truncated: input.truncated });
  },
};

// ── rows.sort ────────────────────────────────────────────────────────────

export const rowsSortHandler: StepHandler<RowsSortStep> = {
  type: "rows.sort",
  writes: "none",
  validate(raw): Checked<RowsSortStep> {
    const head = readBase(raw, "rows.sort", ["by", "dir"]);
    if (!head.ok) return head;
    const by = readColumn(head.raw.by, "« by »");
    if (typeof by !== "string") return refuse(by.error);
    const dir = head.raw.dir;
    if (dir !== "asc" && dir !== "desc") return refuse("« dir » doit valoir asc ou desc");
    return { ok: true, step: { ...head.base, type: "rows.sort", by, dir } };
  },
  preflight: noIssue,
  async run(step, ctx) {
    const input = inputOf(ctx);
    if (!input) return failed(0, NO_INPUT);
    const missing = missingColumns(input, [step.by]);
    if (missing) return failed(input.rows.length, missing);
    const sign = step.dir === "desc" ? -1 : 1;
    // Array.prototype.sort is stable: rows that compare equal keep the order of the source.
    const rows = [...input.rows].sort((a, b) => {
      const ea = isEmptyCell(a[step.by]), eb = isEmptyCell(b[step.by]);
      if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
      return sign * compareCells(a[step.by], b[step.by]);
    });
    return done(input, { columns: [...input.columns], rows, truncated: input.truncated });
  },
};

// ── rows.limit ───────────────────────────────────────────────────────────

export const rowsLimitHandler: StepHandler<RowsLimitStep> = {
  type: "rows.limit",
  writes: "none",
  validate(raw): Checked<RowsLimitStep> {
    const head = readBase(raw, "rows.limit", ["count"]);
    if (!head.ok) return head;
    const count = head.raw.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_LIMIT_COUNT) {
      return refuse(`« count » doit être un entier de 1 à ${MAX_LIMIT_COUNT}`);
    }
    return { ok: true, step: { ...head.base, type: "rows.limit", count } };
  },
  preflight: noIssue,
  async run(step, ctx) {
    const input = inputOf(ctx);
    if (!input) return failed(0, NO_INPUT);
    return done(input, { columns: [...input.columns], rows: input.rows.slice(0, step.count), truncated: input.truncated });
  },
};

// ── rows.select ──────────────────────────────────────────────────────────

/** Names of the columns after a rows.select, in order. */
export function selectedColumns(step: RowsSelectStep): string[] {
  return step.columns.map((c) => c.as ?? c.from);
}

export const rowsSelectHandler: StepHandler<RowsSelectStep> = {
  type: "rows.select",
  writes: "none",
  validate(raw): Checked<RowsSelectStep> {
    const head = readBase(raw, "rows.select", ["columns"]);
    if (!head.ok) return head;
    const list = head.raw.columns;
    if (!Array.isArray(list) || !list.length) return refuse("« columns » doit contenir au moins une colonne");
    if (list.length > MAX_SELECT_COLUMNS) return refuse(`${MAX_SELECT_COLUMNS} colonnes au plus`);
    const columns: RowsSelectStep["columns"] = [];
    const names = new Set<string>();
    for (const [i, item] of list.entries()) {
      const at = `colonne ${i + 1}`;
      if (!isPlainObject(item)) return refuse(`${at} : objet attendu`);
      const extra = unknownKey(item, ["from", "as"]);
      if (extra) return refuse(`${at} : ${extra}`);
      const from = readColumn(item.from, at);
      if (typeof from !== "string") return refuse(from.error);
      let as: string | undefined;
      if (item.as !== undefined && item.as !== null) {
        const renamed = readColumn(item.as, `${at}, « as »`);
        if (typeof renamed !== "string") return refuse(renamed.error);
        if (renamed !== from) as = renamed;
      }
      const name = as ?? from;
      if (names.has(name)) return refuse(`${at} : la colonne « ${name} » est produite deux fois`);
      names.add(name);
      columns.push(as ? { from, as } : { from });
    }
    return { ok: true, step: { ...head.base, type: "rows.select", columns } };
  },
  preflight: noIssue,
  async run(step, ctx) {
    const input = inputOf(ctx);
    if (!input) return failed(0, NO_INPUT);
    const missing = missingColumns(input, step.columns.map((c) => c.from));
    if (missing) return failed(input.rows.length, missing);
    const rows = input.rows.map((row) => {
      const out: Row = {};
      for (const c of step.columns) out[c.as ?? c.from] = row[c.from] ?? null;
      return out;
    });
    return done(input, { columns: selectedColumns(step), rows, truncated: input.truncated });
  },
};
