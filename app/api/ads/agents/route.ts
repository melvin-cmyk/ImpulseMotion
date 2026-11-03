/**
 * Agents IA runs of a client (Motion's AI agent workflow runs). Staff only.
 *   GET ?accountKey=…[&creativeKey=…] → { runs } (30 latest; a run « running » for more than 5 min is shown failed)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { PLAYBOOK_KEY_RE } from "@/lib/ads-warehouse/playbook";
import { toRun } from "@/lib/ads-warehouse/agents";

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const accountKey = req.nextUrl.searchParams.get("accountKey") ?? "";
  if (!PLAYBOOK_KEY_RE.test(accountKey)) return NextResponse.json({ error: "accountKey attendu" }, { status: 400 });
  const creativeKey = req.nextUrl.searchParams.get("creativeKey");
  const rows = await prisma.adAgentRun.findMany({ where: { accountKey, ...(creativeKey ? { creativeKey: creativeKey.slice(0, 200) } : {}) }, orderBy: { createdAt: "desc" }, take: 30 });
  const stale = Date.now() - 5 * 60_000;
  const runs = rows.map((r) => (r.status === "running" && r.createdAt.getTime() < stale ? { ...r, status: "error", error: "L'analyse a été interrompue, relance l'agent." } : r)).map(toRun);
  return NextResponse.json({ runs }, { headers: { "Cache-Control": "private, no-store" } });
}
