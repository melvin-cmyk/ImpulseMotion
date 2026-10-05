/**
 * GET /api/pilot/structure?clientId=…&accountId=…&platform=meta|google            → campaigns and ad sets (ad groups)
 * GET /api/pilot/structure?clientId=…&accountId=…&platform=meta&adsetId=…         → the ads of one ad set (Meta)
 * Read on the platform now (staff, account of the client and of the person's scope),
 * with the client's HQ folder, where the changes will be written.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { hqProjectOf, pilotWritesOpen, resolveAccount } from "@/lib/pilot/service";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = new URL(req.url).searchParams;
  const resolved = await resolveAccount(guard.session, q.get("clientId") ?? "", q.get("accountId") ?? "", q.get("platform") ?? "meta");
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  const { client, account, adapter } = resolved;
  const headers = { "Cache-Control": "no-store" };
  try {
    const adsetId = q.get("adsetId");
    if (adsetId) {
      if (!adapter.readAds) return NextResponse.json({ ads: [] }, { headers });
      return NextResponse.json({ ads: await adapter.readAds(account.digits, adsetId) }, { headers });
    }
    const [structure, currency] = await Promise.all([adapter.readStructure(account.digits), adapter.readCurrency(account.digits)]);
    return NextResponse.json({
      ...structure,
      platform: adapter.platform,
      account: { id: account.digits, name: account.name, currency },
      hqProject: await hqProjectOf(client),
      writesOpen: pilotWritesOpen(adapter.platform),
    }, { headers });
  } catch (e) {
    console.error("[pilot] structure unreadable", e);
    return NextResponse.json({ error: `${adapter.name} ne répond pas pour le moment : réessayez dans quelques minutes.` }, { status: 503 });
  }
}
