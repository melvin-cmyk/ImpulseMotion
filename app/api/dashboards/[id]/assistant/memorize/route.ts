/**
 * « Mémoriser dans HQ » depuis le copilote d'un dashboard (staff only) : la
 * note va au journal du projet HQ rattaché au dashboard (lib/hq-memorize.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { buildTranscript, memorizeToHq } from "@/lib/hq-memorize";

export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;

  const dashboard = await prisma.dashboard.findUnique({ where: { id }, select: { id: true, name: true, hqSlug: true } });
  if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!dashboard.hqSlug) {
    return NextResponse.json({ error: "Ce dashboard n'est rattaché à aucun dossier HQ (réglages du dashboard → dossier HQ)." }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const result = await memorizeToHq({
    transcript: buildTranscript(body.messages),
    project: dashboard.hqSlug,
    clientLabel: dashboard.name,
    author: guard.session.user?.email ?? guard.session.userId,
    origin: `du copilote ImpulseMotion (dashboard « ${dashboard.name} »)`,
    usage: {
      feature: "copilot_memorize",
      dashboardId: dashboard.id,
      clientName: dashboard.name,
      user: { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role },
    },
  });
  if (!result.ok) return NextResponse.json({ error: result.error, note: result.note }, { status: result.status });
  return NextResponse.json({ ok: true, note: result.note, project: result.project });
}
