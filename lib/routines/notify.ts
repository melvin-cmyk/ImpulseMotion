/**
 * Routines — messages sent by a run: Slack and e-mail, both delivered by n8n
 * (the app holds no Slack token and no mail credentials).
 *
 *   Slack   the webhook of the automatic alerts, already published
 *           (lib/auto-alerts/slack.ts, { kind: "digest", channel, text }).
 *   E-mail  the routines webhook (server/n8n/routines-notify.workflow.js):
 *           { version: 1, kind: "email", to, subject, text }, secret in
 *           X-Alert-Secret. Set by N8N_ROUTINES_WEBHOOK_URL; without it no
 *           e-mail step can be applied or run.
 *
 * No noise: a step sends ONE message per run, never one per row. The rows go
 * in the message as a short text table (renderTable), cut cleanly.
 *
 * One message is not asked by a step: the one that says a routine switched
 * itself off (notifyAutoDisabled). It goes to the agency's internal channel
 * for the client, the one the automatic alerts use, and nowhere else: the
 * application cannot write to a person, and a channel named in a routine may
 * be read by the client.
 *
 * Both senders take the WriteGuard of a live run and check it first.
 */

import { autoAlertWebhook, cleanChannel, postDigest } from "@/lib/auto-alerts/slack";
import { assertWriteGuard } from "@/lib/routines/write-guard-check";
import { MAX_EMAIL_RECIPIENTS, type Cell, type ErrorClass, type RowSet, type WriteGuard } from "@/lib/routines/types";

export const EMAIL_NOT_CONFIGURED = "envoi d'e-mail non configuré (N8N_ROUTINES_WEBHOOK_URL absent)";
export const SLACK_NOT_CONFIGURED = "envoi Slack non configuré (webhook n8n des alertes automatiques absent)";

export const MAX_SLACK_CHARS = 3500;
export const MAX_EMAIL_CHARS = 20_000;
export const MAX_SUBJECT_CHARS = 200;
export const TABLE_MAX_ROWS = 20;
export const TABLE_MAX_COLUMNS = 8;
const TABLE_MAX_CELL_CHARS = 28;

export class NotifyError extends Error {
  readonly errorClass: ErrorClass;
  constructor(message: string, errorClass: ErrorClass) {
    super(message);
    this.name = "NotifyError";
    this.errorClass = errorClass;
  }
}

export function notifyErrorClass(err: unknown): ErrorClass {
  return err instanceof NotifyError ? err.errorClass : "infra";
}

// ── Configuration ────────────────────────────────────────────────────────

export function routinesWebhook(env: Record<string, string | undefined> = process.env): { url: string; secret: string } | null {
  const url = env.N8N_ROUTINES_WEBHOOK_URL?.trim();
  if (!url || !/^https:\/\//.test(url)) return null;
  return { url, secret: (env.N8N_ROUTINES_WEBHOOK_SECRET || env.N8N_ALERT_WEBHOOK_SECRET || "").trim() };
}

export const emailConfigured = (): boolean => routinesWebhook() !== null;
export const slackConfigured = (): boolean => autoAlertWebhook() !== null;

// ── Validation ───────────────────────────────────────────────────────────

// Stricter than the alerts' check: no quote, angle bracket, comma or control character.
const EMAIL_RE = /^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/;

/** Lower-cased, deduplicated recipients, or why the list is refused. */
export function cleanRecipients(input: unknown): { ok: true; to: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: "au moins un destinataire est requis" };
  const to: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") return { ok: false, error: "adresse e-mail invalide" };
    const email = raw.trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email) || email.includes("..")) return { ok: false, error: `adresse e-mail invalide : ${email.slice(0, 80)}` };
    if (!to.includes(email)) to.push(email);
  }
  if (to.length > MAX_EMAIL_RECIPIENTS) return { ok: false, error: `au plus ${MAX_EMAIL_RECIPIENTS} destinataires` };
  return { ok: true, to };
}

/** Stored form of a Slack channel ("#c_client" or an id); null when invalid. */
export function cleanSlackChannel(input: unknown): string | null {
  return typeof input === "string" ? cleanChannel(input) : null;
}

// ── Text ─────────────────────────────────────────────────────────────────

/** Cuts on a line end when there is one in the last fifth, and says that it cut. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const mark = "\n… (message tronqué)";
  const room = Math.max(0, maxChars - mark.length);
  const head = text.slice(0, room);
  const lineEnd = head.lastIndexOf("\n");
  return (lineEnd > room * 0.8 ? head.slice(0, lineEnd) : head).trimEnd() + mark;
}

/**
 * A cell or a rendered text cannot ring a whole channel: <!channel>, <!here>,
 * <!everyone> and user or group mentions written in Slack's own syntax are
 * shown as plain text.
 */
export function defuseSlack(text: string): string {
  return text.replace(/<(?=[!@])/g, "&lt;");
}

/** One line for an e-mail subject: no line break (header injection), bounded. */
export function cleanSubject(text: string): string {
  const line = text.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return line.length > MAX_SUBJECT_CHARS ? `${line.slice(0, MAX_SUBJECT_CHARS - 1)}…` : line;
}

function cellText(value: Cell | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > TABLE_MAX_CELL_CHARS ? `${text.slice(0, TABLE_MAX_CELL_CHARS - 1)}…` : text;
}

/**
 * Rows as an aligned text table (monospace). At most `maxRows` rows and
 * TABLE_MAX_COLUMNS columns; what is left out is counted on the last line.
 * Empty text when there is nothing to show.
 */
export function renderTable(rows: RowSet | null | undefined, opts: { maxRows?: number; maxChars?: number } = {}): string {
  if (!rows || !rows.columns.length || !rows.rows.length) return "";
  const maxRows = Math.max(1, opts.maxRows ?? TABLE_MAX_ROWS);
  const maxChars = opts.maxChars ?? 2500;
  const columns = rows.columns.slice(0, TABLE_MAX_COLUMNS);
  const shown = rows.rows.slice(0, maxRows);
  const cells = shown.map((r) => columns.map((c) => cellText(r[c])));
  const head = columns.map((c) => cellText(c));
  const numeric = columns.map((c) => shown.every((r) => r[c] === null || r[c] === undefined || typeof r[c] === "number"));
  const width = columns.map((_, i) => Math.max(head[i].length, ...cells.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((v, i) => (numeric[i] ? v.padStart(width[i]) : v.padEnd(width[i]))).join("  ").trimEnd();

  const out = [line(head), width.map((w) => "-".repeat(w)).join("  ")];
  let kept = 0;
  for (const r of cells) {
    const next = line(r);
    // Room kept for the closing line.
    if (out.join("\n").length + next.length + 1 > maxChars - 80) break;
    out.push(next);
    kept++;
  }
  const notes: string[] = [];
  const hiddenRows = rows.rows.length - kept;
  if (hiddenRows > 0) notes.push(`${hiddenRows} ligne${hiddenRows > 1 ? "s" : ""} de plus${rows.truncated ? " au moins" : ""}`);
  else if (rows.truncated) notes.push("la source contient d'autres lignes");
  const hiddenColumns = rows.columns.length - columns.length;
  if (hiddenColumns > 0) notes.push(`${hiddenColumns} colonne${hiddenColumns > 1 ? "s" : ""} non affichée${hiddenColumns > 1 ? "s" : ""}`);
  if (notes.length) out.push(`… ${notes.join(", ")}`);
  return out.join("\n");
}

// ── Senders ──────────────────────────────────────────────────────────────

// Answers of Slack or n8n that a new attempt will not fix.
const SLACK_FUNCTIONAL = /channel_not_found|not_in_channel|is_archived|invalid_|restricted_action|msg_too_long|no_text|unauthorized|unknown kind|n8n 4\d\d/i;

/** One Slack message in one channel. */
export async function sendSlackMessage(guard: WriteGuard, input: { channel: string; text: string; routine: { id: string; name: string } }): Promise<void> {
  assertWriteGuard(guard);
  const channel = cleanSlackChannel(input.channel);
  if (!channel) throw new NotifyError("canal Slack invalide", "functional");
  if (!input.text.trim()) throw new NotifyError("message Slack vide", "functional");
  if (!slackConfigured()) throw new NotifyError(SLACK_NOT_CONFIGURED, "functional");
  try {
    await postDigest(channel, truncateText(defuseSlack(input.text), MAX_SLACK_CHARS), input.routine);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/channel_not_found|not_in_channel/i.test(message)) {
      throw new NotifyError(`canal Slack ${channel} introuvable ou fermé au bot (l'inviter dans le canal)`, "functional");
    }
    throw new NotifyError(`Slack : ${message.slice(0, 200)}`, SLACK_FUNCTIONAL.test(message) ? "functional" : "infra");
  }
}

/** One e-mail to at most five recipients, plain text. */
export async function sendEmail(guard: WriteGuard, input: { to: string[]; subject: string; text: string }): Promise<void> {
  assertWriteGuard(guard);
  const recipients = cleanRecipients(input.to);
  if (!recipients.ok) throw new NotifyError(recipients.error, "functional");
  const subject = cleanSubject(input.subject);
  if (!subject) throw new NotifyError("objet de l'e-mail vide", "functional");
  if (!input.text.trim()) throw new NotifyError("e-mail vide", "functional");
  const cfg = routinesWebhook();
  if (!cfg) throw new NotifyError(EMAIL_NOT_CONFIGURED, "functional");

  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.secret ? { "X-Alert-Secret": cfg.secret } : {}) },
      body: JSON.stringify({ version: 1, kind: "email", to: recipients.to, subject, text: truncateText(input.text, MAX_EMAIL_CHARS) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new NotifyError(`n8n injoignable : ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`, "infra");
  }
  const raw = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try { json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { /* plain text answer */ }
  if (res.ok && json.ok !== false) return;
  const detail = String(json.error ?? `n8n ${res.status}`).slice(0, 200);
  // 4xx: secret, payload or workflow not published — a new attempt changes nothing.
  const functional = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
  throw new NotifyError(`envoi d'e-mail refusé : ${detail}`, functional ? "functional" : "infra");
}

// ── Routine switched off ─────────────────────────────────────────────────

export interface AutoDisabledNotice {
  routine: { id: string; name: string; clientName: string };
  /** Consecutive functional failures that switched the routine off. */
  failures: number;
  lastError: string | null;
  /** Who activated or wrote the routine, as an e-mail address: said in the message, nobody is mentioned. */
  owner: string | null;
  /** Internal channel of the client (lib/routines/store.ts, internalChannelFor); null = none known. */
  channel: string | null;
}

const appUrl = () => (process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "https://app.impulse-analytics.com").replace(/\/$/, "");
const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function autoDisabledText(notice: Omit<AutoDisabledNotice, "channel">): string {
  const client = notice.routine.clientName.trim();
  return [
    `Routine arrêtée automatiquement : « ${oneLine(notice.routine.name, 120)} »${client && client !== "—" ? ` (client ${oneLine(client, 120)})` : ""}`,
    `${notice.failures} échecs de suite. Dernière erreur : ${notice.lastError ? oneLine(notice.lastError, 600) : "sans message"}`,
    "Elle ne s'exécutera plus : corriger avec l'IA, refaire un essai à blanc, puis l'activer de nouveau.",
    `${notice.owner ? `Activée par ${oneLine(notice.owner, 120)} · ` : ""}${appUrl()}/routines/${notice.routine.id}`,
  ].join("\n");
}

/**
 * ONE message when a routine switches itself off. Never throws: the outcome
 * is a sentence, kept with the event `auto_disabled`.
 */
export async function notifyAutoDisabled(guard: WriteGuard, notice: AutoDisabledNotice): Promise<{ sent: boolean; detail: string }> {
  const channel = notice.channel ? cleanSlackChannel(notice.channel) : null;
  if (!channel) return { sent: false, detail: "Aucun message envoyé : aucun canal Slack interne n'est connu pour ce client." };
  try {
    await sendSlackMessage(guard, { channel, text: autoDisabledText(notice), routine: { id: notice.routine.id, name: notice.routine.name } });
    return { sent: true, detail: `Message envoyé dans ${channel}.` };
  } catch (e) {
    return { sent: false, detail: `Message non envoyé dans ${channel} : ${oneLine(e instanceof Error ? e.message : String(e), 200)}` };
  }
}
