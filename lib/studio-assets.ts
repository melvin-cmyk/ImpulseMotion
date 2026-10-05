/**
 * Studio créa — the assets as the page sees them, and the follow-up of a
 * video until it is ready (server side).
 */

import { prisma } from "@/lib/prisma";
import { publicMediaUrl, relayPoll } from "@/lib/studio";

type Row = NonNullable<Awaited<ReturnType<typeof prisma.creativeAsset.findUnique>>>;

export interface AssetView {
  id: string; kind: string; status: string; progress: number; prompt: string; model: string;
  clientId: string | null; clientName: string; createdByName: string; createdAt: string; mine: boolean;
  params: Record<string, unknown>; url: string | null; downloadUrl: string | null; hasCopy: boolean;
  error: string | null; costUsd: number; sourceId: string | null;
}

export function assetView(a: Row, viewerId: string): AssetView {
  let params: Record<string, unknown> = {};
  try { params = JSON.parse(a.paramsJson); } catch { params = {}; }
  const ready = a.status === "completed" && (a.url || a.file);
  return {
    id: a.id, kind: a.kind, status: a.status, progress: a.progress, prompt: a.prompt, model: a.model,
    clientId: a.alertClientId, clientName: a.clientName, createdByName: a.createdByName, createdAt: a.createdAt.toISOString(),
    // A composition made here has no Agnes link: a fresh signed HTTPS link to the relay's copy (also what Meta downloads).
    mine: a.createdById === viewerId, params, url: a.url ?? (a.file && a.status === "completed" ? publicMediaUrl(a.file, 6 * 3600) : null),
    downloadUrl: ready ? `/api/studio/assets/${a.id}/file` : null, hasCopy: !!a.file,
    error: a.error, costUsd: a.costUsd, sourceId: a.sourceId,
  };
}

/** A video still being generated: asked to Agnes (through the relay) and saved. Never throws. */
export async function refreshVideo(a: Row): Promise<Row> {
  if (a.kind !== "video" || !a.providerId || (a.status !== "queued" && a.status !== "in_progress")) return a;
  try {
    const p = await relayPoll(a.providerId, a.model);
    const status = p.status === "completed" || p.status === "failed" ? p.status : p.status === "queued" ? "queued" : "in_progress";
    // Agnes says « completed » a moment before the link exists: wait for it.
    if (status === "completed" && !p.url) return a;
    return await prisma.creativeAsset.update({
      where: { id: a.id },
      data: { status, progress: status === "completed" ? 100 : Math.max(a.progress, p.progress), url: p.url ?? a.url, file: p.file ?? a.file, error: p.error ?? null },
    });
  } catch (e) {
    console.error("[studio] suivi vidéo impossible", a.id, e);
    // A video lost for more than an hour is given up.
    if (Date.now() - a.createdAt.getTime() > 60 * 60 * 1000) {
      return prisma.creativeAsset.update({ where: { id: a.id }, data: { status: "failed", error: "La génération n'a pas abouti (plus d'une heure sans réponse)." } });
    }
    return a;
  }
}
