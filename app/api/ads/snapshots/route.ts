/**
 * Analyse Ads snapshots (public share links, Motion's « Snapshot »).
 * POST — same body as /api/ads/query + { title, emoji, description,
 * clientName, accountKey, metrics, columns, cardKeys, ratio }: freezes the
 * report and returns { id, url }. GET ?accountKey= — the client's live links.
 * Staff only; accounts intersected with the viewer's scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";
import { createSnapshot, listSnapshots } from "@/lib/ads-warehouse/snapshots";
import type { MetricKey } from "@/lib/ads-warehouse/query";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const extra = (await req.clone().json().catch(() => ({}))) as { title?: string; emoji?: string; description?: string; clientName?: string; accountKey?: string | null; metrics?: MetricKey[]; columns?: MetricKey[]; cardKeys?: string[]; ratio?: string };
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  if (!parsed.q.accountIds.length) return NextResponse.json({ error: "aucun compte dans le périmètre" }, { status: 400 });
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const ratio = extra.ratio === "4:5" || extra.ratio === "1:1" ? extra.ratio : "9:16";
  const id = await createSnapshot(parsed.q, {
    title: String(extra.title ?? "Rapport"), emoji: String(extra.emoji ?? "🏆"), description: String(extra.description ?? ""),
    clientName: String(extra.clientName ?? ""), accountKey: extra.accountKey ?? null,
    createdById: guard.session.userId, createdByName: guard.session.user?.name ?? guard.session.user?.email ?? "",
  }, { metrics: (extra.metrics ?? []).slice(0, 6), columns: (extra.columns ?? []).slice(0, 40), cardKeys: (extra.cardKeys ?? []).slice(0, 60), ratio });
  return NextResponse.json({ id, url: `${req.nextUrl.origin}/s/${id}` });
}

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const accountKey = req.nextUrl.searchParams.get("accountKey");
  if (!accountKey) return NextResponse.json({ snapshots: [] });
  return NextResponse.json({ snapshots: await listSnapshots(accountKey) }, { headers: { "Cache-Control": "private, no-store" } });
}
