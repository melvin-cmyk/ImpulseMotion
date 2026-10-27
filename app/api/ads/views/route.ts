/**
 * Saved reports of Analyse Ads v2 (AnalyseView).
 *   GET  ?accountKey=meta:123 → the client's saved reports (+ agency templates stored with accountKey null)
 *   POST { accountKey, name, emoji?, config } → create
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope, dashboardIdInScope, type AccountScope } from "@/lib/scope";
import { isViewConfig } from "@/lib/ads-warehouse/views";

/** "meta:123" (one platform account) or "client:<dashboardId>" (the whole client). */
function parseKey(key: string | null): { platform: string; accountId: string } | null {
  const m = (key ?? "").match(/^(meta|google|tiktok|linkedin|client):([\w-]{3,40})$/);
  return m ? { platform: m[1], accountId: m[2] } : null;
}
async function keyInScope(scope: AccountScope, key: { platform: string; accountId: string }): Promise<boolean> {
  return key.platform === "client" ? dashboardIdInScope(scope, key.accountId) : platformAccountInScope(scope, key.platform, key.accountId);
}

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const key = parseKey(req.nextUrl.searchParams.get("accountKey"));
  if (!key) return NextResponse.json({ error: "accountKey attendu (ex. meta:123)" }, { status: 400 });
  const scope = await getAccountScope(guard.session);
  if (!(await keyInScope(scope, key))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rows = await prisma.analyseView.findMany({ where: { OR: [{ accountKey: `${key.platform}:${key.accountId}` }, { accountKey: null }] }, orderBy: { updatedAt: "desc" } });
  return NextResponse.json({ views: rows.map((r) => ({ id: r.id, accountKey: r.accountKey, name: r.name, emoji: r.emoji, config: JSON.parse(r.configJson), createdByName: r.createdByName, updatedAt: r.updatedAt.toISOString() })) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => null)) as { accountKey?: string | null; name?: string; emoji?: string; config?: unknown } | null;
  const key = parseKey(body?.accountKey ?? null);
  if (!key || !body?.name?.trim() || !isViewConfig(body.config)) return NextResponse.json({ error: "accountKey, name et config attendus" }, { status: 400 });
  const scope = await getAccountScope(guard.session);
  if (!(await keyInScope(scope, key))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const row = await prisma.analyseView.create({ data: { accountKey: `${key.platform}:${key.accountId}`, name: body.name.trim().slice(0, 80), emoji: (body.emoji ?? "🏆").slice(0, 4), configJson: JSON.stringify(body.config), createdById: guard.session.userId, createdByName: guard.session.user?.name ?? guard.session.user?.email ?? "" } });
  return NextResponse.json({ id: row.id });
}
