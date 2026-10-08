/**
 * Merchant Center accounts the agency's Google account can read (staff), to
 * pick the one of a client in the sources panel. `?refresh=1` bypasses the
 * 10-minute cache. Read-only; nothing is stored.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { listMerchantAccounts } from "@/lib/merchant-center";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  try {
    const accounts = await listMerchantAccounts({ force: req.nextUrl.searchParams.get("refresh") === "1" });
    return NextResponse.json({ accounts }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: `Merchant Center injoignable (${e instanceof Error ? e.message.slice(0, 160) : String(e)})` }, { status: 502 });
  }
}
