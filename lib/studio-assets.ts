/**
 * Studio créa — the assets as the page sees them, and the follow-up of a
 * video until it is ready (server side).
 */

import { prisma } from "@/lib/prisma";
import { dataUriOk, publicMediaUrl, relayPoll, relayUpload } from "@/lib/studio";
import { appendHqJournal } from "@/lib/hq-journal";
import { resolveAlertClient } from "@/lib/creas/templates";
import { statusAfterVerdicts } from "@/lib/creas/copy";
import type { RunStatus } from "@/lib/creas/model";

type Row = NonNullable<Awaited<ReturnType<typeof prisma.creativeAsset.findUnique>>>;

export interface AssetView {
  id: string; kind: string; status: string; progress: number; prompt: string; model: string;
  clientId: string | null; clientName: string; createdByName: string; createdAt: string; mine: boolean;
  params: Record<string, unknown>; url: string | null; downloadUrl: string | null; hasCopy: boolean;
  error: string | null; costUsd: number; sourceId: string | null;
  /** Créas: the template it was made from, where it comes from (studio | template | variation | factory | asset), the consultant's verdict. */
  templateId: string | null; origin: string; feedback: string | null; feedbackNote: string | null;
  /** Fabrique de statics: the run and the copy the visual was made for. */
  factoryRunId: string | null; copyId: string | null;
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
    templateId: a.templateId, origin: a.origin, feedback: a.feedback, feedbackNote: a.feedbackNote,
    factoryRunId: a.factoryRunId, copyId: a.copyId,
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

/**
 * The consultant's verdict on a generated visual (keep / cut, a note), written
 * on the asset and journaled in the client's HQ project — the same rule for
 * the Créas page (PATCH /api/studio/assets/[id]) and for Mo's cards.
 */
export async function setAssetFeedback(id: string, input: { feedback?: "keep" | "cut" | null; feedbackNote?: string | null; clientId?: string }, who: string): Promise<{ ok: true; asset: Row; hq: { ok: boolean; error?: string } } | { ok: false; status: number; error: string }> {
  const row = await prisma.creativeAsset.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, status: 404, error: "introuvable" };
  const data: { feedback?: string | null; feedbackNote?: string | null; alertClientId?: string; clientName?: string } = {};
  if (input.feedback === null || input.feedback === "keep" || input.feedback === "cut") data.feedback = input.feedback;
  if (typeof input.feedbackNote === "string" || input.feedbackNote === null) data.feedbackNote = (input.feedbackNote ?? "").trim().slice(0, 2000) || null;
  if (input.clientId) {
    const client = await resolveAlertClient(input.clientId);
    if (!client) return { ok: false, status: 404, error: "Client introuvable." };
    data.alertClientId = client.id; data.clientName = client.name;
  }
  if (!Object.keys(data).length) return { ok: false, status: 400, error: "Rien à enregistrer." };
  const updated = await prisma.creativeAsset.update({ where: { id }, data });
  if (data.feedback !== undefined && updated.factoryRunId) await syncFactoryRunCounters(updated.factoryRunId).catch(() => undefined);
  // The verdict feeds the client's memory (HQ): a short dated entry, best effort.
  let hq: { ok: boolean; error?: string } = { ok: false };
  if ((data.feedback !== undefined || data.feedbackNote !== undefined) && updated.alertClientId && (updated.feedback || updated.feedbackNote)) {
    const client = await resolveAlertClient(updated.alertClientId);
    // The HQ project: the client's own slug, else the one of its dashboard (where most clients carry it).
    let project = client?.hqSlug ?? null;
    if (client && !project) {
      const ac = await prisma.alertClient.findUnique({ where: { id: client.id }, select: { dashboardId: true } });
      project = ac?.dashboardId ? (await prisma.dashboard.findUnique({ where: { id: ac.dashboardId }, select: { hqSlug: true } }))?.hqSlug ?? null : null;
    }
    if (client && project) {
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(updated.paramsJson); } catch { params = {}; }
      const verdict = updated.feedback === "keep" ? "GARDÉE" : updated.feedback === "cut" ? "COUPÉE" : "commentée";
      const content = [
        `## Créa IA ${verdict} — ${new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })}`,
        `- Visuel : « ${updated.prompt.slice(0, 120)} » (${updated.model}${typeof params.templateName === "string" ? `, template « ${params.templateName} »` : ""}, ${updated.createdByName})`,
        `- Verdict de ${who} : ${verdict.toLowerCase()}${updated.feedbackNote ? ` — ${updated.feedbackNote}` : ""}`,
        `- Lien : /creas?client=${updated.alertClientId}&asset=${updated.id}`,
      ].join("\n");
      hq = await appendHqJournal({ project, slug: `crea-${updated.id.slice(-8)}`, content }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    } else hq = { ok: false, error: "Ce client n'a pas de dossier HQ rattaché : le retour reste dans ImpulseMotion." };
  }
  return { ok: true, asset: updated, hq };
}

/**
 * A brand asset of a client (logo, product photo, a visual delivered by the
 * DA): kept on the relay as a reference, no AI, no cost — the Studio's
 * « élément de marque » and the files dropped on Mo's board.
 */
export async function createBrandAsset(input: { userId: string; userEmail?: string | null; clientId: string; image: unknown; name?: string | null; origin?: "asset"; board?: string }): Promise<{ ok: true; asset: Row } | { ok: false; status: number; error: string }> {
  if (!dataUriOk(input.image)) return { ok: false, status: 400, error: "Image invalide (PNG, JPG ou WebP)." };
  const client = input.clientId ? await prisma.alertClient.findUnique({ where: { id: input.clientId }, select: { id: true, name: true, gone: true } }) : null;
  if (!client || client.gone) return { ok: false, status: 400, error: "Choisissez le client de cet élément de marque." };
  const u = await prisma.user.findUnique({ where: { id: input.userId }, select: { name: true, email: true } });
  const createdByName = (u?.name ?? "").trim() || u?.email || input.userEmail || "Consultant";
  try {
    const { file } = await relayUpload(input.image);
    const asset = await prisma.creativeAsset.create({ data: {
      createdById: input.userId, createdByName, alertClientId: client.id, clientName: client.name,
      prompt: (typeof input.name === "string" && input.name.trim() ? input.name.trim() : "Élément de marque").slice(0, 120), kind: "image", model: "upload", origin: "asset", status: "completed", progress: 100, file,
      paramsJson: JSON.stringify({ ratio: "1:1", asset: true, ...(input.board ? { board: input.board } : {}) }),
    } });
    return { ok: true, asset };
  } catch (e) {
    return { ok: false, status: 502, error: `L'élément n'a pas pu être enregistré : ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Kept / cut counters of a fabrique from its visuals' verdicts; « review » becomes « done » once every visual is judged. */
export async function syncFactoryRunCounters(runId: string): Promise<void> {
  const run = await prisma.factoryRun.findUnique({ where: { id: runId }, select: { status: true, generated: true } });
  if (!run) return;
  const verdicts = await prisma.creativeAsset.groupBy({ by: ["feedback"], where: { factoryRunId: runId, deletedAt: null }, _count: { _all: true } });
  const kept = verdicts.find((v) => v.feedback === "keep")?._count._all ?? 0;
  const cut = verdicts.find((v) => v.feedback === "cut")?._count._all ?? 0;
  await prisma.factoryRun.update({ where: { id: runId }, data: { kept, cut, status: statusAfterVerdicts({ status: run.status as RunStatus, generated: run.generated, kept, cut }) } });
}
