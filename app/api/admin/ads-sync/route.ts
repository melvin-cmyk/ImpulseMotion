/**
 * Creative warehouse — admin controls.
 *   GET  → sync status per platform account (AdSyncState)
 *   POST { accountIds?, platforms?, fullMetadata? } → run one pass now (≤ 280 s)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { runAdsSync, warehouseStatus, WAREHOUSE_ENABLED_PLATFORMS } from "@/lib/ads-warehouse/sync";
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
  const body = (await req.json().catch(() => ({}))) as { accountIds?: string[]; platforms?: WarehousePlatform[]; fullMetadata?: boolean };
  const report = await runAdsSync({ deadline: Date.now() + 280_000, accountIds: body.accountIds, platforms: body.platforms, fullMetadata: body.fullMetadata });
  return NextResponse.json(report);
}
