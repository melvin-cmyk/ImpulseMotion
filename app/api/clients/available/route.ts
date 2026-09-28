/**
 * GET /api/clients/available → staff: the clients of the agency that have no
 * dashboard yet, to pick one when creating a dashboard (lib/report-clients.ts).
 */

import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { pendingReportClients } from "@/lib/report-clients";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const clients = await pendingReportClients(guard.session.userId, await getAccountScope(guard.session));
  return NextResponse.json({ clients }, { headers: { "Cache-Control": "no-store" } });
}
