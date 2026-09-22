/**
 * GET /api/bot/overview → staff panel of /bot: every client in scope with the
 * state of its bot (enabled, number of client accesses), bot or not.
 *   staff  → { items: [{ dashboardId, dashboardName, metaAccountId, googleCustomerId, bot | null }] }
 *   client → 403 (clients only ever see their own bots via GET /api/bot)
 */

import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { listBotOverviewFor } from "@/lib/bot-access";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const items = await listBotOverviewFor(guard.session);
  return NextResponse.json({ items });
}
