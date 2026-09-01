/**
 * POST /api/dashboards/[id]/sources/test → staff: body { token } → result of
 * testHubspotConnection (nothing is persisted). Always 200 with { ok, ... } so the
 * UI can show the provider's reason; 400 only on a malformed request.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { hasSecretsKey } from "@/lib/secrets";
import { testHubspotConnection } from "@/lib/hubspot/client";

export const maxDuration = 30;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const dashboard = await prisma.dashboard.findUnique({ where: { id }, select: { id: true } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return NextResponse.json({ error: "token requis" }, { status: 400 });

  const result = await testHubspotConnection(token);
  return NextResponse.json({ ...result, secretsConfigured: hasSecretsKey() }, { headers: { "Cache-Control": "no-store" } });
}
