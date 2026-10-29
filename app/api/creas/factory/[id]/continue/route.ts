/**
 * POST /api/creas/factory/[id]/continue (bearer = RELAY_SHARED_SECRET, public path in proxy.ts)
 *   { userId, hop, origin, first? } → 202 at once; the pass (≤ 12 images) runs after the answer, then the next hop
 *   is called while visuals remain (lib/creas/background.ts). At the end, the Mo board that asked gets the grid.
 */

import { after, NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveAlertClient } from "@/lib/creas/templates";
import { FactoryError, generatePass, loadRun } from "@/lib/creas/factory";
import { MAX_HOPS, callHop, recordBackgroundStop, relayBearerOk, type HopBody } from "@/lib/creas/background";
import { parseSettings } from "@/lib/creas/model";
import { postMoCards } from "@/lib/mo/thread";

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!relayBearerOk(req.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as HopBody | null;
  if (!body || typeof body.userId !== "string" || typeof body.hop !== "number" || typeof body.origin !== "string") return NextResponse.json({ error: "userId, hop, origin requis" }, { status: 400 });
  if (body.hop >= MAX_HOPS) { await recordBackgroundStop(id, "Génération arrêtée : trop de passes (relancez-la depuis la fabrique)."); return NextResponse.json({ error: "trop de passes" }, { status: 409 }); }
  const run = await loadRun(id);
  if (!run) return NextResponse.json({ error: "Fabrique introuvable." }, { status: 404 });
  const [client, author] = await Promise.all([resolveAlertClient(run.alertClientId), prisma.user.findUnique({ where: { id: body.userId }, select: { id: true, name: true, email: true, role: true } })]);
  if (!client || !author) return NextResponse.json({ error: "Client ou auteur introuvable." }, { status: 404 });
  const user = { id: author.id, email: author.email, role: author.role, name: (author.name ?? "").trim() || author.email || "Consultant" };

  after(async () => {
    try {
      const pass = await generatePass(run, client, user, body.first ?? {});
      console.log(`[fabrique] passe ${body.hop} ${run.id} : ${pass.assets.length} visuels, reste ${pass.remaining}`);
      if (pass.remaining > 0) {
        if (!(await callHop(run.id, { userId: body.userId, hop: body.hop + 1, origin: body.origin }))) await recordBackgroundStop(run.id, `Génération en arrière-plan interrompue (${pass.remaining} visuels restants) : relancez-la depuis la fabrique.`);
        return;
      }
      // Done: the grid goes on the Mo board that asked, if any.
      const fresh = await loadRun(run.id);
      const settings = parseSettings(fresh?.settingsJson);
      await prisma.factoryRun.update({ where: { id: run.id }, data: { settingsJson: JSON.stringify({ ...settings, background: false }) } });
      if (settings.boardId) {
        const assets = await prisma.creativeAsset.findMany({ where: { factoryRunId: run.id, deletedAt: null, status: "completed" }, orderBy: { createdAt: "asc" }, take: 24, select: { id: true, prompt: true, templateId: true } });
        if (assets.length) await postMoCards(settings.boardId, [{
          type: "creatives", runId: run.id, clientName: run.clientName, title: `Fabrique ${run.clientName} — ${fresh?.generated ?? assets.length} visuels`,
          subtitle: `fal · ${(fresh?.costUsd ?? 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} $ · généré en arrière-plan · « garde la 2 », « coupe les deux dernières »`,
          ...(fresh?.driveLink && /^https:\/\//.test(fresh.driveLink) ? { link: fresh.driveLink, linkLabel: "Drive" } : {}),
          items: assets.map((a) => ({ name: a.prompt.slice(0, 60), image: `/api/studio/assets/${a.id}/file?inline=1`, assetId: a.id, metrics: {}, ...(a.templateId ? { templateId: a.templateId } : {}) })),
        }]).catch((e) => console.error("[fabrique] carte Mo impossible", e));
      }
    } catch (e) {
      const message = e instanceof FactoryError ? e.message : e instanceof Error ? e.message : String(e);
      console.error("[fabrique] passe en arrière-plan en échec", run.id, message);
      await recordBackgroundStop(run.id, message);
    }
  });
  return NextResponse.json({ accepted: true, hop: body.hop }, { status: 202 });
}
