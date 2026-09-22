/**
 * HQ brief of a client (what the agency memory knows about it) — staff only.
 *
 * GET  → the cached brief ({ context | null, fresh })
 * POST → refresh it now through the relay (one HQ session), then return it.
 *        Reports refresh it themselves when stale; this is the manual path
 *        after a consultant updated the client folder in HQ.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { getHqClientContext, isHqContextFresh } from "@/lib/hq-client-context";

export const maxDuration = 120;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;

  const d = await prisma.dashboard.findUnique({ where: { id }, select: { hqSlug: true, hqContextMd: true, hqContextAt: true } });
  if (!d) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    context: d.hqSlug && d.hqContextMd && d.hqContextAt ? { slug: d.hqSlug, brief: d.hqContextMd, fetchedAt: d.hqContextAt.toISOString() } : null,
    fresh: isHqContextFresh(d),
  });
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;

  const { context, warning } = await getHqClientContext(id, { force: true, maxMs: 100_000 });
  if (!context) return NextResponse.json({ error: warning ?? "dossier HQ introuvable" }, { status: 404 });
  return NextResponse.json({ context: { slug: context.slug, brief: context.brief, fetchedAt: context.fetchedAt }, warning });
}
