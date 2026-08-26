/**
 * Consultant copilot for a dashboard — staff only, never rendered for clients.
 *
 * GET  → latest persisted thread ({ messages })
 * PUT  → persist the transcript ({ messages })
 * POST → { messages } → SSE stream from the relay, with a system prompt
 *        describing the dashboard + the ```action proposal protocol.
 *        The AI's MCP access is scoped to the dashboard's accounts.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { buildCopilotSystemPrompt } from "@/lib/dashboard-copilot";
import { resolveBinding } from "@/lib/dashboard-widgets";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";

export const maxDuration = 120;

const MAX_MESSAGES = 40;
// Generous per-message cap: assistant replies with tables + action blocks can
// be long; a low cap silently amputates the very blocks the UI must parse.
const MAX_MESSAGE_CHARS = 20000;

async function loadDashboard(id: string) {
  return prisma.dashboard.findUnique({
    where: { id },
    include: {
      widgets: { orderBy: { position: "asc" } },
      user: { select: { name: true, email: true } },
    },
  });
}

function sanitizeMessages(raw: unknown): Array<{ role: "user" | "assistant"; content: string }> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  // Sliding window: long threads are truncated, never rejected — a hard
  // reject at 40 messages used to brick the copilot for the dashboard.
  const recent = raw.slice(-MAX_MESSAGES);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of recent) {
    const role = (m as Record<string, unknown>)?.role;
    const content = (m as Record<string, unknown>)?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    messages.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  return messages;
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

  const dashboard = await loadDashboard(id);
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const messages = sanitizeMessages(body.messages);
  if (!messages) return NextResponse.json({ error: "messages invalid" }, { status: 400 });

  const binding = await resolveBinding(dashboard.userId, dashboard);
  const systemPrompt = buildCopilotSystemPrompt(
    { ...dashboard, widgets: dashboard.widgets },
    dashboard.user.name ?? dashboard.user.email ?? "client",
  );

  const relayBody = {
    messages,
    systemPrompt,
    allowedServers: ["meta-ads-impulse", "mcp-google-ads", "mcp-google-analytics"],
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
      if (!res.ok) {
        lastError = `relay ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
        continue;
      }
      return new Response(res.body, {
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
