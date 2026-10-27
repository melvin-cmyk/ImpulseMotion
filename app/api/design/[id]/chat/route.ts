/**
 * POST /api/design/[id]/chat → a detached turn of the design's AI.
 *   body { message, images?, files?, model?, effort?, account? } → 202 { jobId }
 *
 * The relay starts the turn with the "figcraft" MCP server joined on the
 * design's file (its edit link travels in the request, never to the model),
 * so the model draws in the consultant's editor while they watch. The browser
 * follows the reply through GET /api/ai/jobs/[jobId]/events; the answer is
 * stored in the design's thread when the job ends (lib/ai-jobs.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { STAFF_CHAT_PROFILE } from "@/lib/ai-profiles";
import { HQ_SERVER } from "@/lib/mcp-whitelist";
import { isHqContextFresh } from "@/lib/hq-client-context";
import { sanitizeFiles, sanitizeImages } from "@/lib/relay-attachments";
import type { RelayChatBody, RelayEffort, RelayMessage, RelayModel } from "@/lib/relay-chat";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { workspaceIdFor } from "@/lib/relay-workspace";
import { runningJobCount, startAiJob } from "@/lib/ai-jobs";
import { loadDesign } from "@/lib/design/access";
import { designSessionKey, type DesignMessage } from "@/lib/design/model";
import { appendDesignMessages, parseDesignMessages } from "@/lib/design/thread";
import { buildDesignSystemPrompt, designUploadsNote } from "@/lib/design/prompt";

const MAX_RUNNING_JOBS_PER_USER = 3;
const MAX_HISTORY = 30;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_TURNS = 40;
/** Detached: a visual takes many tool calls; the browser is not holding a function open. */
const BUDGET_MS = 10 * 60_000;
const MODELS = new Set<RelayModel>(["sonnet", "opus", "fable"]);
const EFFORTS = new Set<RelayEffort>(["low", "medium", "high"]);
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

/** What is in the design's workspace right now (uploads/ and out/), from the relay. */
async function workspaceFiles(sessionKey: string): Promise<Array<{ name: string; path: string; bytes: number }>> {
  const ws = workspaceIdFor(sessionKey);
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/files/${ws}`, { headers: relayHeaders(), signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const json = (await res.json()) as { files?: Array<{ path: string; bytes: number }> };
      return (json.files ?? []).filter((f) => f.path.startsWith("uploads/")).map((f) => ({ name: f.path.slice("uploads/".length), path: f.path, bytes: f.bytes }));
    } catch { /* next url */ }
  }
  return [];
}

function toRelayHistory(history: DesignMessage[]): RelayMessage[] {
  return history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS), ...(m.images?.length ? { images: m.images } : {}) }));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const design = await loadDesign(id);
  if (!design) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { message?: unknown; images?: unknown; files?: unknown; model?: unknown; effort?: unknown; account?: unknown };
  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE_CHARS) : "";
  const images = sanitizeImages(body.images);
  const files = sanitizeFiles(body.files);
  if (!message && !images.length && !files.length) return NextResponse.json({ error: "message requis" }, { status: 400 });

  // One reply at a time on a design (the thread and the file are shared), a few per person.
  const running = await prisma.aiJob.findFirst({ where: { conversationId: design.id, surface: "design", status: "running" }, select: { id: true } });
  if (running) return NextResponse.json({ error: "Une réponse est déjà en cours sur ce design. Attendez qu'elle soit terminée.", jobId: running.id }, { status: 409 });
  if (await runningJobCount(guard.session.userId) >= MAX_RUNNING_JOBS_PER_USER) {
    return NextResponse.json({ error: `${MAX_RUNNING_JOBS_PER_USER} réponses sont déjà en cours sur votre compte. Attendez qu'une se termine.` }, { status: 429 });
  }

  const sessionKey = designSessionKey(design.id);
  const [uploads, dashboard] = await Promise.all([
    workspaceFiles(sessionKey),
    design.clientDashboardId
      ? prisma.dashboard.findUnique({ where: { id: design.clientDashboardId }, select: { name: true, hqContextMd: true, hqContextAt: true, hqSlug: true } })
      : Promise.resolve(null),
  ]);
  const clientBrief = dashboard && dashboard.hqSlug && isHqContextFresh(dashboard) ? dashboard.hqContextMd : null;
  const author = guard.session.user?.email ?? null;
  const kind = design.kind === "photocraft" ? "photocraft" : "figcraft";
  const systemPrompt = buildDesignSystemPrompt({ name: design.name, kind, clientName: dashboard?.name ?? design.clientDashboard?.name ?? null, clientBrief, author });

  const history = parseDesignMessages(design.messagesJson);
  const text = message || (images.length ? "(image jointe)" : "(fichiers déposés)");
  const userMessage: DesignMessage = { role: "user", content: text, at: new Date().toISOString(), author, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) };
  const relayMessages = toRelayHistory([...history, userMessage]);
  // The consultant's name and the uploads travel with the turn, not into storage.
  const last = relayMessages[relayMessages.length - 1];
  relayMessages[relayMessages.length - 1] = { ...last, content: `${last.content}\n\n${designUploadsNote(uploads)}${author ? `\n[Demande de ${author}]` : ""}` };

  const model: RelayModel = MODELS.has(body.model as RelayModel) ? (body.model as RelayModel) : STAFF_CHAT_PROFILE.model;
  const effort: RelayEffort = EFFORTS.has(body.effort as RelayEffort) ? (body.effort as RelayEffort) : STAFF_CHAT_PROFILE.effort;
  const account = typeof body.account === "string" && ACCOUNT_RE.test(body.account) && body.account !== "auto" ? body.account : undefined;

  const relayBody: RelayChatBody = {
    messages: relayMessages,
    systemPrompt,
    sessionKey,
    model,
    effort,
    ...(account ? { account } : {}),
    maxTurns: MAX_TURNS,
    budgetMs: BUDGET_MS,
    // The editor's tools, and the agency's memory for briefs and charters; no ads data here.
    allowedServers: [kind, HQ_SERVER],
    accountScope: {},
    ...(kind === "figcraft" ? { figcraft: { link: design.editLink } } : {}),
  };

  await appendDesignMessages(design.id, [userMessage]);
  const started = await startAiJob({
    relayBody,
    surface: "design",
    userId: guard.session.userId,
    conversationId: design.id,
    title: text,
    usageContext: {
      feature: "design_copilot",
      dashboardId: design.clientDashboardId,
      clientName: dashboard?.name ?? design.clientDashboard?.name ?? "Agence",
      user: { id: guard.session.userId, email: author, role: guard.session.role },
    },
  });
  if ("error" in started) {
    await appendDesignMessages(design.id, [{ role: "assistant", content: `_Le copilote n'a pas pu démarrer : ${started.error}_`, at: new Date().toISOString() }]);
    return NextResponse.json({ error: started.error }, { status: 502 });
  }
  return NextResponse.json({ jobId: started.jobId }, { status: 202 });
}
