/**
 * POST /api/mo/[id]/act → one deterministic action on the board (no model):
 *   verdict | creative_metrics | open_editor | drive | competitor_ads | publish_prepare | publish_confirm | upload
 * (lib/mo/act.ts). Staff only, board owned by the caller. Each action is
 * journaled as a « action » line of the board. Answers { say, cardIds, card?,
 * open?, needs?, hq? } or { error } with the status the action chose
 * (428 = the client is missing: the browser asks with chips).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { listClientRegistry } from "@/lib/clients/registry";
import { ensureClientSubfolder, uploadToFolder } from "@/lib/clients/drive";
import { fetchImageBytes, mediaFileDataUri } from "@/lib/creas/media";
import { openInEditor } from "@/lib/creas/open-editor";
import { createBrandAsset, setAssetFeedback } from "@/lib/studio-assets";
import { ActError, parseActRequest, runMoAct, type ActDeps } from "@/lib/mo/act";
import { appendMoAction, loadBoard, parseMoCards, placeMoCard, rewriteMoCard } from "@/lib/mo/thread";
import { competitorAds, creativeMetrics, keepTemplate, metaPublishAd, metaTargets, MoToolError, type MoToolContext } from "@/lib/mo/tools";
import { withClientAliases } from "@/lib/mo/intents";
import { recordMoTurn } from "@/lib/mo/turns";

export const maxDuration = 120;

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

function dataUriBytes(uri: string | null): { buf: Buffer; mimeType: string } | null {
  const m = uri?.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  return m ? { buf: Buffer.from(m[2], "base64"), mimeType: m[1] } : null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const board = await loadBoard(id, guard.session.userId);
  if (!board) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = parseActRequest(await req.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400, ...NO_STORE });

  const user = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { role: true, email: true, name: true } });
  const ctx: MoToolContext = { userId: guard.session.userId, boardId: board.id, role: user?.role ?? guard.session.role ?? "", email: user?.email ?? null, name: user?.name ?? null };
  const who = (user?.name ?? "").trim() || user?.email || "consultant";
  const session = guard.session;

  const deps: ActDeps = {
    loadCards: async () => parseMoCards((await prisma.moBoard.findUnique({ where: { id: board.id }, select: { cardsJson: true } }))?.cardsJson),
    rewriteCard: (cardId, fn) => rewriteMoCard(board.id, cardId, fn),
    placeCard: (spec, at) => placeMoCard(board.id, spec, at),
    journal: (action, content) => appendMoAction(board.id, action, content),
    clients: async () => withClientAliases((await listClientRegistry(await getAccountScope(session))).map((c) => ({ id: c.id, clientId: c.clientId, name: c.name, dashboardId: c.dashboardId, hqSlug: c.hqSlug, aliasIds: c.aliasIds }))),
    assetFeedback: (assetId, verdict) => setAssetFeedback(assetId, { feedback: verdict }, who),
    keepTemplate: (args) => keepTemplate(ctx, args),
    creativeMetrics: (args) => creativeMetrics(ctx, args),
    metaTargets: (args) => metaTargets(ctx, args),
    metaPublishAd: (args) => metaPublishAd(ctx, args),
    competitorAds: (args) => competitorAds(ctx, args),
    openEditor: async (input) => { const r = await openInEditor(session, input); return r.ok ? { ok: true, path: r.path } : r; },
    createAsset: async (input) => { const r = await createBrandAsset({ userId: session.userId, userEmail: session.user?.email, clientId: input.clientId, image: input.image, name: input.name, board: board.id }); return r.ok ? { ok: true, assetId: r.asset.id } : r; },
    assetBytes: async (assetId) => {
      const a = await prisma.creativeAsset.findFirst({ where: { id: assetId, deletedAt: null }, select: { file: true, url: true } });
      if (!a) return null;
      if (a.file) return dataUriBytes(await mediaFileDataUri(a.file));
      const got = a.url ? await fetchImageBytes(a.url) : null;
      return got ? { buf: got.buf, mimeType: got.mediaType } : null;
    },
    adImageBytes: async (platform, adId) => {
      const ad = await prisma.adCatalog.findFirst({ where: { platform, adId }, select: { imageUrl: true, thumbnailUrl: true } });
      const src = ad?.imageUrl || ad?.thumbnailUrl;
      const got = src ? await fetchImageBytes(src) : null;
      return got ? { buf: got.buf, mimeType: got.mediaType } : null;
    },
    driveUpload: async (dashboardId, folder, file) => {
      const f = await ensureClientSubfolder(dashboardId, folder);
      if (!f) throw new Error("dossier Drive du client introuvable");
      const up = await uploadToFolder(f.id, file);
      return { link: up.webViewLink };
    },
  };

  const t0 = Date.now();
  try {
    const result = await runMoAct(parsed, deps, who);
    const totalMs = Date.now() - t0;
    console.log(`[mo/act] ${parsed.action} ${totalMs} ms`);
    // Measured (spec §6): an action is a turn without the model; a pending choice (which ad set) is not a finished one.
    const turnId = result.needs ? null : await recordMoTurn({ userId: guard.session.userId, boardId: board.id, path: "act", kind: parsed.action, totalMs, firstCardMs: result.cardIds.length ? totalMs : null });
    return NextResponse.json({ ...result, ...(turnId ? { turnId } : {}) }, NO_STORE);
  } catch (e) {
    const status = e instanceof ActError || e instanceof MoToolError ? e.status : 500;
    const message = e instanceof ActError || e instanceof MoToolError ? e.message : "L'action a échoué.";
    if (status >= 500) console.error(`[mo/act] ${parsed.action} failed`, e);
    else console.log(`[mo/act] ${parsed.action} ${status} ${Date.now() - t0} ms`);
    return NextResponse.json({ error: message }, { status, ...NO_STORE });
  }
}
