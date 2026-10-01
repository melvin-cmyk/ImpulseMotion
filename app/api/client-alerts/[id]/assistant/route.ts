/**
 * The AI that turns a consultant's sentence into an alert — staff only, and
 * only the person who created the alert: nobody else reads or writes its
 * conversation, not even an admin.
 *
 * GET  → the saved conversation ({ messages, proposals, checks, figures, blocked? })
 * PUT  → saves the conversation ({ messages, proposals }) and answers with the
 *        validation of every proposal it holds ({ checks })
 * POST → { messages } → SSE stream from the relay, with the prompt of
 *        lib/client-alerts/compose-prompt.ts. The AI has no tool: the figures
 *        of the client are read here and travel with the message.
 *
 * The AI writes nothing: its ```alert block is extracted, validated and
 * replayed over the last 30 days here (`checks`), the interface shows
 * « Valider » only for a proposal this route found valid, and the click goes
 * to POST /api/client-alerts/[id]/activate, which validates and replays
 * again. The only field of ClientAlert written here is chatJson.
 *
 * The accounts are the client's CURRENT ones the person may read
 * (lib/client-alerts/accounts.ts), not those frozen on the alert: it is what
 * lets an alert sent to `review` be proposed again on accounts that exist.
 * When the client itself is gone, nothing can be proposed (`blocked`).
 *
 * A lot (several clients ticked, one conversation — lib/client-alerts/lot.ts):
 * every client of the lot is read the same way, the AI gets them all, and
 * each proposal is validated and replayed client by client (`checks[key].lot`).
 * The proposal can be validated as soon as one client takes it; `blocked`
 * only when no client of the lot is reachable any more.
 *
 * The series are read once per request and never throw: an account that
 * cannot be read carries its `error`. When no account is readable the
 * conversation goes on — the AI is told it has no figures. A replay that
 * judged less than half of its days is not shown as a measure
 * (replayVerdict): the proposal waits (`retry`) when an account could not be
 * read, and is refused, with the reason, when the rule itself cannot be
 * judged on this client.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { relayStream, teeRelayStream } from "@/lib/relay-chat";
import { sanitizeThread, toRelayMessages, type ThreadMessage } from "@/lib/relay-attachments";
import { recordAiUsage } from "@/lib/ai-usage";
import { readClientSeries, summarizeSeries } from "@/lib/client-alerts/series";
import { backtest, replayVerdict } from "@/lib/client-alerts/backtest";
import { validateAlertProposal } from "@/lib/client-alerts/validate";
import { unreadText, usableAccounts } from "@/lib/client-alerts/accounts";
import { NOISY_MESSAGES, readDefinition, type AlertAccountRef, type AlertDefinition, type ClientSeries } from "@/lib/client-alerts/types";
import { checkLot, isLotLead, lotRefusal, readLot, type LotMember } from "@/lib/client-alerts/lot";
import { loadLotMembers, lotBlocked } from "@/lib/client-alerts/lot-members";
import {
  ALERT_CHAT_MAX_MESSAGES, ALERT_CHAT_MAX_MESSAGE_CHARS,
  buildAlertRelayBody, checkAlertProposal, extractAlertProposal, proposalKey,
} from "@/lib/client-alerts/compose-prompt";
import { ALERT_NOT_FOUND, OWNER_ONLY, alertAccess, readAccounts, type ProposalCheck } from "@/components/client-alerts/alert-model";

// One short answer without tool; the relay caps the session itself and ends cleanly with error+done.
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };
type Session = { userId: string; role?: string | null; baseRole?: string | null; user?: { email?: string | null } | null };

const PROPOSAL_STATUSES = new Set(["pending", "applied", "invalid"]);

const FIGURES_UNREADABLE = "Les chiffres du client n'ont pas pu être lus pour le moment : la proposition ne peut pas être vérifiée sur les 30 derniers jours. Réessayez dans quelques minutes.";
const REPLAY_FAILED = "La vérification sur les 30 derniers jours a échoué : la proposition ne peut pas être validée pour le moment. Réessayez dans quelques minutes.";

interface Figures { series: ClientSeries | null; summary: string | null }

/** The series of the alert's accounts, read once; never throws — no figures is a state the conversation lives with. */
async function readFigures(accounts: AlertAccountRef[]): Promise<Figures> {
  if (!accounts.length) return { series: null, summary: null };
  let series: ClientSeries;
  try {
    series = await readClientSeries(accounts);
  } catch (e) {
    console.error("[client-alerts] series unreadable", e);
    return { series: null, summary: null };
  }
  // No account readable: there is nothing for the AI to read — it is told so, rather than handed a table of dashes.
  if (!series.accounts.some((a) => !a.error && a.days.length > 0)) return { series, summary: null };
  try {
    return { series, summary: summarizeSeries(series) };
  } catch (e) {
    console.error("[client-alerts] summary failed", e);
    return { series, summary: null };
  }
}

function safeSummary(series: ClientSeries): string | null {
  try { return summarizeSeries(series, 1); } catch (e) { console.error("[client-alerts] summary failed", e); return null; }
}

/** What the page says of the figures: read until which day, and which accounts are missing. */
function figuresView(accounts: AlertAccountRef[], series: ClientSeries | null) {
  if (!series || !series.accounts.some((a) => !a.error && a.days.length > 0)) return { ok: false as const };
  const unreadable = series.accounts.filter((a) => a.error).map((a) => a.account.name);
  return { ok: true as const, until: series.until, accounts: accounts.length, unreadable };
}

/**
 * One entry per assistant message that carries (or tried to carry) a proposal:
 * validated against the accounts the client has today, then replayed with the
 * code the cron runs. `blocked` (the client is gone, or out of the person's
 * reach): nothing is judged, every proposal waits with that reason.
 */
function checksOf(
  messages: Array<{ role: string; content: string }>, accounts: AlertAccountRef[], series: ClientSeries | null, blocked: string | null = null,
): Record<string, ProposalCheck> {
  const out: Record<string, ProposalCheck> = {};
  for (const [i, m] of messages.entries()) {
    if (m.role !== "assistant") continue;
    const extracted = extractAlertProposal(m.content);
    if (extracted.kind === "none") continue;
    const key = proposalKey(i);
    if (extracted.kind === "malformed") { out[key] = { ok: false, errors: extracted.errors }; continue; }
    // Not the proposal's fault: what was known of it is kept (`retry`).
    if (blocked) { out[key] = { ok: false, errors: [blocked], retry: true }; continue; }
    if (!series) { out[key] = { ok: false, errors: [FIGURES_UNREADABLE], retry: true }; continue; }
    const check = checkAlertProposal(m.content, (input) => validateAlertProposal(input, { accounts, series }));
    if (check.kind !== "valid") {
      out[key] = check.kind === "invalid" ? { ok: false, errors: check.errors, hints: check.hints } : { ok: false, errors: ["Proposition illisible."] };
      continue;
    }
    try {
      const replay = backtest(check.proposal, series);
      // A replay that judged (almost) nothing is not a measure: it waits for an account, or the rule is refused.
      const verdict = replayVerdict(check.proposal, series, replay);
      if (verdict.kind === "wait") { out[key] = { ok: false, errors: [unreadText(verdict.unread)], retry: true }; continue; }
      if (verdict.kind === "refused") { out[key] = { ok: false, errors: [verdict.error], hints: [verdict.hint] }; continue; }
      out[key] = { ok: true, proposal: check.proposal, warnings: check.warnings, backtest: replay, noisy: replay.messages.length > NOISY_MESSAGES };
    } catch (e) {
      console.error("[client-alerts] backtest failed", e);
      out[key] = { ok: false, errors: [REPLAY_FAILED], retry: true };
    }
  }
  return out;
}

/** The same as checksOf, for a lot: every proposal judged on every client of the lot. */
function lotChecksOf(messages: Array<{ role: string; content: string }>, members: LotMember[], blocked: string | null): Record<string, ProposalCheck> {
  const out: Record<string, ProposalCheck> = {};
  for (const [i, m] of messages.entries()) {
    if (m.role !== "assistant") continue;
    const extracted = extractAlertProposal(m.content);
    if (extracted.kind === "none") continue;
    const key = proposalKey(i);
    if (extracted.kind === "malformed") { out[key] = { ok: false, errors: extracted.errors }; continue; }
    if (blocked) { out[key] = { ok: false, errors: [blocked], retry: true }; continue; }
    const { lot, accepted } = checkLot(extracted.raw, members, unreadText);
    const first = accepted[0];
    if (!first) {
      const refusal = lotRefusal(lot);
      out[key] = { ok: false, errors: refusal.errors, hints: refusal.hints, ...(refusal.retry ? { retry: true } : {}), lot };
      continue;
    }
    out[key] = {
      ok: true, proposal: first.definition, warnings: first.warnings, backtest: first.backtest,
      noisy: lot.clients.some((c) => c.noisy), lot,
    };
  }
  return out;
}

/** What the page says of the figures of a lot: until which day, and which clients could not be read. */
function lotFiguresView(members: LotMember[]) {
  const read = members.filter((m) => m.series && m.series.accounts.some((a) => !a.error && a.days.length > 0));
  if (!read.length) return { ok: false as const };
  const unreadable = members.filter((m) => !m.blocked && !read.includes(m)).map((m) => m.clientName);
  for (const m of read) {
    for (const a of m.series!.accounts) if (a.error) unreadable.push(`${m.clientName} · ${a.account.name}`);
  }
  const until = read.map((m) => m.series!.until).sort()[0];
  return { ok: true as const, until, accounts: read.reduce((n, m) => n + m.accounts.length, 0), unreadable };
}

/**
 * Statuses kept with the transcript. A proposal the server finds invalid is
 * stored as such, whatever was sent; one that could not be judged this time
 * keeps what was known of it.
 */
function sanitizeStatuses(raw: unknown, checks: Record<string, ProposalCheck>): Record<string, string> {
  const sent = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [key, check] of Object.entries(checks)) {
    const status = sent[key];
    const known = typeof status === "string" && PROPOSAL_STATUSES.has(status) && status !== "invalid" ? status : "pending";
    out[key] = check.ok || check.retry ? known : "invalid";
  }
  return out;
}

function sanitizeMessages(raw: unknown): ThreadMessage[] | null {
  // Sliding window: a long thread is shortened, never refused. No attachment here.
  const thread = sanitizeThread(raw, { maxMessages: ALERT_CHAT_MAX_MESSAGES, maxChars: ALERT_CHAT_MAX_MESSAGE_CHARS });
  return thread ? thread.map((m) => ({ role: m.role, content: m.content })) : null;
}

function readChat(chatJson: string | null | undefined): { messages: ThreadMessage[]; proposals: unknown } {
  try {
    const parsed = JSON.parse(chatJson || "{}");
    if (parsed && typeof parsed === "object") {
      return { messages: sanitizeMessages(parsed.messages) ?? [], proposals: parsed.proposals };
    }
  } catch { /* keep defaults */ }
  return { messages: [], proposals: {} };
}

/**
 * The alert, or the answer to give instead: unknown (or not visible to this person), or not theirs to talk to.
 * `accounts` = what a proposal may use today; `blocked` = why nothing can be proposed any more, when it is so.
 */
async function loadOwnAlert(id: string, session: Session) {
  const alert = await prisma.clientAlert.findUnique({ where: { id } });
  const access = alert ? alertAccess(session, alert) : null;
  if (!alert || !access) return { error: NextResponse.json({ error: ALERT_NOT_FOUND }, { status: 404 }) } as const;
  if (access !== "owner") return { error: NextResponse.json({ error: OWNER_ONLY }, { status: 403 }) } as const;
  if (isLotLead(alert)) {
    // Every client of the lot, with its figures: what the conversation of a lot is about.
    const members = await loadLotMembers(readLot(alert.groupJson), session);
    const lead = members.find((m) => m.alertClientId === alert.alertClientId) ?? members[0];
    return { alert, accounts: lead?.accounts ?? [], blocked: lotBlocked(members), lot: members } as const;
  }
  const usable = await usableAccounts(alert, readAccounts(alert.accountsJson), session);
  return { alert, accounts: usable.accounts, blocked: usable.state === "ok" ? null : usable.reason, lot: null } as const;
}

/** The clients of a lot as the page shows them: name, platforms, and why one is out of reach. */
function lotClients(loaded: Loaded) {
  if (!loaded.lot) return {};
  return {
    lot: loaded.lot.map((m) => ({
      alertClientId: m.alertClientId, clientName: m.clientName,
      platforms: [...new Set(m.accounts.map((a) => a.platform))], blocked: m.blocked ?? null,
    })),
  };
}

type Loaded = Exclude<Awaited<ReturnType<typeof loadOwnAlert>>, { error: unknown }>;

/** checks and figures of the conversation, for one client or for a lot. */
async function judge(loaded: Loaded, messages: Array<{ role: string; content: string }>) {
  if (loaded.lot) {
    return { checks: lotChecksOf(messages, loaded.lot, loaded.blocked), figures: lotFiguresView(loaded.lot) };
  }
  const { series } = await readFigures(loaded.accounts);
  return { checks: checksOf(messages, loaded.accounts, series, loaded.blocked), figures: figuresView(loaded.accounts, series) };
}

/** The rule in service for a lot: the lead's, or else the first alert of the lot that has one. */
async function lotCurrent(alert: { id: string; definitionJson: string }): Promise<AlertDefinition | null> {
  const own = readDefinition(alert.definitionJson);
  if (own) return own;
  const other = await prisma.clientAlert.findFirst({ where: { groupId: alert.id, NOT: { definitionJson: "{}" } }, orderBy: { updatedAt: "desc" }, select: { definitionJson: true } });
  return other ? readDefinition(other.definitionJson) : null;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const loaded = await loadOwnAlert(id, guard.session);
  if ("error" in loaded) return loaded.error;

  const chat = readChat(loaded.alert.chatJson);
  // Read even for an empty conversation: the figures are then ready when the first message is sent.
  const { checks, figures } = await judge(loaded, chat.messages);
  return NextResponse.json({
    messages: chat.messages, proposals: sanitizeStatuses(chat.proposals, checks), checks,
    // Nothing to read for an alert whose client is gone: the page says why instead.
    ...(loaded.blocked ? { blocked: loaded.blocked } : { figures }),
    ...lotClients(loaded),
  });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const loaded = await loadOwnAlert(id, guard.session);
  if ("error" in loaded) return loaded.error;

  const body = await req.json().catch(() => ({}));
  const messages = sanitizeMessages(body?.messages) ?? [];
  const { checks, figures } = await judge(loaded, messages);
  const proposals = sanitizeStatuses(body?.proposals, checks);
  await prisma.clientAlert.update({ where: { id }, data: { chatJson: JSON.stringify({ messages, proposals }) } });
  return NextResponse.json({
    ok: true, proposals, checks,
    ...(loaded.blocked ? { blocked: loaded.blocked } : { figures }),
    ...lotClients(loaded),
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const loaded = await loadOwnAlert(id, guard.session);
  if ("error" in loaded) return loaded.error;
  const { alert, accounts } = loaded;
  // No account left to talk about: the AI is not asked for an alert nobody could validate.
  if (loaded.blocked) return NextResponse.json({ error: loaded.blocked }, { status: 409 });

  const body = await req.json().catch(() => ({}));
  const messages = sanitizeMessages(body?.messages);
  if (!messages) return NextResponse.json({ error: "La conversation n'a pas pu être lue : rechargez la page, puis réessayez." }, { status: 400 });

  const summary = loaded.lot ? null : (await readFigures(accounts)).summary;
  // A lot: every client with its accounts and its figures in short (the day before, 7 and 30 days).
  const lot = loaded.lot?.map((m) => ({
    clientName: m.clientName, accounts: m.accounts, blocked: m.blocked ?? null,
    summary: m.series && m.series.accounts.some((a) => !a.error && a.days.length > 0) ? safeSummary(m.series) : null,
  })) ?? null;

  // Model, effort, servers, accounts and figures are decided here: nothing of them is read from the request.
  const res = await relayStream(buildAlertRelayBody({
    alert: { id: alert.id, status: alert.status },
    clientName: alert.clientName,
    accounts,
    seriesSummary: summary,
    current: loaded.lot ? await lotCurrent(alert) : readDefinition(alert.definitionJson),
    lot,
    userId: guard.session.userId,
    author: guard.session.user?.email ?? null,
    messages: toRelayMessages(messages),
  }));
  if (!res.ok || !res.body) return res;

  const ledger = teeRelayStream(res.body, async (_text, _done, usage) => {
    if (usage) await recordAiUsage(usage, {
      feature: "client_alert_compose",
      dashboardId: null,
      clientName: loaded.lot ? `${alert.clientName} + ${loaded.lot.length - 1} client(s)` : alert.clientName,
      user: { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role },
    });
  });
  return new Response(ledger, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
