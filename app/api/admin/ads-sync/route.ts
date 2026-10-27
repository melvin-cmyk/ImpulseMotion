/**
 * Creative warehouse — admin controls.
 *   GET  → sync status per platform account (AdSyncState)
 *   POST { accountIds?, platforms?, fullMetadata?, resync? } → run one pass now (≤ 280 s);
 *        resync=true first forgets the accounts' sync state (e.g. after changing
 *        their conversion event in Admin → Comptes) so they are re-read from scratch.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { runAdsSync, warehouseStatus, resetAccounts, WAREHOUSE_ENABLED_PLATFORMS } from "@/lib/ads-warehouse/sync";
import type { WarehousePlatform } from "@/lib/ads-warehouse/types";

export const maxDuration = 300;

export async function GET() {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  return NextResponse.json({ platforms: WAREHOUSE_ENABLED_PLATFORMS, accounts: await warehouseStatus() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as { accountIds?: string[]; platforms?: WarehousePlatform[]; fullMetadata?: boolean; resync?: boolean };
  if (body.resync && body.accountIds?.length) for (const p of body.platforms ?? WAREHOUSE_ENABLED_PLATFORMS) await resetAccounts(p, body.accountIds);
  const report = await runAdsSync({ deadline: Date.now() + 280_000, accountIds: body.accountIds, platforms: body.platforms, fullMetadata: body.fullMetadata });
  return NextResponse.json(report);
}
