/**
 * POST /api/relay/memorize — « Mémoriser dans HQ » depuis la console (staff
 * only) : { messages, project } → note datée dans le journal du projet HQ
 * choisi par le consultant (lib/hq-memorize.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { buildTranscript, HQ_PROJECT_RE, memorizeToHq } from "@/lib/hq-memorize";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const project = typeof body.project === "string" && HQ_PROJECT_RE.test(body.project) ? body.project : null;
  if (!project) return NextResponse.json({ error: "Choisissez le dossier HQ du client." }, { status: 400 });

  const result = await memorizeToHq({
    transcript: buildTranscript(body.messages),
    project,
    clientLabel: project,
    author: guard.session.user?.email ?? guard.session.userId,
    origin: "de la console IA ImpulseMotion",
    usage: {
      feature: "copilot_memorize",
      clientName: project,
      user: { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role },
    },
  });
  if (!result.ok) return NextResponse.json({ error: result.error, note: result.note }, { status: result.status });
  return NextResponse.json({ ok: true, note: result.note, project: result.project });
}
