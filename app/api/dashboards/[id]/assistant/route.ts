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
import { teeRelayStream, type RelayEffort, type RelayImage, type RelayMessage, type RelayModel } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";

// Long enough for a multi-step analysis (tools + sandbox); the relay caps the
// session itself (RELAY_CHAT_MAX_BUDGET_MS) and ends cleanly with error+done.
export const maxDuration = 300;
const COPILOT_BUDGET_MS = 280_000;
const COPILOT_MAX_TURNS = 40;

const MODELS = new Set<RelayModel>(["sonnet", "opus"]);
const EFFORTS = new Set<RelayEffort>(["low", "medium", "high"]);

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

// Image attachments: the browser downsizes them before upload (≤1600px JPEG),
// these caps are the server-side backstop (Vercel bodies are capped at 4.5 MB).
const IMAGE_MEDIA_TYPES = new Set<RelayImage["mediaType"]>(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_B64_CHARS = 2_000_000;
const MAX_IMAGES_PER_THREAD = 12;

function sanitizeImages(raw: unknown): RelayImage[] {
  if (!Array.isArray(raw)) return [];
  const out: RelayImage[] = [];
  for (const im of raw.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    const mediaType = (im as Record<string, unknown>)?.mediaType;
    const data = (im as Record<string, unknown>)?.data;
    const name = (im as Record<string, unknown>)?.name;
    if (typeof mediaType !== "string" || !IMAGE_MEDIA_TYPES.has(mediaType as RelayImage["mediaType"])) continue;
    if (typeof data !== "string" || !data || data.length > MAX_IMAGE_B64_CHARS || !/^[A-Za-z0-9+/=]+$/.test(data)) continue;
    out.push({ mediaType: mediaType as RelayImage["mediaType"], data, ...(typeof name === "string" ? { name: name.slice(0, 120) } : {}) });
  }
  return out;
}

/** Metadata of documents dropped in the sandbox workspace (display only — the
 *  relay finds the files by path, the note in the message text tells the AI). */
interface ThreadFile { name: string; path: string; bytes: number }
type ThreadMessage = RelayMessage & { files?: ThreadFile[] };

function sanitizeFiles(raw: unknown): ThreadFile[] {
  if (!Array.isArray(raw)) return [];
  const out: ThreadFile[] = [];
  for (const f of raw.slice(0, 8)) {
    const name = (f as Record<string, unknown>)?.name;
    const path = (f as Record<string, unknown>)?.path;
    const bytes = (f as Record<string, unknown>)?.bytes;
    if (typeof name !== "string" || typeof path !== "string" || !/^uploads\/[A-Za-z0-9._ \-()]{1,120}$/.test(path)) continue;
    out.push({ name: name.slice(0, 120), path, bytes: typeof bytes === "number" && bytes >= 0 ? Math.floor(bytes) : 0 });
  }
  return out;
}

function sanitizeMessages(raw: unknown): ThreadMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  // Sliding window: long threads are truncated, never rejected — a hard
  // reject at 40 messages used to brick the copilot for the dashboard.
  const recent = raw.slice(-MAX_MESSAGES);
  const messages: ThreadMessage[] = [];
  for (const m of recent) {
    const role = (m as Record<string, unknown>)?.role;
    const content = (m as Record<string, unknown>)?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    const images = role === "user" ? sanitizeImages((m as Record<string, unknown>).images) : [];
    const files = role === "user" ? sanitizeFiles((m as Record<string, unknown>).files) : [];
    messages.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS), ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) });
  }
  // Only the most recent images are kept in the thread — older ones would
  // otherwise pile up in the transcript (and in every replay).
  let budget = MAX_IMAGES_PER_THREAD;
  for (let i = messages.length - 1; i >= 0; i--) {
    const im = messages[i].images;
    if (!im) continue;
    if (budget <= 0) { delete messages[i].images; continue; }
    if (im.length > budget) messages[i].images = im.slice(0, budget);
    budget -= messages[i].images!.length;
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
  );

  // The consultant picks the model and the reasoning effort in the panel;
  // anything else falls back to the staff profile.
  const model: RelayModel = MODELS.has(body.model) ? body.model : STAFF_CHAT_PROFILE.model;
  const effort: RelayEffort = EFFORTS.has(body.effort) ? body.effort : STAFF_CHAT_PROFILE.effort;

  const relayBody = {
    // The relay only needs role/content/images; file metadata stays in the thread.
    messages: messages.map((m): RelayMessage => ({ role: m.role, content: m.content, ...(m.images ? { images: m.images } : {}) })),
    systemPrompt,
    sessionKey: `copilot:${dashboard.id}:${guard.session.userId}`,
    model,
    effort,
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
