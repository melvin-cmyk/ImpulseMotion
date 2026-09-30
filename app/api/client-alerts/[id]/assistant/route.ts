/**
 * The AI that turns a consultant's sentence into an alert — staff only, and
 * only the person who created the alert: nobody else reads or writes its
 * conversation, not even an admin.
 *
 * GET  → the saved conversation ({ messages, proposals, checks, figures })
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
 * The series are read once per request. When they cannot be read the
 * conversation goes on: the AI is told it has no figures, and the proposals
 * wait (`retry`) instead of being shown as wrong.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { relayStream, teeRelayStream } from "@/lib/relay-chat";
import { sanitizeThread, toRelayMessages, type ThreadMessage } from "@/lib/relay-attachments";
import { recordAiUsage } from "@/lib/ai-usage";
import { readClientSeries, summarizeSeries } from "@/lib/client-alerts/series";
import { backtest } from "@/lib/client-alerts/backtest";
import { validateAlertProposal } from "@/lib/client-alerts/validate";
import { NOISY_MESSAGES, readDefinition, type AlertAccountRef, type ClientSeries } from "@/lib/client-alerts/types";
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
  try {
    return { series, summary: summarizeSeries(series) };
  } catch (e) {
    console.error("[client-alerts] summary failed", e);
    return { series, summary: null };
  }
}

/** What the page says of the figures: read until which day, and which accounts are missing. */
function figuresView(accounts: AlertAccountRef[], series: ClientSeries | null) {
  if (!series) return { ok: false as const };
  const unreadable = series.accounts.filter((a) => a.error).map((a) => a.account.name);
  return { ok: true as const, until: series.until, accounts: accounts.length, unreadable };
}

/**
 * One entry per assistant message that carries (or tried to carry) a proposal:
 * validated against the alert's frozen accounts, then replayed with the code
 * the cron runs.
 */
function checksOf(messages: Array<{ role: string; content: string }>, accounts: AlertAccountRef[], series: ClientSeries | null): Record<string, ProposalCheck> {
  const out: Record<string, ProposalCheck> = {};
  for (const [i, m] of messages.entries()) {
    if (m.role !== "assistant") continue;
    const extracted = extractAlertProposal(m.content);
    if (extracted.kind === "none") continue;
    const key = proposalKey(i);
    if (extracted.kind === "malformed") { out[key] = { ok: false, errors: extracted.errors }; continue; }
    if (!series) { out[key] = { ok: false, errors: [FIGURES_UNREADABLE], retry: true }; continue; }
    const check = checkAlertProposal(m.content, (input) => validateAlertProposal(input, { accounts, series }));
    if (check.kind !== "valid") { out[key] = { ok: false, errors: check.kind === "invalid" ? check.errors : ["Proposition illisible."] }; continue; }
    try {
      const replay = backtest(check.proposal, series);
      out[key] = { ok: true, proposal: check.proposal, warnings: check.warnings, backtest: replay, noisy: replay.messages.length > NOISY_MESSAGES };
    } catch (e) {
      console.error("[client-alerts] backtest failed", e);
      out[key] = { ok: false, errors: [REPLAY_FAILED], retry: true };
    }
  }
  return out;
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

/** The alert, or the answer to give instead: unknown (or not visible to this person), or not theirs to talk to. */
async function loadOwnAlert(id: string, session: Session) {
  const alert = await prisma.clientAlert.findUnique({ where: { id } });
  const access = alert ? alertAccess(session, alert) : null;
  if (!alert || !access) return { error: NextResponse.json({ error: ALERT_NOT_FOUND }, { status: 404 }) } as const;
  if (access !== "owner") return { error: NextResponse.json({ error: OWNER_ONLY }, { status: 403 }) } as const;
  return { alert, accounts: readAccounts(alert.accountsJson) } as const;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const loaded = await loadOwnAlert(id, guard.session);
  if ("error" in loaded) return loaded.error;

  const chat = readChat(loaded.alert.chatJson);
  // Read even for an empty conversation: the figures are then ready when the first message is sent.
  const { series } = await readFigures(loaded.accounts);
  const checks = checksOf(chat.messages, loaded.accounts, series);
  return NextResponse.json({
    messages: chat.messages, proposals: sanitizeStatuses(chat.proposals, checks), checks,
    figures: figuresView(loaded.accounts, series),
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
  const { series } = await readFigures(loaded.accounts);
  const checks = checksOf(messages, loaded.accounts, series);
  const proposals = sanitizeStatuses(body?.proposals, checks);
  await prisma.clientAlert.update({ where: { id }, data: { chatJson: JSON.stringify({ messages, proposals }) } });
  return NextResponse.json({ ok: true, proposals, checks, figures: figuresView(loaded.accounts, series) });
}

export async function POST(req: NextRequest, { params }: Params) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const loaded = await loadOwnAlert(id, guard.session);
  if ("error" in loaded) return loaded.error;
  const { alert, accounts } = loaded;

  const body = await req.json().catch(() => ({}));
  const messages = sanitizeMessages(body?.messages);
  if (!messages) return NextResponse.json({ error: "messages invalid" }, { status: 400 });

  const { summary } = await readFigures(accounts);

  // Model, effort, servers, accounts and figures are decided here: nothing of them is read from the request.
  const res = await relayStream(buildAlertRelayBody({
    alert: { id: alert.id, status: alert.status },
    clientName: alert.clientName,
    accounts,
    seriesSummary: summary,
    current: readDefinition(alert.definitionJson),
    userId: guard.session.userId,
    author: guard.session.user?.email ?? null,
    messages: toRelayMessages(messages),
  }));
  if (!res.ok || !res.body) return res;

  const ledger = teeRelayStream(res.body, async (_text, _done, usage) => {
    if (usage) await recordAiUsage(usage, {
      feature: "client_alert_compose",
      dashboardId: null,
      clientName: alert.clientName,
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
