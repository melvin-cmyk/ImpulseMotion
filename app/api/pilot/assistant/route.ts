/**
 * POST /api/pilot/assistant — the AI a consultant talks to about one client
 * in Pilotage (staff only).
 *   body { clientId, messages, thread, focus?: { platform, accountId } }
 *   → SSE stream from the relay, with the prompt of lib/pilot/assistant.ts.
 *
 * The AI has no tool: the client's Meta and Google Ads accounts in the
 * person's scope are read here and travel with the message. It writes
 * nothing: its ```pilot blocks are read by the page, and a click prepares the
 * usual preview (POST /api/pilot/actions), which reads the platform again.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { relayStream, teeRelayStream } from "@/lib/relay-chat";
import { sanitizeThread, toRelayMessages } from "@/lib/relay-attachments";
import { recordAiUsage } from "@/lib/ai-usage";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { parseAlertAccounts } from "@/lib/auto-alerts/clients";
import { pilotAdapter } from "@/lib/pilot/adapters";
import { readContextAccount } from "@/lib/pilot/assistant-context";
import { PILOT_CHAT_MAX_MESSAGES, PILOT_CHAT_MAX_MESSAGE_CHARS, PILOT_MAX_ACCOUNTS, buildPilotRelayBody } from "@/lib/pilot/assistant";
import type { PilotPlatform } from "@/lib/pilot/ops";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  const thread = typeof body?.thread === "string" && /^[a-z0-9-]{4,40}$/i.test(body.thread) ? body.thread : "main";
  const messages = sanitizeThread(body?.messages, { maxMessages: PILOT_CHAT_MAX_MESSAGES, maxChars: PILOT_CHAT_MAX_MESSAGE_CHARS });
  if (!messages) return NextResponse.json({ error: "La conversation n'a pas pu être lue : rechargez la page, puis réessayez." }, { status: 400 });

  const client = clientId ? await prisma.alertClient.findUnique({ where: { id: clientId } }) : null;
  if (!client || client.gone) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  const scope = await getAccountScope(guard.session);
  const accounts = parseAlertAccounts(client.accountsJson)
    .filter((a): a is typeof a & { platform: PilotPlatform } => a.platform === "meta" || a.platform === "google")
    .filter((a) => platformAccountInScope(scope, a.platform, a.accountId));
  if (!accounts.length) return NextResponse.json({ error: "Aucun compte Meta ou Google Ads de ce client n'est dans votre périmètre." }, { status: 403 });

  // The account open on the page first; beyond PILOT_MAX_ACCOUNTS the others are left out (said to the AI by their absence).
  const focus = body?.focus && typeof body.focus === "object" ? body.focus as { platform?: string; accountId?: string } : null;
  const isFocus = (a: { platform: string; accountId: string }) => {
    const adapter = pilotAdapter(a.platform);
    return !!(focus && adapter && focus.platform === a.platform && adapter.accountKey(String(focus.accountId ?? "")) === adapter.accountKey(a.accountId));
  };
  const chosen = [...accounts].sort((a, b) => Number(isFocus(b)) - Number(isFocus(a))).slice(0, PILOT_MAX_ACCOUNTS);
  const context = await Promise.all(chosen.map((a) => readContextAccount({ platform: a.platform, accountId: a.accountId, name: a.name ?? a.accountId })));

  const today = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full", timeStyle: "short" });
  const res = await relayStream(buildPilotRelayBody({
    clientId: client.id, clientName: client.name, userId: guard.session.userId,
    author: guard.session.user?.email ?? null, thread, accounts: context, today,
    messages: toRelayMessages(messages.map((m) => ({ role: m.role, content: m.content }))),
  }));
  if (!res.ok || !res.body) return res;

  const ledger = teeRelayStream(res.body, async (_text, _done, usage) => {
    if (usage) await recordAiUsage(usage, {
      feature: "pilot_assistant", dashboardId: client.dashboardId ?? null, clientName: client.name,
      user: { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role },
    });
  });
  return new Response(ledger, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
