/** PATCH { name?, emoji?, config? } / DELETE — one saved report (staff; the report's account must be in scope). */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope, dashboardIdInScope } from "@/lib/scope";
import { isViewConfig } from "@/lib/ads-warehouse/views";

async function load(id: string, session: { userId?: string | null; role?: string | null }) {
  const row = await prisma.analyseView.findUnique({ where: { id } });
  if (!row) return { error: NextResponse.json({ error: "introuvable" }, { status: 404 }) };
  const [platform, accountId] = (row.accountKey ?? ":").split(":");
  const scope = await getAccountScope(session as never);
  const ok = !row.accountKey || (platform === "client" ? await dashboardIdInScope(scope, accountId) : platformAccountInScope(scope, platform, accountId));
  if (!ok) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { row };
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  const l = await load(id, guard.session);
  if ("error" in l) return l.error;
  const body = (await req.json().catch(() => ({}))) as { name?: string; emoji?: string; config?: unknown };
  await prisma.analyseView.update({ where: { id }, data: { name: body.name?.trim().slice(0, 80) || undefined, emoji: body.emoji?.slice(0, 4) || undefined, configJson: isViewConfig(body.config) ? JSON.stringify(body.config) : undefined } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  const l = await load(id, guard.session);
  if ("error" in l) return l.error;
  await prisma.analyseView.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
