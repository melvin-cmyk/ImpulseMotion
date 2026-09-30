/**
 * Client alerts — private Slack messages, through n8n (the app holds no Slack token).
 *
 * One n8n workflow (server/n8n/client-alerts-dm.workflow.js), one webhook, two kinds of request:
 *   { kind: "lookup", email }            → the Slack member with this address, or null
 *   { kind: "dm", slackUserId, text }    → posts `text` in the private conversation with this member
 * Same shared secret as the other alerts (X-Alert-Secret).
 *
 * A private alert never lands in a channel: only member ids (U… / W…) are
 * accepted here, and the workflow checks it a second time.
 */

import { prisma } from "@/lib/prisma";
import type { SlackIdentity } from "@/lib/client-alerts/types";

/** Slack accepts far more, but a private alert that long is not an alert. */
export const MAX_DM_CHARS = 3500;
/** An address unknown to Slack is looked up again at most once a day. */
export const UNKNOWN_RECHECK_MS = 24 * 3_600_000;

const MEMBER_RE = /^[UW][A-Z0-9]{8,20}$/;
const EMAIL_RE = /^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9][a-z0-9.-]{0,251}\.[a-z]{2,}$/;

/**
 * n8n or Slack failed (as opposed to a refused input): nothing is known about the person.
 * `message` is what a consultant reads (the page, the card of a trigger that was not delivered);
 * `detail` is the technical cause — Slack's own code, the HTTP status — for the logs and the cron's answer only.
 */
export class SlackDmError extends Error {
  readonly detail: string;
  /**
   * The request left and nobody knows what became of it (no answer in time, an answer that says
   * nothing, a failure of the delivery service itself): the message may be in Slack. Anything
   * else — refused by Slack, refused by the service, service unreachable — was not delivered.
   */
  readonly uncertain: boolean;
  constructor(message: string, detail: string = message, uncertain = false) {
    super(message);
    this.name = "SlackDmError";
    this.detail = detail;
    this.uncertain = uncertain;
  }
}

/** The address given is the login of another person: their alerts would land in the wrong private conversation. */
export const ADDRESS_TAKEN = "Cette adresse est celle d'un autre compte ImpulseMotion.";
export class SlackAddressError extends Error {
  constructor(message: string = ADDRESS_TAKEN) {
    super(message);
    this.name = "SlackAddressError";
  }
}

const SERVICE = "le service d'envoi vers Slack";
/** Slack's codes a consultant may meet, in words; anything else is « Slack a refusé l'envoi ». */
const SLACK_WORDS: Record<string, string> = {
  users_not_found: "Slack ne connaît pas ce compte",
  user_not_found: "Slack ne connaît pas ce compte",
  channel_not_found: "Slack ne trouve pas la conversation privée avec ce compte",
  account_inactive: "ce compte Slack est désactivé",
  user_disabled: "ce compte Slack est désactivé",
  cannot_dm_bot: "ce compte Slack est un robot : il ne reçoit pas de message privé",
  missing_scope: "l'application Slack n'a pas encore le droit d'envoyer des messages privés",
  not_authed: "la connexion de l'application à Slack est à refaire",
  invalid_auth: "la connexion de l'application à Slack est à refaire",
  token_revoked: "la connexion de l'application à Slack est à refaire",
  token_expired: "la connexion de l'application à Slack est à refaire",
  ratelimited: "Slack limite les envois pour le moment",
  rate_limited: "Slack limite les envois pour le moment",
  unauthorized: `${SERVICE} a refusé la demande`,
};

/** A Slack member id — never a channel (C… / G…) nor a conversation (D…). */
export function isSlackMemberId(input: unknown): input is string {
  return typeof input === "string" && MEMBER_RE.test(input);
}

/** Trimmed, lower-cased address; null when it does not look like one. */
export function cleanEmail(input: unknown): string | null {
  const email = typeof input === "string" ? input.trim().toLowerCase() : "";
  return email && email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

export function dmWebhook(): { url: string; secret: string } | null {
  const explicit = process.env.N8N_DM_WEBHOOK_URL?.trim();
  const legacy = process.env.N8N_ALERT_WEBHOOK_URL?.trim();
  // Same n8n instance as the consultant alerts: only the path differs.
  const url = explicit || (legacy ? legacy.replace(/\/impulsemotion-alerts\/?$/, "/impulsemotion-dm") : "");
  if (!url || url === legacy) return null;
  return { url, secret: process.env.N8N_ALERT_WEBHOOK_SECRET?.trim() ?? "" };
}

/** The n8n webhook of the private messages is set. */
export function dmConfigured(): boolean {
  return dmWebhook() !== null;
}

async function call(body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const cfg = dmWebhook();
  if (!cfg) throw new SlackDmError("l'envoi des messages privés Slack n'est pas encore branché", "webhook n8n des messages privés non configuré");
  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.secret ? { "X-Alert-Secret": cfg.secret } : {}) },
      body: JSON.stringify({ version: 1, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new SlackDmError(timedOut ? `${SERVICE} ne répond pas` : `${SERVICE} est injoignable`, timedOut ? "n8n ne répond pas" : "n8n injoignable", timedOut);
  }
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* plain text answer */ }
  if (!json || typeof json !== "object" || Array.isArray(json)) json = {};
  if (!res.ok || json.ok === false) {
    // Slack's own code (users_not_found, missing_scope, channel_not_found…), and the scope it asks for.
    const slack = typeof json.error === "string" && json.error ? json.error : null;
    const needed = typeof json.needed === "string" && json.needed ? ` (${json.needed})` : "";
    const words = slack ? SLACK_WORDS[slack] ?? "Slack a refusé l'envoi" : `${SERVICE} a répondu par une erreur`;
    // Slack's own refusal, or a refusal of the service (secret, flow not published): nothing was posted.
    // A 5xx of the service without a word from Slack says nothing of what it did before failing.
    throw new SlackDmError(words, `${slack ?? `n8n ${res.status}`}${needed}`.slice(0, 200), !slack && res.status >= 500);
  }
  // An empty or foreign 200 is not a success: a message reported as sent must have been sent.
  if (json.ok !== true) throw new SlackDmError(`${SERVICE} a donné une réponse inattendue`, "réponse n8n inattendue", true);
  return json;
}

/** null = Slack knows nobody with this address. Throws when n8n or Slack fails. */
export async function lookupSlackUser(email: string): Promise<{ id: string; name: string | null } | null> {
  const address = cleanEmail(email);
  if (!address) throw new Error("adresse e-mail invalide");
  const res = await call({ kind: "lookup", email: address }, 15_000);
  if (res.user === null) return null;
  const user = (res.user && typeof res.user === "object" ? res.user : {}) as Record<string, unknown>;
  // Anything else than a member id is a failure, never « nobody »: the person would be marked unknown for a day.
  if (!isSlackMemberId(user.id)) throw new SlackDmError(`${SERVICE} a donné une réponse inattendue`, "réponse n8n inattendue");
  const name = typeof user.name === "string" ? user.name.trim().slice(0, 120) : "";
  return { id: user.id, name: name || null };
}

/** Cuts on a line (else a word), never inside a Slack link, and says it was cut. */
export function capDmText(text: string, max = MAX_DM_CHARS): string {
  const clean = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, max - 2);
  const line = cut.lastIndexOf("\n");
  const word = cut.lastIndexOf(" ");
  if (line >= max / 2) cut = cut.slice(0, line);
  else if (word >= max / 2) cut = cut.slice(0, word);
  const open = cut.lastIndexOf("<");
  if (open > cut.lastIndexOf(">")) cut = cut.slice(0, open);
  // Half of a surrogate pair left by a cut in the middle of a long word.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}\n…`;
}

export async function sendSlackDm(slackUserId: string, text: string): Promise<void> {
  if (!isSlackMemberId(slackUserId)) throw new Error("destinataire Slack invalide : un message privé ne part que vers un membre");
  const body = capDmText(text);
  if (!body) throw new Error("message vide");
  await call({ kind: "dm", slackUserId, text: body }, 15_000);
}

type SlackColumns = { email: string | null; slackEmail: string | null; slackUserId: string | null; slackCheckedAt: Date | null };

/** Pure: what the columns of User say. */
export function slackIdentityOf(user: SlackColumns): SlackIdentity {
  const email = user.slackEmail?.trim() || user.email?.trim() || null;
  // A stored value that is not a member id is treated as absent: it could never be written to.
  const slackUserId = isSlackMemberId(user.slackUserId) ? user.slackUserId : null;
  const checkedAt = user.slackCheckedAt ? user.slackCheckedAt.toISOString() : null;
  return { email, slackUserId, checkedAt, status: slackUserId ? "found" : checkedAt ? "unknown" : "unchecked" };
}

/**
 * Reads User, looks the address up in Slack when it has never been found (at most once a day when unknown,
 * always with `force`), stores the result. `email` replaces User.slackEmail first.
 *
 * A failure of n8n or Slack throws and stores nothing: « unknown » is only ever Slack's own answer.
 * An address that is the login of ANOTHER user is refused (SlackAddressError) and nothing is stored.
 */
export async function resolveSlackIdentity(userId: string, opts: { force?: boolean; email?: string | null } = {}): Promise<SlackIdentity> {
  const select = { email: true, slackEmail: true, slackUserId: true, slackCheckedAt: true } as const;
  const found = await prisma.user.findUnique({ where: { id: userId }, select });
  if (!found) throw new Error("utilisateur introuvable");
  let user: SlackColumns = found;

  if (opts.email !== undefined) {
    const given = String(opts.email ?? "").trim();
    const address = given ? cleanEmail(given) : null;
    if (given && !address) throw new Error("adresse e-mail invalide");
    const login = cleanEmail(user.email);
    // null or "" = back to the login address; the login address itself is not stored twice.
    const slackEmail = address && address !== login ? address : null;
    // A private alert goes to its creator: never to the Slack of another person of the application.
    if (slackEmail) {
      const other = await prisma.user.findFirst({ where: { email: { equals: slackEmail, mode: "insensitive" }, NOT: { id: userId } }, select: { id: true } });
      if (other) throw new SlackAddressError();
    }
    if (slackEmail !== (user.slackEmail ?? null)) {
      // What Slack said about the previous address says nothing about this one.
      const moved = (slackEmail ?? login) !== (cleanEmail(user.slackEmail) ?? login);
      const data = moved ? { slackEmail, slackUserId: null, slackCheckedAt: null } : { slackEmail };
      await prisma.user.update({ where: { id: userId }, data });
      user = { ...user, ...data };
    }
  }

  const identity = slackIdentityOf(user);
  if (identity.status === "found" && !opts.force) return identity;
  const address = cleanEmail(identity.email);
  if (!address) return { ...identity, slackUserId: null, status: "unknown" };
  const recent = user.slackCheckedAt !== null && Date.now() - user.slackCheckedAt.getTime() < UNKNOWN_RECHECK_MS;
  if (identity.status === "unknown" && recent && !opts.force) return identity;

  const member = await lookupSlackUser(address);
  const data = { slackUserId: member?.id ?? null, slackCheckedAt: new Date() };
  await prisma.user.update({ where: { id: userId }, data });
  // The name is what lets the person see Slack found the right account; it is not kept.
  return { ...slackIdentityOf({ ...user, ...data }), name: member?.name ?? null };
}
