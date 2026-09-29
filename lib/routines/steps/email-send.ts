/**
 * Routines — email.send: ONE plain-text e-mail per run, five recipients at
 * most, delivered by the routines webhook of n8n
 * ({ version: 1, kind: "email", to, subject, text }, lib/routines/notify.ts).
 *
 * Without N8N_ROUTINES_WEBHOOK_URL the step is refused as soon as the
 * definition is applied (preflight), and fails the same way at run time, dry
 * run included: « envoi d'e-mail non configuré ».
 *
 * Same rules as slack.message for the rows: optional text table under the
 * body, {{row.<column>}} reads the first row, and a message that depends on
 * rows is not sent when there are none.
 */

import {
  MAX_EMAIL_CHARS, MAX_SUBJECT_CHARS, NotifyError, cleanRecipients, cleanSubject, emailProblem, renderTable, sendEmail,
} from "@/lib/routines/notify";
import { assertCanWrite } from "@/lib/routines/write-guard-check";
import { renderTemplateDetailed, scopeFromContext, templateError } from "@/lib/routines/template";
import { type Checked, done, errorMessage, failed, readStepBase, refuse } from "@/lib/routines/steps/sheet-read";
import { composeMessage, skipped } from "@/lib/routines/steps/slack-message";
import type { EmailSendStep, PlannedWrite, StepHandler } from "@/lib/routines/types";

export const MAX_BODY_TEMPLATE_CHARS = 5000;

function validate(raw: unknown): Checked<EmailSendStep> {
  const head = readStepBase(raw, "email.send", ["to", "subject", "body", "includeTable"]);
  if (!head.ok) return head;
  const recipients = cleanRecipients(head.raw.to);
  if (!recipients.ok) return refuse(`to : ${recipients.error}`);
  const badSubject = templateError(head.raw.subject);
  if (badSubject) return refuse(`subject : ${badSubject}`);
  const subject = head.raw.subject as string;
  if (!subject.trim()) return refuse("subject : objet vide");
  if (subject.length > MAX_SUBJECT_CHARS || /[\r\n]/.test(subject)) return refuse(`subject : une seule ligne de ${MAX_SUBJECT_CHARS} caractères au plus`);
  const badBody = templateError(head.raw.body);
  if (badBody) return refuse(`body : ${badBody}`);
  const body = head.raw.body as string;
  if (!body.trim()) return refuse("body : message vide");
  if (body.length > MAX_BODY_TEMPLATE_CHARS) return refuse(`body : ${MAX_BODY_TEMPLATE_CHARS} caractères au plus`);
  const step: EmailSendStep = { ...head.base, type: "email.send", to: recipients.to, subject, body };
  if (head.raw.includeTable !== undefined) {
    if (typeof head.raw.includeTable !== "boolean") return refuse("includeTable : true ou false");
    step.includeTable = head.raw.includeTable;
  }
  return { ok: true, step };
}

export const emailSendHandler: StepHandler<EmailSendStep> = {
  type: "email.send",
  writes: "message",
  validate,

  async preflight(step) {
    const problem = emailProblem();
    return problem ? [{ stepId: step.id, severity: "error", message: problem }] : [];
  },

  async run(step, ctx) {
    const rowsIn = ctx.input?.rows.length ?? 0;
    const through = ctx.input ? { rows: ctx.input } : {};
    const problem = emailProblem();
    if (problem) return failed(rowsIn, "functional", problem);
    const recipients = cleanRecipients(step.to);
    if (!recipients.ok) return failed(rowsIn, "functional", recipients.error);

    const composed = composeMessage(ctx, step.body, {
      includeTable: step.includeTable === true, maxChars: MAX_EMAIL_CHARS,
      table: (rows, room) => renderTable(rows, { maxRows: 50, maxChars: Math.min(room, 8000) }),
    });
    if (composed.kind === "error") return failed(rowsIn, "functional", `body : ${composed.message}`);
    if (composed.kind === "skip") return skipped(rowsIn, composed.reason, through);

    let subject: string;
    try {
      const first = ctx.input?.rows[0] ?? null;
      const rendered = renderTemplateDetailed(step.subject, scopeFromContext(ctx, first));
      const lost = rendered.missing.filter((m) => m.startsWith("row."));
      if (lost.length) return failed(rowsIn, "functional", `subject : ${lost.map((m) => `« ${m.slice(4)} »`).join(", ")} absente des lignes reçues`);
      subject = cleanSubject(rendered.text);
    } catch (e) {
      return failed(rowsIn, "functional", `subject : ${errorMessage(e)}`);
    }
    if (!subject) return failed(rowsIn, "functional", "subject : objet vide une fois le gabarit rendu");

    const to = recipients.to;
    const summary = `E-mail à ${to.join(", ")}`;
    const planned: PlannedWrite[] = [{ target: "email", summary, preview: { to: to.join(", "), subject, text: composed.text } }];
    if (!ctx.write) return done(rowsIn, 0, { output: through, warnings: composed.warnings, planned, counts: { messages: 1 } });
    try {
      assertCanWrite(ctx);
      await sendEmail(ctx.write, { to, subject, text: composed.text });
    } catch (e) {
      return failed(rowsIn, e instanceof NotifyError ? e.errorClass : "functional", errorMessage(e), { output: through, warnings: composed.warnings });
    }
    return done(rowsIn, 1, { output: through, warnings: composed.warnings, written: [{ summary, target: "email" }], counts: { messages: 1 } });
  },
};
