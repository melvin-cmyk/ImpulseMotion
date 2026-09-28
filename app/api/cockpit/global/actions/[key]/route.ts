/**
 * PUT /api/cockpit/global/actions/[key] — follow-up of a client by the team
 * (state, owner, due date, note). Staff; a consultant only on a client that
 * is in their scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { loadCockpitView } from "@/lib/cockpit/view";

const STATES = new Set(["", "todo", "doing", "done"]);
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function PUT(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { key } = await params;
  if (!KEY_RE.test(key)) return NextResponse.json({ error: "client invalide" }, { status: 400 });

  const view = await loadCockpitView(await getAccountScope(guard.session));
  if (!view.data?.clients.some((c) => c.key === key)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const state = typeof body?.state === "string" && STATES.has(body.state) ? body.state : "";
  const due = typeof body?.due === "string" && DATE_RE.test(body.due) ? body.due : null;
  const data = {
    state,
    owner: text(body?.owner, 80),
    due,
    note: text(body?.note, 2000),
    updatedBy: guard.session.user?.email ?? guard.session.userId,
  };
  const row = await prisma.cockpitAction.upsert({ where: { clientKey: key }, create: { clientKey: key, ...data }, update: data });
  return NextResponse.json({
    action: { state: row.state, owner: row.owner, due: row.due, note: row.note, updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() },
  });
}
