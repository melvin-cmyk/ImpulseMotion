/**
 * The AI that writes a routine with the consultant — whoever has access to the routines (lib/routines/access.ts).
 *
 * GET  → the saved conversation ({ messages, proposals, checks })
 * PUT  → saves the conversation ({ messages, proposals }) and answers with the
 *        validation of every proposal it holds ({ checks })
 * POST → { messages } → SSE stream from the relay, with the prompt of
 *        lib/routines/compose-prompt.ts. Read-only tools, scoped to the
 *        routine's accounts.
 *
 * The AI writes nothing: its ```routine block is extracted and validated here
 * (`checks`), the interface shows « Appliquer » only for a proposal this route
 * found valid, and the click goes to POST /api/routines/[id]/definition, which
 * validates again. The only field of Routine written here is chatJson.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRoutinesAccess } from "@/lib/routines/access";
import { bindingOutOfScope, getAccountScope } from "@/lib/scope";
import { relayStream, teeRelayStream } from "@/lib/relay-chat";
import { sanitizeThread, toRelayMessages, type ThreadMessage } from "@/lib/relay-attachments";
import { recordAiUsage } from "@/lib/ai-usage";
import { chatJsonWith, readRoutineContext } from "@/lib/routines/context";
import { proposalNotices } from "@/lib/routines/proposal-notices";
import { validateProposal, type ProposalContext } from "@/lib/routines/validate";
import { writesPlatform } from "@/lib/routines/steps";
import type { RoutineProposal } from "@/lib/routines/types";
import {
  ROUTINE_CHAT_MAX_MESSAGES, ROUTINE_CHAT_MAX_MESSAGE_CHARS,
  buildRoutineRelayBody, checkRoutineProposal, proposalKey, type ProposalValidator,
} from "@/lib/routines/compose-prompt";

// The relay caps the session itself and ends cleanly with error+done.
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };
type Session = { userId: string; role?: string | null; user?: { email?: string | null } | null };

const PROPOSAL_STATUSES = new Set(["pending", "applied", "refused", "failed", "invalid"]);

type Check =
  | { ok: true; proposal: RoutineProposal; writesPlatform: boolean; notices: string[] }
  | { ok: false; errors: string[] };

type Routine = { id: string; definitionJson: string; chatJson: string };

/** validateProposal answers { ok, value } (lot A); { ok, proposal }, the form first agreed on, is read too. */
const validatorFor = (context: ProposalContext): ProposalValidator => (input) => {
  const result = validateProposal(input, context) as
    | { ok: true; value?: RoutineProposal; proposal?: RoutineProposal }
    | { ok: false; errors: string[] };
  if (!result.ok) return { ok: false, errors: result.errors };
  const proposal = result.value ?? result.proposal;
  return proposal ? { ok: true, proposal } : { ok: false, errors: ["validation sans résultat"] };
};

/**
 * One entry per assistant message that carries (or tried to carry) a proposal.
 * Validated against what the routine has fixed (the Page chosen when it was
 * created), with what the proposal would change of what is already done.
 */
async function checksOf(routine: Routine, messages: Array<{ role: string; content: string }>): Promise<Record<string, Check>> {
  const out: Record<string, Check> = {};
  const validator = validatorFor({ pageId: readRoutineContext(routine.chatJson).page?.id ?? null });
  for (const [i, m] of messages.entries()) {
    if (m.role !== "assistant") continue;
    const check = checkRoutineProposal(m.content, validator);
    if (check.kind === "none") continue;
    out[proposalKey(i)] = check.kind === "valid"
      ? {
          ok: true, proposal: check.proposal, writesPlatform: writesPlatform(check.proposal.definition.steps),
          notices: await proposalNotices(routine, check.proposal.definition).catch(() => []),
        }
      : { ok: false, errors: check.errors };
  }
  return out;
}

/** Statuses kept with the transcript; a proposal the server finds invalid is stored as such, whatever was sent. */
function sanitizeStatuses(raw: unknown, checks: Record<string, Check>): Record<string, string> {
  const sent = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [key, check] of Object.entries(checks)) {
    const status = sent[key];
    if (!check.ok) out[key] = "invalid";
    else out[key] = typeof status === "string" && PROPOSAL_STATUSES.has(status) && status !== "invalid" ? status : "pending";
  }
  return out;
}

function sanitizeMessages(raw: unknown): ThreadMessage[] | null {
  // Sliding window: a long thread is shortened, never refused. No attachment here.
  const thread = sanitizeThread(raw, { maxMessages: ROUTINE_CHAT_MAX_MESSAGES, maxChars: ROUTINE_CHAT_MAX_MESSAGE_CHARS });
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

/** The routine, or the answer to give instead (unknown, or an account the session may not read). */
async function loadRoutine(id: string, session: Session) {
  const routine = await prisma.routine.findUnique({ where: { id } });
  if (!routine) return { error: NextResponse.json({ error: "Routine introuvable" }, { status: 404 }) } as const;
  const scope = await getAccountScope(session);
  if (bindingOutOfScope(scope, routine)) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  return { routine } as const;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const guard = await requireRoutinesAccess();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const loaded = await loadRoutine(id, guard.session);
  if ("error" in loaded) return loaded.error;

  const chat = readChat(loaded.routine.chatJson);
  const checks = await checksOf(loaded.routine, chat.messages);
  return NextResponse.json({ messages: chat.messages, proposals: sanitizeStatuses(chat.proposals, checks), checks });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const guard = await requireRoutinesAccess();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const loaded = await loadRoutine(id, guard.session);
  if ("error" in loaded) return loaded.error;

  const body = await req.json().catch(() => ({}));
  const messages = sanitizeMessages(body.messages) ?? [];
  const checks = await checksOf(loaded.routine, messages);
  const proposals = sanitizeStatuses(body.proposals, checks);
  // The Page chosen when the routine was created stays with the conversation it is meant for.
  await prisma.routine.update({ where: { id }, data: { chatJson: chatJsonWith(loaded.routine.chatJson, { messages, proposals }) } });
  return NextResponse.json({ ok: true, proposals, checks });
}

export async function POST(req: NextRequest, { params }: Params) {
  const guard = await requireRoutinesAccess();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const loaded = await loadRoutine(id, guard.session);
  if ("error" in loaded) return loaded.error;
  const { routine } = loaded;
  if (routine.status === "archived") return NextResponse.json({ error: "Cette routine est archivée." }, { status: 409 });

  const body = await req.json().catch(() => ({}));
  const messages = sanitizeMessages(body.messages);
  if (!messages) return NextResponse.json({ error: "messages invalid" }, { status: 400 });

  // Model, effort, servers and accounts are decided here: nothing of them is read from the request.
  const res = await relayStream(buildRoutineRelayBody({
    routine: { ...routine, page: readRoutineContext(routine.chatJson).page ?? null },
    userId: guard.session.userId,
    author: guard.session.user?.email ?? null,
    messages: toRelayMessages(messages),
  }));
  if (!res.ok || !res.body) return res;

  const ledger = teeRelayStream(res.body, async (_text, _done, usage) => {
    if (usage) await recordAiUsage(usage, {
      feature: "routine_compose",
      dashboardId: routine.dashboardId,
      clientName: routine.clientName,
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
