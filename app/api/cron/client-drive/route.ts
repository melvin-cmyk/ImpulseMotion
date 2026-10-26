/**
 * GET /api/cron/client-drive (CRON_SECRET) → the Google Drive folder of every
 * client bound to an ad platform (Meta or Google Ads) that has none yet, a
 * batch per firing. The cockpit creates the folder on a visit too; this pass
 * covers the clients nobody opened (rule of 2026-10-26: a client with a pixel
 * or a Google account gets its folder).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkCronAuth } from "@/lib/cron-auth";
import { ensureClientFolder } from "@/lib/clients/drive";

export const maxDuration = 300;

const MAX_PER_FIRING = 25;
const BUDGET_MS = 240_000;

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.CLIENT_DRIVE_CRON?.trim().toLowerCase() === "off") return NextResponse.json({ stopped: true, created: 0 });

  const pending = await prisma.dashboard.findMany({
    where: { driveFolderId: null, OR: [{ metaAccountId: { not: null } }, { googleCustomerId: { not: null } }] },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
    take: MAX_PER_FIRING,
  });
  const deadline = Date.now() + BUDGET_MS;
  const done: string[] = [];
  const failed: Array<{ id: string; name: string; error: string }> = [];
  for (const d of pending) {
    if (Date.now() > deadline) break;
    try {
      const folder = await ensureClientFolder(d.id);
      if (folder) done.push(d.name);
    } catch (e) {
      failed.push({ id: d.id, name: d.name, error: e instanceof Error ? e.message : String(e) });
      // The Drive side is down: the rest would fail the same way.
      if (failed.length >= 3) break;
    }
  }
  console.log(`[cron/client-drive] ${done.length} dossier(s) créé(s), ${failed.length} échec(s), ${Math.max(0, pending.length - done.length - failed.length)} restant(s) pour ce passage`);
  return NextResponse.json({ created: done.length, failed, remaining: pending.length - done.length - failed.length });
}
