/**
 * Routines — sheet.write: one Sheet row per input row, columns by name.
 *
 *   append  adds the rows at the end of the tab;
 *   upsert  finds each row by the value of keyColumn: present once in the
 *           tab = its cells are rewritten, absent = the row is added. A key
 *           present twice in the tab, empty, or carried by two input rows
 *           stops the step before anything is written.
 *
 * Without input (first step of a plan) a single row is written, from
 * {{run.date}} and {{steps.<id>.text}}. With an input that holds no row,
 * nothing is written.
 *
 * Everything is prepared, then checked, then written: a missing column, in
 * the tab or in the rows, fails the step with the Sheet untouched. In a dry
 * run (ctx.write null) the tab is read but never written, and every write is
 * listed in `planned` with the values as they would land in the cells. A live
 * run fills `planned` the same way, and `written` with what was done.
 *
 * A rendered value that is a plain number ("12.5", "-3") is written as a
 * number; any other text is written as text, with an apostrophe in front when
 * it starts with = + - or @ (done again by the relay).
 *
 * Routine.maxItemsPerRun does not apply here (it bounds what is created on an
 * ad platform): the step takes MAX_WRITE_ROWS rows at most and refuses more.
 */

import {
  SHEETS_MAX_APPEND_ROWS, SHEETS_MAX_ROWS_CAP, SHEETS_MAX_UPDATES, SheetsError,
  appendRows, readHeader, readSheet, sheetsErrorClass, updateCells, writtenValue, type CellUpdate,
} from "@/lib/relay-sheets";
import { renderTemplateDetailed, scopeFromContext, templateError } from "@/lib/routines/template";
import {
  type Checked, done, errorMessage, failed, readColumnName, readSheetRef, readStepBase, refuse, unverified,
} from "@/lib/routines/steps/sheet-read";
import type { Cell, PlannedWrite, Row, SheetWriteStep, StepContext, StepHandler, StepRunOutcome } from "@/lib/routines/types";

export const MAX_WRITE_COLUMNS = 50;
export const MAX_WRITE_ROWS = 500;

function validate(raw: unknown): Checked<SheetWriteStep> {
  const head = readStepBase(raw, "sheet.write", ["sheet", "mode", "keyColumn", "columns"]);
  if (!head.ok) return head;
  const sheet = readSheetRef(head.raw.sheet);
  if ("error" in sheet) return refuse(sheet.error);
  const mode = head.raw.mode;
  if (mode !== "append" && mode !== "upsert") return refuse("mode attendu : append ou upsert");

  const list = head.raw.columns;
  if (!Array.isArray(list) || list.length === 0) return refuse("columns : au moins une colonne à écrire");
  if (list.length > MAX_WRITE_COLUMNS) return refuse(`au plus ${MAX_WRITE_COLUMNS} colonnes`);
  const columns: SheetWriteStep["columns"] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return refuse("columns : chaque entrée est { column, value }");
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some((k) => k !== "column" && k !== "value")) return refuse("columns : seuls column et value sont acceptés");
    const column = readColumnName(entry.column, "columns");
    if (typeof column !== "string") return refuse(column.error);
    if (columns.some((c) => c.column === column)) return refuse(`colonne « ${column} » citée deux fois`);
    const bad = templateError(entry.value);
    if (bad) return refuse(`colonne « ${column} » : ${bad}`);
    columns.push({ column, value: entry.value as string });
  }

  const step: SheetWriteStep = { ...head.base, type: "sheet.write", sheet, mode, columns };
  if (mode === "upsert") {
    const key = readColumnName(head.raw.keyColumn, "keyColumn");
    if (typeof key !== "string") return refuse(`${key.error} (obligatoire en mode upsert)`);
    if (!columns.some((c) => c.column === key)) return refuse(`la colonne clé « ${key} » doit figurer dans columns, avec la valeur qui identifie la ligne`);
    step.keyColumn = key;
  } else if (head.raw.keyColumn !== undefined) {
    return refuse("keyColumn ne s'emploie qu'en mode upsert");
  }
  return { ok: true, step };
}

/** Rendered text → cell: a plain number is written as a number, the rest as text. */
export function toCell(text: string): Cell {
  const t = text.trim();
  if (t === "") return null;
  // No leading zero ("0123" is a code), no "+", and short enough to stay exact.
  if (t.length <= 15 && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(t)) return Number(t);
  return text;
}

export const keyOf = (value: Cell | undefined): string => (value === null || value === undefined ? "" : String(value).trim());

interface Prepared { values: Cell[]; key: string }

function prepare(step: SheetWriteStep, ctx: StepContext): { rows: Prepared[]; warnings: string[] } | { error: string } {
  const sources: Array<Row | null> = ctx.input ? ctx.input.rows : [null];
  if (sources.length > MAX_WRITE_ROWS) return { error: `${sources.length} lignes à écrire : ${MAX_WRITE_ROWS} au plus par exécution (ajouter une étape rows.limit ou rows.filter)` };
  const rows: Prepared[] = [];
  const emptySteps = new Set<string>();
  const keyIndex = step.keyColumn ? step.columns.findIndex((c) => c.column === step.keyColumn) : -1;
  for (const source of sources) {
    const values: Cell[] = [];
    for (const c of step.columns) {
      let rendered: { text: string; missing: string[] };
      try { rendered = renderTemplateDetailed(c.value, scopeFromContext(ctx, source)); }
      catch (e) { return { error: `colonne « ${c.column} » : ${errorMessage(e)}` }; }
      const lost = rendered.missing.filter((m) => m.startsWith("row."));
      if (lost.length) {
        return { error: source
          ? `colonne « ${c.column} » : ${lost.map((m) => `« ${m.slice(4)} »`).join(", ")} absente des lignes reçues`
          : `colonne « ${c.column} » : le gabarit lit une ligne ({{${lost[0]}}}) mais l'étape ne reçoit aucune ligne` };
      }
      rendered.missing.filter((m) => m.startsWith("steps.")).forEach((m) => emptySteps.add(m));
      values.push(toCell(rendered.text));
    }
    rows.push({ values, key: keyIndex >= 0 ? keyOf(values[keyIndex]) : "" });
  }
  return { rows, warnings: [...emptySteps].map((m) => `{{${m}}} est vide : l'étape citée n'a pas produit de texte.`) };
}

function preview(step: SheetWriteStep, values: Cell[]): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  step.columns.forEach((c, i) => { out[c.column] = writtenValue(values[i]); });
  return out;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface Plan { appends: Prepared[]; updates: Array<{ row: number; prepared: Prepared }> }

/** Upsert: which prepared rows rewrite a Sheet row, which are added. */
export function planUpsert(prepared: Prepared[], sheetKeys: Array<{ key: string; row: number }>): Plan | { error: string } {
  const seen = new Set<string>();
  for (const p of prepared) {
    if (!p.key) return { error: "clé vide : chaque ligne doit porter une valeur dans la colonne clé" };
    if (seen.has(p.key)) return { error: `clé en double dans les lignes à écrire : « ${p.key} »` };
    seen.add(p.key);
  }
  const rowsOf = new Map<string, number[]>();
  for (const k of sheetKeys) {
    if (!k.key) continue;
    rowsOf.set(k.key, [...(rowsOf.get(k.key) ?? []), k.row]);
  }
  const plan: Plan = { appends: [], updates: [] };
  for (const p of prepared) {
    const found = rowsOf.get(p.key) ?? [];
    if (found.length > 1) return { error: `clé en double dans le Sheet : « ${p.key} » aux lignes ${found.join(", ")}. Rien n'a été écrit.` };
    if (found.length === 1) plan.updates.push({ row: found[0], prepared: p });
    else plan.appends.push(p);
  }
  return plan;
}

async function run(step: SheetWriteStep, ctx: StepContext): Promise<StepRunOutcome> {
  const rowsIn = ctx.input?.rows.length ?? 0;
  const through = ctx.input ? { rows: ctx.input } : {};
  const prepared = prepare(step, ctx);
  if ("error" in prepared) return failed(rowsIn, "functional", prepared.error);
  const warnings = prepared.warnings;
  if (!prepared.rows.length) return done(rowsIn, 0, { output: through, warnings: [...warnings, "Aucune ligne à écrire."] });

  const tab = step.sheet.tab;
  const names = step.columns.map((c) => c.column);
  let plan: Plan;
  try {
    if (step.mode === "upsert" && step.keyColumn) {
      const data = await readSheet(step.sheet, { maxRows: SHEETS_MAX_ROWS_CAP });
      const missing = names.filter((c) => !data.columns.includes(c));
      if (missing.length) return failed(rowsIn, "functional", `colonne inconnue dans l'onglet « ${tab} » : ${missing.map((c) => `« ${c} »`).join(", ")}. Rien n'a été écrit.`);
      if (data.truncated) return failed(rowsIn, "functional", `l'onglet « ${tab} » dépasse ${SHEETS_MAX_ROWS_CAP} lignes : la recherche par clé n'y est pas sûre. Rien n'a été écrit.`);
      const key = step.keyColumn;
      const found = planUpsert(prepared.rows, data.rows.map((r, i) => ({ key: keyOf(r[key]), row: data.rowNumbers[i] })));
      if ("error" in found) return failed(rowsIn, "functional", found.error);
      plan = found;
    } else {
      const header = await readHeader(step.sheet);
      const missing = names.filter((c) => !header.includes(c));
      if (missing.length) return failed(rowsIn, "functional", `colonne inconnue dans l'onglet « ${tab} » : ${missing.map((c) => `« ${c} »`).join(", ")}. Rien n'a été écrit.`);
      plan = { appends: prepared.rows, updates: [] };
    }
  } catch (e) {
    return failed(rowsIn, sheetsErrorClass(e), errorMessage(e));
  }

  const keyed = (p: Prepared) => (p.key ? { itemKey: p.key } : {});
  const planned: PlannedWrite[] = [
    ...plan.updates.map((u) => ({ target: "sheet" as const, summary: `Mise à jour de la ligne ${u.row} de « ${tab} »`, ...keyed(u.prepared), preview: preview(step, u.prepared.values) })),
    ...plan.appends.map((p) => ({ target: "sheet" as const, summary: `Ajout d'une ligne dans « ${tab} »`, ...keyed(p), preview: preview(step, p.values) })),
  ];
  // Dry run: the list of what would be written, and nothing else.
  if (!ctx.write) return done(rowsIn, 0, { output: through, planned, warnings });

  const written: StepRunOutcome["written"] = [];
  try {
    const cells: Array<CellUpdate & { owner: number }> = [];
    plan.updates.forEach((u, owner) => {
      step.columns.forEach((c, i) => {
        // The key cell already holds this value.
        if (c.column !== step.keyColumn) cells.push({ row: u.row, column: c.column, value: u.prepared.values[i], owner });
      });
    });
    for (const part of chunks(cells, SHEETS_MAX_UPDATES)) {
      await updateCells(ctx.write, step.sheet, part.map(({ row, column, value }) => ({ row, column, value })));
    }
    plan.updates.forEach((u) => written.push({ ...keyed(u.prepared), summary: `Ligne ${u.row} de « ${tab} » mise à jour` }));
    for (const part of chunks(plan.appends, SHEETS_MAX_APPEND_ROWS)) {
      await appendRows(ctx.write, step.sheet, names, part.map((p) => p.values));
      part.forEach((p) => written.push({ ...keyed(p), summary: `Ligne ajoutée dans « ${tab} »` }));
    }
  } catch (e) {
    const partial = written.length ? ` (${written.length} écriture${written.length > 1 ? "s" : ""} déjà faite${written.length > 1 ? "s" : ""})` : "";
    return failed(rowsIn, e instanceof SheetsError ? e.errorClass : "functional", `${errorMessage(e)}${partial}`, { output: through, planned, written, warnings });
  }
  return done(rowsIn, written.length, { output: through, planned, written, warnings });
}

export const sheetWriteHandler: StepHandler<SheetWriteStep> = {
  type: "sheet.write",
  writes: "sheet",
  validate,

  async preflight(step) {
    try {
      const header = await readHeader(step.sheet);
      const missing = step.columns.map((c) => c.column).filter((c) => !header.includes(c));
      return missing.length
        ? [{ stepId: step.id, severity: "error", message: `colonne inconnue dans l'onglet « ${step.sheet.tab} » : ${missing.map((c) => `« ${c} »`).join(", ")}` }]
        : [];
    } catch (e) {
      if (e instanceof SheetsError && e.errorClass === "functional") return [{ stepId: step.id, severity: "error", message: e.message }];
      return [unverified(step.id, `onglet « ${step.sheet.tab} »`, e)];
    }
  },

  run,
};
