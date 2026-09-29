/**
 * Routines — text templates.
 *
 * Three placeholders and nothing else:
 *
 *   {{row.<column>}}       a cell of the current row
 *   {{run.date}}           the day of the run, YYYY-MM-DD in the routine's timezone
 *   {{steps.<id>.text}}    the text produced by an earlier step (ai.summary)
 *
 * Plain substitution: no expression, no filter, no code. Anything else between
 * {{ and }} is refused when the definition is validated, so a template that
 * reaches the engine is known to be harmless.
 *
 * A value is never read again as a template. The template is cut into tokens
 * once, from the text written in the definition, and the values are only
 * appended: a cell that contains "{{steps.x.text}}" comes out as these very
 * characters.
 */

import type { Cell, Row, StepContext, StepOutput, Template } from "@/lib/routines/types";

/** Step ids, as the definition and the templates write them. */
export const STEP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
export const MAX_TEMPLATE_CHARS = 5000;
const MAX_COLUMN_CHARS = 120;

export type TemplateToken =
  | { kind: "text"; value: string }
  | { kind: "row"; column: string }
  | { kind: "run.date" }
  | { kind: "step.text"; stepId: string };

export type ParsedTemplate = { ok: true; tokens: TemplateToken[] } | { ok: false; error: string };

export interface TemplateRefs { columns: string[]; stepIds: string[]; runDate: boolean }

export interface TemplateScope {
  /** Current row; absent for a text that is written once per run. */
  row?: Row | null;
  /** YYYY-MM-DD, see runDate(). */
  runDate: string;
  /** Outputs of the earlier steps, by step id (StepContext.outputs). */
  steps: Record<string, StepOutput>;
}

function parsePlaceholder(inner: string): TemplateToken | string {
  const expr = inner.trim();
  if (expr === "run.date") return { kind: "run.date" };
  if (expr.startsWith("row.")) {
    const column = expr.slice(4).trim();
    if (!column) return "{{row.}} : nom de colonne manquant";
    if (column.length > MAX_COLUMN_CHARS) return "nom de colonne trop long";
    // A pipe is a filter in other template languages: refused rather than read as a column name.
    if (/[{}|\n\r]/.test(column)) return `motif « {{${expr}}} » refusé : nom de colonne invalide (ni filtre ni accolade)`;
    return { kind: "row", column };
  }
  const step = /^steps\.([^.\s]+)\.text$/.exec(expr);
  if (step && STEP_ID_RE.test(step[1])) return { kind: "step.text", stepId: step[1] };
  const shown = expr.length > 60 ? `${expr.slice(0, 60)}…` : expr;
  return `motif « {{${shown}}} » refusé : seuls {{row.<colonne>}}, {{run.date}} et {{steps.<id>.text}} sont acceptés`;
}

/** Cuts a template into tokens, or says why it is outside the grammar. */
export function parseTemplate(template: unknown): ParsedTemplate {
  if (typeof template !== "string") return { ok: false, error: "le gabarit doit être un texte" };
  if (template.length > MAX_TEMPLATE_CHARS) return { ok: false, error: `gabarit trop long (${MAX_TEMPLATE_CHARS} caractères au plus)` };
  const tokens: TemplateToken[] = [];
  let pos = 0;
  while (pos < template.length) {
    const open = template.indexOf("{{", pos);
    if (open === -1) { tokens.push({ kind: "text", value: template.slice(pos) }); break; }
    if (open > pos) tokens.push({ kind: "text", value: template.slice(pos, open) });
    const close = template.indexOf("}}", open + 2);
    if (close === -1) return { ok: false, error: "« {{ » sans « }} » : motif non fermé" };
    const parsed = parsePlaceholder(template.slice(open + 2, close));
    if (typeof parsed === "string") return { ok: false, error: parsed };
    tokens.push(parsed);
    pos = close + 2;
  }
  return { ok: true, tokens };
}

/** Null when the template follows the grammar, the reason otherwise. */
export function templateError(template: unknown): string | null {
  const parsed = parseTemplate(template);
  return parsed.ok ? null : parsed.error;
}

/**
 * For a text that must be the same at every run and depend on its row alone
 * (the name of an ad, by which it is found again): null when the template
 * reads {{row.<column>}} only, the reason otherwise. The template is supposed
 * to follow the grammar (templateError first).
 */
export function rowOnlyTemplateError(template: Template): string | null {
  const parsed = parseTemplate(template);
  if (!parsed.ok) return parsed.error;
  const moving = parsed.tokens.find((t) => t.kind === "run.date" || t.kind === "step.text");
  if (!moving) return null;
  const motif = moving.kind === "step.text" ? `{{steps.${moving.stepId}.text}}` : "{{run.date}}";
  return `${motif} est refusé dans le nom d'une publicité. Ce nom ne dépend que de la ligne ({{row.<colonne>}}) : s'il changeait d'une exécution à l'autre, la même publicité serait créée une seconde fois`;
}

/** What a template reads. Throws on a template outside the grammar: validate first. */
export function templateRefs(template: Template): TemplateRefs {
  const parsed = parseTemplate(template);
  if (!parsed.ok) throw new Error(parsed.error);
  const columns = new Set<string>();
  const stepIds = new Set<string>();
  let runDate = false;
  for (const t of parsed.tokens) {
    if (t.kind === "row") columns.add(t.column);
    else if (t.kind === "step.text") stepIds.add(t.stepId);
    else if (t.kind === "run.date") runDate = true;
  }
  return { columns: [...columns], stepIds: [...stepIds], runDate };
}

function cellText(value: Cell | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/**
 * Renders a template and lists what it could not find (column absent from the
 * row, step without text). A missing value renders as an empty text; the
 * caller decides whether that is an error.
 */
export function renderTemplateDetailed(template: Template, scope: TemplateScope): { text: string; missing: string[] } {
  const parsed = parseTemplate(template);
  if (!parsed.ok) throw new Error(`Gabarit refusé : ${parsed.error}`);
  const missing: string[] = [];
  let text = "";
  for (const t of parsed.tokens) {
    if (t.kind === "text") text += t.value;
    else if (t.kind === "run.date") text += scope.runDate;
    else if (t.kind === "row") {
      const row = scope.row;
      if (!row || !own(row, t.column)) missing.push(`row.${t.column}`);
      else text += cellText(row[t.column]);
    } else {
      const out = own(scope.steps, t.stepId) ? scope.steps[t.stepId] : undefined;
      if (typeof out?.text !== "string") missing.push(`steps.${t.stepId}.text`);
      else text += out.text;
    }
  }
  return { text, missing };
}

export function renderTemplate(template: Template, scope: TemplateScope): string {
  return renderTemplateDetailed(template, scope).text;
}

/** Day of the run in the routine's timezone, YYYY-MM-DD. */
export function runDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Scope of a step handler: the run's date, the earlier outputs and, if any, the current row. */
export function scopeFromContext(ctx: Pick<StepContext, "now" | "routine" | "outputs">, row?: Row | null): TemplateScope {
  return { row: row ?? null, runDate: runDate(ctx.now, ctx.routine.timezone), steps: ctx.outputs };
}
