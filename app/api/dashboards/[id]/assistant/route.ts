/**
 * Consultant copilot for a dashboard — staff only, never rendered for clients.
 *
 * GET  → latest persisted thread ({ messages })
 * PUT  → persist the transcript ({ messages })
 * POST → { messages } → SSE stream from the relay, with a system prompt
 *        describing the dashboard + the ```action proposal protocol.
 *        The AI's MCP access is scoped to the dashboard's accounts.
 */

import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { buildCopilotSystemPrompt } from "@/lib/dashboard-copilot";
import { resolveBinding } from "@/lib/dashboard-widgets";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { SANDBOX_SERVER, STAFF_MCP_SERVERS } from "@/lib/mcp-whitelist";
import { STAFF_CHAT_PROFILE } from "@/lib/ai-profiles";
import { teeRelayStream, type RelayEffort, type RelayModel } from "@/lib/relay-chat";
import { sanitizeThread, toRelayMessages, type ThreadMessage } from "@/lib/relay-attachments";
import { recordAiUsage } from "@/lib/ai-usage";

// Long enough for a multi-step analysis (tools + sandbox); the relay caps the
// session itself (RELAY_CHAT_MAX_BUDGET_MS) and ends cleanly with error+done.
export const maxDuration = 300;
const COPILOT_BUDGET_MS = 280_000;
const COPILOT_MAX_TURNS = 40;

const MODELS = new Set<RelayModel>(["sonnet", "opus", "fable"]);
const EFFORTS = new Set<RelayEffort>(["low", "medium", "high"]);
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

const MAX_MESSAGES = 40;
// Generous per-message cap: assistant replies with tables + action blocks can
// be long; a low cap silently amputates the very blocks the UI must parse.
const MAX_MESSAGE_CHARS = 20000;

async function loadDashboard(id: string) {
  return prisma.dashboard.findUnique({
    where: { id },
    include: {
      widgets: { orderBy: { position: "asc" } },
      pages: { orderBy: { position: "asc" }, select: { id: true, name: true, position: true } },
      user: { select: { name: true, email: true } },
    },
  });
}

function sanitizeMessages(raw: unknown): ThreadMessage[] | null {
  // Sliding window: long threads are truncated, never rejected — a hard
  // reject at 40 messages used to brick the copilot for the dashboard.
  return sanitizeThread(raw, { maxMessages: MAX_MESSAGES, maxChars: MAX_MESSAGE_CHARS });
}

/** Proposal statuses persisted alongside the transcript so Appliqué/Refusé
 *  survive page reloads. Kept small and validated. */
function sanitizeProposals(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  const VALID = new Set(["pending", "applied", "refused", "failed", "invalid"]);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 400)) {
    if (typeof value === "string" && VALID.has(value) && key.length <= 40) out[key] = value;
  }
  return out;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;

  const thread = await prisma.assistantThread.findFirst({
    where: { dashboardId: id },
    orderBy: { updatedAt: "desc" },
  });
  let messages: unknown = [];
  let proposals: Record<string, string> = {};
  try {
    const parsed = JSON.parse(thread?.messages ?? "[]");
    if (Array.isArray(parsed)) {
      messages = parsed; // legacy format: bare array
    } else if (parsed && typeof parsed === "object") {
      messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      proposals = sanitizeProposals(parsed.proposals);
    }
  } catch { /* keep defaults */ }
  return NextResponse.json({ threadId: thread?.id ?? null, messages, proposals });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;

  const dashboard = await prisma.dashboard.findUnique({ where: { id } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const messages = sanitizeMessages(body.messages) ?? [];
  const proposals = sanitizeProposals(body.proposals);
  const payload = JSON.stringify({ messages, proposals });

  const existing = await prisma.assistantThread.findFirst({
    where: { dashboardId: id },
    orderBy: { updatedAt: "desc" },
  });
  const thread = existing
    ? await prisma.assistantThread.update({
        where: { id: existing.id },
        data: { messages: payload },
      })
    : await prisma.assistantThread.create({
        data: { dashboardId: id, userId: guard.session.userId, messages: payload },
      });
  return NextResponse.json({ threadId: thread.id });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;

  const dashboard = await loadDashboard(id);
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const messages = sanitizeMessages(body.messages);
  if (!messages) return NextResponse.json({ error: "messages invalid" }, { status: 400 });

  const binding = await resolveBinding(dashboard.userId, dashboard);
  const systemPrompt = buildCopilotSystemPrompt(
    { ...dashboard, widgets: dashboard.widgets, pages: dashboard.pages },
    dashboard.user.name ?? dashboard.user.email ?? "client",
    // The cached HQ brief (7-day TTL, lib/hq-client-context.ts) replaces a
    // live HQ exploration on every question about the client.
    dashboard.hqSlug && dashboard.hqContextMd ? { slug: dashboard.hqSlug, brief: dashboard.hqContextMd } : null,
    guard.session.user?.email ?? null,
  );

  // The consultant picks the model and the reasoning effort in the panel;
  // anything else falls back to the staff profile.
  const model: RelayModel = MODELS.has(body.model) ? body.model : STAFF_CHAT_PROFILE.model;
  const effort: RelayEffort = EFFORTS.has(body.effort) ? body.effort : STAFF_CHAT_PROFILE.effort;

  const relayBody = {
    // The relay only needs role/content/images; file metadata stays in the thread.
    messages: toRelayMessages(messages),
    systemPrompt,
    sessionKey: `copilot:${dashboard.id}:${guard.session.userId}`,
    model,
    effort,
    account: typeof body.account === "string" && ACCOUNT_RE.test(body.account) && body.account !== "auto" ? body.account : undefined,
    maxTurns: COPILOT_MAX_TURNS,
    budgetMs: COPILOT_BUDGET_MS,
    // Staff-only route: ads servers (scoped to this dashboard below), HQ
    // read-only, Sheets, web, and the Python sandbox (workspace = this
    // conversation, see files/[...path]/route.ts for its outputs).
    allowedServers: [...STAFF_MCP_SERVERS, SANDBOX_SERVER],
    accountScope: {
      meta: binding.metaAccountId ? [binding.metaAccountId] : [],
      google: binding.googleCustomerId ? [binding.googleCustomerId] : [],
    },
  };

  let lastError = "relay unreachable";
  for (const url of RELAY_URLS) {
    try {
      // Reachability preflight so dead URLs fail fast (generous timeout for a
      // tunnel that may need a cold start).
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
      if (!health.ok) { lastError = `relay health ${health.status}`; continue; }

      // Headers-only timeout: AbortSignal.timeout on the fetch would ALSO
      // govern the streamed body and cut long copilot sessions mid-reply
      // (truncated ```action blocks = "nothing gets saved"). The session time
      // budget lives in the relay, which ends cleanly with error+done events.
      const ctl = new AbortController();
      const headersTimer = setTimeout(() => ctl.abort(), 15000);
      let res: Response;
      try {
        res = await fetch(`${url}/api/chat`, {
          method: "POST",
          headers: relayHeaders(),
          body: JSON.stringify(relayBody),
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(headersTimer);
      }
      if (!res.ok || !res.body) {
        lastError = `relay ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
        continue;
      }
      const ledger = teeRelayStream(res.body, async (_text, _done, usage) => {
        if (usage) await recordAiUsage(usage, {
          feature: "copilot",
          dashboardId: dashboard.id,
          clientName: dashboard.name,
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
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return NextResponse.json({ error: `Copilote indisponible (${lastError})` }, { status: 502 });
}
