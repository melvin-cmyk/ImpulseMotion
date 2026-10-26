/**
 * GET /api/clients → { clients: [{ id, name, metaAccountId, googleCustomerId, tiktokAdvertiserIds, driveFolderId }] }
 * The clients (deduped dashboards) the viewer may see, with every identifier
 * the global picker searches on: name, Meta account, Google Ads customer,
 * TikTok advertiser. Staff only.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { listPortfolioClients } from "@/lib/portfolio";

export interface ClientRef {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  tiktokAdvertiserIds: string[];
  driveFolderId: string | null;
  hqSlug: string | null;
}

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { clients } = await listPortfolioClients(await getAccountScope(guard.session));
  const extra = await prisma.dashboard.findMany({ where: { id: { in: clients.map((c) => c.id) } }, select: { id: true, driveFolderId: true, hqSlug: true } });
  const byId = new Map(extra.map((e) => [e.id, e]));
  const out: ClientRef[] = clients
    .map((c) => ({
      id: c.id,
      name: c.name,
      metaAccountId: c.metaAccountId,
      googleCustomerId: c.googleCustomerId,
      tiktokAdvertiserIds: c.tiktokAdvertiserIds,
      driveFolderId: byId.get(c.id)?.driveFolderId ?? null,
      hqSlug: byId.get(c.id)?.hqSlug ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  return NextResponse.json({ clients: out }, { headers: { "Cache-Control": "private, max-age=60" } });
}
