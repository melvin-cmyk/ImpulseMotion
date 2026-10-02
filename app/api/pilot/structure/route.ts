/**
 * GET /api/pilot/structure?clientId=…&accountId=…            → campaigns and ad sets
 * GET /api/pilot/structure?clientId=…&accountId=…&adsetId=…  → the ads of one ad set
 * Read on Meta now (staff, account of the client and of the person's scope),
 * with the client's HQ folder, where the changes will be written.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { hqProjectOf, pilotWritesOpen, resolveAccount } from "@/lib/pilot/service";
import { readAccountCurrency, readAds, readStructure } from "@/lib/pilot/meta";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = new URL(req.url).searchParams;
  const resolved = await resolveAccount(guard.session, q.get("clientId") ?? "", q.get("accountId") ?? "");
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  const { client, account } = resolved;
  const headers = { "Cache-Control": "no-store" };
  try {
    const adsetId = q.get("adsetId");
    if (adsetId) {
      const ads = await readAds(adsetId);
      return NextResponse.json({ ads: ads.filter((a) => a.accountId === account.digits) }, { headers });
    }
    const [structure, currency] = await Promise.all([readStructure(account.digits), readAccountCurrency(account.digits)]);
    return NextResponse.json({
      ...structure,
      account: { id: account.digits, name: account.name, currency },
      hqProject: await hqProjectOf(client),
      writesOpen: pilotWritesOpen(),
    }, { headers });
  } catch (e) {
    console.error("[pilot] structure unreadable", e);
    return NextResponse.json({ error: "Meta ne répond pas pour le moment : réessayez dans quelques minutes." }, { status: 503 });
  }
}
