/**
 * Routines — sheet.read: the rows of one tab, header on row 1.
 *
 * The required columns are checked twice against the real header: when the
 * definition is applied (preflight) and at every run, because a column can be
 * renamed in the Sheet at any time. A missing column is a functional failure
 * and stops the run before anything is written.
 *
 * Values as lib/relay-sheets.ts reads them: raw numbers, dates as the text
 * shown in the sheet, empty cell = null, empty rows skipped.
 *
 * This file also holds the small pieces shared by the step files of lot B
 * (readStepBase, failed, done).
 */

import { SHEETS_DEFAULT_MAX_ROWS, SHEETS_MAX_ROWS_CAP, SheetsError, readHeader, readSheet, sheetRefError, sheetsErrorClass } from "@/lib/relay-sheets";
import { STEP_ID_RE } from "@/lib/routines/template";
import type { ErrorClass, PreflightIssue, SheetReadStep, SheetRef, StepHandler, StepRunOutcome, StepType } from "@/lib/routines/types";

export const MAX_REQUIRED_COLUMNS = 50;
export const MAX_COLUMN_CHARS = 120;

// ── Shared by the steps of lot B ─────────────────────────────────────────

export type Checked<S> = { ok: true; step: S } | { ok: false; error: string };
export const refuse = (error: string) => ({ ok: false as const, error });

export interface StepBaseFields { id: string; label?: string; input?: string }

/** Common fields of a step, from untrusted input; any key outside `fields` is refused. */
export function readStepBase(
  raw: unknown, type: StepType, fields: readonly string[],
): { ok: true; raw: Record<string, unknown>; base: StepBaseFields } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse("l'étape doit être un objet");
  const o = raw as Record<string, unknown>;
  if (o.type !== type) return refuse(`type attendu : ${type}`);
  const extra = Object.keys(o).find((k) => !["id", "type", "label", "input", ...fields].includes(k));
  if (extra !== undefined) return refuse(`champ « ${extra} » inconnu`);
  if (typeof o.id !== "string" || !STEP_ID_RE.test(o.id)) return refuse("identifiant d'étape invalide (lettres, chiffres, tiret et souligné, 40 caractères au plus)");
  const base: StepBaseFields = { id: o.id };
  if (o.label !== undefined) {
    if (typeof o.label !== "string" || o.label.length > 120) return refuse("libellé invalide (texte de 120 caractères au plus)");
    if (o.label.trim()) base.label = o.label.trim();
  }
  if (o.input !== undefined) {
    if (typeof o.input !== "string" || !STEP_ID_RE.test(o.input)) return refuse("« input » doit désigner une étape par son identifiant");
    base.input = o.input;
  }
  return { ok: true, raw: o, base };
}

export function readSheetRef(value: unknown): SheetRef | { error: string } {
  const error = sheetRefError(value);
  if (error) return { error };
  const { spreadsheetId, tab } = value as SheetRef;
  if (Object.keys(value as object).some((k) => k !== "spreadsheetId" && k !== "tab")) return { error: "feuille : seuls spreadsheetId et tab sont acceptés" };
  return { spreadsheetId, tab: tab.trim() };
}

export function readColumnName(value: unknown, what: string): string | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: `${what} : nom de colonne manquant` };
  if (value.trim().length > MAX_COLUMN_CHARS) return { error: `${what} : nom de colonne trop long` };
  return value.trim();
}

export function failed(rowsIn: number, errorClass: ErrorClass, message: string, extra: Partial<StepRunOutcome> = {}): StepRunOutcome {
  return { rowsIn, rowsOut: 0, output: {}, planned: [], written: [], warnings: [], ...extra, status: "failed", error: { class: errorClass, message } };
}

export function done(rowsIn: number, rowsOut: number, extra: Partial<StepRunOutcome> = {}): StepRunOutcome {
  return { status: "ok", rowsIn, rowsOut, output: {}, planned: [], written: [], warnings: [], ...extra };
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Issue of a check that could not be made (relay down…): blocking, the definition is not applied unverified. */
export function unverified(stepId: string, what: string, e: unknown): PreflightIssue {
  return { stepId, severity: "error", message: `${what} : vérification impossible (${errorMessage(e)})` };
}

// ── sheet.read ───────────────────────────────────────────────────────────

function validate(raw: unknown): Checked<SheetReadStep> {
  const head = readStepBase(raw, "sheet.read", ["sheet", "requiredColumns", "maxRows"]);
  if (!head.ok) return head;
  const sheet = readSheetRef(head.raw.sheet);
  if ("error" in sheet) return refuse(sheet.error);
  const list = head.raw.requiredColumns;
  if (!Array.isArray(list)) return refuse("requiredColumns doit être une liste de noms de colonnes (vide si aucune n'est exigée)");
  if (list.length > MAX_REQUIRED_COLUMNS) return refuse(`au plus ${MAX_REQUIRED_COLUMNS} colonnes requises`);
  const requiredColumns: string[] = [];
  for (const item of list) {
    const name = readColumnName(item, "requiredColumns");
    if (typeof name !== "string") return refuse(name.error);
    if (!requiredColumns.includes(name)) requiredColumns.push(name);
  }
  const step: SheetReadStep = { ...head.base, type: "sheet.read", sheet, requiredColumns };
  if (head.raw.maxRows !== undefined) {
    const n = head.raw.maxRows;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > SHEETS_MAX_ROWS_CAP) return refuse(`maxRows : entier de 1 à ${SHEETS_MAX_ROWS_CAP}`);
    step.maxRows = n;
  }
  return { ok: true, step };
}

/** Required columns that the header does not hold. */
export function missingColumns(required: readonly string[], header: readonly string[]): string[] {
  return required.filter((c) => !header.includes(c));
}

const missingMessage = (missing: string[], tab: string) =>
  `colonne${missing.length > 1 ? "s" : ""} absente${missing.length > 1 ? "s" : ""} de l'onglet « ${tab} » : ${missing.map((c) => `« ${c} »`).join(", ")}`;

export const sheetReadHandler: StepHandler<SheetReadStep> = {
  type: "sheet.read",
  writes: "none",
  validate,

  async preflight(step) {
    try {
      const missing = missingColumns(step.requiredColumns, await readHeader(step.sheet));
      return missing.length ? [{ stepId: step.id, severity: "error", message: missingMessage(missing, step.sheet.tab) }] : [];
    } catch (e) {
      if (e instanceof SheetsError && e.errorClass === "functional") return [{ stepId: step.id, severity: "error", message: e.message }];
      return [unverified(step.id, `onglet « ${step.sheet.tab} »`, e)];
    }
  },

  async run(step, ctx) {
    const rowsIn = ctx.input?.rows.length ?? 0;
    try {
      const data = await readSheet(step.sheet, { maxRows: step.maxRows ?? SHEETS_DEFAULT_MAX_ROWS });
      const missing = missingColumns(step.requiredColumns, data.columns);
      if (missing.length) return failed(rowsIn, "functional", missingMessage(missing, step.sheet.tab));
      const warnings = [...data.warnings];
      if (data.truncated) warnings.push(`L'onglet contient plus de ${data.rows.length} lignes : seules les ${data.rows.length} premières sont lues.`);
      return done(rowsIn, data.rows.length, {
        output: { rows: { columns: data.columns, rows: data.rows, truncated: data.truncated } },
        warnings,
      });
    } catch (e) {
      return failed(rowsIn, sheetsErrorClass(e), errorMessage(e));
    }
  },
};
