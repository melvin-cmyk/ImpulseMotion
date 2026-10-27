/**
 * POST /api/ads/facets — values of the naming-convention tags of the selected
 * accounts (for the "Convention de nommage" filter): { keys: [{ key, count,
 * values: [{ value, count }] }] }. Same body / scope rules as /api/ads/query.
 */

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";

export async function POST(req: NextRequest) {
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  const { platforms, accountIds } = parsed.q;
  if (!accountIds.length) return NextResponse.json({ keys: [] });
  const rows = await prisma.$queryRaw<Array<{ key: string; value: string; count: number }>>(Prisma.sql`
    SELECT kv.key, kv.value, COUNT(*)::int AS count
    FROM "AdCatalog" c, LATERAL jsonb_each_text(c."tagsJson"::jsonb) AS kv(key, value)
    WHERE c.platform IN (${Prisma.join(platforms)}) AND c."accountId" IN (${Prisma.join(accountIds)})
    GROUP BY 1, 2 ORDER BY 1, 3 DESC`);
  const byKey = new Map<string, { key: string; count: number; values: Array<{ value: string; count: number }> }>();
  for (const r of rows) {
    if (/^(s|t)\d+$/.test(r.key)) continue;
    const k = byKey.get(r.key) ?? { key: r.key, count: 0, values: [] };
    k.count += Number(r.count);
    if (k.values.length < 40) k.values.push({ value: r.value, count: Number(r.count) });
    byKey.set(r.key, k);
  }
  const keys = Array.from(byKey.values()).sort((a, b) => b.count - a.count).slice(0, 30);
  return NextResponse.json({ keys }, { headers: { "Cache-Control": "private, max-age=120" } });
}
