import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { validateNotify } from "@/lib/alert-notify";
import { validateRuleInput } from "@/lib/alert-entities";

async function getOwned(id: string, userId: string) {
  const row = await prisma.alertRule.findUnique({ where: { id } });
  if (!row || row.userId !== userId) return null;
  return row;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const owned = await getOwned(id, guard.session.userId);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json();
  const spec = validateRuleInput(body, { partial: true });
  if (!spec.ok) return NextResponse.json({ error: spec.error }, { status: 400 });
  let notify: import("@/lib/alert-notify").AlertNotify | null = null;
  if (body.notify !== undefined) {
    const v = validateNotify(body.notify);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    notify = v.value;
  }
  const updated = await prisma.alertRule.update({
    where: { id },
    data: {
      ...spec.data,
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(notify ? { notifyJson: JSON.stringify(notify) } : {}),
    },
  });
  return NextResponse.json({ rule: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const owned = await getOwned(id, guard.session.userId);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });
  await prisma.alertRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
