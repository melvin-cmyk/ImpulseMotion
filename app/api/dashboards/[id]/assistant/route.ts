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
const MAX_MESSAGE_CHARS = 8000;

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
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null;
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of raw) {
    const role = (m as Record<string, unknown>)?.role;
    const content = (m as Record<string, unknown>)?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    messages.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  return messages;
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
  try { messages = JSON.parse(thread?.messages ?? "[]"); } catch { /* keep [] */ }
  return NextResponse.json({ threadId: thread?.id ?? null, messages });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const dashboard = await prisma.dashboard.findUnique({ where: { id } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const messages = sanitizeMessages(body.messages) ?? [];

  const existing = await prisma.assistantThread.findFirst({
    where: { dashboardId: id },
    orderBy: { updatedAt: "desc" },
  });
  const thread = existing
    ? await prisma.assistantThread.update({
        where: { id: existing.id },
        data: { messages: JSON.stringify(messages) },
      })
    : await prisma.assistantThread.create({
        data: { dashboardId: id, userId: guard.session.userId, messages: JSON.stringify(messages) },
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

  for (const url of RELAY_URLS) {
    try {
      // Fast reachability preflight so unreachable URLs fail in ~1s, while the
      // actual chat stream gets the full window (a stream-long AbortSignal
      // would kill the SSE mid-response).
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
      if (!health.ok) continue;
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify(relayBody),
        signal: AbortSignal.timeout(110000),
      });
      if (!res.ok) continue;
      return new Response(res.body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    } catch {
      // try next relay URL
    }
  }
  return NextResponse.json({ error: "relay unreachable" }, { status: 502 });
}
