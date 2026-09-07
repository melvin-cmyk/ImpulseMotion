/**
 * GET /api/bot → the private bots the session may open.
 *   staff  → every enabled bot (to test them)
 *   client → bots granted via ClientBotAccess, enabled only
 * Response: { bots: [{ id, name, dashboardName, sources }] }
 */

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { listBotsFor } from "@/lib/bot-access";

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const bots = await listBotsFor(guard.session);
  return NextResponse.json({ bots });
}
