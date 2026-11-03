/**
 * POST /api/ads/agents/run — runs an agent workflow on the client's account or
 * one creative. Same body and scope rules as /api/ads/query, plus
 * { accountKey, workflow, creativeKey?, input? }. Answers the finished run.
 */

import { NextRequest, NextResponse } from "next/server";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";
import { requireStaff } from "@/lib/auth-helpers";
import { PLAYBOOK_KEY_RE } from "@/lib/ads-warehouse/playbook";
import { runAgent } from "@/lib/ads-warehouse/agents";
import { AGENT_BY_KEY } from "@/lib/ads-warehouse/agents-catalog";

export const maxDuration = 180;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const b = (await req.clone().json().catch(() => ({}))) as { accountKey?: string; workflow?: string; creativeKey?: string; input?: string };
  const accountKey = String(b.accountKey ?? "");
  if (!PLAYBOOK_KEY_RE.test(accountKey)) return NextResponse.json({ error: "accountKey attendu" }, { status: 400 });
  const workflow = String(b.workflow ?? "");
  if (!AGENT_BY_KEY[workflow]) return NextResponse.json({ error: "Agent inconnu" }, { status: 400 });
  const creativeKey = b.creativeKey ? String(b.creativeKey).slice(0, 200) : null;
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  const run = await runAgent(parsed.q, accountKey, workflow, creativeKey, String(b.input ?? "").trim().slice(0, 600), { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "", name: guard.session.user?.name ?? "" });
  return NextResponse.json({ run });
}
