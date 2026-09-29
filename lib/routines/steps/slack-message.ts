/**
 * Routines — slack.message: ONE message per run in one channel, whatever the
 * number of rows (owner's rule: no noise in Slack, never a message per row).
 *
 * The rows are shown, on request, as a short text table under the message
 * (includeTable). {{row.<column>}} reads the FIRST row received: it is meant
 * for plans that end on a single row (rows.limit 1, account level).
 *
 * A message that depends on rows (table, or {{row.…}}) is not sent when the
 * step receives none: the step is skipped, nothing is posted.
 *
 * Delivery by the n8n webhook of the automatic alerts (lib/routines/notify.ts).
 * In a dry run nothing is sent and the message is shown in `planned`.
 */

import {
  MAX_SLACK_CHARS, NotifyError, SLACK_NOT_CONFIGURED, cleanSlackChannel, defuseSlack, renderTable, sendSlackMessage, slackConfigured, truncateText,
} from "@/lib/routines/notify";
import { renderTemplateDetailed, scopeFromContext, templateError, templateRefs } from "@/lib/routines/template";
import { type Checked, done, errorMessage, failed, readStepBase, refuse } from "@/lib/routines/steps/sheet-read";
import type { PlannedWrite, RowSet, SlackMessageStep, StepContext, StepHandler, StepRunOutcome, Template } from "@/lib/routines/types";

export const MAX_SLACK_TEMPLATE_CHARS = 3000;

function validate(raw: unknown): Checked<SlackMessageStep> {
  const head = readStepBase(raw, "slack.message", ["channel", "text", "includeTable"]);
  if (!head.ok) return head;
  const channel = cleanSlackChannel(head.raw.channel);
  if (!channel) return refuse("canal Slack invalide (ex. #c_client ou C0123ABCD)");
  const bad = templateError(head.raw.text);
  if (bad) return refuse(`text : ${bad}`);
  const text = head.raw.text as string;
  if (!text.trim()) return refuse("text : message vide");
  if (text.length > MAX_SLACK_TEMPLATE_CHARS) return refuse(`text : ${MAX_SLACK_TEMPLATE_CHARS} caractères au plus`);
  const step: SlackMessageStep = { ...head.base, type: "slack.message", channel, text };
  if (head.raw.includeTable !== undefined) {
    if (typeof head.raw.includeTable !== "boolean") return refuse("includeTable : true ou false");
    step.includeTable = head.raw.includeTable;
  }
  return { ok: true, step };
}

export type Composed =
  | { kind: "message"; text: string; warnings: string[] }
  | { kind: "skip"; reason: string }
  | { kind: "error"; message: string };

/**
 * Text of the single message of a step (Slack or e-mail body): template
 * rendered on the first row, then the table. Shared with email.send.
 */
export function composeMessage(
  ctx: Pick<StepContext, "now" | "routine" | "outputs" | "input">,
  template: Template,
  opts: { includeTable: boolean; maxChars: number; table: (rows: RowSet, room: number) => string },
): Composed {
  let readsRow: boolean;
  try { readsRow = templateRefs(template).columns.length > 0; }
  catch (e) { return { kind: "error", message: errorMessage(e) }; }
  const rows = ctx.input;
  const empty = !rows || rows.rows.length === 0;
  if (empty && (readsRow || opts.includeTable)) {
    return { kind: "skip", reason: rows ? "Aucune ligne reçue : message non envoyé." : "L'étape ne reçoit aucune ligne : message non envoyé." };
  }

  let rendered: { text: string; missing: string[] };
  try { rendered = renderTemplateDetailed(template, scopeFromContext(ctx, empty ? null : rows.rows[0])); }
  catch (e) { return { kind: "error", message: errorMessage(e) }; }
  const lost = rendered.missing.filter((m) => m.startsWith("row."));
  if (lost.length) return { kind: "error", message: `${lost.map((m) => `« ${m.slice(4)} »`).join(", ")} absente des lignes reçues` };

  const warnings = rendered.missing.filter((m) => m.startsWith("steps.")).map((m) => `{{${m}}} est vide : l'étape citée n'a pas produit de texte.`);
  if (readsRow && rows && rows.rows.length > 1) warnings.push(`{{row.…}} lit la première des ${rows.rows.length} lignes reçues : un seul message est envoyé par exécution.`);

  let text = truncateText(rendered.text.trim(), opts.maxChars);
  if (opts.includeTable && rows) {
    const room = opts.maxChars - text.length - 10;
    const table = room > 200 ? opts.table(rows, room) : "";
    if (table) text = `${text}\n\n${table}`;
    else warnings.push("Tableau non joint : le message occupe déjà toute la place.");
  }
  if (!text.trim()) return { kind: "error", message: "message vide une fois le gabarit rendu" };
  return { kind: "message", text, warnings };
}

/** Skipped step: nothing sent, the reason as a warning. */
export function skipped(rowsIn: number, reason: string, output: StepRunOutcome["output"]): StepRunOutcome {
  return { status: "skipped", rowsIn, rowsOut: 0, output, planned: [], written: [], warnings: [reason] };
}

// Backticks of a cell would close the code block that holds the table.
const slackTable = (rows: RowSet, room: number) => {
  const table = renderTable(rows, { maxChars: room - 8 }).replace(/`/g, "'");
  return table ? `\`\`\`\n${table}\n\`\`\`` : "";
};

export const slackMessageHandler: StepHandler<SlackMessageStep> = {
  type: "slack.message",
  writes: "message",
  validate,

  async preflight(step) {
    return slackConfigured() ? [] : [{ stepId: step.id, severity: "error", message: SLACK_NOT_CONFIGURED }];
  },

  async run(step, ctx) {
    const rowsIn = ctx.input?.rows.length ?? 0;
    const through = ctx.input ? { rows: ctx.input } : {};
    if (!slackConfigured()) return failed(rowsIn, "functional", SLACK_NOT_CONFIGURED);
    const channel = cleanSlackChannel(step.channel);
    if (!channel) return failed(rowsIn, "functional", "canal Slack invalide");

    const composed = composeMessage(ctx, step.text, { includeTable: step.includeTable === true, maxChars: MAX_SLACK_CHARS, table: slackTable });
    if (composed.kind === "error") return failed(rowsIn, "functional", composed.message);
    if (composed.kind === "skip") return skipped(rowsIn, composed.reason, through);
    const text = defuseSlack(composed.text);
    const summary = `Message Slack dans ${channel}`;

    const planned: PlannedWrite[] = [{ target: "slack", summary, preview: { channel, text } }];

    if (!ctx.write) return done(rowsIn, 0, { output: through, warnings: composed.warnings, planned });
    try {
      await sendSlackMessage(ctx.write, { channel, text, routine: { id: ctx.routine.id, name: ctx.routine.name } });
    } catch (e) {
      return failed(rowsIn, e instanceof NotifyError ? e.errorClass : "functional", errorMessage(e), { output: through, planned, warnings: composed.warnings });
    }
    return done(rowsIn, 1, { output: through, planned, warnings: composed.warnings, written: [{ summary }] });
  },
};
