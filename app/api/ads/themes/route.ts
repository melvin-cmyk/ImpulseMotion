/**
 * POST /api/ads/themes — « Thèmes de message » (Motion's Messaging themes).
 * Body = /api/ads/query body + { accountKey, action: "list" | "analyze" }.
 * analyze: the AI files the client's creatives under themes (≈ 1 min), then
 * the list is returned. Staff only; accounts intersected with the scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";
import { analyzeThemes, listThemes } from "@/lib/ads-warehouse/themes";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const extra = (await req.clone().json().catch(() => ({}))) as { accountKey?: string; action?: string };
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  const accountKey = String(extra.accountKey ?? "");
  if (!/^(client|meta):[\w-]{3,80}$/.test(accountKey)) return NextResponse.json({ error: "client manquant" }, { status: 400 });
  if (extra.action === "analyze") {
    const guard = await requireStaff();
    if ("error" in guard) return guard.error;
    try {
      await analyzeThemes(parsed.q, accountKey, { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "" });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Analyse impossible" }, { status: 502 });
    }
  }
  return NextResponse.json(await listThemes(parsed.q, accountKey), { headers: { "Cache-Control": "private, no-store" } });
}
