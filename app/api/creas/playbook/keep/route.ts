/**
 * POST /api/creas/playbook/keep { brand, country?, libraryIds: string[], clientId? } (staff)
 *   → 201 { kept: [{ id, name, libraryId, format, existed }], failed } : the ads ticked in a brand's study become
 *   templates (source competitor, tags « playbook:<marque>, <format> »), analysis reused, picture copied on the relay.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAlertClient } from "@/lib/creas/templates";
import { PlaybookError, keepFromPlaybook } from "@/lib/creas/playbook";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const libraryIds = Array.isArray(body.libraryIds) ? body.libraryIds.filter((x): x is string => typeof x === "string" && /^\d{5,25}$/.test(x)).slice(0, 12) : [];
  if (!libraryIds.length) return NextResponse.json({ error: "Cochez au moins une pub." }, { status: 400 });
  const client = typeof body.clientId === "string" && body.clientId ? await resolveAlertClient(body.clientId) : null;
  if (typeof body.clientId === "string" && body.clientId && !client) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  const author = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { name: true, email: true } });
  try {
    const out = await keepFromPlaybook({ brand: typeof body.brand === "string" ? body.brand : "", country: typeof body.country === "string" ? body.country : undefined, libraryIds, client: client ? { id: client.id, name: client.name } : null, user: { id: guard.session.userId, name: (author?.name ?? "").trim() || author?.email || "Consultant" } });
    return NextResponse.json(out, { status: 201 });
  } catch (e) {
    if (e instanceof PlaybookError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
