/**
 * POST /api/ads/playbook/propose — the AI reads the client's last 30 days and
 * proposes 3–5 learnings, stored « À valider » (Motion's « To Review »).
 * Same body and scope rules as /api/ads/query, plus { accountKey }.
 */

import { NextRequest, NextResponse } from "next/server";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";
import { requireStaff } from "@/lib/auth-helpers";
import { proposeLearnings, PLAYBOOK_KEY_RE } from "@/lib/ads-warehouse/playbook";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const extra = (await req.clone().json().catch(() => ({}))) as { accountKey?: string };
  const accountKey = String(extra.accountKey ?? "");
  if (!PLAYBOOK_KEY_RE.test(accountKey)) return NextResponse.json({ error: "accountKey attendu" }, { status: 400 });
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  try {
    const created = await proposeLearnings(parsed.q, accountKey, { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "", name: guard.session.user?.name ?? "" });
    return NextResponse.json({ created });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Proposition impossible" }, { status: 502 });
  }
}
