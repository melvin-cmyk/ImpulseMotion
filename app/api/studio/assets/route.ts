/**
 * Studio créa (staff only) — images and videos generated with Agnes AI.
 *
 * GET  ?mine=1&clientId=…  → the latest assets (videos still in progress are followed up)
 * POST                      → generate:
 *   { kind: "image", prompt, ratio, size: "1K"|"2K", mode: "free"|"edit"|"product", scene?, sceneCustom?, textless?, enhance? (default true), variants? (1–4), clientId?, images?: dataURI[] (≤ 3) }
 *   { kind: "composite", sourceId, image: dataURI, layers } — texts and logo laid by the Studio editor (no AI)
 *   { kind: "video", prompt, ratio, seconds, quality: "fast"|"hd", clientId?, sourceId? (animate a Studio image) | image? (dataURI photo to animate) }
 * An image comes back at once (10–60 s); a video comes back « queued » and is followed by GET /api/studio/assets/[id].
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import {
  IMAGE_RATIOS, VIDEO_QUALITIES, VIDEO_RATIOS, VIDEO_SECONDS, dataUriOk, hdSecondsPerDay, promptOk,
  STUDIO_MODES, publicMediaUrl, relayEnhance, relayImage, relayUpload, relayVideo, videoCost, type StudioMode, type VideoQuality,
} from "@/lib/studio";
import { assetView, refreshVideo } from "@/lib/studio-assets";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = new URL(req.url).searchParams;
  const rows = await prisma.creativeAsset.findMany({
    where: {
      deletedAt: null,
      ...(q.get("mine") === "1" ? { createdById: guard.session.userId } : {}),
      ...(q.get("clientId") ? { alertClientId: q.get("clientId") } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  // Videos in progress are asked once per listing (a few at most).
  const refreshed = await Promise.all(rows.map((r, i) => (i < 30 ? refreshVideo(r) : r)));
  const hdToday = await hdSecondsUsed(new Date(Date.now() - 86_400_000));
  return NextResponse.json({
    assets: refreshed.map((a) => assetView(a, guard.session.userId)),
    hd: { usedToday: hdToday, perDay: hdSecondsPerDay(), usdPerSecond: VIDEO_QUALITIES.hd.usdPerSecond },
  }, { headers: { "Cache-Control": "no-store" } });
}

async function hdSecondsUsed(since: Date): Promise<number> {
  const rows = await prisma.creativeAsset.findMany({ where: { kind: "video", model: VIDEO_QUALITIES.hd.model, createdAt: { gte: since }, status: { not: "failed" } }, select: { paramsJson: true } });
  return rows.reduce((n, r) => { try { return n + (Number(JSON.parse(r.paramsJson).seconds) || 0); } catch { return n; } }, 0);
}

async function authorName(userId: string, fallback?: string | null) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  return (u?.name ?? "").trim() || u?.email || fallback || "Consultant";
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Demande illisible." }, { status: 400 });
  if (!promptOk(body.prompt)) return NextResponse.json({ error: "Décrivez ce que vous voulez (3 caractères au moins, 4 000 au plus)." }, { status: 400 });
  const prompt = String(body.prompt).trim();

  const client = typeof body.clientId === "string" && body.clientId
    ? await prisma.alertClient.findUnique({ where: { id: body.clientId }, select: { id: true, name: true, gone: true } })
    : null;
  if (body.clientId && (!client || client.gone)) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  const base = {
    createdById: guard.session.userId, createdByName: await authorName(guard.session.userId, guard.session.user?.email),
    alertClientId: client?.id ?? null, clientName: client?.name ?? "", prompt,
  };

  // A composition made in the Studio (texts and logo laid by the editor over a visual): kept on the relay, no AI.
  if (body.kind === "composite") {
    if (!dataUriOk(body.image)) return NextResponse.json({ error: "Image composée invalide." }, { status: 400 });
    const src = typeof body.sourceId === "string" ? await prisma.creativeAsset.findUnique({ where: { id: body.sourceId }, select: { id: true, paramsJson: true, alertClientId: true, clientName: true } }) : null;
    try {
      const { file } = await relayUpload(body.image);
      let ratio = "1:1";
      try { ratio = JSON.parse(src?.paramsJson ?? "{}").ratio ?? ratio; } catch { /* default */ }
      const asset = await prisma.creativeAsset.create({
        data: {
          ...base, alertClientId: base.alertClientId ?? src?.alertClientId ?? null, clientName: base.clientName || src?.clientName || "",
          kind: "image", model: "composition", sourceId: src?.id ?? null, status: "completed", progress: 100, file,
          paramsJson: JSON.stringify({ ratio, composite: true, layers: typeof body.layers === "object" ? body.layers : null }),
        },
      });
      return NextResponse.json({ asset: assetView(asset, guard.session.userId) }, { status: 201 });
    } catch (e) {
      return NextResponse.json({ error: `La composition n'a pas pu être enregistrée : ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
    }
  }

  const mode: StudioMode = (STUDIO_MODES as readonly string[]).includes(body.mode) ? body.mode : "free";
  const textless = body.textless === true;
  const enhance = body.enhance !== false;

  if (body.kind === "image") {
    const ratio = (IMAGE_RATIOS as readonly string[]).includes(body.ratio) ? body.ratio : "1:1";
    const size = body.size === "1K" ? "1K" : "2K";
    const images = Array.isArray(body.images) ? body.images.filter(dataUriOk).slice(0, 3) : [];
    const variants = Math.min(4, Math.max(1, Math.round(Number(body.variants) || 1)));
    const scene = typeof body.scene === "string" ? body.scene.slice(0, 40) : undefined;
    const sceneCustom = typeof body.sceneCustom === "string" ? body.sceneCustom.slice(0, 300) : undefined;
    // The request rewritten into a precise brief (Agnes' text model, free), unless the consultant wrote it themselves.
    const brief = enhance
      ? await relayEnhance({ request: prompt, kind: "image", mode: images.length && mode === "free" ? "edit" : mode, scene, sceneCustom, textless, ratio, images }).catch(() => null)
      : null;
    const sent = brief?.prompt ?? prompt;
    const group = `g_${Date.now().toString(36)}`;
    const results = await Promise.allSettled(Array.from({ length: variants }, () => relayImage({ prompt: sent, ratio, size, images })));
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (!ok.length) {
      const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      return NextResponse.json({ error: `L'image n'a pas pu être générée : ${first?.reason instanceof Error ? first.reason.message : String(first?.reason ?? "")}` }, { status: 502 });
    }
    const params = { ratio, size, references: images.length, mode, scene: scene ?? null, textless, promptSent: sent, note: brief?.note ?? "", enhanced: !!brief?.enhanced, group, variants };
    const assets = [];
    for (const out of ok) {
      assets.push(await prisma.creativeAsset.create({
        data: { ...base, kind: "image", model: out.model, paramsJson: JSON.stringify(params), status: "completed", progress: 100, url: out.url, file: out.file },
      }));
    }
    const views = assets.map((a) => assetView(a, guard.session.userId));
    return NextResponse.json({ asset: views[0], assets: views, failed: variants - ok.length }, { status: 201 });
  }

  if (body.kind === "video") {
    const ratio = (VIDEO_RATIOS as readonly string[]).includes(body.ratio) ? body.ratio : "9:16";
    const seconds = Math.min(VIDEO_SECONDS.max, Math.max(VIDEO_SECONDS.min, Math.round(Number(body.seconds) || VIDEO_SECONDS.default)));
    const quality: VideoQuality = body.quality === "hd" ? "hd" : "fast";
    const q = VIDEO_QUALITIES[quality];
    if (quality === "hd") {
      const used = await hdSecondsUsed(new Date(Date.now() - 86_400_000));
      if (used + seconds > hdSecondsPerDay()) {
        return NextResponse.json({ error: `Plafond HD atteint (${used} s sur ${hdSecondsPerDay()} s pour l'équipe sur 24 h). Utilisez la qualité « Rapide », gratuite.` }, { status: 429 });
      }
    }

    // The first frame: an image of the Studio, or a photo sent now (put on the relay behind a signed link Agnes can read).
    let firstFrame: string | undefined;
    let sourceId: string | null = null;
    if (typeof body.sourceId === "string" && body.sourceId) {
      const src = await prisma.creativeAsset.findUnique({ where: { id: body.sourceId } });
      if (!src || src.kind !== "image" || src.deletedAt || !src.url) return NextResponse.json({ error: "Image de départ introuvable." }, { status: 404 });
      // Agnes' own link first (already HTTPS); the copy kept by the relay when that link is gone.
      firstFrame = src.url ?? (src.file ? publicMediaUrl(src.file, 6 * 3600) ?? undefined : undefined);
      sourceId = src.id;
    } else if (dataUriOk(body.image)) {
      try {
        const { file } = await relayUpload(body.image);
        const link = publicMediaUrl(file, 6 * 3600);
        if (!link) return NextResponse.json({ error: "Adresse publique de l'application inconnue : impossible d'animer une photo." }, { status: 503 });
        firstFrame = link;
      } catch (e) {
        return NextResponse.json({ error: `La photo n'a pas pu être envoyée : ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
      }
    }

    const brief = enhance
      ? await relayEnhance({ request: prompt, kind: "video", mode, textless: true, ratio, images: typeof body.image === "string" && dataUriOk(body.image) ? [body.image] : [] }).catch(() => null)
      : null;
    const sent = brief?.prompt ?? prompt;
    try {
      const out = await relayVideo({ prompt: sent, model: q.model, size: q.size, seconds, aspect_ratio: ratio, ...(firstFrame ? { first_frame: firstFrame } : {}) });
      const asset = await prisma.creativeAsset.create({
        data: {
          ...base, kind: "video", model: q.model, providerId: out.videoId, sourceId, status: out.status === "in_progress" ? "in_progress" : "queued",
          paramsJson: JSON.stringify({ ratio, seconds, quality, size: q.size, fromImage: !!firstFrame, promptSent: sent, note: brief?.note ?? "", enhanced: !!brief?.enhanced }), costUsd: videoCost(quality, seconds),
        },
      });
      return NextResponse.json({ asset: assetView(asset, guard.session.userId) }, { status: 201 });
    } catch (e) {
      return NextResponse.json({ error: `La vidéo n'a pas pu être lancée : ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
    }
  }

  return NextResponse.json({ error: "Type inconnu (image ou vidéo)." }, { status: 400 });
}
