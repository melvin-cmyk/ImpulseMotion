/**
 * POST /api/ads/copilot — one answer of the Analyse Ads copilot.
 * Body = the report query (as /api/ads/query) + { messages: [{role, content}], groupLabel?, clientName? }.
 * The server re-runs the query (scope-safe, fresh) to build the context, then
 * asks the relay (staff chat profile, no tools). Usage is recorded.
 */

import { NextRequest, NextResponse } from "next/server";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";
import { queryAds } from "@/lib/ads-warehouse/query";
import { buildAnalyseContext, buildAnalyseSystemPrompt } from "@/lib/ads-warehouse/copilot";
import { relayComplete, type RelayMessage } from "@/lib/relay-chat";
import { STAFF_CHAT_PROFILE } from "@/lib/ai-profiles";
import { recordAiUsage } from "@/lib/ai-usage";
import { requireStaff } from "@/lib/auth-helpers";

export const maxDuration = 120;
const MAX_HISTORY = 12;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const clone = req.clone();
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  const body = (await clone.json().catch(() => ({}))) as { messages?: Array<{ role: string; content: string }>; groupLabel?: string; clientName?: string };
  const history: RelayMessage[] = (body.messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()).slice(-MAX_HISTORY).map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 6000) }));
  if (!history.length || history[history.length - 1].role !== "user") return NextResponse.json({ error: "message requis" }, { status: 400 });

  const result = await queryAds({ ...parsed.q, limit: 40, offset: 0 });
  if (!result.rows.length) return NextResponse.json({ reply: "Le rapport est vide sur cette période : je n'ai rien à analyser. Élargis la période ou retire un filtre." });
  const context = buildAnalyseContext(parsed.q, result, { clientName: body.clientName?.slice(0, 80) ?? null, groupLabel: body.groupLabel?.slice(0, 40) ?? parsed.q.groupBy });
  const systemPrompt = `${buildAnalyseSystemPrompt()}\n\n=== RAPPORT AFFICHÉ ===\n${context}`;
  try {
    const reply = await relayComplete(
      { messages: history, systemPrompt, allowedServers: [], accountScope: {}, model: STAFF_CHAT_PROFILE.model, effort: STAFF_CHAT_PROFILE.effort, maxTurns: 1 },
      { maxMs: 100_000, onUsage: (usage) => void recordAiUsage(usage, { feature: "analyse_copilot", clientName: body.clientName ?? `meta:${parsed.q.accountIds.join(",")}`, user: { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "" } }) },
    );
    return NextResponse.json({ reply });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Copilote indisponible" }, { status: 502 });
  }
}
