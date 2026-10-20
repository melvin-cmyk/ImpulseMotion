/**
 * Copilote IA d'un dashboard du staff (propriétaire ou admin — jamais un client).
 *
 * GET  → le fil persistant de la personne ({ messages, proposals, seenHtmlHash })
 * PUT  → enregistre le fil ({ messages, proposals, seenHtmlHash })
 * POST → { messages, model?, effort?, account? } → flux SSE du relay, avec le
 *        prompt du copilote (lib/staff-dashboards/copilot.ts), l'état court du
 *        dashboard en `turnContext`, et la page entière dans le message quand
 *        l'IA ne l'a pas encore vue. L'en-tête X-Page-Hash dit quelle version
 *        de la page l'IA connaît après ce tour.
 * Les outils MCP de l'IA sont ceux du staff, sur le périmètre de comptes de la
 * personne (même règle que la console /ai), plus le bac à sable et n8n (le
 * consultant fait construire les automatisations qui alimentent sa page).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAllowedAccountIds } from "@/lib/acl";
import { CLIENT_DATA_SERVER, N8N_SERVER, SANDBOX_SERVER, STAFF_MCP_SERVERS } from "@/lib/mcp-whitelist";
import { staffDataScopeForAll } from "@/lib/staff-data-scope";
import { STAFF_CHAT_PROFILE } from "@/lib/ai-profiles";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { relayTakesTurnContext } from "@/lib/dashboard-copilot";
import { teeRelayStream, type RelayEffort, type RelayModel } from "@/lib/relay-chat";
import { sanitizeThread, toRelayMessages, type ThreadMessage } from "@/lib/relay-attachments";
import { recordAiUsage } from "@/lib/ai-usage";
import { parseDatasets, parseParams } from "@/lib/staff-dashboards/model";
import { buildStaffCopilotSystemPrompt, buildStaffCopilotTurnContext, staffCopilotSessionKey, withPageIfUnseen } from "@/lib/staff-dashboards/copilot";
import { catalogPromptText, loadStaffCatalog } from "@/lib/staff-dashboards/catalog";
import type { StaffDashboardState } from "@/lib/staff-dashboards/proposals";

export const maxDuration = 300;
const BUDGET_MS = 280_000;
const MAX_TURNS = 40;
const MODELS = new Set<RelayModel>(["sonnet", "opus", "fable"]);
const EFFORTS = new Set<RelayEffort>(["low", "medium", "high"]);
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const MAX_MESSAGES = 40;
// Les réponses portent des pages entières : un plafond bas amputerait les blocs à appliquer.
const MAX_MESSAGE_CHARS = 300_000;
const PROPOSAL_STATUSES = new Set(["pending", "applied", "refused", "failed", "invalid"]);

type Ctx = { params: Promise<{ id: string }> };

interface ThreadPayload { messages: ThreadMessage[]; proposals: Record<string, string>; seenHtmlHash: string | null }

async function loadEditable(id: string, session: { userId: string; role?: string | null }) {
  const row = await prisma.staffDashboard.findUnique({
    where: { id },
    select: { id: true, ownerId: true, title: true, description: true, datasetsJson: true, paramsJson: true, html: true },
  });
  if (!row) return { error: NextResponse.json({ error: "introuvable" }, { status: 404 }) };
  if (row.ownerId !== session.userId && session.role !== "admin") return { error: NextResponse.json({ error: "réservé au propriétaire" }, { status: 403 }) };
  return { row };
}

function toState(row: { title: string; description: string | null; datasetsJson: string; paramsJson: string; html: string }): StaffDashboardState {
  return {
    title: row.title,
    description: row.description ?? "",
    datasets: parseDatasets(row.datasetsJson).datasets,
    params: parseParams(row.paramsJson),
    html: row.html,
  };
}

function sanitizePayload(raw: unknown): ThreadPayload {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const proposals: Record<string, string> = {};
  if (p.proposals && typeof p.proposals === "object") {
    for (const [k, v] of Object.entries(p.proposals as Record<string, unknown>).slice(0, 600)) {
      if (typeof v === "string" && PROPOSAL_STATUSES.has(v) && k.length <= 40) proposals[k] = v;
    }
  }
  return {
    messages: sanitizeThread(p.messages, { maxMessages: MAX_MESSAGES, maxChars: MAX_MESSAGE_CHARS }) ?? [],
    proposals,
    seenHtmlHash: typeof p.seenHtmlHash === "string" && /^[a-z0-9]{1,8}-[0-9a-f]{8}$/.test(p.seenHtmlHash) ? p.seenHtmlHash : null,
  };
}

async function readThread(dashboardId: string, userId: string): Promise<ThreadPayload> {
  const t = await prisma.staffDashboardThread.findUnique({ where: { dashboardId_userId: { dashboardId, userId } }, select: { payload: true } });
  try { return sanitizePayload(JSON.parse(t?.payload ?? "{}")); } catch { return { messages: [], proposals: {}, seenHtmlHash: null }; }
}

async function writeThread(dashboardId: string, userId: string, payload: ThreadPayload): Promise<void> {
  const data = JSON.stringify(payload);
  await prisma.staffDashboardThread.upsert({
    where: { dashboardId_userId: { dashboardId, userId } },
    create: { dashboardId, userId, payload: data },
    update: { payload: data },
  });
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const loaded = await loadEditable(id, guard.session);
  if ("error" in loaded) return loaded.error;
  return NextResponse.json(await readThread(id, guard.session.userId), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const loaded = await loadEditable(id, guard.session);
  if ("error" in loaded) return loaded.error;
  const body = await req.json().catch(() => ({}));
  await writeThread(id, guard.session.userId, sanitizePayload(body));
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const loaded = await loadEditable(id, guard.session);
  if ("error" in loaded) return loaded.error;
  const { row } = loaded;

  const body = await req.json().catch(() => ({}));
  const messages = sanitizeThread(body.messages, { maxMessages: MAX_MESSAGES, maxChars: MAX_MESSAGE_CHARS });
  if (!messages || !messages.length || messages[messages.length - 1].role !== "user") return NextResponse.json({ error: "messages invalides" }, { status: 400 });

  const userId = guard.session.userId;
  const state = toState(row);
  const thread = await readThread(id, userId);
  // La page entière voyage dans le message quand l'IA ne connaît pas cette
  // version (premier tour, page modifiée à la main, ou par une proposition
  // appliquée sans que le navigateur ait pu le noter).
  const last = messages[messages.length - 1];
  const page = withPageIfUnseen(last.content, state.html, thread.seenHtmlHash);
  const relayMessages = toRelayMessages(messages);
  relayMessages[relayMessages.length - 1] = { ...relayMessages[relayMessages.length - 1], content: page.content };

  const [metaIds, googleIds, tiktokIds] = await Promise.all([
    getAllowedAccountIds(userId, "meta"),
    getAllowedAccountIds(userId, "google"),
    getAllowedAccountIds(userId, "tiktok"),
  ]);

  const model: RelayModel = MODELS.has(body.model) ? body.model : STAFF_CHAT_PROFILE.model;
  const effort: RelayEffort = EFFORTS.has(body.effort) ? body.effort : STAFF_CHAT_PROFILE.effort;
  // The team's catalogue of metrics and dimensions, after the cached static part of the prompt.
  const catalogText = catalogPromptText(await loadStaffCatalog().catch(() => ({ metrics: [], dimensions: [] })));
  const systemPrompt = buildStaffCopilotSystemPrompt(guard.session.user?.email ?? null, catalogText);
  // Warehouses of the e-commerce clients (closed key list pinned by the relay).
  const dataScope = await staffDataScopeForAll();
  const turnContext = buildStaffCopilotTurnContext(state);

  const relayBodyFor = (takesTurnContext: boolean) => ({
    messages: relayMessages,
    ...(takesTurnContext ? { systemPrompt, turnContext } : { systemPrompt: `${systemPrompt}\n\n${turnContext}` }),
    hqGuidance: "caller" as const,
    sessionKey: staffCopilotSessionKey(id, userId),
    model,
    effort,
    account: typeof body.account === "string" && ACCOUNT_RE.test(body.account) && body.account !== "auto" ? body.account : undefined,
    maxTurns: MAX_TURNS,
    budgetMs: BUDGET_MS,
    allowedServers: [...STAFF_MCP_SERVERS, SANDBOX_SERVER, N8N_SERVER, ...(dataScope ? [CLIENT_DATA_SERVER] : [])],
    ...(dataScope ? { dataScope } : {}),
    accountScope: { meta: metaIds, google: googleIds, tiktok: tiktokIds, unrestricted: guard.session.role === "admin" },
  });

  let lastError = "relay unreachable";
  for (const url of RELAY_URLS) {
    try {
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
      if (!health.ok) { lastError = `relay health ${health.status}`; continue; }
      const relayBody = relayBodyFor(relayTakesTurnContext(await health.json().catch(() => null)));
      const ctl = new AbortController();
      const headersTimer = setTimeout(() => ctl.abort(), 15000);
      let res: Response;
      try {
        res = await fetch(`${url}/api/chat`, { method: "POST", headers: relayHeaders(), body: JSON.stringify(relayBody), signal: ctl.signal });
      } finally {
        clearTimeout(headersTimer);
      }
      if (!res.ok || !res.body) {
        lastError = `relay ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
        continue;
      }
      const ledger = teeRelayStream(res.body, async (_text, _done, usage) => {
        if (page.pageSent) {
          // L'IA a maintenant vu cette version de la page : noté dans le fil,
          // même si le navigateur n'enregistre pas le sien.
          const current = await readThread(id, userId);
          if (current.seenHtmlHash !== page.hash) await writeThread(id, userId, { ...current, seenHtmlHash: page.hash });
        }
        if (usage) await recordAiUsage(usage, {
          feature: "copilot",
          clientName: `Dashboard staff : ${row.title}`,
          user: { id: userId, email: guard.session.user?.email, role: guard.session.role },
        });
      });
      return new Response(ledger, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Page-Hash": page.hash,
        },
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return NextResponse.json({ error: `Copilote indisponible (${lastError})` }, { status: 502 });
}
