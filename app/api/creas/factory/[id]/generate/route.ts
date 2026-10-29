/**
 * POST /api/creas/factory/[id]/generate → one pass of generation (staff), ≤ 12 images.
 *   First call (copies validated): { n, engine?, ratio?, textless? } — the quota is checked on the whole run (429 with a readable message).
 *   Next calls: {} — the browser calls again until `remaining` is 0.
 *   { background: true } (or n > BACKGROUND_FROM): this first pass runs here, the rest is chained on the server
 *   (lib/creas/background.ts) and the answer says `background: true` — the page can be closed.
 *   → { run, assets (made in this pass), remaining, failed, warn? }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAlertClient } from "@/lib/creas/templates";
import { FactoryError, generatePass, loadRun } from "@/lib/creas/factory";
import { startBackground } from "@/lib/creas/background";
import { BACKGROUND_FROM, parseSettings } from "@/lib/creas/model";

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const run = await loadRun(id);
  if (!run) return NextResponse.json({ error: "Fabrique introuvable." }, { status: 404 });
  const client = await resolveAlertClient(run.alertClientId);
  if (!client) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // A generation chained in the background is already doing the passes: a second runner would make the same visuals twice.
  if (run.status === "generating" && parseSettings(run.settingsJson).background) return NextResponse.json({ error: "Cette fabrique se génère en arrière-plan : la grille se remplit toute seule." }, { status: 409 });
  const author = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { name: true, email: true } });
  const user = { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "", name: (author?.name ?? "").trim() || author?.email || "Consultant" };
  try {
    const out = await generatePass(run, client, user, { n: typeof body.n === "number" ? body.n : undefined, engine: typeof body.engine === "string" ? body.engine : undefined, ratio: typeof body.ratio === "string" ? body.ratio : undefined, textless: body.textless === true });
    const wantsBackground = body.background === true || (typeof body.n === "number" && body.n > BACKGROUND_FROM);
    if (wantsBackground && out.remaining > 0) {
      const started = await startBackground(run.id, { userId: user.id, origin: req.nextUrl.origin, first: { n: out.run.settings.n } });
      // Hop 0 receives `first` but the run is already « generating »: generatePass ignores it and goes on.
      return NextResponse.json({ ...out, background: started, ...(started ? {} : { warn: [out.warn, "La suite en arrière-plan n'a pas pu démarrer : continuez depuis cette page."].filter(Boolean).join(" ") }) }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof FactoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
