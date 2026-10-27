/**
 * Shared request parsing of the Analyse Ads v2 APIs (/api/ads/*): staff
 * guard, date ranges, platform whitelist and ACCOUNT SCOPE — an account the
 * viewer may not see is silently dropped from the query (lib/scope.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import type { AdsQuery } from "@/lib/ads-warehouse/query";
import { WAREHOUSE_PLATFORMS, type WarehousePlatform } from "@/lib/ads-warehouse/types";
import { validateRange } from "@/lib/date-ranges";

export function normalizeAccountId(platform: string, id: string): string {
  const s = String(id).trim();
  if (platform === "meta") return s.replace(/^act_/, "");
  if (platform === "google") return s.replace(/-/g, "");
  return s;
}

export async function parseScopedQuery(req: NextRequest): Promise<{ q: AdsQuery } | { error: NextResponse }> {
  const guard = await requireStaff();
  if ("error" in guard && guard.error) return { error: guard.error };
  if (!("session" in guard)) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const body = (await req.json().catch(() => null)) as Partial<AdsQuery> & { accounts?: Array<{ platform: WarehousePlatform; id: string }> } | null;
  if (!body) return { error: NextResponse.json({ error: "corps JSON attendu" }, { status: 400 }) };
  const range = validateRange(body.range?.since ?? null, body.range?.until ?? null);
  if (!range.ok) return { error: NextResponse.json({ error: range.error }, { status: 400 }) };
  let compare: AdsQuery["compare"] = null;
  if (body.compare?.since && body.compare?.until) {
    const c = validateRange(body.compare.since, body.compare.until);
    if (!c.ok) return { error: NextResponse.json({ error: c.error }, { status: 400 }) };
    compare = c.range;
  }
  const scope = await getAccountScope(guard.session);
  const platforms = (body.platforms?.length ? body.platforms : ["meta"]).filter((p): p is WarehousePlatform => (WAREHOUSE_PLATFORMS as string[]).includes(p));
  const wanted = (body.accounts ?? (body.accountIds ?? []).map((id) => ({ platform: platforms[0], id })))
    .map((a) => ({ platform: a.platform, id: normalizeAccountId(a.platform, a.id) }))
    .filter((a) => platforms.includes(a.platform) && platformAccountInScope(scope, a.platform, a.id));
  const accountIds = Array.from(new Set(wanted.map((a) => a.id)));
  const q: AdsQuery = {
    platforms: Array.from(new Set(wanted.map((a) => a.platform))),
    accountIds,
    range: range.range,
    compare,
    groupBy: (body.groupBy as AdsQuery["groupBy"]) ?? "creative",
    filters: body.filters ?? {},
    sort: body.sort,
    limit: body.limit,
    offset: body.offset,
  };
  return { q };
}

