/**
 * GET /api/clients → { clients: ClientRef[] } — the agency's clients (one row
 * per client, every Meta / Google / TikTok account under it, with or without
 * a dashboard), within the viewer's scope. Feeds the Clients list, ⌘K and
 * Analyse Ads. See lib/clients/registry.ts.
 */

import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { listClientRegistry } from "@/lib/clients/registry";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const clients = await listClientRegistry(await getAccountScope(guard.session));
  return NextResponse.json({ clients }, { headers: { "Cache-Control": "private, max-age=60" } });
}
